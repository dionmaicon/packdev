/**
 * Runtime compatibility matrix: for each candidate version of a package,
 * copy the target app into an isolated sandbox, pin that version, run a
 * real install, run the app's own test command, and record pass/fail.
 *
 * Unlike api/api-diff, this never touches the real project — only a
 * throwaway copy — so crash-safety here means "delete the in-flight
 * sandbox on SIGINT/SIGTERM," not the backup/restore mechanism used by
 * init/finish.
 */

import { rmSync } from "fs";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import { createHash } from "crypto";
import * as semver from "semver";
import {
  fileExists,
  readJsonFile,
  writeJsonFile,
  runWithConcurrencyLimit,
  type PackageInfo,
} from "./utils";
import {
  detectPackageManager,
  LOCK_FILE_BY_MANAGER,
  type PackageJson,
  type PackageManagerInfo,
} from "./packageManager";
import { fetchPackageMetadata, listVersionsInRange } from "./registry";
import { resolveInstalledPackage, getInstalledVersion } from "./api";
import { findDuplicateResolutions, resolveWorkspaceDirs } from "./dupes";
import { esmOnlyAdvisory } from "./apiDiff";
import { scanImportedSymbols, scanPassedOptionKeys, createScanCache } from "./appScan";

export type CompatStatus = "PASSED" | "FAILED" | "INSTALL_FAILED" | "SKIPPED";

export interface DupesRegressionEntry {
  package: string;
  controlCopies: number;
  candidateCopies: number;
}

export interface CompatVersionResult {
  version: string;
  status: CompatStatus;
  exitCode: number | null;
  durationMs: number;
  output?: string | undefined;
  lockfileHash: string | null;
  lockfileSnapshotPath: string | null;
  // Set only when --check-dupes is on and the install succeeded: distinct
  // resolved-copy counts for the package under test plus each of its direct
  // dependencies, keyed by package name.
  dupeCounts?: Record<string, number> | undefined;
  // Set only when --check-dupes is on and this version's copy count for some
  // package is HIGHER than the control's — the exact shape a dependency-range
  // gap produces (e.g. a bumped package requiring a newer transitive SDK than
  // the repo declares, nesting a second copy). Never computed for the control
  // itself, only for candidates compared against it.
  dupesRegression?: DupesRegressionEntry[] | undefined;
  // Set only when this candidate looks ESM-only relative to the control AND
  // the app's own test command is a CJS-blind jest run (see
  // detectEsmMismatch) — unlike the other testCommandCaveats, this is
  // necessarily per-version: a package can go ESM-only in exactly one
  // candidate, not the whole range.
  esmMismatch?: string | undefined;
  // Set only when fan-out (--app with multiple targets, or --fan-out) is
  // active: one entry per tested consumer, including the primary --app
  // itself (dir "."), each run against this same already-installed
  // sandbox. When present, `status` above is the rollup — PASSED only if
  // every consumer passed — because "the owning workspace's tests still
  // pass" is a much weaker claim than "every tested dependent still works."
  consumers?: ConsumerTestResult[] | undefined;
}

export interface ConsumerTestResult {
  // Relative to the sandboxed monorepo root; "." for the primary --app.
  dir: string;
  // The consumer's own package.json "name", or null if it has none.
  name: string | null;
  status: "PASSED" | "FAILED";
  exitCode: number | null;
  output?: string | undefined;
}

export type TestHarnessCaveatCode =
  | "TRANSPILE_ONLY"
  | "TYPE_CHECK_ONLY"
  | "PASS_WITH_NO_TESTS";

export interface TestHarnessCaveat {
  code: TestHarnessCaveatCode;
  severity: "warning";
  message: string;
}

export interface CompatReport {
  package: string;
  minimumCompatibleVersion: string | null;
  recommendedVersion: string | null;
  nonMonotonic: boolean;
  versions: CompatVersionResult[];
  group?: string[] | undefined;
  snapshotDir: string;
  concurrency: number;
  // The first entry of testCommandCaveats' message, or null — kept for
  // back-compat with agents/scripts already reading this scalar field.
  testCommandCaveat: string | null;
  // Every static caveat detected about the app's own --test command/harness
  // (transpile-only jest, type-check-only, --passWithNoTests). Does NOT
  // include esmMismatch, which is per-candidate and lives on each version's
  // own CompatVersionResult instead.
  testCommandCaveats: TestHarnessCaveat[];
  // The currently-installed version of the package, tested the same way as
  // every candidate — null when it isn't resolvable in appDir's node_modules
  // (e.g. never installed, or a workspace-hoisted layout compat can't see).
  control: CompatVersionResult | null;
  // True when `control` ran and didn't PASS: the test harness itself is
  // broken for this app (a missing devDependency satisfied only by hoisting,
  // a flaky suite, ...), not evidence any candidate is actually incompatible.
  // minimumCompatibleVersion/recommendedVersion are forced to null in this
  // case rather than recommending a version off a harness that can't even
  // confirm the version already running in production.
  controlFailed: boolean;
  // "workspace" when every version was sandboxed as the whole monorepo root
  // (needed to resolve workspace:-protocol deps); "hermetic" when only
  // appDir itself was copied. Same for every version in this report — it's
  // decided once up front, not per candidate.
  sandboxMode: "hermetic" | "workspace";
  // The package manager actually used to run every sandboxed install, e.g.
  // "yarn@1.22.22" or "npm" when no version could be pinned down. Traces a
  // recommendation back to what actually produced it.
  packageManager: string;
  // True when --seed-lockfile copied the source app's own lockfile into
  // every sandbox before install, reproducing real resolution stickiness —
  // the pinned candidate then forces a minimal update against that existing
  // tree instead of a fresh solve.
  seededLockfile: boolean;
  // Non-null exactly when there's something worth saying about that choice:
  // a reduced-hermeticity warning when seededLockfile is true (a stale
  // lockfile can mask a resolution a fresh solve would have surfaced), or a
  // recommendation to turn it on when checkDupes is set without it (nested-
  // fork duplicates are systematically under-reported against a fresh
  // solve, which re-flattens the tree checkDupes was built to catch).
  lockfileSeedNote: string | null;
  // Relative-to-monorepo-root dirs of every fan-out consumer tested
  // alongside the primary --app, in the same order as each version's own
  // `consumers[1..]` — empty when fan-out wasn't requested. Report-level so
  // the human/CLI summary can name them without digging into a version.
  fanOutConsumers: string[];
}

export interface CompatOptions {
  range?: string | undefined;
  versions?: string[] | undefined;
  appDir: string;
  // Required unless testScript is set (which runs "<manager> run <script>"
  // per target instead). Callers must enforce that at least one is present
  // — this stays optional at the type level so a testScript-only run
  // type-checks without a dummy string.
  testCommand?: string | undefined;
  registryUrl: string;
  token?: string | undefined;
  includePrerelease?: boolean | undefined;
  includeDeprecated?: boolean | undefined;
  group?: string[] | undefined;
  snapshotDir?: string | undefined;
  concurrency?: number | undefined;
  preferOffline?: boolean | undefined;
  checkDupes?: boolean | undefined;
  // Copy the source app's own lockfile into every sandbox before install,
  // reproducing real resolution stickiness instead of a fresh solve. Off by
  // default (a fresh solve is more hermetic — no chance of a stale lockfile
  // masking a resolution the fresh solve would surface), but the condition
  // --check-dupes actually needs to see a nested-fork regression.
  seedLockfile?: boolean | undefined;
  // Explicit extra workspace directories to test as consumers, in addition
  // to appDir, in the same sandbox — e.g. from expanding --app 'apps/*' or
  // --app libs/a,libs/b down to everything after the first match. Forces
  // workspace sandbox mode: consumers are sibling packages, so they must
  // physically exist alongside appDir in the sandbox. Mutually exclusive
  // with fanOut.
  consumerApps?: string[] | undefined;
  // Auto-discover consumers instead of listing them — see
  // resolveFanOutConsumers for the tiered discovery/ranking this drives.
  fanOut?: boolean | undefined;
  // Cap on auto-discovered consumers (fanOut only) — fan-out multiplies
  // wall clock per version, so this bounds it. Default 5.
  fanOutTop?: number | undefined;
  // Run `<packageManager> run <testScript>` in each consumer's own
  // directory instead of the single `testCommand` for all of them.
  // Consumers rarely share one test command; forcing them to is how a
  // fan-out ends up only really testing one app. Ignored (testCommand
  // applies to every target) when not set.
  testScript?: string | undefined;
  // Force sandboxing to only appDir ("hermetic") or the whole discovered
  // monorepo root ("workspace"), overriding the automatic workspace:-protocol
  // detection. Errors if "workspace" is requested but no root is found.
  mode?: "hermetic" | "workspace" | undefined;
  // Override the detected package manager, e.g. "yarn@1.22.22" or "pnpm".
  packageManager?: string | undefined;
}

function formatPackageManager(info: PackageManagerInfo): string {
  return info.version ? `${info.manager}@${info.version}` : info.manager;
}

export type DependencySection =
  | "dependencies"
  | "devDependencies"
  | "peerDependencies";

export async function resolveCandidateVersions(
  pkgName: string,
  options: Pick<
    CompatOptions,
    | "range"
    | "versions"
    | "registryUrl"
    | "token"
    | "includePrerelease"
    | "includeDeprecated"
  >,
): Promise<string[]> {
  if (options.versions && options.versions.length > 0) {
    const invalid = options.versions.filter((v) => !semver.valid(v));
    if (invalid.length > 0) {
      throw new Error(`Invalid version(s): ${invalid.join(", ")}`);
    }
    return [...options.versions].sort((a, b) => semver.compare(a, b));
  }

  if (!options.range) {
    throw new Error("Either --range or --versions must be provided");
  }

  const metadata = await fetchPackageMetadata(
    pkgName,
    options.registryUrl,
    options.token,
  );
  return listVersionsInRange(metadata, options.range, {
    includePrerelease: options.includePrerelease,
    includeDeprecated: options.includeDeprecated,
  });
}

export function findDependencySection(
  packageJson: PackageJson,
  pkgName: string,
): DependencySection | null {
  const sections: DependencySection[] = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
  ];
  for (const section of sections) {
    const entries = packageJson[section] as Record<string, string> | undefined;
    if (entries && pkgName in entries) return section;
  }
  return null;
}

export interface PinTarget {
  name: string;
  section: DependencySection;
}

/**
 * Names of dependencies declared with the `workspace:` protocol (yarn/pnpm
 * workspaces convention, e.g. `"workspace:*"`, `"workspace:^"`). These only
 * resolve inside the monorepo's own workspace root — createSandbox copies
 * the app out to a standalone temp directory, so a real install there can
 * never satisfy them. Detecting this up front lets testOneVersion report a
 * clear SKIPPED instead of a bare, undiagnosable INSTALL_FAILED.
 */
export function findWorkspaceProtocolDeps(packageJson: PackageJson): string[] {
  const sections: DependencySection[] = [
    "dependencies",
    "devDependencies",
    "peerDependencies",
  ];
  const found = new Set<string>();
  for (const section of sections) {
    const entries = packageJson[section] as Record<string, string> | undefined;
    if (!entries) continue;
    for (const [name, spec] of Object.entries(entries)) {
      if (typeof spec === "string" && spec.startsWith("workspace:")) {
        found.add(name);
      }
    }
  }
  return [...found].sort();
}

/**
 * Walk upward from `appDir` looking for the monorepo root a `workspace:`
 * specifier actually resolves against — a `package.json` with a
 * `workspaces` field, or a `pnpm-workspace.yaml`. Returns null if none is
 * found anywhere up the tree (an unusual case: `workspace:` specifiers
 * outside any discoverable workspaces config), which is the only situation
 * compat still has to report SKIPPED for.
 */
// True when `spec` (a dependency's declared specifier) actually resolves to
// a local workspace rather than a same-named registry/alias/git package.
// Local-workspace linking isn't gated on the `workspace:` protocol string —
// npm/yarn classic auto-link a same-named local workspace off a plain "*"
// or matching semver range too — but a plain semver range only links
// locally when the local package's own version actually satisfies it;
// otherwise the package manager installs a separate copy from the
// registry, and an `npm:`/git/URL specifier never resolves locally at all
// regardless of name. `localVersion` undefined (no "version" field on the
// candidate) falls back to permissive — this is expected to be rare enough
// in practice that failing open beats a false negative.
function specifierLinksToLocalWorkspace(spec: string, localVersion: string | undefined): boolean {
  if (spec.startsWith("workspace:") || spec.startsWith("file:") || spec.startsWith("link:")) {
    return true;
  }
  if (spec.startsWith("npm:") || /^(git\+|git:|github:|https?:)/.test(spec)) {
    return false;
  }
  if (localVersion === undefined) return true;
  return semver.validRange(spec) !== null && semver.satisfies(localVersion, spec);
}

// Dependency keys (in any of dependencies/devDependencies/peerDependencies)
// that name a workspace in `candidateVersions` AND whose declared specifier
// actually links to that local workspace (see specifierLinksToLocalWorkspace).
function findDependencyNamesAmong(
  packageJson: PackageJson,
  candidateVersions: Map<string, string | undefined>,
): string[] {
  const sections: DependencySection[] = ["dependencies", "devDependencies", "peerDependencies"];
  const found = new Set<string>();
  for (const section of sections) {
    const entries = packageJson[section] as Record<string, string> | undefined;
    if (!entries) continue;
    for (const [name, spec] of Object.entries(entries)) {
      if (!candidateVersions.has(name)) continue;
      if (specifierLinksToLocalWorkspace(spec, candidateVersions.get(name))) found.add(name);
    }
  }
  return [...found];
}

export async function findMonorepoRoot(appDir: string): Promise<string | null> {
  let dir = path.resolve(appDir);
  for (;;) {
    const packageJson = await readJsonFile<PackageJson & { workspaces?: unknown }>(
      path.join(dir, "package.json"),
    );
    if (packageJson?.workspaces) return dir;
    if (await fileExists(path.join(dir, "pnpm-workspace.yaml"))) return dir;

    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Resolve the primary package plus every (deduplicated) group member to the
 * section that currently declares it, so a lockstep group (e.g. NestJS's
 * @nestjs/* family) can be pinned to the same candidate version in one
 * sandboxed run instead of just the primary package alone.
 */
export function resolvePinTargets(
  pkgName: string,
  group: string[] | undefined,
  packageJson: PackageJson,
): PinTarget[] {
  const names = [...new Set([pkgName, ...(group ?? [])])];
  return names.map((name) => {
    const section = findDependencySection(packageJson, name);
    if (!section) {
      throw new Error(`"${name}" is not declared in the app's package.json`);
    }
    return { name, section };
  });
}

/**
 * Like resolvePinTargets, but for a fan-out consumer that isn't required to
 * declare pkgName (or every --group member) itself: pins whichever of
 * [pkgName, ...group] this workspace actually declares, instead of
 * all-or-nothing. All-or-nothing would silently drop the pin even for a
 * consumer that DOES declare pkgName directly, just because it's missing
 * one unrelated lockstep group member — leaving that consumer's own
 * dependency at its original version and defeating the point of testing it.
 */
function resolveAvailablePinTargets(
  pkgName: string,
  group: string[] | undefined,
  packageJson: PackageJson,
): PinTarget[] {
  const names = [...new Set([pkgName, ...(group ?? [])])];
  const targets: PinTarget[] = [];
  for (const name of names) {
    const section = findDependencySection(packageJson, name);
    if (section) targets.push({ name, section });
  }
  return targets;
}

// Cap on in-flight package.json reads / AST scans during workspace
// discovery (findWorkspacesDeclaring, resolveFanOutConsumers). This is
// lightweight fs+parse work, not a full install/test process, so a higher
// cap than the version-testing --concurrency default is fine — it's not
// user-configurable because there's no comparable per-workspace resource
// cost to tune against.
const DISCOVERY_CONCURRENCY = 8;

// When --app doesn't declare the package, a monorepo often has some sibling
// workspace that does — this is usually the actual fix (point --app there),
// not evidence the package name is wrong. Scans every workspace's own
// package.json rather than just appDir's, so the error names candidates
// instead of leaving the caller to `grep` the monorepo by hand.
interface DeclaringWorkspace {
  // package.json "name", falling back to the monorepo-relative dir when unnamed.
  name: string;
  // Monorepo-relative dir — usable directly in a suggested --app value.
  dir: string;
  // package.json "version" — needed to check whether a dependency on this
  // workspace (by name) actually resolves locally (specifierLinksToLocalWorkspace)
  // rather than to a same-named registry/alias/git package.
  version: string | undefined;
}

async function findWorkspacesDeclaring(
  pkgName: string,
  appDir: string,
): Promise<DeclaringWorkspace[]> {
  const monorepoRoot = await findMonorepoRoot(appDir);
  if (!monorepoRoot) return [];

  const workspaceDirs = await resolveWorkspaceDirs(monorepoRoot);
  const resolvedAppDir = path.resolve(appDir);
  // Independent per-workspace package.json reads — no ordering dependency
  // between them, so run them off the same concurrency-limited pool used
  // for everything else in this file rather than one at a time.
  const entries = await runWithConcurrencyLimit(
    workspaceDirs.filter((dir) => path.resolve(dir) !== resolvedAppDir),
    DISCOVERY_CONCURRENCY,
    async (dir): Promise<DeclaringWorkspace | null> => {
      const packageJson = await readJsonFile<PackageJson & { name?: string }>(
        path.join(dir, "package.json"),
      );
      if (!packageJson || !findDependencySection(packageJson, pkgName)) return null;
      const relDir = path.relative(monorepoRoot, dir);
      return { name: packageJson.name ?? relDir, dir: relDir, version: packageJson.version };
    },
  );
  return entries
    .filter((e): e is DeclaringWorkspace => e !== null)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export interface ConsumerTarget {
  // Absolute path on the real (unsandboxed) disk.
  absoluteDir: string;
  // Relative to the monorepo root — this is what locates it again once
  // copied into the sandbox.
  relativeDir: string;
}

/**
 * Auto-discover fan-out consumers, widened by exactly one hop past direct
 * declarers so the wrapper pattern (a lib wraps pkgName, apps depend on the
 * lib rather than pkgName directly) is actually reachable:
 *
 *   tier 0 — every workspace under monorepoRoot (other than appDir) that
 *            directly declares pkgName in dependencies/devDependencies/
 *            peerDependencies.
 *   tier 1 — every workspace that depends on a tier-0 workspace by name,
 *            with a specifier that actually resolves locally (`workspace:`,
 *            `file:`/`link:`, or a plain/semver range the tier-0
 *            workspace's own version satisfies — see
 *            specifierLinksToLocalWorkspace; excludes `npm:` aliases, git,
 *            and URL specifiers, and a semver range the local version
 *            doesn't actually satisfy, since a package manager would
 *            install a separate registry copy for those, not link the
 *            wrapper this fan-out is trying to reach) — but does not itself
 *            declare pkgName. This is the one hop that makes a wrapper's
 *            own consumers discoverable — going deeper
 *            (consumer-of-a-consumer) would risk pulling in the whole repo,
 *            so it stops here.
 *
 * A workspace that only gets pkgName through hoisting (imports it but
 * doesn't declare it, and doesn't depend locally on a declarer) isn't
 * eligible in either tier — pinning requires either a section to pin
 * pkgName into directly (tier 0) or a wrapper whose own pin already carries
 * the version through (tier 1).
 *
 * Ranked: tier 0 before tier 1; within a tier, by distinct symbols imported
 * from the thing that makes it eligible (pkgName for tier 0, the
 * connecting wrapper(s) for tier 1), descending; then by whether it passes
 * an object literal into a call on that import (scanPassedOptionKeys) —
 * the signal that distinguishes a consumer handing the wrapper real
 * options (and so most likely to break on a structural change) from one
 * that only calls a bare decorator. Capped at `top`.
 */
// Resolves symlinks on both sides before comparing, so a workspace dir that
// only *looks* contained (e.g. a symlink pointing outside monorepoRoot)
// can't slip through — relativeDir is later joined straight into a sandbox
// path (createSandbox, testOneVersion), so an uncontained target isn't just
// a bookkeeping error, it's compat rewriting/executing a real external
// directory while believing it's sandboxed. Falls back to the
// non-realpath'd absolute dir if either side doesn't exist yet (lets the
// caller's own "no package.json found" error fire with a clearer message
// than an ENOENT from realpath would).
async function assertConsumerWithinMonorepo(monorepoRoot: string, absoluteDir: string): Promise<void> {
  const [realRoot, realTarget] = await Promise.all([
    fs.realpath(monorepoRoot).catch(() => path.resolve(monorepoRoot)),
    fs.realpath(absoluteDir).catch(() => path.resolve(absoluteDir)),
  ]);
  const rel = path.relative(realRoot, realTarget);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(
      `Fan-out consumer "${absoluteDir}" resolves outside the monorepo root "${monorepoRoot}" ` +
        `(possibly via a symlink or a "../" path) — refusing to sandbox it. Fan-out consumers must ` +
        `be real subdirectories of the discovered workspaces root.`,
    );
  }
}

interface FanOutCandidate {
  dir: string;
  tier: 0 | 1;
  symbolCount: number;
  hasObjectArg: boolean;
}

export async function resolveFanOutConsumers(
  pkgName: string,
  monorepoRoot: string,
  appDir: string,
  top: number,
): Promise<ConsumerTarget[]> {
  const workspaceDirs = await resolveWorkspaceDirs(monorepoRoot);
  const resolvedAppDir = path.resolve(appDir);
  // Scoped to exactly this call — file-list/AST reuse across the tier-0 and
  // tier-1 scans below (and across scanImportedSymbols/scanPassedOptionKeys,
  // which otherwise each re-glob and re-parse the same directory), never
  // held past this function returning. See createScanCache's own doc for
  // why this can't be a module-level cache (the MCP server is long-lived
  // and source files can change between separate tool calls).
  const scanCache = createScanCache();

  // Read every workspace, INCLUDING appDir — appDir itself may be the
  // direct declarer (the common case: --app points at the wrapper), and
  // its name has to be in tier0Names for tier-1 detection to find anything
  // that depends on it. appDir is excluded only when building the actual
  // candidate list below, never from this name-resolution pass. Each read
  // is independent, so run them concurrently rather than one at a time.
  const workspaceEntries = await runWithConcurrencyLimit(
    workspaceDirs,
    DISCOVERY_CONCURRENCY,
    async (dir): Promise<{ dir: string; packageJson: PackageJson & { name?: string } } | null> => {
      const packageJson = await readJsonFile<PackageJson & { name?: string }>(
        path.join(dir, "package.json"),
      );
      return packageJson ? { dir, packageJson } : null;
    },
  );
  const workspaces = workspaceEntries.filter(
    (w): w is { dir: string; packageJson: PackageJson & { name?: string } } => w !== null,
  );

  const tier0 = workspaces.filter((w) => findDependencySection(w.packageJson, pkgName));
  const tier0Names = new Set(
    tier0.map((w) => w.packageJson.name).filter((n): n is string => !!n),
  );
  // name -> declared version, so a tier-1 dependency on it can be checked
  // for actual semver compatibility (specifierLinksToLocalWorkspace) rather
  // than matched on name alone.
  const tier0Versions = new Map<string, string | undefined>(
    tier0
      .filter((w): w is typeof w & { packageJson: { name: string } } => !!w.packageJson.name)
      .map((w) => [w.packageJson.name, w.packageJson.version]),
  );

  const tier0Candidates = await runWithConcurrencyLimit(
    tier0.filter((w) => path.resolve(w.dir) !== resolvedAppDir),
    DISCOVERY_CONCURRENCY,
    async (w): Promise<FanOutCandidate> => {
      const [{ symbols }, optionKeys] = await Promise.all([
        scanImportedSymbols(w.dir, pkgName, scanCache),
        scanPassedOptionKeys(w.dir, pkgName, scanCache),
      ]);
      return {
        dir: w.dir,
        tier: 0,
        symbolCount: symbols.size,
        hasObjectArg: optionKeys.size > 0,
      };
    },
  );

  const tier1Inputs = workspaces.filter((w) => {
    if (path.resolve(w.dir) === resolvedAppDir) return false;
    if (tier0Names.has(w.packageJson.name ?? "")) return false; // already tier 0
    return findDependencyNamesAmong(w.packageJson, tier0Versions).length > 0;
  });

  const tier1Candidates = await runWithConcurrencyLimit(
    tier1Inputs,
    DISCOVERY_CONCURRENCY,
    async (w): Promise<FanOutCandidate> => {
      const wrapperNames = findDependencyNamesAmong(w.packageJson, tier0Versions);
      let symbolCount = 0;
      let hasObjectArg = false;
      for (const wrapperName of wrapperNames) {
        const { symbols } = await scanImportedSymbols(w.dir, wrapperName, scanCache);
        symbolCount += symbols.size;
        if (!hasObjectArg) {
          const optionKeys = await scanPassedOptionKeys(w.dir, wrapperName, scanCache);
          if (optionKeys.size > 0) hasObjectArg = true;
        }
      }
      return { dir: w.dir, tier: 1, symbolCount, hasObjectArg };
    },
  );

  const candidates: FanOutCandidate[] = [...tier0Candidates, ...tier1Candidates];

  candidates.sort(
    (a, b) =>
      a.tier - b.tier ||
      b.symbolCount - a.symbolCount ||
      Number(b.hasObjectArg) - Number(a.hasObjectArg) ||
      a.dir.localeCompare(b.dir),
  );

  return candidates.slice(0, top).map(({ dir }) => ({
    absoluteDir: path.resolve(dir),
    relativeDir: path.relative(monorepoRoot, path.resolve(dir)),
  }));
}

const SANDBOX_PREFIX = "packdev-compat-sandbox-";
const EXCLUDED_COPY_NAMES = new Set([
  "node_modules",
  ".git",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "dist",
  "build",
]);

// Tracks every in-flight sandbox so a signal handler can clean all of them up.
// A Set, not a single value: with --concurrency > 1 multiple sandboxes exist
// simultaneously, and a single-slot tracker would leak every sandbox except
// whichever one happened to be created last.
const activeSandboxDirs = new Set<string>();

/**
 * Copy `appDir` into a fresh temp directory (excluding node_modules, .git,
 * lockfiles, dist/build) and pin every target in `pinTargets` to `version`
 * in its own section — a lockstep group all moves to the same version in
 * one sandboxed run. Deliberately not copying the lockfile: each sandbox
 * gets a fully independent install, which is what actually prevents
 * workspace-hoisting cross-contamination between version runs.
 */
/**
 * Copy `sourceDir` into a fresh sandbox and pin `pinTargets` in the
 * package.json at `sourceDir/appRelativePath` (default "" — the common
 * case, sourceDir *is* the app). When the app has `workspace:`-protocol
 * deps, `sourceDir` is instead the whole monorepo root (so those specifiers
 * resolve against real sibling workspace directories that now physically
 * exist in the sandbox) and `appRelativePath` locates the actual app within
 * it — the caller must then run the install at the sandbox root and the
 * test command at `sandboxDir/appRelativePath`.
 */
export async function createSandbox(
  sourceDir: string,
  version: string,
  pinTargets: PinTarget[],
  appRelativePath: string = "",
  // When set (a "packageManager" field pin or a --package-manager override
  // carries a version), written into the sandboxed package.json(s) so
  // Corepack's own shims — not our bare `spawn(manager, ...)` call — pick up
  // and run that exact version. Without this, a pinned/overridden version
  // was only ever reflected in the JSON report, never in which binary
  // actually ran the install.
  packageManagerPin?: { manager: PackageManagerInfo["manager"]; version: string },
  // The detected package manager's own lock file name (e.g. "yarn.lock"),
  // only when --seed-lockfile is on. Copying it in reproduces the real
  // repo's resolution stickiness — the pinned version then forces a minimal
  // update against that existing tree instead of a fresh solve, which is
  // the condition under which --check-dupes can actually see a nested-fork
  // regression. Undefined/other lockfiles stay excluded either way; a
  // pnpm-lock.yaml has no business in an npm sandbox regardless.
  seedLockfileName?: string,
  // Fan-out consumers: each gets `version` pinned into its own package.json
  // at `sandboxDir/relativePath`, the same way as the primary appRelativePath
  // above — a lockstep group pin (pinTargets may include --group members
  // too) applied per consumer, since each consumer declares its own range
  // for pkgName independently of the primary app's.
  extraPinTargets?: { relativePath: string; pinTargets: PinTarget[] }[],
): Promise<string> {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), SANDBOX_PREFIX));
  activeSandboxDirs.add(sandboxDir);

  await fs.cp(sourceDir, sandboxDir, {
    recursive: true,
    filter: (source: string) => {
      const base = path.basename(source);
      if (seedLockfileName && base === seedLockfileName) return true;
      return !EXCLUDED_COPY_NAMES.has(base);
    },
  });

  const pinOnePackageJson = async (
    relativePath: string,
    targets: PinTarget[],
  ): Promise<void> => {
    const packageJsonPath = path.join(sandboxDir, relativePath, "package.json");
    const packageJson = await readJsonFile<PackageJson>(packageJsonPath);
    if (!packageJson) {
      throw new Error(
        `No package.json found in sandboxed copy of ${path.join(sourceDir, relativePath)}`,
      );
    }
    for (const { name, section } of targets) {
      packageJson[section] = {
        ...((packageJson[section] as Record<string, string> | undefined) ?? {}),
        [name]: version,
      };
    }
    await writeJsonFile(packageJsonPath, packageJson);
  };

  await pinOnePackageJson(appRelativePath, pinTargets);
  for (const consumer of extraPinTargets ?? []) {
    await pinOnePackageJson(consumer.relativePath, consumer.pinTargets);
  }

  if (packageManagerPin) {
    const packageJsonPath = path.join(sandboxDir, appRelativePath, "package.json");
    const packageJson = await readJsonFile<PackageJson>(packageJsonPath);
    if (packageJson) {
      packageJson["packageManager"] = `${packageManagerPin.manager}@${packageManagerPin.version}`;
      await writeJsonFile(packageJsonPath, packageJson);
    }
  }

  // Install always runs from sandboxDir's own root (see testOneVersion), not
  // appRelativePath — in a sandboxed monorepo that's a different package.json
  // than the one just patched above, and Corepack only reads the pin from
  // the nearest package.json to its own invocation cwd.
  if (packageManagerPin && appRelativePath) {
    const rootPackageJsonPath = path.join(sandboxDir, "package.json");
    const rootPackageJson = await readJsonFile<PackageJson>(rootPackageJsonPath);
    if (rootPackageJson) {
      rootPackageJson["packageManager"] = `${packageManagerPin.manager}@${packageManagerPin.version}`;
      await writeJsonFile(rootPackageJsonPath, rootPackageJson);
    }
  }

  return sandboxDir;
}

export async function cleanupSandbox(sandboxDir: string): Promise<void> {
  await fs.rm(sandboxDir, { recursive: true, force: true });
  activeSandboxDirs.delete(sandboxDir);
}

let signalHandlersRegistered = false;

/** Best-effort sandbox cleanup on Ctrl+C / termination — never leaves a
 * half-installed sandbox directory behind. */
export function registerCompatSignalHandling(): void {
  if (signalHandlersRegistered) return;
  signalHandlersRegistered = true;

  const cleanupAndExit = (signal: NodeJS.Signals) => {
    for (const dir of activeSandboxDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    activeSandboxDirs.clear();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };

  process.once("SIGINT", () => cleanupAndExit("SIGINT"));
  process.once("SIGTERM", () => cleanupAndExit("SIGTERM"));
}

export interface RunResult {
  success: boolean;
  exitCode: number | null;
  output: string;
}

const MAX_OUTPUT_CHARS = 4000;

function truncate(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output;
  return `...[truncated]...\n${output.slice(-MAX_OUTPUT_CHARS)}`;
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell: true });
    let output = "";
    child.stdout?.on("data", (chunk) => (output += chunk.toString()));
    child.stderr?.on("data", (chunk) => (output += chunk.toString()));
    child.on("close", (code) => {
      resolve({ success: code === 0, exitCode: code, output: truncate(output) });
    });
    child.on("error", (error) => {
      resolve({
        success: false,
        exitCode: null,
        output: truncate(`${output}\n${error.message}`),
      });
    });
  });
}

export function runInstall(
  sandboxDir: string,
  manager: PackageManagerInfo["manager"],
  registryUrl?: string,
  preferOffline?: boolean,
): Promise<RunResult> {
  const args = [
    "install",
    ...(registryUrl ? ["--registry", registryUrl] : []),
    ...(preferOffline ? ["--prefer-offline"] : []),
  ];
  return runCommand(manager, args, sandboxDir);
}

export function runTestCommand(
  testCwd: string,
  testCommand: string,
): Promise<RunResult> {
  return runCommand(testCommand, [], testCwd);
}

/**
 * Read whatever lockfile the sandbox's install actually produced, hash it,
 * and copy it into `snapshotDir` — named by version+manager, not by run, so
 * pointing repeated runs at the same --snapshot-dir accumulates a diffable
 * history per version instead of silently overwriting drift away. A missing
 * lockfile (install produced none) is a valid, reportable outcome, not an
 * error — mirrors the project's hasTypes:false/typesSource:"none" convention.
 */
async function captureLockfileSnapshot(
  sandboxDir: string,
  packageManagerInfo: PackageManagerInfo,
  snapshotDir: string,
  pkgName: string,
  version: string,
): Promise<{ hash: string | null; path: string | null }> {
  const sourcePath = path.join(sandboxDir, packageManagerInfo.lockFile);
  let content: Buffer;
  try {
    content = await fs.readFile(sourcePath);
  } catch {
    return { hash: null, path: null };
  }

  const hash = createHash("sha256").update(content).digest("hex");
  const destPath = path.join(
    snapshotDir,
    `${pkgName.replace(/\//g, "__")}-${version}-${packageManagerInfo.manager}-${packageManagerInfo.lockFile}`,
  );
  await fs.writeFile(destPath, content);

  return { hash, path: destPath };
}

async function resolveSnapshotDir(snapshotDir?: string): Promise<string> {
  if (snapshotDir) {
    await fs.mkdir(snapshotDir, { recursive: true });
    return path.resolve(snapshotDir);
  }
  return fs.mkdtemp(path.join(os.tmpdir(), "packdev-compat-snapshots-"));
}

// True when a FAILED/INSTALL_FAILED version sits between two PASSED
// versions in sorted order — a cheap, honest signal that the pass/fail
// pattern isn't contiguous (full bisect is future work).
function computeNonMonotonic(versions: CompatVersionResult[]): boolean {
  let seenPass = false;
  let seenFailAfterPass = false;
  for (const v of versions) {
    if (v.status === "PASSED") {
      if (seenFailAfterPass) return true;
      seenPass = true;
    } else if (seenPass) {
      seenFailAfterPass = true;
    }
  }
  return false;
}

// Counts distinct resolved copies of the package under test plus each of its
// own direct dependencies, inside the sandbox that was just installed. This
// is the walk `dupes` already does, just aimed at a throwaway sandbox instead
// of the real project — a dependency-range gap (e.g. a bumped package
// requiring a newer transitive SDK than the repo declares) nests a second
// copy under the bumped package's own node_modules, and this is what makes
// that visible without a human reaching for `packdev dupes` by hand.
async function collectDupeCounts(
  pkgName: string,
  sandboxRoot: string,
  testCwdRelative: string,
): Promise<Record<string, number>> {
  const pkgDir = await resolveInstalledPackage(
    pkgName,
    path.join(sandboxRoot, testCwdRelative),
  );
  const directDeps = pkgDir
    ? Object.keys(
        (await readJsonFile<PackageJson>(path.join(pkgDir, "package.json")))
          ?.dependencies as Record<string, string> | undefined ?? {},
      )
    : [];

  const namesToCheck = [...new Set([pkgName, ...directDeps])];
  // sandboxRoot's workspace layout is fixed for the lifetime of this
  // already-installed sandbox — resolve it once and hand it to every
  // per-name call below instead of letting findDuplicateResolutions
  // re-walk the identical layout once per name. The per-name walks
  // themselves are independent (each over its own node_modules subtree),
  // so run them concurrently too.
  const workspaceDirs = await resolveWorkspaceDirs(sandboxRoot);
  const entries = await runWithConcurrencyLimit(
    namesToCheck,
    DISCOVERY_CONCURRENCY,
    async (name): Promise<[string, number]> => {
      const report = await findDuplicateResolutions(name, sandboxRoot, { workspaceDirs });
      return [name, report.resolutions.length];
    },
  );
  return Object.fromEntries(entries);
}

export interface EsmCheckContext {
  consumerIsCjsBlind: boolean;
  controlInfo: PackageInfo | null;
}

// Sandboxes, installs, and tests exactly one version — the shared execution
// path for both the full linear scan (runCompat) and --bisect.
async function testOneVersion(
  pkgName: string,
  version: string,
  options: CompatOptions,
  packageManagerInfo: PackageManagerInfo,
  pinTargets: PinTarget[],
  snapshotDir: string,
  workspaceProtocolDeps: string[],
  monorepoRoot: string | null,
  appRelativePath: string,
  esmCheck: EsmCheckContext,
  consumerTargets: ResolvedConsumerTarget[],
): Promise<CompatVersionResult> {
  const startedAt = Date.now();

  if (workspaceProtocolDeps.length > 0 && !monorepoRoot) {
    return {
      version,
      status: "SKIPPED",
      exitCode: null,
      durationMs: Date.now() - startedAt,
      output:
        `Cannot sandbox: ${options.appDir}'s package.json declares workspace:-protocol ` +
        `dependencies (${workspaceProtocolDeps.join(", ")}), but no workspaces root ` +
        `(package.json "workspaces" or pnpm-workspace.yaml) could be found anywhere above ` +
        `it — compat cannot resolve these specifiers without one.`,
      lockfileHash: null,
      lockfileSnapshotPath: null,
    };
  }

  // With workspace:-protocol deps, sandbox the whole monorepo (not just the
  // app) so sibling workspaces physically exist and those specifiers
  // resolve normally — install runs at the sandboxed monorepo root, the
  // test command runs at the sandboxed app's own directory within it.
  const sourceDir = monorepoRoot ?? options.appDir;
  const testCwdRelative = monorepoRoot ? appRelativePath : "";

  let sandboxDir: string | null = null;
  try {
    sandboxDir = await createSandbox(
      sourceDir,
      version,
      pinTargets,
      testCwdRelative,
      packageManagerInfo.version !== undefined
        ? { manager: packageManagerInfo.manager, version: packageManagerInfo.version }
        : undefined,
      options.seedLockfile ? packageManagerInfo.lockFile : undefined,
      consumerTargets.length > 0
        ? consumerTargets.map((c) => ({ relativePath: c.relativePath, pinTargets: c.pinTargets }))
        : undefined,
    );

    const installResult = await runInstall(
      sandboxDir,
      packageManagerInfo.manager,
      options.registryUrl,
      options.preferOffline,
    );
    if (!installResult.success) {
      return {
        version,
        status: "INSTALL_FAILED",
        exitCode: installResult.exitCode,
        durationMs: Date.now() - startedAt,
        output: installResult.output,
        lockfileHash: null,
        lockfileSnapshotPath: null,
      };
    }

    const snapshot = await captureLockfileSnapshot(
      sandboxDir,
      packageManagerInfo,
      snapshotDir,
      pkgName,
      version,
    );

    const dupeCounts = options.checkDupes
      ? await collectDupeCounts(pkgName, sandboxDir, testCwdRelative)
      : undefined;

    const esmMismatch = esmCheck.consumerIsCjsBlind
      ? await (async () => {
          const candidateDir = await resolveInstalledPackage(
            pkgName,
            path.join(sandboxDir!, testCwdRelative),
          );
          const candidateInfo = candidateDir
            ? await readJsonFile<PackageInfo>(path.join(candidateDir, "package.json"))
            : null;
          return detectEsmMismatch(true, esmCheck.controlInfo, candidateInfo);
        })()
      : undefined;

    const effectiveTestCommand = options.testScript
      ? `${packageManagerInfo.manager} run ${options.testScript}`
      : (options.testCommand ?? "");

    const testCwd = path.join(sandboxDir, testCwdRelative);
    const testResult = await runTestCommand(testCwd, effectiveTestCommand);

    let consumers: ConsumerTestResult[] | undefined;
    // The exitCode/output a caller sees when `status` is the fan-out
    // rollup: default to the primary's own result, but if the primary
    // itself passed and a consumer is what actually failed, surface that
    // consumer's exitCode/output instead — otherwise a top-level
    // "FAILED, exitCode 0, no output" would be internally contradictory
    // for any caller that doesn't also inspect `consumers`.
    let rolledUpExitCode = testResult.exitCode;
    let rolledUpOutput = testResult.success ? undefined : testResult.output;
    let overallSuccess = testResult.success;
    if (consumerTargets.length > 0) {
      const primaryPackageJson = await readJsonFile<PackageJson & { name?: string }>(
        path.join(testCwd, "package.json"),
      );
      consumers = [
        {
          dir: ".",
          name: primaryPackageJson?.name ?? null,
          status: testResult.success ? "PASSED" : "FAILED",
          exitCode: testResult.exitCode,
          output: testResult.success ? undefined : testResult.output,
        },
      ];
      // Deliberately serial, not concurrent: every consumer's test command
      // runs against a subdirectory of the SAME sandbox as the primary and
      // every other consumer, not an isolated copy. A shared workspace
      // root can have shared mutable state a test/build script writes to
      // (a root-level cache dir, coverage output, an incremental build-info
      // file, a dev-server port) — running these concurrently would trade
      // wall-clock time for a chance of nondeterministic cross-consumer
      // interference, which is a bad trade for a tool whose entire value is
      // a trustworthy pass/fail signal. (Testing different VERSIONS is
      // still parallel via --concurrency — each version gets its own fully
      // independent sandbox, so there's no shared state across versions.)
      for (const consumer of consumerTargets) {
        const consumerCwd = path.join(sandboxDir, consumer.relativePath);
        const consumerResult = await runTestCommand(consumerCwd, effectiveTestCommand);
        const consumerPackageJson = await readJsonFile<PackageJson & { name?: string }>(
          path.join(consumerCwd, "package.json"),
        );
        consumers.push({
          dir: consumer.relativePath,
          name: consumerPackageJson?.name ?? null,
          status: consumerResult.success ? "PASSED" : "FAILED",
          exitCode: consumerResult.exitCode,
          output: consumerResult.success ? undefined : consumerResult.output,
        });
        if (overallSuccess && !consumerResult.success) {
          // First failure seen — the primary passed, so this consumer is
          // the one actually explaining the rollup.
          rolledUpExitCode = consumerResult.exitCode;
          rolledUpOutput = consumerResult.output;
        }
        overallSuccess = overallSuccess && consumerResult.success;
      }
    }

    return {
      version,
      status: overallSuccess ? "PASSED" : "FAILED",
      exitCode: rolledUpExitCode,
      durationMs: Date.now() - startedAt,
      output: rolledUpOutput,
      lockfileHash: snapshot.hash,
      lockfileSnapshotPath: snapshot.path,
      dupeCounts,
      esmMismatch,
      consumers,
    };
  } finally {
    if (sandboxDir) await cleanupSandbox(sandboxDir);
  }
}

// Parses a --package-manager override like "yarn@1.22.22" or bare "pnpm".
function parsePackageManagerOverride(spec: string): PackageManagerInfo {
  const match = /^(npm|yarn|pnpm)(?:@(.+))?$/.exec(spec.trim());
  const manager = match?.[1] as PackageManagerInfo["manager"] | undefined;
  if (!manager) {
    throw new Error(
      `Invalid --package-manager value "${spec}" — expected npm, yarn, pnpm, or <name>@<version>`,
    );
  }
  return {
    manager,
    lockFile: LOCK_FILE_BY_MANAGER[manager],
    ...(match?.[2] !== undefined ? { version: match[2] } : {}),
    source: "cli-override",
  };
}

export interface ResolvedConsumerTarget {
  relativePath: string;
  pinTargets: PinTarget[];
  absoluteDir: string;
}

async function resolveRunContext(
  pkgName: string,
  options: CompatOptions,
): Promise<{
  pinTargets: PinTarget[];
  packageManagerInfo: PackageManagerInfo;
  workspaceProtocolDeps: string[];
  monorepoRoot: string | null;
  appRelativePath: string;
  sandboxMode: "hermetic" | "workspace";
  consumerTargets: ResolvedConsumerTarget[];
}> {
  if (options.consumerApps && options.consumerApps.length > 0 && options.fanOut) {
    throw new Error(
      "`consumerApps` (explicit fan-out targets) and `fanOut` (auto-discovery) are mutually " +
        "exclusive — pick one. Silently preferring the explicit list would make a requested " +
        "auto-discovery disappear without any indication why.",
    );
  }

  const appPackageJsonPath = path.join(options.appDir, "package.json");
  const appPackageJson = await readJsonFile<PackageJson>(appPackageJsonPath);
  if (!appPackageJson) {
    throw new Error(`No package.json found in app directory: ${options.appDir}`);
  }

  let pinTargets: PinTarget[];
  try {
    pinTargets = resolvePinTargets(pkgName, options.group, appPackageJson);
  } catch (error) {
    const message = (error as Error).message;
    const missingName = /^"(.+)" is not declared/.exec(message)?.[1] ?? pkgName;
    const declaringWorkspaces = await findWorkspacesDeclaring(missingName, options.appDir);
    if (declaringWorkspaces.length > 0) {
      // The wrapper hint below is specifically about REACHING pkgName
      // (the package under test) transitively — it doesn't apply when the
      // undeclared name is instead a --group member. resolvePinTargets
      // throws on the first undeclared name in [pkgName, ...group], so
      // missingName can be a group member; a workspace that wraps THAT
      // member wouldn't necessarily declare pkgName at all, so both
      // suggested --app commands below would just fail again with a
      // different "not declared" error. Only special-case when pkgName
      // itself is what's missing — otherwise fall through to the generic
      // "declared in these workspaces" message, which is still correct
      // (it just names where the missing group member lives).
      const declaringVersions =
        missingName === pkgName
          ? new Map(declaringWorkspaces.map((w) => [w.name, w.version]))
          : new Map<string, string | undefined>();
      const reachableWrapperNames = findDependencyNamesAmong(appPackageJson, declaringVersions);
      const wrapperName =
        reachableWrapperNames.length === 1 ? reachableWrapperNames[0] : undefined;
      const wrapper = wrapperName
        ? declaringWorkspaces.find((w) => w.name === wrapperName)
        : undefined;
      if (wrapper && wrapperName) {
        const wrapperSpec =
          (findDependencySection(appPackageJson, wrapperName) &&
            (appPackageJson[findDependencySection(appPackageJson, wrapperName)!] as Record<
              string,
              string
            >)[wrapperName]) ??
          "*";
        // wrapper.dir is relative to the monorepo root (that's what
        // findWorkspacesDeclaring resolved it against), but a --app value
        // the user types is resolved from the CURRENT WORKING DIRECTORY —
        // often the consumer itself, not the monorepo root. Re-anchor it to
        // cwd so the suggested command is actually copy-pasteable from the
        // failing invocation, not silently wrong whenever cwd != monorepo
        // root.
        const monorepoRootForHint = await findMonorepoRoot(options.appDir);
        const wrapperPathForCli = monorepoRootForHint
          ? path.relative(process.cwd(), path.join(monorepoRootForHint, wrapper.dir)) || "."
          : wrapper.dir;
        throw new Error(
          `"${missingName}" is not declared in ${options.appDir}, but it reaches it through ` +
            `${wrapper.name} (${wrapperSpec}). Use one of:\n` +
            `  --app ${wrapperPathForCli},${options.appDir}\n` +
            `  --app ${wrapperPathForCli} --fan-out\n` +
            // Both suggestions above put --app on the WRAPPER, not the
            // current (non-declaring) --app value — just appending
            // --fan-out to the original invocation would still fail here,
            // since the primary would still be the non-declaring consumer.
            `(pointing --app at the wrapper — appending --fan-out to this exact command won't help, ` +
            `since the primary here would still be the non-declaring target)`,
        );
      }
      throw new Error(
        `${message} — but it is declared in these workspaces: ` +
          `${declaringWorkspaces.map((w) => w.name).join(", ")}. Point --app at one of them instead.`,
      );
    }
    throw error;
  }
  const workspaceProtocolDeps = findWorkspaceProtocolDeps(appPackageJson);

  const wantsFanOut = (options.consumerApps && options.consumerApps.length > 0) || !!options.fanOut;

  let monorepoRoot: string | null = null;
  let appRelativePath = "";
  const wantsWorkspaceRoot =
    options.mode === "workspace" ||
    wantsFanOut ||
    (options.mode === undefined && workspaceProtocolDeps.length > 0);
  if (wantsWorkspaceRoot) {
    monorepoRoot = await findMonorepoRoot(options.appDir);
    if (monorepoRoot) {
      appRelativePath = path.relative(monorepoRoot, path.resolve(options.appDir));
    }
  }
  if (options.mode === "workspace" && !monorepoRoot) {
    throw new Error(
      `--mode workspace requested, but no workspaces root (package.json "workspaces" or ` +
        `pnpm-workspace.yaml) could be found anywhere above ${options.appDir}.`,
    );
  }
  if (wantsFanOut && !monorepoRoot) {
    throw new Error(
      `Fan-out (multiple --app targets, or --fan-out) requires a discoverable workspaces root ` +
        `(package.json "workspaces" or pnpm-workspace.yaml) above ${options.appDir}, but none ` +
        `was found — consumers are sibling packages, so they must physically exist alongside ` +
        `--app in the sandbox.`,
    );
  }
  const sandboxMode: "hermetic" | "workspace" = monorepoRoot ? "workspace" : "hermetic";

  const consumerTargets: ResolvedConsumerTarget[] = [];
  if (wantsFanOut && monorepoRoot) {
    const consumers: ConsumerTarget[] =
      options.consumerApps && options.consumerApps.length > 0
        ? options.consumerApps.map((d) => ({
            absoluteDir: path.resolve(d),
            relativeDir: path.relative(monorepoRoot!, path.resolve(d)),
          }))
        : await resolveFanOutConsumers(pkgName, monorepoRoot, options.appDir, options.fanOutTop ?? 5);

    for (const consumer of consumers) {
      await assertConsumerWithinMonorepo(monorepoRoot, consumer.absoluteDir);
      const consumerPackageJson = await readJsonFile<PackageJson>(
        path.join(consumer.absoluteDir, "package.json"),
      );
      if (!consumerPackageJson) {
        throw new Error(`No package.json found in consumer directory: ${consumer.absoluteDir}`);
      }
      // Unlike the primary, a consumer doesn't have to declare pkgName (or
      // every --group member) itself — the wrapper pattern this fan-out
      // widening exists to reach is exactly the case where it doesn't. Pin
      // whichever of pkgName/group members it actually declares (possibly
      // none): a consumer with nothing to pin just gets copied into the
      // sandbox and tested as-is, seeing whatever version the primary's own
      // pin resolves to through the workspace link — but a consumer that
      // DOES declare pkgName itself must still get that pin, even if it's
      // missing an unrelated --group member.
      const consumerPinTargets = resolveAvailablePinTargets(
        pkgName,
        options.group,
        consumerPackageJson,
      );
      consumerTargets.push({
        relativePath: consumer.relativeDir,
        pinTargets: consumerPinTargets,
        absoluteDir: consumer.absoluteDir,
      });
    }
  }

  const packageManagerInfo = options.packageManager
    ? parsePackageManagerOverride(options.packageManager)
    : await detectPackageManager(options.appDir);
  return {
    pinTargets,
    packageManagerInfo,
    workspaceProtocolDeps,
    monorepoRoot,
    appRelativePath,
    sandboxMode,
    consumerTargets,
  };
}

const JEST_CONFIG_CANDIDATES = [
  "jest.config.js",
  "jest.config.cjs",
  "jest.config.mjs",
  "jest.config.ts",
  "jest.config.json",
];

async function readJestConfigSources(appDir: string): Promise<string[]> {
  const sources: string[] = [];
  for (const name of JEST_CONFIG_CANDIDATES) {
    const configPath = path.join(appDir, name);
    if (await fileExists(configPath)) {
      sources.push(await fs.readFile(configPath, "utf-8"));
    }
  }
  const pkgJsonPath = path.join(appDir, "package.json");
  if (await fileExists(pkgJsonPath)) {
    sources.push(await fs.readFile(pkgJsonPath, "utf-8"));
  }
  return sources;
}

// Resolves what "the test command" actually is for harness-analysis
// purposes at `dir`: with --test-script, that's each target's OWN
// package.json script body (e.g. "jest --coverage"), not the literal
// "<manager> run <script>" invocation — the latter never contains the word
// "jest" even when the script it runs does, which would otherwise make
// every TRANSPILE_ONLY/TYPE_CHECK_ONLY/PASS_WITH_NO_TESTS/ESM-mismatch
// check silently no-op for the --test-script path (the recommended way to
// run fan-out, where this would matter most). Falls back to the literal
// invocation if the script name isn't found in package.json (e.g. defined
// some other way) rather than analyzing nothing.
async function resolveHarnessCommand(
  dir: string,
  options: CompatOptions,
  packageManagerInfo: PackageManagerInfo,
): Promise<string> {
  if (!options.testScript) return options.testCommand ?? "";
  const packageJson = await readJsonFile<PackageJson & { scripts?: Record<string, string> }>(
    path.join(dir, "package.json"),
  );
  return packageJson?.scripts?.[options.testScript] ?? `${packageManagerInfo.manager} run ${options.testScript}`;
}

/**
 * analyzeTestHarness against every target's own effective command (primary
 * --app, plus each fan-out consumer when --test-script is set — each may
 * define a different script), merged by caveat code so a gap found in any
 * one target's harness is still surfaced once. Report-level
 * testCommandCaveats is necessarily a single merged list, not attributed
 * per-target; consumers[].output on a FAILED run still names which target
 * actually failed if that's what's needed next.
 */
async function analyzeTestHarnessAcrossTargets(
  options: CompatOptions,
  packageManagerInfo: PackageManagerInfo,
  consumerTargets: ResolvedConsumerTarget[],
): Promise<TestHarnessCaveat[]> {
  const merged = new Map<string, TestHarnessCaveat>();
  const primaryCommand = await resolveHarnessCommand(options.appDir, options, packageManagerInfo);
  for (const caveat of await analyzeTestHarness(options.appDir, primaryCommand)) {
    merged.set(caveat.code, caveat);
  }
  // Every consumer gets analyzed, --test-script or not: with a shared
  // --test command (no --test-script), testOneVersion still runs that same
  // command from each consumer's OWN directory, which reads that
  // consumer's OWN jest config — a consumer using isolatedModules/
  // babel-jest/passWithNoTests would otherwise never surface here just
  // because the command string itself is shared. resolveHarnessCommand
  // already falls back to the shared testCommand when testScript is unset.
  for (const consumer of consumerTargets) {
    const consumerCommand = await resolveHarnessCommand(consumer.absoluteDir, options, packageManagerInfo);
    for (const caveat of await analyzeTestHarness(consumer.absoluteDir, consumerCommand)) {
      if (!merged.has(caveat.code)) merged.set(caveat.code, caveat);
    }
  }
  return [...merged.values()];
}

/**
 * PASSED/FAILED from compat is only as trustworthy as the --test command
 * itself. This is a best-effort heuristic over the app's test command and
 * jest config — false negatives are expected and fine; it only needs to
 * catch the common cases well enough to warn:
 *
 * - TRANSPILE_ONLY: a transpile-only jest setup (ts-jest isolatedModules,
 *   babel-jest, @swc/jest with no separate type-check step) never actually
 *   reads the dependency's .d.ts, so a version with a genuinely broken type
 *   surface can still "pass".
 * - TYPE_CHECK_ONLY: the exact mirror — a bare `tsc --noEmit` and nothing
 *   else can see a broken type surface, but nothing runtime-only (an
 *   ESM-only bump, a duplicate-copy regression, a behavior change).
 * - PASS_WITH_NO_TESTS: jest's --passWithNoTests makes a suite that matches
 *   zero test files exit 0 — PASSED then asserts nothing at all.
 */
export async function analyzeTestHarness(
  appDir: string,
  testCommand: string,
): Promise<TestHarnessCaveat[]> {
  const caveats: TestHarnessCaveat[] = [];
  const isJest = /\bjest\b/i.test(testCommand);

  if (isJest) {
    const combined = (await readJestConfigSources(appDir)).join("\n");
    if (/isolatedModules["']?\s*:\s*true/.test(combined)) {
      caveats.push({
        code: "TRANSPILE_ONLY",
        severity: "warning",
        message:
          "jest config uses ts-jest with isolatedModules:true — this transpiles TypeScript without type-checking it, so a version with a broken type surface can still pass",
      });
    } else if (/@swc\/jest|babel-jest/.test(combined)) {
      caveats.push({
        code: "TRANSPILE_ONLY",
        severity: "warning",
        message:
          "jest config transforms TypeScript via @swc/jest or babel-jest — these transpile without type-checking, so a version with a broken type surface can still pass",
      });
    }
    if (/--passWithNoTests\b/.test(testCommand) || /passWithNoTests["']?\s*:\s*true/.test(combined)) {
      caveats.push({
        code: "PASS_WITH_NO_TESTS",
        severity: "warning",
        message:
          "--passWithNoTests is set — a run that matches zero test files still exits 0, so PASSED here may mean the suite never actually ran against this version",
      });
    }
  }

  // Only a bare `tsc`/`tsc --noEmit` counts — a command that pipes into or
  // chains after a real runner (`tsc --noEmit && jest`, `npm test`) isn't
  // type-check-only, and testCommand is a whole shell command, not just
  // the binary name, so this must anchor rather than substring-match.
  if (/^\s*(npx\s+)?tsc(\s+--\S+)*\s*$/i.test(testCommand.trim())) {
    caveats.push({
      code: "TYPE_CHECK_ONLY",
      severity: "warning",
      message:
        "--test only runs tsc — this can see a broken type surface but nothing runtime-only (an ESM-only bump, a duplicate-copy regression, an actual behavior change); include your real test suite for ground-truth coverage",
    });
  }

  return caveats;
}

/**
 * True when the app's own test command is a jest run that will choke on an
 * ESM-only dependency: not itself "type":"module" (an ESM package can import
 * another ESM package fine) and no evidence the app customized jest's
 * default transformIgnorePatterns (['/node_modules/']), which otherwise
 * leaves every package under node_modules untransformed. Best-effort by
 * design — a custom transformIgnorePatterns override that still blocks this
 * particular package is a false negative this can't see, and that's fine.
 */
async function isConsumerCjsBlindToEsm(appDir: string, testCommand: string): Promise<boolean> {
  if (!/\bjest\b/i.test(testCommand)) return false;

  const appPackageJson = await readJsonFile<PackageJson>(path.join(appDir, "package.json"));
  if ((appPackageJson as { type?: string } | null)?.type === "module") return false;

  const combined = (await readJestConfigSources(appDir)).join("\n");
  return !/transformIgnorePatterns/.test(combined);
}

/**
 * Per-candidate ESM-only advisory: fires only when the app's test harness is
 * CJS-blind to jest's default node_modules transform-skip AND this specific
 * candidate looks ESM-only relative to the control. Unlike
 * analyzeTestHarness's caveats, this can't be computed once up front — a
 * package can go ESM-only in exactly one candidate version, not the whole
 * tested range.
 */
async function detectEsmMismatch(
  consumerIsCjsBlind: boolean,
  controlInfo: PackageInfo | null,
  candidateInfo: PackageInfo | null,
): Promise<string | undefined> {
  if (!consumerIsCjsBlind || !controlInfo || !candidateInfo) return undefined;
  return esmOnlyAdvisory(controlInfo, candidateInfo);
}

// The version currently resolved in appDir's node_modules — null when it
// isn't installed there at all (never installed, or hoisted somewhere
// compat's own node_modules walk-up can't see from this exact directory).
async function resolveControlVersion(
  pkgName: string,
  appDir: string,
): Promise<string | null> {
  const dir = await resolveInstalledPackage(pkgName, appDir);
  if (!dir) return null;
  return getInstalledVersion(dir);
}

// Ensures the control (installed) version gets tested exactly once even
// when it isn't among the requested candidates — reusing an already-tested
// result when it happens to coincide with one, rather than paying for a
// redundant sandbox run.
async function resolveControlResult(
  pkgName: string,
  options: CompatOptions,
  packageManagerInfo: PackageManagerInfo,
  pinTargets: PinTarget[],
  snapshotDir: string,
  workspaceProtocolDeps: string[],
  monorepoRoot: string | null,
  appRelativePath: string,
  alreadyTested: CompatVersionResult[],
  esmCheck: EsmCheckContext,
  consumerTargets: ResolvedConsumerTarget[],
): Promise<CompatVersionResult | null> {
  const controlVersion = await resolveControlVersion(pkgName, options.appDir);
  if (!controlVersion) return null;

  const existing = alreadyTested.find((v) => v.version === controlVersion);
  if (existing) return existing;

  return testOneVersion(
    pkgName,
    controlVersion,
    options,
    packageManagerInfo,
    pinTargets,
    snapshotDir,
    workspaceProtocolDeps,
    monorepoRoot,
    appRelativePath,
    esmCheck,
    consumerTargets,
  );
}

// Resolves once per run: whether the app's own test command is CJS-blind to
// an ESM-only jest transform gap, and — only if so — the control's package.json,
// since detectEsmMismatch needs both to say anything.
async function resolveEsmCheckContext(
  pkgName: string,
  options: CompatOptions,
  packageManagerInfo: PackageManagerInfo,
): Promise<EsmCheckContext> {
  const primaryCommand = await resolveHarnessCommand(options.appDir, options, packageManagerInfo);
  const consumerIsCjsBlind = await isConsumerCjsBlindToEsm(options.appDir, primaryCommand);
  if (!consumerIsCjsBlind) return { consumerIsCjsBlind: false, controlInfo: null };

  const controlDir = await resolveInstalledPackage(pkgName, options.appDir);
  const controlInfo = controlDir
    ? await readJsonFile<PackageInfo>(path.join(controlDir, "package.json"))
    : null;
  return { consumerIsCjsBlind: true, controlInfo };
}

// Mutates `versions` in place: for each one with dupeCounts, compares each
// package's copy count against the control's count for that same package
// (only packages the control itself also checked — a package newly declared
// by a candidate isn't a "regression" of anything). A version whose copy
// count went up gets dupesRegression populated and, if it otherwise PASSED,
// is escalated to FAILED — the test suite passing is exactly what makes this
// class of bug dangerous: it's invisible until it isn't.
function applyDupesRegressions(
  versions: CompatVersionResult[],
  control: CompatVersionResult | null,
): void {
  if (!control?.dupeCounts) return;
  for (const v of versions) {
    if (v === control || !v.dupeCounts) continue;
    const regressions: DupesRegressionEntry[] = [];
    for (const [name, controlCopies] of Object.entries(control.dupeCounts)) {
      const candidateCopies = v.dupeCounts[name];
      if (candidateCopies !== undefined && candidateCopies > controlCopies) {
        regressions.push({ package: name, controlCopies, candidateCopies });
      }
    }
    if (regressions.length > 0) {
      v.dupesRegression = regressions;
      if (v.status === "PASSED") v.status = "FAILED";
    }
  }
}

// The actual sandbox source root matches testOneVersion's own choice
// (monorepoRoot when set, appDir otherwise) — --seed-lockfile only does
// anything if that root really has the detected/overridden manager's
// lockfile; a manager override naming a manager whose lockfile isn't
// actually present there means createSandbox silently copies nothing, and
// the report must say so rather than claiming a seed that didn't happen.
async function resolveSeededLockfile(
  options: CompatOptions,
  packageManagerInfo: PackageManagerInfo,
  monorepoRoot: string | null,
): Promise<boolean> {
  if (!options.seedLockfile) return false;
  const sourceRoot = monorepoRoot ?? options.appDir;
  return fileExists(path.join(sourceRoot, packageManagerInfo.lockFile));
}

function computeLockfileSeedNote(options: CompatOptions, seededLockfile: boolean): string | null {
  if (options.seedLockfile && !seededLockfile) {
    return (
      "--seed-lockfile was requested, but no lockfile for the detected/overridden package " +
      "manager was found at the sandbox source root — nothing was actually seeded, every " +
      "sandbox got a fresh solve as if the flag were off."
    );
  }
  if (seededLockfile) {
    return (
      "--seed-lockfile is on: every sandbox started from the app's own lockfile, so the " +
      "install is less hermetic than a fresh solve — a resolution a clean install would have " +
      "surfaced can stay masked if the seeded lockfile is already stale."
    );
  }
  if (options.checkDupes) {
    return (
      "--check-dupes is on without --seed-lockfile: a fresh solve re-flattens the dependency " +
      "tree, which can hide exactly the nested-fork duplicate class --check-dupes was built to " +
      "catch. Add --seed-lockfile to reproduce the real repo's resolution stickiness."
    );
  }
  return null;
}

export async function runCompat(
  pkgName: string,
  options: CompatOptions,
): Promise<CompatReport> {
  registerCompatSignalHandling();

  const candidateVersions = await resolveCandidateVersions(pkgName, options);
  const {
    pinTargets,
    packageManagerInfo,
    workspaceProtocolDeps,
    monorepoRoot,
    appRelativePath,
    sandboxMode,
    consumerTargets,
  } = await resolveRunContext(pkgName, options);
  const snapshotDir = await resolveSnapshotDir(options.snapshotDir);
  const concurrency = options.concurrency ?? 1;
  const testCommandCaveats = await analyzeTestHarnessAcrossTargets(options, packageManagerInfo, consumerTargets);
  const esmCheck = await resolveEsmCheckContext(pkgName, options, packageManagerInfo);

  const versions = await runWithConcurrencyLimit(
    candidateVersions,
    concurrency,
    (version) =>
      testOneVersion(
        pkgName,
        version,
        options,
        packageManagerInfo,
        pinTargets,
        snapshotDir,
        workspaceProtocolDeps,
        monorepoRoot,
        appRelativePath,
        esmCheck,
        consumerTargets,
      ),
  );

  const control = await resolveControlResult(
    pkgName,
    options,
    packageManagerInfo,
    pinTargets,
    snapshotDir,
    workspaceProtocolDeps,
    monorepoRoot,
    appRelativePath,
    versions,
    esmCheck,
    consumerTargets,
  );
  if (options.checkDupes) applyDupesRegressions(versions, control);
  const controlFailed = control !== null && control.status !== "PASSED";

  const passedVersions = versions
    .filter((v) => v.status === "PASSED")
    .map((v) => v.version);

  const seededLockfile = await resolveSeededLockfile(options, packageManagerInfo, monorepoRoot);

  return {
    package: pkgName,
    // A control that can't even confirm the version already running in
    // production means the harness itself is broken — recommending a
    // candidate off it would be asserting more than the run actually showed.
    minimumCompatibleVersion: controlFailed ? null : (passedVersions[0] ?? null),
    recommendedVersion: controlFailed
      ? null
      : (passedVersions[passedVersions.length - 1] ?? null),
    nonMonotonic: computeNonMonotonic(versions),
    versions,
    group: options.group,
    snapshotDir,
    concurrency,
    testCommandCaveat: testCommandCaveats[0]?.message ?? null,
    testCommandCaveats,
    control,
    controlFailed,
    sandboxMode,
    packageManager: formatPackageManager(packageManagerInfo),
    seededLockfile,
    lockfileSeedNote: computeLockfileSeedNote(options, seededLockfile),
    fanOutConsumers: consumerTargets.map((c) => c.relativePath),
  };
}

export interface CompatBisectReport extends CompatReport {
  bisected: true;
  testedVersionCount: number;
  totalVersionCount: number;
  fellBackToLinearScan: boolean;
}

function finishBisect(
  pkgName: string,
  candidateVersions: string[],
  tested: CompatVersionResult[],
  minimumCompatibleVersion: string | null,
  recommendedVersion: string | null,
  fellBackToLinearScan: boolean,
  snapshotDir: string,
  testCommandCaveats: TestHarnessCaveat[],
  group: string[] | undefined,
  control: CompatVersionResult | null,
  sandboxMode: "hermetic" | "workspace",
  packageManagerInfo: PackageManagerInfo,
  seededLockfile: boolean,
  lockfileSeedNote: string | null,
  fanOutConsumers: string[],
): CompatBisectReport {
  const controlFailed = control !== null && control.status !== "PASSED";
  return {
    package: pkgName,
    minimumCompatibleVersion: controlFailed ? null : minimumCompatibleVersion,
    recommendedVersion: controlFailed ? null : recommendedVersion,
    nonMonotonic: false,
    versions: tested,
    bisected: true,
    testedVersionCount: tested.length,
    totalVersionCount: candidateVersions.length,
    fellBackToLinearScan,
    group,
    snapshotDir,
    concurrency: 1,
    testCommandCaveat: testCommandCaveats[0]?.message ?? null,
    testCommandCaveats,
    control,
    controlFailed,
    sandboxMode,
    packageManager: formatPackageManager(packageManagerInfo),
    seededLockfile,
    lockfileSeedNote,
    fanOutConsumers,
  };
}

/**
 * Binary-search for the pass/fail boundary instead of testing every
 * candidate version. Assumes the pattern is monotonic (fails below some
 * version, passes from it onward) — after converging, re-runs the boundary
 * version once to catch flakiness/non-monotonicity, falling back to a full
 * linear scan (runCompat) rather than trusting a possibly-wrong fast answer.
 */
export async function runCompatBisect(
  pkgName: string,
  options: CompatOptions,
): Promise<CompatBisectReport> {
  registerCompatSignalHandling();

  if (options.checkDupes) {
    // Bisect's pass/fail boundary is committed to as soon as a version's
    // *test command* passes — a dupes-regression escalation discovered only
    // afterward can't be applied without invalidating the search that
    // already ran (a version bisect skipped over, on the strength of the
    // boundary passing, might itself have been the one with the regression).
    // Reject the combination rather than silently ignore --check-dupes or
    // report a boundary that was computed without it.
    throw new Error(
      "--bisect and --check-dupes cannot be combined: bisect's boundary is decided from the " +
        "test command's pass/fail alone, before a dupes-regression check on the boundary " +
        "version could change that verdict. Use a linear scan (drop --bisect) to combine " +
        "with --check-dupes.",
    );
  }

  const candidateVersions = await resolveCandidateVersions(pkgName, options);
  const snapshotDir = await resolveSnapshotDir(options.snapshotDir);
  const {
    pinTargets,
    packageManagerInfo,
    workspaceProtocolDeps,
    monorepoRoot,
    appRelativePath,
    sandboxMode,
    consumerTargets,
  } = await resolveRunContext(pkgName, options);
  const testCommandCaveats = await analyzeTestHarnessAcrossTargets(options, packageManagerInfo, consumerTargets);
  const esmCheck = await resolveEsmCheckContext(pkgName, options, packageManagerInfo);

  const seededLockfile = await resolveSeededLockfile(options, packageManagerInfo, monorepoRoot);

  const tested: CompatVersionResult[] = [];
  const finish = async (
    minimumCompatibleVersion: string | null,
    recommendedVersion: string | null,
  ): Promise<CompatBisectReport> => {
    const control = await resolveControlResult(
      pkgName,
      options,
      packageManagerInfo,
      pinTargets,
      snapshotDir,
      workspaceProtocolDeps,
      monorepoRoot,
      appRelativePath,
      tested,
      esmCheck,
      consumerTargets,
    );
    return finishBisect(
      pkgName,
      candidateVersions,
      tested,
      minimumCompatibleVersion,
      recommendedVersion,
      false,
      snapshotDir,
      testCommandCaveats,
      options.group,
      control,
      sandboxMode,
      packageManagerInfo,
      seededLockfile,
      computeLockfileSeedNote(options, seededLockfile),
      consumerTargets.map((c) => c.relativePath),
    );
  };

  if (candidateVersions.length === 0) {
    return finish(null, null);
  }

  const testAt = (index: number) =>
    testOneVersion(
      pkgName,
      candidateVersions[index]!,
      options,
      packageManagerInfo,
      pinTargets,
      snapshotDir,
      workspaceProtocolDeps,
      monorepoRoot,
      appRelativePath,
      esmCheck,
      consumerTargets,
    );

  const topIndex = candidateVersions.length - 1;
  const topVersion = candidateVersions[topIndex]!;

  const topResult = await testAt(topIndex);
  tested.push(topResult);
  if (topResult.status !== "PASSED") {
    // Nothing in range is presumed compatible under the monotonic
    // assumption — bisect makes no claim beyond the top version.
    return finish(null, null);
  }

  if (candidateVersions.length === 1) {
    return finish(topVersion, topVersion);
  }

  const bottomResult = await testAt(0);
  tested.push(bottomResult);
  if (bottomResult.status === "PASSED") {
    return finish(candidateVersions[0]!, topVersion);
  }

  let lo = 0;
  let hi = topIndex;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    const midResult = await testAt(mid);
    tested.push(midResult);
    if (midResult.status === "PASSED") {
      hi = mid;
    } else {
      lo = mid;
    }
  }

  const boundaryVersion = candidateVersions[hi]!;
  const confirmResult = await testAt(hi);
  tested.push(confirmResult);

  if (confirmResult.status !== "PASSED") {
    // The monotonic assumption broke (flaky test or a real non-monotonic
    // pattern) — fall back to a full linear scan for a trustworthy answer.
    // Reuse the same resolved snapshotDir (not options.snapshotDir, which
    // may be undefined) so pre-fallback and fallback snapshots land in one
    // consistent directory instead of two.
    const fullReport = await runCompat(pkgName, { ...options, snapshotDir });
    return {
      ...fullReport,
      bisected: true,
      testedVersionCount: candidateVersions.length,
      totalVersionCount: candidateVersions.length,
      fellBackToLinearScan: true,
    };
  }

  return finish(boundaryVersion, topVersion);
}

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
import { fileExists, readJsonFile, writeJsonFile } from "./utils";
import {
  detectPackageManager,
  type PackageJson,
  type PackageManagerInfo,
} from "./packageManager";
import { fetchPackageMetadata, listVersionsInRange } from "./registry";

export type CompatStatus = "PASSED" | "FAILED" | "INSTALL_FAILED" | "SKIPPED";

export interface CompatVersionResult {
  version: string;
  status: CompatStatus;
  exitCode: number | null;
  durationMs: number;
  output?: string | undefined;
  lockfileHash: string | null;
  lockfileSnapshotPath: string | null;
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
}

export interface CompatOptions {
  range?: string | undefined;
  versions?: string[] | undefined;
  appDir: string;
  testCommand: string;
  registryUrl: string;
  token?: string | undefined;
  includePrerelease?: boolean | undefined;
  includeDeprecated?: boolean | undefined;
  group?: string[] | undefined;
  snapshotDir?: string | undefined;
  concurrency?: number | undefined;
  preferOffline?: boolean | undefined;
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
): Promise<string> {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), SANDBOX_PREFIX));
  activeSandboxDirs.add(sandboxDir);

  await fs.cp(sourceDir, sandboxDir, {
    recursive: true,
    filter: (source: string) => !EXCLUDED_COPY_NAMES.has(path.basename(source)),
  });

  const packageJsonPath = path.join(sandboxDir, appRelativePath, "package.json");
  const packageJson = await readJsonFile<PackageJson>(packageJsonPath);
  if (!packageJson) {
    throw new Error(
      `No package.json found in sandboxed copy of ${path.join(sourceDir, appRelativePath)}`,
    );
  }

  for (const { name, section } of pinTargets) {
    packageJson[section] = {
      ...((packageJson[section] as Record<string, string> | undefined) ?? {}),
      [name]: version,
    };
  }
  await writeJsonFile(packageJsonPath, packageJson);

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
    sandboxDir = await createSandbox(sourceDir, version, pinTargets, testCwdRelative);

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

    const testCwd = path.join(sandboxDir, testCwdRelative);
    const testResult = await runTestCommand(testCwd, options.testCommand);
    return {
      version,
      status: testResult.success ? "PASSED" : "FAILED",
      exitCode: testResult.exitCode,
      durationMs: Date.now() - startedAt,
      output: testResult.success ? undefined : testResult.output,
      lockfileHash: snapshot.hash,
      lockfileSnapshotPath: snapshot.path,
    };
  } finally {
    if (sandboxDir) await cleanupSandbox(sandboxDir);
  }
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
}> {
  const appPackageJsonPath = path.join(options.appDir, "package.json");
  const appPackageJson = await readJsonFile<PackageJson>(appPackageJsonPath);
  if (!appPackageJson) {
    throw new Error(`No package.json found in app directory: ${options.appDir}`);
  }

  const pinTargets = resolvePinTargets(pkgName, options.group, appPackageJson);
  const workspaceProtocolDeps = findWorkspaceProtocolDeps(appPackageJson);

  let monorepoRoot: string | null = null;
  let appRelativePath = "";
  if (workspaceProtocolDeps.length > 0) {
    monorepoRoot = await findMonorepoRoot(options.appDir);
    if (monorepoRoot) {
      appRelativePath = path.relative(monorepoRoot, path.resolve(options.appDir));
    }
  }

  const packageManagerInfo = await detectPackageManager(options.appDir);
  return { pinTargets, packageManagerInfo, workspaceProtocolDeps, monorepoRoot, appRelativePath };
}

/**
 * Run `worker` over `items` with at most `limit` calls in flight at once.
 * Results are written back by index, so the returned order always matches
 * `items`' order regardless of which call finished first — every command's
 * report stays deterministically ordered whether or not concurrency is on.
 */
async function runWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function runLane(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index]!);
    }
  }

  const laneCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: laneCount }, () => runLane()));
  return results;
}

export async function runCompat(
  pkgName: string,
  options: CompatOptions,
): Promise<CompatReport> {
  registerCompatSignalHandling();

  const candidateVersions = await resolveCandidateVersions(pkgName, options);
  const { pinTargets, packageManagerInfo, workspaceProtocolDeps, monorepoRoot, appRelativePath } =
    await resolveRunContext(pkgName, options);
  const snapshotDir = await resolveSnapshotDir(options.snapshotDir);
  const concurrency = options.concurrency ?? 1;

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
      ),
  );

  const passedVersions = versions
    .filter((v) => v.status === "PASSED")
    .map((v) => v.version);

  return {
    package: pkgName,
    minimumCompatibleVersion: passedVersions[0] ?? null,
    recommendedVersion: passedVersions[passedVersions.length - 1] ?? null,
    nonMonotonic: computeNonMonotonic(versions),
    versions,
    group: options.group,
    snapshotDir,
    concurrency,
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
  group?: string[] | undefined,
): CompatBisectReport {
  return {
    package: pkgName,
    minimumCompatibleVersion,
    recommendedVersion,
    nonMonotonic: false,
    versions: tested,
    bisected: true,
    testedVersionCount: tested.length,
    totalVersionCount: candidateVersions.length,
    fellBackToLinearScan,
    group,
    snapshotDir,
    concurrency: 1,
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

  const candidateVersions = await resolveCandidateVersions(pkgName, options);
  const snapshotDir = await resolveSnapshotDir(options.snapshotDir);
  if (candidateVersions.length === 0) {
    return finishBisect(pkgName, candidateVersions, [], null, null, false, snapshotDir, options.group);
  }

  const { pinTargets, packageManagerInfo, workspaceProtocolDeps, monorepoRoot, appRelativePath } =
    await resolveRunContext(pkgName, options);
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
    );

  const tested: CompatVersionResult[] = [];
  const topIndex = candidateVersions.length - 1;
  const topVersion = candidateVersions[topIndex]!;

  const topResult = await testAt(topIndex);
  tested.push(topResult);
  if (topResult.status !== "PASSED") {
    // Nothing in range is presumed compatible under the monotonic
    // assumption — bisect makes no claim beyond the top version.
    return finishBisect(pkgName, candidateVersions, tested, null, null, false, snapshotDir, options.group);
  }

  if (candidateVersions.length === 1) {
    return finishBisect(
      pkgName,
      candidateVersions,
      tested,
      topVersion,
      topVersion,
      false,
      snapshotDir,
      options.group,
    );
  }

  const bottomResult = await testAt(0);
  tested.push(bottomResult);
  if (bottomResult.status === "PASSED") {
    return finishBisect(
      pkgName,
      candidateVersions,
      tested,
      candidateVersions[0]!,
      topVersion,
      false,
      snapshotDir,
      options.group,
    );
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

  return finishBisect(
    pkgName,
    candidateVersions,
    tested,
    boundaryVersion,
    topVersion,
    false,
    snapshotDir,
    options.group,
  );
}

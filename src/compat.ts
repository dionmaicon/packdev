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
import * as semver from "semver";
import { readJsonFile, writeJsonFile } from "./utils";
import {
  detectPackageManager,
  type PackageJson,
  type PackageManagerInfo,
} from "./packageManager";
import { fetchPackageMetadata, listVersionsInRange } from "./registry";

export type CompatStatus = "PASSED" | "FAILED" | "INSTALL_FAILED";

export interface CompatVersionResult {
  version: string;
  status: CompatStatus;
  exitCode: number | null;
  durationMs: number;
  output?: string | undefined;
}

export interface CompatReport {
  package: string;
  minimumCompatibleVersion: string | null;
  recommendedVersion: string | null;
  nonMonotonic: boolean;
  versions: CompatVersionResult[];
  group?: string[] | undefined;
}

export interface CompatOptions {
  range?: string | undefined;
  versions?: string[] | undefined;
  appDir: string;
  testCommand: string;
  registryUrl: string;
  includePrerelease?: boolean | undefined;
  includeDeprecated?: boolean | undefined;
  group?: string[] | undefined;
}

export type DependencySection =
  | "dependencies"
  | "devDependencies"
  | "peerDependencies";

export async function resolveCandidateVersions(
  pkgName: string,
  options: Pick<
    CompatOptions,
    "range" | "versions" | "registryUrl" | "includePrerelease" | "includeDeprecated"
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

  const metadata = await fetchPackageMetadata(pkgName, options.registryUrl);
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

// Tracks the one in-flight sandbox so a signal handler can clean it up.
// compat runs versions sequentially, so there's never more than one at a time.
let activeSandboxDir: string | null = null;

/**
 * Copy `appDir` into a fresh temp directory (excluding node_modules, .git,
 * lockfiles, dist/build) and pin every target in `pinTargets` to `version`
 * in its own section — a lockstep group all moves to the same version in
 * one sandboxed run. Deliberately not copying the lockfile: each sandbox
 * gets a fully independent install, which is what actually prevents
 * workspace-hoisting cross-contamination between version runs.
 */
export async function createSandbox(
  appDir: string,
  version: string,
  pinTargets: PinTarget[],
): Promise<string> {
  const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), SANDBOX_PREFIX));
  activeSandboxDir = sandboxDir;

  await fs.cp(appDir, sandboxDir, {
    recursive: true,
    filter: (source: string) => !EXCLUDED_COPY_NAMES.has(path.basename(source)),
  });

  const packageJsonPath = path.join(sandboxDir, "package.json");
  const packageJson = await readJsonFile<PackageJson>(packageJsonPath);
  if (!packageJson) {
    throw new Error(`No package.json found in sandboxed copy of ${appDir}`);
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
  if (activeSandboxDir === sandboxDir) activeSandboxDir = null;
}

let signalHandlersRegistered = false;

/** Best-effort sandbox cleanup on Ctrl+C / termination — never leaves a
 * half-installed sandbox directory behind. */
export function registerCompatSignalHandling(): void {
  if (signalHandlersRegistered) return;
  signalHandlersRegistered = true;

  const cleanupAndExit = (signal: NodeJS.Signals) => {
    if (activeSandboxDir) {
      try {
        rmSync(activeSandboxDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
      activeSandboxDir = null;
    }
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
): Promise<RunResult> {
  const args = ["install", ...(registryUrl ? ["--registry", registryUrl] : [])];
  return runCommand(manager, args, sandboxDir);
}

export function runTestCommand(
  sandboxDir: string,
  testCommand: string,
): Promise<RunResult> {
  return runCommand(testCommand, [], sandboxDir);
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
  version: string,
  options: CompatOptions,
  packageManagerInfo: PackageManagerInfo,
  pinTargets: PinTarget[],
): Promise<CompatVersionResult> {
  const startedAt = Date.now();
  let sandboxDir: string | null = null;
  try {
    sandboxDir = await createSandbox(options.appDir, version, pinTargets);

    const installResult = await runInstall(
      sandboxDir,
      packageManagerInfo.manager,
      options.registryUrl,
    );
    if (!installResult.success) {
      return {
        version,
        status: "INSTALL_FAILED",
        exitCode: installResult.exitCode,
        durationMs: Date.now() - startedAt,
        output: installResult.output,
      };
    }

    const testResult = await runTestCommand(sandboxDir, options.testCommand);
    return {
      version,
      status: testResult.success ? "PASSED" : "FAILED",
      exitCode: testResult.exitCode,
      durationMs: Date.now() - startedAt,
      output: testResult.success ? undefined : testResult.output,
    };
  } finally {
    if (sandboxDir) await cleanupSandbox(sandboxDir);
  }
}

async function resolveRunContext(
  pkgName: string,
  options: CompatOptions,
): Promise<{ pinTargets: PinTarget[]; packageManagerInfo: PackageManagerInfo }> {
  const appPackageJsonPath = path.join(options.appDir, "package.json");
  const appPackageJson = await readJsonFile<PackageJson>(appPackageJsonPath);
  if (!appPackageJson) {
    throw new Error(`No package.json found in app directory: ${options.appDir}`);
  }

  const pinTargets = resolvePinTargets(pkgName, options.group, appPackageJson);

  const packageManagerInfo = await detectPackageManager(options.appDir);
  return { pinTargets, packageManagerInfo };
}

export async function runCompat(
  pkgName: string,
  options: CompatOptions,
): Promise<CompatReport> {
  registerCompatSignalHandling();

  const candidateVersions = await resolveCandidateVersions(pkgName, options);
  const { pinTargets, packageManagerInfo } = await resolveRunContext(pkgName, options);

  const versions: CompatVersionResult[] = [];
  for (const version of candidateVersions) {
    versions.push(
      await testOneVersion(version, options, packageManagerInfo, pinTargets),
    );
  }

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
  if (candidateVersions.length === 0) {
    return finishBisect(pkgName, candidateVersions, [], null, null, false, options.group);
  }

  const { pinTargets, packageManagerInfo } = await resolveRunContext(pkgName, options);
  const testAt = (index: number) =>
    testOneVersion(
      candidateVersions[index]!,
      options,
      packageManagerInfo,
      pinTargets,
    );

  const tested: CompatVersionResult[] = [];
  const topIndex = candidateVersions.length - 1;
  const topVersion = candidateVersions[topIndex]!;

  const topResult = await testAt(topIndex);
  tested.push(topResult);
  if (topResult.status !== "PASSED") {
    // Nothing in range is presumed compatible under the monotonic
    // assumption — bisect makes no claim beyond the top version.
    return finishBisect(pkgName, candidateVersions, tested, null, null, false, options.group);
  }

  if (candidateVersions.length === 1) {
    return finishBisect(
      pkgName,
      candidateVersions,
      tested,
      topVersion,
      topVersion,
      false,
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
    const fullReport = await runCompat(pkgName, options);
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
    options.group,
  );
}

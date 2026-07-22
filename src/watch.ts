import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { loadConfig, PackdevDependency } from "./packageManager";
import { fileExists, readJsonFile, PackageInfo } from "./utils";

const DEFAULT_IGNORE = ["node_modules", ".git", "dist", "build"];

export interface WatchTarget {
  package: string;
  dir: string;
  buildCommand?: string;
  ignore: string[];
}

export interface WatchEvent {
  event:
    | "build-start"
    | "build-success"
    | "build-failed"
    | "watching"
    | "no-targets";
  package?: string;
  message?: string;
}

interface WatchOptions {
  configPath?: string;
  once?: boolean;
  onEvent?: (event: WatchEvent) => void;
  debounceMs?: number;
  // How long after a build finishes to keep ignoring change events, so the
  // build's own writes (e.g. into dist/) don't immediately retrigger it.
  postBuildCooldownMs?: number;
}

async function resolveBuildCommand(
  dependency: PackdevDependency,
  overrides: Record<string, { build?: string; ignore?: string[] }> | undefined,
): Promise<string | undefined> {
  const override = overrides?.[dependency.package]?.["build"];
  if (override) return override;

  const pkgJson = await readJsonFile<
    PackageInfo & { scripts?: Record<string, string> }
  >(path.join(dependency.location, "package.json"));
  if (pkgJson?.scripts?.["build"]) {
    return "npm run build";
  }
  return undefined;
}

/**
 * Collect the local dependencies that `packdev watch` should track: only
 * "local" (file:) type deps with a resolvable directory and a build command
 * (either an explicit .packdev.json "watch" override, or a detected "build"
 * script in the target package.json).
 */
export async function getWatchTargets(
  configPath: string = ".packdev.json",
): Promise<WatchTarget[]> {
  const config = await loadConfig(configPath);
  if (!config) return [];

  const targets: WatchTarget[] = [];
  for (const dependency of config.dependencies) {
    if (dependency.type !== "local") continue;
    if (!(await fileExists(dependency.location))) continue;

    const buildCommand = await resolveBuildCommand(dependency, config.watch);
    const ignore = config.watch?.[dependency.package]?.ignore ?? DEFAULT_IGNORE;
    const target: WatchTarget = {
      package: dependency.package,
      dir: dependency.location,
      ignore,
    };
    if (buildCommand) target.buildCommand = buildCommand;
    targets.push(target);
  }

  return targets;
}

function isIgnoredPath(filename: string | null, ignore: string[]): boolean {
  if (!filename) return false;
  const segments = filename.split(path.sep);
  return segments.some((segment) => ignore.includes(segment));
}

function runBuild(target: WatchTarget): Promise<boolean> {
  return new Promise((resolve) => {
    if (!target.buildCommand) {
      resolve(true);
      return;
    }
    const [cmd, ...args] = target.buildCommand.split(" ");
    const child = spawn(cmd!, args, {
      cwd: target.dir,
      stdio: "ignore",
      shell: true,
    });
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

/**
 * Run `packdev watch`. In --once mode, builds every target once and
 * resolves. In live mode, watches each target's directory and rebuilds
 * (debounced) on change until SIGINT/SIGTERM.
 */
export async function runWatch(options: WatchOptions): Promise<void> {
  const {
    configPath = ".packdev.json",
    once = false,
    onEvent,
    debounceMs = 300,
    postBuildCooldownMs = 500,
  } = options;
  const emit = (event: WatchEvent) => onEvent?.(event);

  const targets = await getWatchTargets(configPath);
  if (targets.length === 0) {
    emit({
      event: "no-targets",
      message: "No local dependencies with a build step found",
    });
    return;
  }

  // Guards against the rebuild-storm footgun: a build's own output writes
  // (e.g. into dist/) can otherwise retrigger the watcher that just ran it.
  const suppressUntil = new Map<string, number>();

  const build = async (target: WatchTarget) => {
    emit({ event: "build-start", package: target.package });
    const ok = await runBuild(target);
    suppressUntil.set(target.package, Date.now() + postBuildCooldownMs);
    emit({
      event: ok ? "build-success" : "build-failed",
      package: target.package,
    });
  };

  for (const target of targets) {
    if (!target.buildCommand) continue;
    await build(target);
  }

  if (once) return;

  const watchers: fs.FSWatcher[] = [];
  const timers = new Map<string, NodeJS.Timeout>();

  const scheduleRebuild = (target: WatchTarget) => {
    if (!target.buildCommand) return;
    const suppressed = suppressUntil.get(target.package);
    if (suppressed && Date.now() < suppressed) return;

    const existing = timers.get(target.package);
    if (existing) clearTimeout(existing);
    timers.set(
      target.package,
      setTimeout(() => build(target), debounceMs),
    );
  };

  for (const target of targets) {
    if (!target.buildCommand) continue;

    const onChange = (_eventType: string, filename: string | null) => {
      if (isIgnoredPath(filename, target.ignore)) return;
      scheduleRebuild(target);
    };

    try {
      const watcher = fs.watch(target.dir, { recursive: true }, onChange);
      watchers.push(watcher);
    } catch {
      // recursive watch unsupported on this platform (e.g. some Linux setups) —
      // fall back to watching the top-level directory only.
      const watcher = fs.watch(target.dir, onChange);
      watchers.push(watcher);
    }
    emit({ event: "watching", package: target.package, message: target.dir });
  }

  await new Promise<void>((resolve) => {
    const shutdown = () => {
      watchers.forEach((w) => w.close());
      timers.forEach((t) => clearTimeout(t));
      resolve();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

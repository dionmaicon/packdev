/**
 * Find every distinct copy of a package actually resolved in the
 * dependency tree. Two copies of the same package break `instanceof`
 * checks and DI singletons (e.g. NestJS tokens are class references) —
 * invisible to types, static analysis, and even a passing test suite
 * unless it happens to exercise the exact code path affected. This is
 * true even when both copies are the *same version*: same version does
 * not mean same physical file, and Node caches modules by realpath, so
 * two distinct directories always produce two distinct class objects.
 *
 * This is a direct filesystem walk of node_modules directories, not a
 * package.json dependency-graph walk — what matters here is what Node's
 * own module resolution actually sees, not the declared dependency tree.
 *
 * In a workspaces monorepo, hoisting is partial: a workspace whose range
 * can't be satisfied by the hoisted version gets its own private nested
 * copy. Scanning only the root's node_modules misses exactly those
 * copies — the ones most likely to cause this class of bug — so by
 * default this module also discovers and scans every workspace.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { fileExists, isDirectory, readJsonFile, type PackageInfo } from "./utils";
import { resolveInstalledPackage } from "./api";

export interface DupeResolution {
  path: string;
  realpath: string;
  version: string;
  /** Relative workspace this copy was found under ("." for the scan root). */
  workspace: string;
}

export interface ParentResolution {
  path: string;
  realpath: string;
  version: string;
}

export interface DupeReport {
  resolutions: DupeResolution[];
  /** Absolute workspace directories matched by a workspaces config, whether or not scanned. */
  workspacesDetected: string[];
  /** Absolute workspace directories actually walked (subset of workspacesDetected, or all of it). */
  scannedWorkspaces: string[];
  /**
   * Set only when `resolutions` is empty: the package resolves from a
   * directory *above* the scan root (Node's normal upward node_modules
   * walk), which is a very different fact from "not a dependency here at
   * all" even though both currently produce an empty `resolutions` list.
   */
  resolvedViaParent: ParentResolution | null;
}

async function listPackageDirs(
  nodeModulesDir: string,
): Promise<{ name: string; dir: string }[]> {
  let entries;
  try {
    entries = await fs.readdir(nodeModulesDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const results: { name: string; dir: string }[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ".bin") continue;

    if (entry.name.startsWith("@")) {
      const scopeDir = path.join(nodeModulesDir, entry.name);
      let scopedEntries;
      try {
        scopedEntries = await fs.readdir(scopeDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const scoped of scopedEntries) {
        if (!scoped.isDirectory()) continue;
        results.push({
          name: `${entry.name}/${scoped.name}`,
          dir: path.join(scopeDir, scoped.name),
        });
      }
      continue;
    }

    results.push({ name: entry.name, dir: path.join(nodeModulesDir, entry.name) });
  }
  return results;
}

// Guards symlink cycles (pnpm hoists via symlinks into a shared store) by
// tracking real paths of node_modules directories already walked. Shared
// across workspace scans so a hoisted root doesn't get walked repeatedly.
async function walk(
  nodeModulesDir: string,
  pkgName: string,
  workspaceLabel: string,
  results: DupeResolution[],
  visitedRealPaths: Set<string>,
): Promise<void> {
  let realPath: string;
  try {
    realPath = await fs.realpath(nodeModulesDir);
  } catch {
    return;
  }
  if (visitedRealPaths.has(realPath)) return;
  visitedRealPaths.add(realPath);

  const packageDirs = await listPackageDirs(nodeModulesDir);
  for (const { name, dir } of packageDirs) {
    if (name === pkgName) {
      const packageInfo = await readJsonFile<PackageInfo>(
        path.join(dir, "package.json"),
      );
      if (packageInfo?.version) {
        let dirRealPath: string;
        try {
          dirRealPath = await fs.realpath(dir);
        } catch {
          dirRealPath = dir;
        }
        if (!results.some((r) => r.realpath === dirRealPath)) {
          results.push({
            path: dir,
            realpath: dirRealPath,
            version: packageInfo.version,
            workspace: workspaceLabel,
          });
        }
      }
    }
    await walk(path.join(dir, "node_modules"), pkgName, workspaceLabel, results, visitedRealPaths);
  }
}

const GLOB_SEGMENT_SPECIAL = /[.*+?^${}()|[\]\\]/g;

function globSegmentToRegExp(segment: string): RegExp {
  const escaped = segment.replace(GLOB_SEGMENT_SPECIAL, (ch) =>
    ch === "*" ? "*" : `\\${ch}`,
  );
  const pattern = escaped.replace(/\*/g, "[^/]*");
  return new RegExp(`^${pattern}$`);
}

// Bounded so a runaway "**" pattern over a huge node_modules-laden tree
// can't hang the scan; deep monorepo workspace layouts rarely exceed this.
const MAX_GLOB_DEPTH = 6;
const GLOB_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build"]);

async function collectDirsRecursive(
  baseDir: string,
  depth: number,
): Promise<string[]> {
  const results = [baseDir];
  if (depth <= 0) return results;

  let entries;
  try {
    entries = await fs.readdir(baseDir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || GLOB_SKIP_DIRS.has(entry.name)) continue;
    const nested = await collectDirsRecursive(path.join(baseDir, entry.name), depth - 1);
    results.push(...nested);
  }
  return results;
}

async function expandGlobSegments(baseDir: string, segments: string[]): Promise<string[]> {
  if (segments.length === 0) return [baseDir];

  const segment = segments[0];
  const rest = segments.slice(1);
  if (segment === undefined) return [baseDir];

  if (segment === "**") {
    const candidates = await collectDirsRecursive(baseDir, MAX_GLOB_DEPTH);
    const out: string[] = [];
    for (const dir of candidates) {
      out.push(...(await expandGlobSegments(dir, rest)));
    }
    return out;
  }

  if (segment.includes("*")) {
    let entries;
    try {
      entries = await fs.readdir(baseDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const re = globSegmentToRegExp(segment);
    const out: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || GLOB_SKIP_DIRS.has(entry.name)) continue;
      if (!re.test(entry.name)) continue;
      out.push(...(await expandGlobSegments(path.join(baseDir, entry.name), rest)));
    }
    return out;
  }

  const next = path.join(baseDir, segment);
  if (!(await isDirectory(next))) return [];
  return expandGlobSegments(next, rest);
}

async function expandGlob(rootDir: string, pattern: string): Promise<string[]> {
  const segments = pattern.split("/").filter(Boolean);
  return expandGlobSegments(rootDir, segments);
}

async function readWorkspacePatterns(rootDir: string): Promise<string[]> {
  const packageJson = await readJsonFile<PackageInfo & { workspaces?: unknown }>(
    path.join(rootDir, "package.json"),
  );
  const patterns: string[] = [];

  const ws = packageJson?.workspaces;
  if (Array.isArray(ws)) {
    patterns.push(...ws.filter((p): p is string => typeof p === "string"));
  } else if (ws && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages)) {
    patterns.push(
      ...(ws as { packages: unknown[] }).packages.filter(
        (p): p is string => typeof p === "string",
      ),
    );
  }

  const pnpmWorkspacePath = path.join(rootDir, "pnpm-workspace.yaml");
  if (await fileExists(pnpmWorkspacePath)) {
    const content = await fs.readFile(pnpmWorkspacePath, "utf-8");
    patterns.push(...parsePnpmWorkspaceYaml(content));
  }

  return patterns;
}

// Minimal parse of the one shape that matters here:
//   packages:
//     - 'apps/*'
//     - 'libs/*'
// No general YAML support — just enough to read a packages: list without a
// new dependency.
function parsePnpmWorkspaceYaml(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const patterns: string[] = [];
  let inPackages = false;
  for (const line of lines) {
    if (/^packages:\s*$/.test(line.trim())) {
      inPackages = true;
      continue;
    }
    if (inPackages) {
      const itemMatch = line.match(/^\s*-\s*(.+?)\s*$/);
      if (itemMatch?.[1]) {
        const value = itemMatch[1].replace(/^['"]|['"]$/g, "");
        patterns.push(value);
        continue;
      }
      if (line.trim() === "" || line.startsWith(" ") || line.startsWith("\t")) {
        continue;
      }
      inPackages = false;
    }
  }
  return patterns;
}

/**
 * Resolve a workspaces config (package.json `workspaces`, or
 * pnpm-workspace.yaml) at `rootDir` into absolute directories that are
 * real workspaces (contain their own package.json). Returns [] when no
 * workspaces config exists — a plain, non-monorepo project.
 */
export async function resolveWorkspaceDirs(rootDir: string): Promise<string[]> {
  const patterns = await readWorkspacePatterns(rootDir);
  if (patterns.length === 0) return [];

  const includePatterns = patterns.filter((p) => !p.startsWith("!"));
  const excludePatterns = patterns
    .filter((p) => p.startsWith("!"))
    .map((p) => p.slice(1));

  const included = new Set<string>();
  for (const pattern of includePatterns) {
    const dirs = await expandGlob(rootDir, pattern);
    for (const dir of dirs) included.add(dir);
  }

  const excluded = new Set<string>();
  for (const pattern of excludePatterns) {
    const dirs = await expandGlob(rootDir, pattern);
    for (const dir of dirs) excluded.add(dir);
  }

  const resolvedRoot = path.resolve(rootDir);
  const out: string[] = [];
  for (const dir of included) {
    if (excluded.has(dir)) continue;
    if (path.resolve(dir) === resolvedRoot) continue;
    if (!(await fileExists(path.join(dir, "package.json")))) continue;
    out.push(dir);
  }
  return out.sort();
}

export interface FindDuplicateResolutionsOptions {
  /** Discover and scan workspace-nested node_modules too. Default true. */
  scanWorkspaces?: boolean;
}

export async function findDuplicateResolutions(
  pkgName: string,
  rootDir: string,
  options: FindDuplicateResolutionsOptions = {},
): Promise<DupeReport> {
  const scanWorkspaces = options.scanWorkspaces ?? true;
  const resolvedRoot = path.resolve(rootDir);

  const results: DupeResolution[] = [];
  const visited = new Set<string>();
  await walk(path.join(resolvedRoot, "node_modules"), pkgName, ".", results, visited);

  const workspacesDetected = await resolveWorkspaceDirs(resolvedRoot);
  const scannedWorkspaces: string[] = [];

  if (scanWorkspaces) {
    for (const workspaceDir of workspacesDetected) {
      const label = path.relative(resolvedRoot, workspaceDir) || ".";
      await walk(
        path.join(workspaceDir, "node_modules"),
        pkgName,
        label,
        results,
        visited,
      );
      scannedWorkspaces.push(workspaceDir);
    }
  }

  let resolvedViaParent: ParentResolution | null = null;
  if (results.length === 0) {
    const parentDir = path.dirname(resolvedRoot);
    if (parentDir !== resolvedRoot) {
      const found = await resolveInstalledPackage(pkgName, parentDir);
      if (found) {
        const packageInfo = await readJsonFile<PackageInfo>(
          path.join(found, "package.json"),
        );
        if (packageInfo?.version) {
          let realPath: string;
          try {
            realPath = await fs.realpath(found);
          } catch {
            realPath = found;
          }
          resolvedViaParent = { path: found, realpath: realPath, version: packageInfo.version };
        }
      }
    }
  }

  return { resolutions: results, workspacesDetected, scannedWorkspaces, resolvedViaParent };
}

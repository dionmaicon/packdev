/**
 * Find every distinct copy of a package actually resolved in the
 * dependency tree. Two copies of the same package break `instanceof`
 * checks and DI singletons (e.g. NestJS tokens are class references) —
 * invisible to types, static analysis, and even a passing test suite
 * unless it happens to exercise the exact code path affected.
 *
 * This is a direct filesystem walk of node_modules directories, not a
 * package.json dependency-graph walk — what matters here is what Node's
 * own module resolution actually sees, not the declared dependency tree.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { readJsonFile, type PackageInfo } from "./utils";

export interface DupeResolution {
  path: string;
  version: string;
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
// tracking real paths of node_modules directories already walked.
async function walk(
  nodeModulesDir: string,
  pkgName: string,
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
        results.push({ path: dir, version: packageInfo.version });
      }
    }
    await walk(path.join(dir, "node_modules"), pkgName, results, visitedRealPaths);
  }
}

export async function findDuplicateResolutions(
  pkgName: string,
  rootDir: string,
): Promise<DupeResolution[]> {
  const results: DupeResolution[] = [];
  const visited = new Set<string>();
  await walk(path.join(rootDir, "node_modules"), pkgName, results, visited);
  return results;
}

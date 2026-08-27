/**
 * Utility functions for package development management
 */

import * as path from "path";
import * as fs from "fs/promises";

// Type definitions
export interface PackageInfo {
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  main?: string;
  module?: string;
  types?: string;
  typings?: string;
  exports?: unknown;
  type?: "module" | "commonjs";
}

export interface DependencyInfo {
  name: string;
  version: string;
  resolved?: string;
  integrity?: string;
  dev?: boolean;
}

export interface LocalPackageValidation {
  exists: boolean;
  hasPackageJson: boolean;
  packageInfo?: PackageInfo;
  isValidPackage: boolean;
  issues: string[];
}

// Path utilities
export function normalizePath(inputPath: string): string {
  return path.normalize(inputPath).replace(/\\/g, "/");
}

export function resolveRelativePath(
  basePath: string,
  targetPath: string,
): string {
  return path.resolve(basePath, targetPath);
}

export function getRelativePath(from: string, to: string): string {
  return path.relative(from, to).replace(/\\/g, "/");
}

export function isAbsolutePath(inputPath: string): boolean {
  return path.isAbsolute(inputPath);
}

// Package name utilities
export function validatePackageName(name: string): boolean {
  // NPM package name validation
  const packageNameRegex =
    /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
  return packageNameRegex.test(name) && name.length <= 214;
}

export function formatPackageName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9@\-._~/]/g, "-");
}

export function extractPackageScope(name: string): {
  scope?: string;
  name: string;
} {
  const match = name.match(/^(@[^/]+)\/(.+)$/);
  if (match && match[1] && match[2]) {
    return { scope: match[1], name: match[2] };
  }
  return { name };
}

// Version utilities
export function isValidSemver(version: string): boolean {
  const semverRegex =
    /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+(?:[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
  return semverRegex.test(version);
}

export function normalizeVersion(version: string): string {
  // Remove prefixes like ^, ~, >=, etc.
  return version.replace(/^[\^~>=<]+/, "");
}

export function isVersionRange(version: string): boolean {
  return /^[\^~>=<]/.test(version);
}

export function parseVersionRange(version: string): {
  operator: string;
  version: string;
} {
  const match = version.match(/^([\^~>=<]+)(.+)$/);
  if (match && match[1] && match[2]) {
    return { operator: match[1], version: match[2] };
  }
  return { operator: "", version };
}

// File utilities
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(dirPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

export async function writeJsonFile<T>(
  filePath: string,
  data: T,
  indent: number = 2,
): Promise<void> {
  const content = JSON.stringify(data, null, indent);
  await fs.writeFile(filePath, content + "\n", "utf-8");
}

export async function createBackup(
  filePath: string,
  suffix: string = ".backup",
): Promise<string> {
  const backupPath = `${filePath}${suffix}`;
  await fs.copyFile(filePath, backupPath);
  return backupPath;
}

// Local package validation
export async function validateLocalPackage(
  packagePath: string,
): Promise<LocalPackageValidation> {
  const result: LocalPackageValidation = {
    exists: false,
    hasPackageJson: false,
    isValidPackage: false,
    issues: [],
  };

  try {
    // Check if path exists
    result.exists = await fileExists(packagePath);
    if (!result.exists) {
      result.issues.push(`Path does not exist: ${packagePath}`);
      return result;
    }

    // Check if it's a directory
    const isDir = await isDirectory(packagePath);
    if (!isDir) {
      result.issues.push(`Path is not a directory: ${packagePath}`);
      return result;
    }

    // Check for package.json
    const packageJsonPath = path.join(packagePath, "package.json");
    result.hasPackageJson = await fileExists(packageJsonPath);

    if (!result.hasPackageJson) {
      result.issues.push(`No package.json found in: ${packagePath}`);
      return result;
    }

    // Load and validate package.json
    const packageInfo = await readJsonFile<PackageInfo>(packageJsonPath);
    if (!packageInfo) {
      result.issues.push(`Invalid package.json in: ${packagePath}`);
      return result;
    }

    result.packageInfo = packageInfo;

    // Validate package name
    if (!packageInfo.name) {
      result.issues.push("Package name is missing");
    } else if (!validatePackageName(packageInfo.name)) {
      result.issues.push(`Invalid package name: ${packageInfo.name}`);
    }

    // Validate version
    if (!packageInfo.version) {
      result.issues.push("Package version is missing");
    } else if (!isValidSemver(packageInfo.version)) {
      result.issues.push(`Invalid package version: ${packageInfo.version}`);
    }

    // Check for main entry point
    const mainFile = packageInfo.main || "index.js";
    const mainPath = path.join(packagePath, mainFile);
    const hasMain = await fileExists(mainPath);

    if (!hasMain) {
      result.issues.push(`Main entry point not found: ${mainFile}`);
    }

    result.isValidPackage = result.issues.length === 0;
  } catch (error) {
    result.issues.push(
      `Error validating package: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }

  return result;
}

// Dependency utilities
export function createFileUrl(filePath: string): string {
  const absolutePath = path.resolve(filePath);
  return `file:${absolutePath}`;
}

export function isFileUrl(url: string): boolean {
  return url.startsWith("file:");
}

export function extractFileUrl(url: string): string {
  return url.replace(/^file:/, "");
}

export function isDevelopmentDependency(version: string): boolean {
  return (
    isFileUrl(version) || version.includes("file:") || version.includes("link:")
  );
}

// Workspace / monorepo discovery utilities
export interface WorkspacePackage {
  name: string;
  dir: string;
}

async function readPnpmWorkspaceGlobs(rootDir: string): Promise<string[]> {
  const filePath = path.join(rootDir, "pnpm-workspace.yaml");
  if (!(await fileExists(filePath))) {
    return [];
  }

  const content = await fs.readFile(filePath, "utf-8");
  const lines = content.split(/\r?\n/);
  const globs: string[] = [];
  let inPackages = false;

  for (const line of lines) {
    if (/^packages:\s*$/.test(line.trim())) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;

    const match = line.match(/^\s*-\s*['"]?([^'"]+)['"]?\s*$/);
    if (match && match[1]) {
      globs.push(match[1]);
    } else if (line.trim() !== "") {
      inPackages = false;
    }
  }

  return globs;
}

// Expands a single-level glob like "packages/*" into concrete directories.
// Patterns without "*" are treated as a literal directory.
async function expandWorkspaceGlob(
  rootDir: string,
  pattern: string,
): Promise<string[]> {
  const starIndex = pattern.indexOf("*");
  if (starIndex === -1) {
    return [path.join(rootDir, pattern)];
  }

  const baseDir = path.join(rootDir, pattern.slice(0, starIndex));
  if (!(await isDirectory(baseDir))) {
    return [];
  }

  const entries = await fs.readdir(baseDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(baseDir, entry.name));
}

/**
 * Discover named packages declared via npm/yarn "workspaces" in package.json
 * or a pnpm-workspace.yaml file at the given root.
 */
export async function discoverWorkspacePackages(
  rootDir: string = ".",
): Promise<WorkspacePackage[]> {
  const results: WorkspacePackage[] = [];
  const seenDirs = new Set<string>();

  let globs: string[] = [];
  const rootPkg = await readJsonFile<{
    workspaces?: string[] | { packages?: string[] };
  }>(path.join(rootDir, "package.json"));

  if (rootPkg?.workspaces) {
    globs = Array.isArray(rootPkg.workspaces)
      ? rootPkg.workspaces
      : rootPkg.workspaces.packages || [];
  }

  if (globs.length === 0) {
    globs = await readPnpmWorkspaceGlobs(rootDir);
  }

  for (const pattern of globs) {
    const dirs = await expandWorkspaceGlob(rootDir, pattern);
    for (const dir of dirs) {
      if (seenDirs.has(dir)) continue;
      const pkg = await readJsonFile<PackageInfo>(
        path.join(dir, "package.json"),
      );
      if (pkg?.name) {
        seenDirs.add(dir);
        results.push({ name: pkg.name, dir });
      }
    }
  }

  return results;
}

/**
 * Discover named packages in sibling directories of the given root
 * (e.g. `../my-utils` next to the current project).
 */
export async function discoverSiblingPackages(
  rootDir: string = ".",
): Promise<WorkspacePackage[]> {
  const parentDir = path.resolve(rootDir, "..");
  const results: WorkspacePackage[] = [];

  if (!(await isDirectory(parentDir))) {
    return results;
  }

  const entries = await fs.readdir(parentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(parentDir, entry.name);
    if (path.resolve(dir) === path.resolve(rootDir)) continue;

    const pkg = await readJsonFile<PackageInfo>(
      path.join(dir, "package.json"),
    );
    if (pkg?.name) {
      results.push({ name: pkg.name, dir });
    }
  }

  return results;
}

/**
 * Walk up from `startDir` to find the monorepo root: the nearest ancestor
 * whose package.json declares "workspaces", or that contains a
 * pnpm-workspace.yaml. Returns null if none is found (not a monorepo, or the
 * caller is already at/above the root).
 */
export async function findWorkspaceRoot(
  startDir: string = ".",
): Promise<string | null> {
  let dir = path.resolve(startDir);
  for (;;) {
    const pkg = await readJsonFile<{
      workspaces?: string[] | { packages?: string[] };
    }>(path.join(dir, "package.json"));
    if (pkg?.workspaces) return dir;
    if (await fileExists(path.join(dir, "pnpm-workspace.yaml"))) return dir;

    const parentDir = path.dirname(dir);
    if (parentDir === dir) return null;
    dir = parentDir;
  }
}

/**
 * Resolve a package name to a local directory. Searches, in order: the
 * workspaces declared at the monorepo root (walking up from `rootDir` so this
 * works from inside a workspace child), the workspaces declared at `rootDir`
 * itself, then sibling directories. Returns all matches found (empty, one, or
 * many).
 */
export async function resolveLocalPackage(
  packageName: string,
  rootDir: string = ".",
): Promise<WorkspacePackage[]> {
  const seenDirs = new Set<string>();
  const matches: WorkspacePackage[] = [];
  const collect = (pkgs: WorkspacePackage[]) => {
    for (const pkg of pkgs) {
      if (pkg.name !== packageName) continue;
      const key = path.resolve(pkg.dir);
      if (seenDirs.has(key)) continue;
      seenDirs.add(key);
      matches.push(pkg);
    }
  };

  const workspaceRoot = await findWorkspaceRoot(rootDir);
  if (workspaceRoot && path.resolve(workspaceRoot) !== path.resolve(rootDir)) {
    collect(await discoverWorkspacePackages(workspaceRoot));
  }
  collect(await discoverWorkspacePackages(rootDir));
  if (matches.length > 0) {
    return matches;
  }

  collect(await discoverSiblingPackages(rootDir));
  return matches;
}

/**
 * Run `worker` over `items` with at most `limit` calls in flight at once.
 * Results are written back by index, so the returned order always matches
 * `items`' order regardless of which call finished first — a caller's
 * report stays deterministically ordered whether or not concurrency is on.
 */
export async function runWithConcurrencyLimit<T, R>(
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

// Array and object utilities
export function groupBy<T, K extends string | number | symbol>(
  array: T[],
  keyFn: (item: T) => K,
): Record<K, T[]> {
  return array.reduce(
    (result, item) => {
      const key = keyFn(item);
      if (!result[key]) {
        result[key] = [];
      }
      result[key].push(item);
      return result;
    },
    {} as Record<K, T[]>,
  );
}

export function omit<T extends object, K extends keyof T>(
  obj: T,
  keys: K[],
): Omit<T, K> {
  const result = { ...obj };
  keys.forEach((key) => delete result[key]);
  return result;
}

export function pick<T extends object, K extends keyof T>(
  obj: T,
  keys: K[],
): Pick<T, K> {
  const result = {} as Pick<T, K>;
  keys.forEach((key) => {
    if (key in obj) {
      result[key] = obj[key];
    }
  });
  return result;
}

// Async utilities
export async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryOperation<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  delayMs: number = 1000,
): Promise<T> {
  let lastError: Error;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      if (i < maxRetries - 1) {
        await delay(delayMs);
      }
    }
  }

  throw lastError!;
}

// Logging and formatting utilities
export function formatSize(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }

  return `${size.toFixed(1)}${units[unitIndex]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
}

export function createTimestamp(): string {
  return new Date().toISOString();
}

export function formatTimestamp(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleString();
}

// Configuration utilities
export function deepMerge<T extends Record<string, any>>(
  target: T,
  source: Partial<T>,
): T {
  const result = { ...target } as any;

  for (const key in source) {
    if (Object.prototype.hasOwnProperty.call(source, key)) {
      const sourceValue = source[key];
      const targetValue = result[key];

      if (
        sourceValue &&
        typeof sourceValue === "object" &&
        !Array.isArray(sourceValue) &&
        targetValue &&
        typeof targetValue === "object" &&
        !Array.isArray(targetValue)
      ) {
        result[key] = deepMerge(targetValue, sourceValue);
      } else if (sourceValue !== undefined) {
        result[key] = sourceValue;
      }
    }
  }

  return result;
}

export function flattenObject(
  obj: object,
  prefix: string = "",
): Record<string, any> {
  const flattened: Record<string, any> = {};

  for (const [key, value] of Object.entries(obj)) {
    const newKey = prefix ? `${prefix}.${key}` : key;

    if (value && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(flattened, flattenObject(value, newKey));
    } else {
      flattened[newKey] = value;
    }
  }

  return flattened;
}

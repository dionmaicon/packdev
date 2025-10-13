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
  types?: string;
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
  return name.toLowerCase().replace(/[^a-z0-9@\-._~\/]/g, "-");
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
    if (source.hasOwnProperty(key)) {
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

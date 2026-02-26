import * as fs from "fs/promises";
import * as path from "path";
import { spawn } from "child_process";

// Types for configuration and package management
export interface PackdevDependency {
  package: string;
  location: string;
  version: string;
  type?: "local" | "git" | "release";
}

export interface PackdevConfig {
  version: string;
  dependencies: PackdevDependency[];
  created: string;
  lastModified?: string;
  autoCommitFlow?: boolean;
}

export interface PackageJson {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  [key: string]: any;
}

export interface InitResult {
  success: boolean;
  error?: string;
  replacedCount: number;
  replacedPackages: Array<{
    name: string;
    originalVersion: string;
    localPath: string;
  }>;
}

export interface FinishResult {
  success: boolean;
  error?: string;
  restoredCount: number;
  restoredPackages: Array<{
    name: string;
    localPath: string;
    originalVersion: string;
  }>;
}

export interface AddDependencyResult {
  success: boolean;
  error?: string;
  version?: string;
}

export interface RemoveDependencyResult {
  success: boolean;
  error?: string;
}

export interface ListDependenciesResult {
  success: boolean;
  error?: string;
  dependencies: PackdevDependency[];
}

export interface ValidationResult {
  isValid: boolean;
  configExists: boolean;
  packageJsonExists: boolean;
  isInDevMode: boolean;
  dependencies: PackdevDependency[];
  issues: string[];
}

export interface SetupHooksResult {
  success: boolean;
  error?: string;
  message?: string;
}

interface PackageManagerInfo {
  manager: "npm" | "yarn" | "pnpm";
  lockFile: string;
}

interface GitReference {
  url: string;
  ref: string | undefined;
  protocol: "https" | "ssh" | "git";
}

// Utility functions
async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function detectPackageManager(): Promise<PackageManagerInfo> {
  // Check for lock files to determine package manager
  if (await fileExists("pnpm-lock.yaml")) {
    return { manager: "pnpm", lockFile: "pnpm-lock.yaml" };
  }
  if (await fileExists("yarn.lock")) {
    return { manager: "yarn", lockFile: "yarn.lock" };
  }
  // Default to npm (package-lock.json may or may not exist)
  return { manager: "npm", lockFile: "package-lock.json" };
}

async function executeInstall(
  packageManagerInfo: PackageManagerInfo,
): Promise<boolean> {
  const { manager } = packageManagerInfo;

  try {
    console.log(`\n🔄 Running ${manager} install...`);

    return new Promise((resolve) => {
      const child = spawn(manager, ["install"], {
        stdio: "inherit",
        shell: true,
      });

      child.on("close", (code) => {
        if (code === 0) {
          console.log(`✅ ${manager} install completed successfully!`);
          resolve(true);
        } else {
          console.log(`❌ ${manager} install failed with exit code ${code}`);
          resolve(false);
        }
      });

      child.on("error", (error) => {
        console.log(`❌ Failed to run ${manager} install:`, error.message);
        resolve(false);
      });
    });
  } catch (error) {
    console.log(`❌ Failed to execute ${manager} install:`, error);
    return false;
  }
}

async function promptForInstall(
  packageManagerInfo: PackageManagerInfo,
  autoInstall: boolean = true,
): Promise<boolean> {
  const { manager } = packageManagerInfo;

  console.log(`\n📦 Dependencies have been updated in package.json`);

  if (!autoInstall) {
    console.log(`💡 Run '${manager} install' to update your node_modules\n`);
    return false;
  }

  console.log(`🔄 Running ${manager} install to update node_modules...`);
  return await executeInstall(packageManagerInfo);
}

// Git URL detection and parsing functions
function isGitUrl(location: string): boolean {
  const gitPatterns = [
    /^git\+https?:\/\/.+\.git(#.+)?$/,
    /^git\+ssh:\/\/.+\.git(#.+)?$/,
    /^git@[^:]+:.+\.git(#.+)?$/,
    /^https?:\/\/.+\.git(#.+)?$/,
    /^github:[^/]+\/[^#]+(#.+)?$/,
    /^gitlab:[^/]+\/[^#]+(#.+)?$/,
  ];
  return gitPatterns.some((pattern) => pattern.test(location));
}

export function parseGitUrl(gitUrl: string): GitReference | null {
  if (!isGitUrl(gitUrl)) {
    return null;
  }

  let url = gitUrl;
  let ref: string | undefined;
  let protocol: "https" | "ssh" | "git";

  // Extract ref (branch/tag/commit) if present
  const hashIndex = gitUrl.indexOf("#");
  if (hashIndex !== -1) {
    ref = gitUrl.substring(hashIndex + 1);
    url = gitUrl.substring(0, hashIndex);
  }

  // Determine protocol and normalize URL
  if (url.startsWith("git+https://") || url.startsWith("https://")) {
    protocol = "https";
  } else if (url.startsWith("git+ssh://") || url.startsWith("git@")) {
    protocol = "ssh";
  } else if (url.startsWith("github:")) {
    protocol = "https";
    const parts = url.replace("github:", "").split("/");
    url = `https://github.com/${parts[0]}/${parts[1]}.git`;
  } else if (url.startsWith("gitlab:")) {
    protocol = "https";
    const parts = url.replace("gitlab:", "").split("/");
    url = `https://gitlab.com/${parts[0]}/${parts[1]}.git`;
  } else {
    protocol = "git";
  }

  return { url, ref, protocol };
}

// Semver/range pattern: matches version strings like ^1.0.0, ~2.3.0, 1.0.0, >=1.0.0, etc.
// Does NOT match local paths (starting with . or /) or git URLs
const semverRangePattern =
  /^[\^~]?\d+\.\d+\.\d+|^[><=!]+\s*\d+\.\d+\.\d+|^\d+\.\d+\.\d+/;

function isReleaseVersion(location: string): boolean {
  if (isGitUrl(location)) return false;
  if (
    location.startsWith(".") ||
    location.startsWith("/") ||
    location.startsWith("file:")
  )
    return false;
  return semverRangePattern.test(location);
}

function detectDependencyType(location: string): "local" | "git" | "release" {
  if (isGitUrl(location)) return "git";
  if (isReleaseVersion(location)) return "release";
  return "local";
}

// Check if a package.json version value is an active release override
// by comparing it against the stored override location
function isActiveReleaseOverride(
  currentVersion: string,
  dependency: PackdevDependency,
): boolean {
  return (
    dependency.type === "release" && currentVersion === dependency.location
  );
}

function resolveLocation(location: string): string {
  if (isGitUrl(location)) {
    return location; // Use git URL directly for npm/yarn to handle
  } else if (isReleaseVersion(location)) {
    return location; // Use semver version string directly for npm/yarn to handle
  } else {
    return resolveLocalPath(location); // Use file: path for local
  }
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function writeJsonFile<T>(filePath: string, data: T): Promise<void> {
  const content = JSON.stringify(data, null, 2);
  await fs.writeFile(filePath, content, "utf-8");
}

function resolveLocalPath(location: string): string {
  // Convert relative path to file:// URL for npm
  const absolutePath = path.resolve(location);
  return `file:${absolutePath}`;
}

function isLocalPath(version: string): boolean {
  return version.startsWith("file:");
}

// function extractLocalPath(version: string): string {
//   return version.replace("file:", "");
// }

// Core package management functions
export async function loadConfig(
  configPath: string,
): Promise<PackdevConfig | null> {
  return await readJsonFile<PackdevConfig>(configPath);
}

export async function saveConfig(
  configPath: string,
  config: PackdevConfig,
): Promise<void> {
  config.lastModified = new Date().toISOString();
  await writeJsonFile(configPath, config);
}

export async function loadPackageJson(): Promise<PackageJson | null> {
  return await readJsonFile<PackageJson>("package.json");
}

export async function savePackageJson(packageJson: PackageJson): Promise<void> {
  await writeJsonFile("package.json", packageJson);
}

export async function initializeProject(
  configPath: string = ".packdev.json",
  autoInstall: boolean = true,
): Promise<InitResult> {
  try {
    // Check if config file exists
    if (!(await fileExists(configPath))) {
      return {
        success: false,
        error: `Configuration file ${configPath} not found. Use 'packdev create-config' to create one.`,
        replacedCount: 0,
        replacedPackages: [],
      };
    }

    // Load config
    const config = await loadConfig(configPath);
    if (!config) {
      return {
        success: false,
        error: `Failed to load configuration from ${configPath}`,
        replacedCount: 0,
        replacedPackages: [],
      };
    }

    if (config.dependencies.length === 0) {
      return {
        success: true,
        error: "No local dependencies configured",
        replacedCount: 0,
        replacedPackages: [],
      };
    }

    // Load package.json
    const packageJson = await loadPackageJson();
    if (!packageJson) {
      return {
        success: false,
        error: "package.json not found in current directory",
        replacedCount: 0,
        replacedPackages: [],
      };
    }

    const replacedPackages: Array<{
      name: string;
      originalVersion: string;
      localPath: string;
    }> = [];

    let replacedCount = 0;

    // Replace versions with resolved locations (local or git)
    for (const dependency of config.dependencies) {
      const { package: packageName, location } = dependency;

      // For local dependencies, check if path exists (skip for git and release)
      if (dependency.type === "local" && !(await fileExists(location))) {
        console.warn(`⚠️  Local package not found: ${location}`);
        continue;
      }

      const resolvedLocation = resolveLocation(location);
      let wasReplaced = false;

      // Replace in dependencies
      if (packageJson.dependencies && packageJson.dependencies[packageName]) {
        // Update the config with the current version if it's not already an override
        const depVer = packageJson.dependencies[packageName];
        if (
          !isLocalPath(depVer) &&
          !isGitUrl(depVer) &&
          !isActiveReleaseOverride(depVer, dependency)
        ) {
          dependency.version = depVer;
        }
        packageJson.dependencies[packageName] = resolvedLocation;
        wasReplaced = true;
      }

      // Replace in devDependencies
      if (
        packageJson.devDependencies &&
        packageJson.devDependencies[packageName]
      ) {
        const devDepVer = packageJson.devDependencies[packageName];
        if (
          !isLocalPath(devDepVer) &&
          !isGitUrl(devDepVer) &&
          !isActiveReleaseOverride(devDepVer, dependency)
        ) {
          dependency.version = devDepVer;
        }
        packageJson.devDependencies[packageName] = resolvedLocation;
        wasReplaced = true;
      }

      // Replace in peerDependencies
      if (
        packageJson.peerDependencies &&
        packageJson.peerDependencies[packageName]
      ) {
        const peerDepVer = packageJson.peerDependencies[packageName];
        if (
          !isLocalPath(peerDepVer) &&
          !isGitUrl(peerDepVer) &&
          !isActiveReleaseOverride(peerDepVer, dependency)
        ) {
          dependency.version = peerDepVer;
        }
        packageJson.peerDependencies[packageName] = resolvedLocation;
        wasReplaced = true;
      }

      if (wasReplaced) {
        replacedCount++;
        replacedPackages.push({
          name: packageName,
          originalVersion: dependency.version,
          localPath: location,
        });
      }
    }

    // Save updated config and package.json
    await saveConfig(configPath, config);
    await savePackageJson(packageJson);

    // Auto-run install after updating package.json
    const packageManagerInfo = await detectPackageManager();
    await promptForInstall(packageManagerInfo, autoInstall);

    return {
      success: true,
      replacedCount,
      replacedPackages,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
      replacedCount: 0,
      replacedPackages: [],
    };
  }
}

export async function finishProject(
  configPath: string = ".packdev.json",
  autoInstall: boolean = true,
): Promise<FinishResult> {
  try {
    // Load config
    const config = await loadConfig(configPath);
    if (!config) {
      return {
        success: false,
        error: `Configuration file ${configPath} not found`,
        restoredCount: 0,
        restoredPackages: [],
      };
    }

    // Load package.json
    const packageJson = await loadPackageJson();
    if (!packageJson) {
      return {
        success: false,
        error: "package.json not found in current directory",
        restoredCount: 0,
        restoredPackages: [],
      };
    }

    const restoredPackages: Array<{
      name: string;
      localPath: string;
      originalVersion: string;
    }> = [];

    let restoredCount = 0;

    // Restore original versions
    for (const dependency of config.dependencies) {
      const { package: packageName, location, version } = dependency;
      let wasRestored = false;

      // Restore in dependencies
      if (packageJson.dependencies && packageJson.dependencies[packageName]) {
        const depVer = packageJson.dependencies[packageName];
        if (
          isLocalPath(depVer) ||
          isGitUrl(depVer) ||
          isActiveReleaseOverride(depVer, dependency)
        ) {
          packageJson.dependencies[packageName] = version;
          wasRestored = true;
        }
      }

      // Restore in devDependencies
      if (
        packageJson.devDependencies &&
        packageJson.devDependencies[packageName]
      ) {
        const devDepVer = packageJson.devDependencies[packageName];
        if (
          isLocalPath(devDepVer) ||
          isGitUrl(devDepVer) ||
          isActiveReleaseOverride(devDepVer, dependency)
        ) {
          packageJson.devDependencies[packageName] = version;
          wasRestored = true;
        }
      }

      // Restore in peerDependencies
      if (
        packageJson.peerDependencies &&
        packageJson.peerDependencies[packageName]
      ) {
        const peerDepVer = packageJson.peerDependencies[packageName];
        if (
          isLocalPath(peerDepVer) ||
          isGitUrl(peerDepVer) ||
          isActiveReleaseOverride(peerDepVer, dependency)
        ) {
          packageJson.peerDependencies[packageName] = version;
          wasRestored = true;
        }
      }

      if (wasRestored) {
        restoredCount++;
        restoredPackages.push({
          name: packageName,
          localPath: location,
          originalVersion: version,
        });
      }
    }

    // Save updated package.json
    await savePackageJson(packageJson);

    // Auto-run install after restoring original versions
    const packageManagerInfo = await detectPackageManager();
    await promptForInstall(packageManagerInfo, autoInstall);

    return {
      success: true,
      restoredCount,
      restoredPackages,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
      restoredCount: 0,
      restoredPackages: [],
    };
  }
}

export async function addLocalDependency(
  packageName: string,
  location: string,
  configPath: string = ".packdev.json",
  explicitVersion?: string,
  autoInstall: boolean = true,
): Promise<AddDependencyResult> {
  try {
    const dependencyType = detectDependencyType(location);

    // Check if local path exists (only for local dependencies)
    if (dependencyType === "local" && !(await fileExists(location))) {
      return {
        success: false,
        error: `Package path does not exist: ${location}`,
      };
    }

    // Load or create config
    let config = await loadConfig(configPath);
    if (!config) {
      config = {
        version: "1.0.0",
        dependencies: [],
        created: new Date().toISOString(),
      };
    }

    // Auto-detect version from package.json or use explicit version
    let version = explicitVersion;
    if (!version) {
      const packageJson = await loadPackageJson();
      if (packageJson) {
        version =
          packageJson.dependencies?.[packageName] ||
          packageJson.devDependencies?.[packageName] ||
          packageJson.peerDependencies?.[packageName];
      }

      if (!version) {
        return {
          success: false,
          error: `Package '${packageName}' not found in package.json. Either add it to your dependencies first or use --original-version to specify the version manually.`,
        };
      }

      // Don't save local file paths, git URLs, or active release overrides as the original version
      const existingOverride = config.dependencies.find(
        (dep) => dep.package === packageName,
      );
      const isActiveRelease =
        existingOverride &&
        isActiveReleaseOverride(version, existingOverride);

      if (isLocalPath(version) || isGitUrl(version) || isActiveRelease) {
        return {
          success: false,
          error: `Package '${packageName}' already uses a local path, git URL, or release override (${version}). Cannot determine original version. Use --original-version to specify it manually.`,
        };
      }
    }

    // Remove existing entry if it exists
    config.dependencies = config.dependencies.filter(
      (dep) => dep.package !== packageName,
    );

    // Add new dependency with auto-detected type
    // Add new dependency with auto-detected type
    config.dependencies.push({
      package: packageName,
      location: location,
      version: version,
      type: dependencyType,
    });

    // Save config
    await saveConfig(configPath, config);

    // Update package.json with resolved location (local or git)
    const packageJson = await loadPackageJson();
    if (packageJson) {
      const resolvedLocation = resolveLocation(location);
      let wasUpdated = false;

      // Update in dependencies
      if (packageJson.dependencies && packageJson.dependencies[packageName]) {
        packageJson.dependencies[packageName] = resolvedLocation;
        wasUpdated = true;
      }

      // Update in devDependencies
      if (
        packageJson.devDependencies &&
        packageJson.devDependencies[packageName]
      ) {
        packageJson.devDependencies[packageName] = resolvedLocation;
        wasUpdated = true;
      }

      // Update in peerDependencies
      if (
        packageJson.peerDependencies &&
        packageJson.peerDependencies[packageName]
      ) {
        packageJson.peerDependencies[packageName] = resolvedLocation;
        wasUpdated = true;
      }

      if (wasUpdated) {
        await savePackageJson(packageJson);

        // Auto-run install after updating package.json
        const packageManagerInfo = await detectPackageManager();
        await promptForInstall(packageManagerInfo, autoInstall);
      }
    }

    return {
      success: true,
      version,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}

export async function removeLocalDependency(
  packageName: string,
  configPath: string = ".packdev.json",
): Promise<RemoveDependencyResult> {
  try {
    // Load config
    const config = await loadConfig(configPath);
    if (!config) {
      return {
        success: false,
        error: `Configuration file ${configPath} not found`,
      };
    }

    // Check if dependency exists
    const dependencyIndex = config.dependencies.findIndex(
      (dep) => dep.package === packageName,
    );
    if (dependencyIndex === -1) {
      return {
        success: false,
        error: `Dependency ${packageName} not found`,
      };
    }

    // Remove dependency
    config.dependencies.splice(dependencyIndex, 1);

    // Save config
    await saveConfig(configPath, config);

    return {
      success: true,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
    };
  }
}

export async function listLocalDependencies(
  configPath: string = ".packdev.json",
): Promise<ListDependenciesResult> {
  try {
    const config = await loadConfig(configPath);
    if (!config) {
      return {
        success: true,
        dependencies: [],
      };
    }

    return {
      success: true,
      dependencies: config.dependencies,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Unknown error occurred",
      dependencies: [],
    };
  }
}

export async function validateProject(
  configPath: string = ".packdev.json",
): Promise<ValidationResult> {
  const result: ValidationResult = {
    isValid: true,
    configExists: false,
    packageJsonExists: false,
    isInDevMode: false,
    dependencies: [],
    issues: [],
  };

  try {
    // Check config file
    result.configExists = await fileExists(configPath);

    // Check package.json
    result.packageJsonExists = await fileExists("package.json");

    if (!result.packageJsonExists) {
      result.isValid = false;
      result.issues.push("package.json not found");
      return result;
    }

    if (!result.configExists) {
      return result; // Valid but no config
    }

    // Load config
    const config = await loadConfig(configPath);
    if (config) {
      result.dependencies = config.dependencies;
    }

    // Load package.json to check if in dev mode
    const packageJson = await loadPackageJson();
    if (packageJson && config) {
      // Check if any dependencies are using local paths, git URLs, or release overrides
      for (const dependency of config.dependencies) {
        const packageName = dependency.package;

        const depVersion = packageJson.dependencies?.[packageName] ?? "";
        const devDepVersion =
          packageJson.devDependencies?.[packageName] ?? "";
        const peerDepVersion =
          packageJson.peerDependencies?.[packageName] ?? "";

        if (
          isLocalPath(depVersion) ||
          isLocalPath(devDepVersion) ||
          isLocalPath(peerDepVersion) ||
          isGitUrl(depVersion) ||
          isGitUrl(devDepVersion) ||
          isGitUrl(peerDepVersion) ||
          isActiveReleaseOverride(depVersion, dependency) ||
          isActiveReleaseOverride(devDepVersion, dependency) ||
          isActiveReleaseOverride(peerDepVersion, dependency)
        ) {
          result.isInDevMode = true;
          break;
        }
      }

      // Validate local paths exist (only for local dependencies)
      for (const dependency of config.dependencies) {
        if (
          dependency.type === "local" &&
          !(await fileExists(dependency.location))
        ) {
          result.issues.push(
            `Package path does not exist: ${dependency.location}`,
          );
          result.isValid = false;
        }
      }
    }
  } catch (error) {
    result.isValid = false;
    result.issues.push(
      `Error validating project: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }

  return result;
}

/**
 * Setup GitHub pre-commit hooks to prevent accidental development dependency commits
 */
export async function setupGitHooks(
  force: boolean = false,
  disable: boolean = false,
  autoCommitFlow: boolean = false,
  configPath: string = ".packdev.json",
): Promise<SetupHooksResult> {
  try {
    const hooksDir = ".git/hooks";
    const preCommitFile = path.join(hooksDir, "pre-commit");
    const checkScriptFile = path.join(hooksDir, "check-local-deps.js");

    // Save autoCommitFlow preference to config if not disabling
    if (!disable) {
      let config = await loadConfig(configPath);
      if (config) {
        // Only set autoCommitFlow if explicitly true, otherwise preserve existing value
        if (autoCommitFlow === true) {
          config.autoCommitFlow = true;
        }
        config.lastModified = new Date().toISOString();
        await saveConfig(configPath, config);
      }
    }

    if (disable) {
      // Remove hooks
      try {
        if (await fileExists(preCommitFile)) {
          await fs.unlink(preCommitFile);
        }
        if (await fileExists(checkScriptFile)) {
          await fs.unlink(checkScriptFile);
        }
        // Remove directory if empty
        try {
          const files = await fs.readdir(hooksDir);
          if (files.length === 0) {
            await fs.rmdir(hooksDir);
          }
        } catch {
          // Directory might not be empty or not exist, ignore
        }
        return {
          success: true,
          message: "Safety hooks have been removed",
        };
      } catch (error) {
        return {
          success: false,
          error: `Failed to remove hooks: ${error instanceof Error ? error.message : "Unknown error"}`,
        };
      }
    }

    // Create hooks directory
    if (!(await fileExists(hooksDir))) {
      await fs.mkdir(hooksDir, { recursive: true });
    }

    // Check if files exist and force flag
    if (!force) {
      if (await fileExists(preCommitFile)) {
        return {
          success: false,
          error: "Pre-commit hook already exists. Use --force to overwrite",
        };
      }
    }

    // Create the check script
    const checkScript = `#!/usr/bin/env node
/**
 * packdev Safety Check - Prevents commits with local file dependencies
 * Generated by packdev setup-hooks command
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { execSync } = require('child_process');

function log(message, color = '\\x1b[0m') {
  console.log(\`\${color}\${message}\\x1b[0m\`);
}

function logError(message) {
  log(\`❌ \${message}\`, '\\x1b[31m');
}

function logWarning(message) {
  log(\`⚠️  \${message}\`, '\\x1b[33m');
}

function logInfo(message) {
  log(\`📋 \${message}\`, '\\x1b[36m');
}

function logSuccess(message) {
  log(\`✅ \${message}\`, '\\x1b[32m');
}

/**
 * Load .packdev.json config
 */
function loadPackdevConfig() {
  try {
    const configPath = path.join(process.cwd(), '.packdev.json');
    if (!fs.existsSync(configPath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    return null;
  }
}

/**
 * Check if a version string is an active release override based on packdev config
 */
function isActiveReleaseOverride(version, packdevConfig) {
  if (!packdevConfig || !packdevConfig.dependencies) return false;
  return packdevConfig.dependencies.some(
    (dep) => dep.type === 'release' && dep.location === version
  );
}

/**
 * Check if package.json contains local file dependencies or active release overrides
 */
function hasLocalFileDependencies() {
  try {
    const packageJsonPath = path.join(process.cwd(), 'package.json');
    if (!fs.existsSync(packageJsonPath)) {
      return { hasLocal: false, dependencies: [] };
    }

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const packdevConfig = loadPackdevConfig();
    const localDeps = [];

    // Check all dependency sections
    const depSections = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

    for (const section of depSections) {
      const deps = packageJson[section];
      if (deps && typeof deps === 'object') {
        for (const [name, version] of Object.entries(deps)) {
          if (typeof version === 'string' && (
            version.startsWith('file:') ||
            version.startsWith('./') ||
            isActiveReleaseOverride(version, packdevConfig)
          )) {
            localDeps.push({ name, version, section });
          }
        }
      }
    }

    return { hasLocal: localDeps.length > 0, dependencies: localDeps };
  } catch (error) {
    logError(\`Failed to read package.json: \${error.message}\`);
    return { hasLocal: false, dependencies: [] };
  }
}

/**
 * Check if commit message contains WIP
 */
function isWipCommit(commitMessage) {
  if (!commitMessage) return false;
  // Match various WIP patterns:
  // - "WIP", "wip" as standalone words
  // - "work in progress" phrase
  // - "draft", "temp", "temporary"
  // - "[WIP]", "(WIP)" with brackets
  const wipPattern = /\\b(wip|draft|temp(orary)?|\\[wip\\]|\\(wip\\))\\b|work\\s+in\\s+progress/i;
  return wipPattern.test(commitMessage);
}

/**
 * Get commit message from git
 */
function getCommitMessage() {
  try {
    // Method 1: Check environment variable (set by test or custom usage)
    if (process.env.TEST_COMMIT_MESSAGE) {
      return process.env.TEST_COMMIT_MESSAGE;
    }

    // Method 2: Check environment variables that might contain the commit message
    if (process.env.PACKDEV_COMMIT_MESSAGE_OVERRIDE) {
      return process.env.PACKDEV_COMMIT_MESSAGE_OVERRIDE;
    }

    // Method 3: Try to get from git environment variables
    if (process.env.GIT_COMMIT_MESSAGE) {
      return process.env.GIT_COMMIT_MESSAGE;
    }

    // Method 4: Try command line arguments (passed to the hook)
    const args = process.argv.slice(2);
    if (args.length > 0) {
      return args.join(' ');
    }

    return '';
  } catch (error) {
    return '';
  }
}

/**
 * Check if WIP by examining git process command line
 */
function isWipFromGitProcess() {
  try {
    // Check parent process command line for WIP
    const parentPid = process.ppid;
    if (parentPid) {
      const cmdline = execSync('ps -p ' + parentPid + ' -o command --no-headers', {
        encoding: 'utf8',
        stdio: 'pipe'
      }).trim();

      if (cmdline && /git\s+commit.*-m\s*["'].*\bwip\b/i.test(cmdline)) {
        return true;
      }
    }
  } catch (error) {
    // Ignore errors in process detection
  }
  return false;
}

/**
 * Get commit message for auto-commit flow
 */
function getAutoCommitMessage() {
  // Check for environment variable first
  const envMessage = process.env.PACKDEV_COMMIT_MESSAGE;
  if (envMessage) {
    return envMessage;
  }

  // Try to get the original commit message that was being attempted
  const commitMessage = getCommitMessage();
  if (commitMessage && commitMessage !== '--verbose') {
    return commitMessage;
  }

  // Default message
  return 'Auto-commit: restore dependencies and commit changes';
}

/**
 * Execute auto-commit flow with dependency restoration
 */
async function executeAutoCommitFlow() {
  try {
    logInfo('🔄 Auto-commit: Restoring dependencies and including in your commit...');

    // Find packdev binary - try common locations
    let packdevCmd = 'packdev';
    const possiblePaths = [
      'node ../dist/index.js',  // Relative to test directory
      'npx packdev',            // Global install
      'packdev'                 // PATH
    ];

    // Find working packdev command
    let success = false;
    for (const cmd of possiblePaths) {
      try {
        execSync(cmd + ' --version', { stdio: 'pipe', timeout: 5000 });
        packdevCmd = cmd;
        success = true;
        break;
      } catch (error) {
        continue;
      }
    }

    if (!success) {
      logError('❌ Auto-commit failed: packdev binary not found');
      return false;
    }

    // Step 1: Check if package.json currently has local dependencies
    let hadLocalDeps = false;
    try {
      const packageJson = JSON.parse(require('fs').readFileSync('package.json', 'utf8'));
      for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        if (packageJson[section]) {
          for (const [name, version] of Object.entries(packageJson[section])) {
            if (typeof version === 'string' && (version.startsWith('file:') || version.startsWith('./'))) {
              hadLocalDeps = true;
              break;
            }
          }
        }
        if (hadLocalDeps) break;
      }
    } catch (error) {
      logError('❌ Failed to check package.json: ' + error.message);
      return false;
    }

    if (!hadLocalDeps) {
      logInfo('ℹ️  No local dependencies found, nothing to restore');
      return true;
    }

    // Step 2: Run packdev finish to restore original dependencies
    try {
      execSync(packdevCmd + ' finish', { stdio: 'pipe', timeout: 10000 });
      logInfo('✅ Dependencies restored to original versions');
    } catch (error) {
      logError('❌ Failed to restore dependencies: ' + error.message);
      return false;
    }

    // Step 3: Add the updated package.json to the commit (if there are changes)
    try {
      execSync('git add package.json', { stdio: 'pipe' });
      logInfo('✅ Updated package.json added to commit');
    } catch (error) {
      logError('❌ Failed to stage package.json: ' + error.message);
      return false;
    }

    // Step 4: Check if package-lock.json exists and add it too
    try {
      const fs = require('fs');
      if (fs.existsSync('package-lock.json')) {
        execSync('git add package-lock.json', { stdio: 'pipe' });
        logInfo('✅ Updated package-lock.json added to commit');
      }
    } catch (error) {
      // Not critical, continue
    }

    logSuccess('✅ Your commit will include both your changes AND restored dependencies');
    return true;
  } catch (error) {
    logError('❌ Auto-commit preparation failed: ' + error.message);
    return false;
  }
}




async function main() {
  // Check for debug/verbose mode
  const isVerbose = process.argv.includes('--verbose') || process.env.PACKDEV_VERBOSE === '1';

  if (isVerbose) {
    logInfo('packdev Safety Check: Checking for local file dependencies...');
  }

  const { hasLocal, dependencies } = hasLocalFileDependencies();

  if (!hasLocal) {
    if (isVerbose) {
      logSuccess('No local file dependencies found. Commit allowed.');
    }
    process.exit(0);
  }

  // Found local dependencies
  if (isVerbose) {
    logWarning('Local file dependencies detected:');
    dependencies.forEach(dep => {
      console.log('  📦 ' + dep.name + ': ' + dep.version + ' (' + dep.section + ')');
    });
  }

  const commitMessage = getCommitMessage();
  const isWip = isWipCommit(commitMessage) || isWipFromGitProcess();

  if (isVerbose) {
    logInfo('Commit message: "' + commitMessage + '"');
    logInfo('WIP detected: ' + isWip);
  }

  if (isWip) {
    logInfo('WIP detected in commit message. Allowing commit with local dependencies.');
    logInfo('⚠️  Remember to restore original dependencies before final commit!');
    process.exit(0);
  }

  // Check if auto-commit flow is enabled
  const config = loadPackdevConfig();
  const autoCommitFlowEnabled = config && config.autoCommitFlow === true;

  if (autoCommitFlowEnabled) {
    logWarning('Local dependencies detected, auto-restoring...');

    // Check for environment variable override
    const envOverride = process.env.PACKDEV_AUTO_COMMIT;
    if (envOverride && envOverride.toLowerCase() === 'no') {
      logInfo('Auto-commit disabled by environment variable');
    } else {
      // Auto-commit flow is enabled, restore dependencies and include in commit
      try {
        const success = await executeAutoCommitFlow();
        if (success) {
          logSuccess('✅ Dependencies restored and added to your commit');
          process.exit(0); // Allow the commit to proceed
        } else {
          process.exit(1); // Block the commit
        }
      } catch (error) {
        logError('Auto-commit flow failed: ' + error.message);
        process.exit(1);
      }
    }
  }

  // Block the commit - show minimal message
  logError('Commit blocked: Local dependencies detected');
  console.log('Run "packdev finish" or use "WIP:" in commit message to bypass');
  console.log('');

  process.exit(1);
}

if (require.main === module) {
  main().catch(error => {
    logError(\`Unexpected error: \${error.message}\`);
    process.exit(1);
  });
}
`;

    // Create the pre-commit hook
    const preCommitHook = `#!/bin/sh
#
# packdev Safety Hook - Pre-commit check for local dependencies
# Generated by packdev setup-hooks command
#

# Check if the safety check script exists
if [ -f ".git/hooks/check-local-deps.js" ]; then
    # Ensure we have a controlling terminal for interactive prompts
    # This is crucial for git hooks to work with user input
    if [ -t 0 ]; then
        # We already have a terminal
        node .git/hooks/check-local-deps.js "$@"
    else
        # Try to connect to controlling terminal
        if [ -e /dev/tty ]; then
            node .git/hooks/check-local-deps.js "$@" < /dev/tty
        else
            # Fallback for systems without /dev/tty
            node .git/hooks/check-local-deps.js "$@"
        fi
    fi
    exit_code=$?

    if [ $exit_code -ne 0 ]; then
        echo ""
        echo "🚫 Commit aborted by packdev safety check"
        echo ""
        exit $exit_code
    fi
fi
`;

    // Write the files
    await fs.writeFile(checkScriptFile, checkScript);
    await fs.writeFile(preCommitFile, preCommitHook);

    // Make pre-commit hook executable (Unix systems)
    try {
      await fs.chmod(preCommitFile, 0o755);
    } catch {
      // Windows or permission issue, not critical
    }

    // Setup instructions
    const setupMessage = `
Created Git safety hooks in .git/hooks/
${
  autoCommitFlow
    ? `Auto-commit flow enabled: Dependencies are automatically restored during commits.
- Dependencies are automatically restored before committing
- Your commit message and changes are preserved
- Clean dependencies are included in the same commit
- No user prompting - the process is fully automated`
    : `The hooks are automatically active and will prevent commits with development dependencies unless:
1. You run 'packdev finish' to restore original dependencies, or
2. You include 'WIP' in your commit message`
}

The hooks are now ready to use!`;

    return {
      success: true,
      message: setupMessage.trim(),
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to setup hooks: ${error instanceof Error ? error.message : "Unknown error"}`,
    };
  }
}

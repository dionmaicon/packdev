"use strict";
/**
 * Utility functions for local package development management
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizePath = normalizePath;
exports.resolveRelativePath = resolveRelativePath;
exports.getRelativePath = getRelativePath;
exports.isAbsolutePath = isAbsolutePath;
exports.validatePackageName = validatePackageName;
exports.formatPackageName = formatPackageName;
exports.extractPackageScope = extractPackageScope;
exports.isValidSemver = isValidSemver;
exports.normalizeVersion = normalizeVersion;
exports.isVersionRange = isVersionRange;
exports.parseVersionRange = parseVersionRange;
exports.fileExists = fileExists;
exports.isDirectory = isDirectory;
exports.readJsonFile = readJsonFile;
exports.writeJsonFile = writeJsonFile;
exports.createBackup = createBackup;
exports.validateLocalPackage = validateLocalPackage;
exports.createFileUrl = createFileUrl;
exports.isFileUrl = isFileUrl;
exports.extractFileUrl = extractFileUrl;
exports.isDevelopmentDependency = isDevelopmentDependency;
exports.groupBy = groupBy;
exports.omit = omit;
exports.pick = pick;
exports.delay = delay;
exports.retryOperation = retryOperation;
exports.formatSize = formatSize;
exports.formatDuration = formatDuration;
exports.createTimestamp = createTimestamp;
exports.formatTimestamp = formatTimestamp;
exports.deepMerge = deepMerge;
exports.flattenObject = flattenObject;
const path = __importStar(require("path"));
const fs = __importStar(require("fs/promises"));
// Path utilities
function normalizePath(inputPath) {
    return path.normalize(inputPath).replace(/\\/g, "/");
}
function resolveRelativePath(basePath, targetPath) {
    return path.resolve(basePath, targetPath);
}
function getRelativePath(from, to) {
    return path.relative(from, to).replace(/\\/g, "/");
}
function isAbsolutePath(inputPath) {
    return path.isAbsolute(inputPath);
}
// Package name utilities
function validatePackageName(name) {
    // NPM package name validation
    const packageNameRegex = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
    return packageNameRegex.test(name) && name.length <= 214;
}
function formatPackageName(name) {
    return name.toLowerCase().replace(/[^a-z0-9@\-._~\/]/g, "-");
}
function extractPackageScope(name) {
    const match = name.match(/^(@[^/]+)\/(.+)$/);
    if (match && match[1] && match[2]) {
        return { scope: match[1], name: match[2] };
    }
    return { name };
}
// Version utilities
function isValidSemver(version) {
    const semverRegex = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+(?:[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;
    return semverRegex.test(version);
}
function normalizeVersion(version) {
    // Remove prefixes like ^, ~, >=, etc.
    return version.replace(/^[\^~>=<]+/, "");
}
function isVersionRange(version) {
    return /^[\^~>=<]/.test(version);
}
function parseVersionRange(version) {
    const match = version.match(/^([\^~>=<]+)(.+)$/);
    if (match && match[1] && match[2]) {
        return { operator: match[1], version: match[2] };
    }
    return { operator: "", version };
}
// File utilities
async function fileExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    }
    catch {
        return false;
    }
}
async function isDirectory(dirPath) {
    try {
        const stats = await fs.stat(dirPath);
        return stats.isDirectory();
    }
    catch {
        return false;
    }
}
async function readJsonFile(filePath) {
    try {
        const content = await fs.readFile(filePath, "utf-8");
        return JSON.parse(content);
    }
    catch {
        return null;
    }
}
async function writeJsonFile(filePath, data, indent = 2) {
    const content = JSON.stringify(data, null, indent);
    await fs.writeFile(filePath, content + "\n", "utf-8");
}
async function createBackup(filePath, suffix = ".backup") {
    const backupPath = `${filePath}${suffix}`;
    await fs.copyFile(filePath, backupPath);
    return backupPath;
}
// Local package validation
async function validateLocalPackage(packagePath) {
    const result = {
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
        const packageInfo = await readJsonFile(packageJsonPath);
        if (!packageInfo) {
            result.issues.push(`Invalid package.json in: ${packagePath}`);
            return result;
        }
        result.packageInfo = packageInfo;
        // Validate package name
        if (!packageInfo.name) {
            result.issues.push("Package name is missing");
        }
        else if (!validatePackageName(packageInfo.name)) {
            result.issues.push(`Invalid package name: ${packageInfo.name}`);
        }
        // Validate version
        if (!packageInfo.version) {
            result.issues.push("Package version is missing");
        }
        else if (!isValidSemver(packageInfo.version)) {
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
    }
    catch (error) {
        result.issues.push(`Error validating package: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
    return result;
}
// Dependency utilities
function createFileUrl(filePath) {
    const absolutePath = path.resolve(filePath);
    return `file:${absolutePath}`;
}
function isFileUrl(url) {
    return url.startsWith("file:");
}
function extractFileUrl(url) {
    return url.replace(/^file:/, "");
}
function isDevelopmentDependency(version) {
    return (isFileUrl(version) || version.includes("file:") || version.includes("link:"));
}
// Array and object utilities
function groupBy(array, keyFn) {
    return array.reduce((result, item) => {
        const key = keyFn(item);
        if (!result[key]) {
            result[key] = [];
        }
        result[key].push(item);
        return result;
    }, {});
}
function omit(obj, keys) {
    const result = { ...obj };
    keys.forEach((key) => delete result[key]);
    return result;
}
function pick(obj, keys) {
    const result = {};
    keys.forEach((key) => {
        if (key in obj) {
            result[key] = obj[key];
        }
    });
    return result;
}
// Async utilities
async function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
async function retryOperation(operation, maxRetries = 3, delayMs = 1000) {
    let lastError;
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await operation();
        }
        catch (error) {
            lastError = error;
            if (i < maxRetries - 1) {
                await delay(delayMs);
            }
        }
    }
    throw lastError;
}
// Logging and formatting utilities
function formatSize(bytes) {
    const units = ["B", "KB", "MB", "GB"];
    let size = bytes;
    let unitIndex = 0;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }
    return `${size.toFixed(1)}${units[unitIndex]}`;
}
function formatDuration(ms) {
    if (ms < 1000)
        return `${ms}ms`;
    if (ms < 60000)
        return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3600000)
        return `${(ms / 60000).toFixed(1)}m`;
    return `${(ms / 3600000).toFixed(1)}h`;
}
function createTimestamp() {
    return new Date().toISOString();
}
function formatTimestamp(date) {
    const d = typeof date === "string" ? new Date(date) : date;
    return d.toLocaleString();
}
// Configuration utilities
function deepMerge(target, source) {
    const result = { ...target };
    for (const key in source) {
        if (source.hasOwnProperty(key)) {
            const sourceValue = source[key];
            const targetValue = result[key];
            if (sourceValue &&
                typeof sourceValue === "object" &&
                !Array.isArray(sourceValue) &&
                targetValue &&
                typeof targetValue === "object" &&
                !Array.isArray(targetValue)) {
                result[key] = deepMerge(targetValue, sourceValue);
            }
            else if (sourceValue !== undefined) {
                result[key] = sourceValue;
            }
        }
    }
    return result;
}
function flattenObject(obj, prefix = "") {
    const flattened = {};
    for (const [key, value] of Object.entries(obj)) {
        const newKey = prefix ? `${prefix}.${key}` : key;
        if (value && typeof value === "object" && !Array.isArray(value)) {
            Object.assign(flattened, flattenObject(value, newKey));
        }
        else {
            flattened[newKey] = value;
        }
    }
    return flattened;
}
//# sourceMappingURL=utils.js.map
/**
 * Utility functions for local package development management
 */
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
export declare function normalizePath(inputPath: string): string;
export declare function resolveRelativePath(basePath: string, targetPath: string): string;
export declare function getRelativePath(from: string, to: string): string;
export declare function isAbsolutePath(inputPath: string): boolean;
export declare function validatePackageName(name: string): boolean;
export declare function formatPackageName(name: string): string;
export declare function extractPackageScope(name: string): {
    scope?: string;
    name: string;
};
export declare function isValidSemver(version: string): boolean;
export declare function normalizeVersion(version: string): string;
export declare function isVersionRange(version: string): boolean;
export declare function parseVersionRange(version: string): {
    operator: string;
    version: string;
};
export declare function fileExists(filePath: string): Promise<boolean>;
export declare function isDirectory(dirPath: string): Promise<boolean>;
export declare function readJsonFile<T>(filePath: string): Promise<T | null>;
export declare function writeJsonFile<T>(filePath: string, data: T, indent?: number): Promise<void>;
export declare function createBackup(filePath: string, suffix?: string): Promise<string>;
export declare function validateLocalPackage(packagePath: string): Promise<LocalPackageValidation>;
export declare function createFileUrl(filePath: string): string;
export declare function isFileUrl(url: string): boolean;
export declare function extractFileUrl(url: string): string;
export declare function isDevelopmentDependency(version: string): boolean;
export declare function groupBy<T, K extends string | number | symbol>(array: T[], keyFn: (item: T) => K): Record<K, T[]>;
export declare function omit<T extends object, K extends keyof T>(obj: T, keys: K[]): Omit<T, K>;
export declare function pick<T extends object, K extends keyof T>(obj: T, keys: K[]): Pick<T, K>;
export declare function delay(ms: number): Promise<void>;
export declare function retryOperation<T>(operation: () => Promise<T>, maxRetries?: number, delayMs?: number): Promise<T>;
export declare function formatSize(bytes: number): string;
export declare function formatDuration(ms: number): string;
export declare function createTimestamp(): string;
export declare function formatTimestamp(date: Date | string): string;
export declare function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T;
export declare function flattenObject(obj: object, prefix?: string): Record<string, any>;
//# sourceMappingURL=utils.d.ts.map
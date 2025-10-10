export interface PackdevDependency {
    package: string;
    location: string;
    version: string;
    type?: "local" | "git";
}
export interface PackdevConfig {
    version: string;
    dependencies: PackdevDependency[];
    created: string;
    lastModified?: string;
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
interface GitReference {
    url: string;
    ref: string | undefined;
    protocol: "https" | "ssh" | "git";
}
export declare function parseGitUrl(gitUrl: string): GitReference | null;
export declare function loadConfig(configPath: string): Promise<PackdevConfig | null>;
export declare function saveConfig(configPath: string, config: PackdevConfig): Promise<void>;
export declare function loadPackageJson(): Promise<PackageJson | null>;
export declare function savePackageJson(packageJson: PackageJson): Promise<void>;
export declare function initializeProject(configPath?: string, autoInstall?: boolean): Promise<InitResult>;
export declare function finishProject(configPath?: string, autoInstall?: boolean): Promise<FinishResult>;
export declare function addLocalDependency(packageName: string, location: string, configPath?: string, explicitVersion?: string, autoInstall?: boolean): Promise<AddDependencyResult>;
export declare function removeLocalDependency(packageName: string, configPath?: string): Promise<RemoveDependencyResult>;
export declare function listLocalDependencies(configPath?: string): Promise<ListDependenciesResult>;
export declare function validateProject(configPath?: string): Promise<ValidationResult>;
/**
 * Setup GitHub pre-commit hooks to prevent accidental development dependency commits
 */
export declare function setupGitHooks(force?: boolean, disable?: boolean): Promise<SetupHooksResult>;
export {};
//# sourceMappingURL=packageManager.d.ts.map
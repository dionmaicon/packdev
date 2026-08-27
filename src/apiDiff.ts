/**
 * Orchestrates the api-diff track: scan the app's real usage of a package,
 * fetch candidate versions from the registry, and check each one's export
 * map against that usage — entirely statically, no install.
 *
 * This only verifies API *shape*. It never claims runtime/behavioral
 * compatibility (that's the `compat` runtime track) — callers must keep the
 * `apiCompatible` label honest and not present it as a test PASS/FAIL.
 */

import * as path from "path";
import * as ts from "typescript";
import { readJsonFile, type PackageInfo } from "./utils";
import {
  resolvePackageExportMap,
  resolveEntryPoint,
  extractRawExportHints,
  findUnresolvableReexportsForPackage,
  resolveInstalledPackage,
  type ExportedSymbolWithSubpath,
  type UnresolvedReexports,
} from "./api";
import { scanImportedSymbols } from "./appScan";
import {
  fetchPackageMetadata,
  listVersionsInRange,
  downloadTarball,
  extractTarball,
  cleanupExtractedTarball,
  resolveTypesPackageTarball,
} from "./registry";

export type TypesSource = "bundled" | "types-package" | "none";

export interface ApiDiffVersionResult {
  version: string;
  // null means "couldn't be verified" (see unresolvedSymbols) — a distinct,
  // honest third state from true/false, not a synonym for "incompatible".
  apiCompatible: boolean | null;
  missingSymbols: string[];
  // Symbols the app uses that this version's types exist for but couldn't be
  // statically confirmed present or absent — typically a barrel .d.ts
  // (`export * from "./generated"`) the isolated single-file program can't
  // follow. These are never counted as missing: reporting a real symbol as
  // absent when it can't actually be verified is a false negative, worse
  // than admitting "unknown" (see api's rawExportHints fallback, the same
  // underlying limitation).
  unresolvedSymbols: string[];
  exportCount: number;
  typesSource: TypesSource;
  // Set only when typesSource is "types-package" — the @types/<pkg> package
  // and version actually used to resolve the surface, so a reader can judge
  // for themselves whether it tracks this candidate.
  typesPackage?: string;
  typesPackageVersion?: string;
  // True when typesSource is "types-package" and no @types version shares
  // this candidate's major — the types were the best available guess, not a
  // verified match, and apiCompatible is forced to null to say so honestly.
  typesPackageVersionMismatch?: boolean;
  // Set when this candidate looks ESM-only (adds "type":"module", or drops
  // a CJS "require"/"default" condition) relative to the control (installed)
  // version — a signal that a CommonJS test runner (e.g. Jest with default
  // transformIgnorePatterns) may fail even though this static check passes.
  esmOnlyAdvisory?: string;
}

export interface ApiDiffReport {
  package: string;
  range: string;
  usedSymbols: string[];
  hasDynamicUsage: boolean;
  minimumCompatibleVersion: string | null;
  recommendedVersion: string | null;
  versions: ApiDiffVersionResult[];
}

export interface ApiDiffOptions {
  range: string;
  appDir: string;
  registryUrl: string;
  token?: string | undefined;
  includePrerelease?: boolean;
  includeDeprecated?: boolean;
}

interface ResolvedExports {
  exports: ExportedSymbolWithSubpath[];
  typesSource: TypesSource;
  extraCleanupDir?: string;
  // Non-null when types exist but resolved to zero exports and a raw syntax
  // scan of the root .d.ts still found export-shaped content (barrel
  // re-exports, generic wrappers, ...) — signals "unverifiable", not "empty".
  unresolved: boolean;
  // Root-level `export ... from "spec"` statements whose target couldn't be
  // resolved (local file genuinely missing, or — far more commonly — a
  // sibling npm package not present in this isolated extraction). Distinct
  // from `unresolved` above: this applies even when SOME exports resolved
  // fine (a barrel mixing local and cross-package re-exports), so only the
  // specifically-affected used symbols get downgraded to unresolved instead
  // of every used symbol in the file.
  reexports: UnresolvedReexports;
  typesPackage?: string;
  typesPackageVersion?: string;
  typesPackageVersionMismatch?: boolean;
}

// Types resolved but produced zero exports — check whether that's a
// genuinely empty declaration file or an unresolvable barrel/re-export the
// isolated single-file program can't follow (same detection api's
// rawExportHints fallback uses). Only the latter should suppress
// missingSymbols — a truly empty .d.ts legitimately exports nothing.
async function hasUnresolvableBarrelContent(
  pkgDir: string,
  packageInfo: PackageInfo,
): Promise<boolean> {
  const { typesPath } = await resolveEntryPoint(pkgDir, packageInfo);
  if (!typesPath) return false;
  return extractRawExportHints(typesPath).length > 0;
}

// Bundled types (root export plus any subpath exports, e.g. pkg/testing) win
// when present. Otherwise, since the tarball was extracted into an isolated
// temp dir with no node_modules tree, the local @types sibling-lookup
// fallback used by resolvePackageExportMap's root resolution has nothing to
// search — so fetch @types/<pkg> from the same registry instead, and merge
// its own root+subpath exports the same way.
async function resolveExportsForVersion(
  pkgName: string,
  version: string,
  packageDir: string,
  packageInfo: PackageInfo,
  registryUrl: string,
  token: string | undefined,
): Promise<ResolvedExports> {
  const noReexports: UnresolvedReexports = { wildcard: false, namedUnresolved: new Set() };
  const bundled = await resolvePackageExportMap(packageDir, packageInfo);
  if (bundled.hasTypes) {
    const unresolved =
      bundled.exports.length === 0 &&
      (await hasUnresolvableBarrelContent(packageDir, packageInfo));
    const reexports = await findUnresolvableReexportsForPackage(packageDir, packageInfo);
    return { exports: bundled.exports, typesSource: "bundled", unresolved, reexports };
  }

  const typesMatch = await resolveTypesPackageTarball(
    pkgName,
    version,
    registryUrl,
    token,
  );
  if (!typesMatch) {
    return { exports: [], typesSource: "none", unresolved: false, reexports: noReexports };
  }

  const typesBuffer = await downloadTarball(typesMatch.tarball, token);
  const { packageDir: typesPkgDir, cleanupDir: typesCleanupDir } =
    await extractTarball(typesBuffer);

  const typesPkgInfo = await readJsonFile<PackageInfo>(
    path.join(typesPkgDir, "package.json"),
  );
  if (!typesPkgInfo) {
    await cleanupExtractedTarball(typesCleanupDir);
    return { exports: [], typesSource: "none", unresolved: false, reexports: noReexports };
  }

  const resolved = await resolvePackageExportMap(typesPkgDir, typesPkgInfo);
  if (!resolved.hasTypes) {
    await cleanupExtractedTarball(typesCleanupDir);
    return { exports: [], typesSource: "none", unresolved: false, reexports: noReexports };
  }

  const unresolved =
    resolved.exports.length === 0 &&
    (await hasUnresolvableBarrelContent(typesPkgDir, typesPkgInfo));
  const reexports = await findUnresolvableReexportsForPackage(typesPkgDir, typesPkgInfo);

  return {
    exports: resolved.exports,
    typesSource: "types-package",
    extraCleanupDir: typesCleanupDir,
    unresolved,
    reexports,
    typesPackage: typesPkgInfo.name,
    typesPackageVersion: typesMatch.version,
    typesPackageVersionMismatch: !typesMatch.majorMatched,
  };
}

// With esModuleInterop/allowSyntheticDefaultImports on, `import x from "mod"`
// against a module with no real default export is satisfied by TS/Node
// synthesizing one from the whole CJS namespace — reporting "default"
// missing there is flagging a rule the consumer has explicitly opted out of.
function consumerAllowsSyntheticDefault(appDir: string): boolean {
  const configPath = ts.findConfigFile(appDir, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) return false;
  const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
  if (configFile.error || !configFile.config) return false;
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(configPath),
  );
  return !!(parsed.options.esModuleInterop || parsed.options.allowSyntheticDefaultImports);
}

// The root (".") entry of a package's "exports" map, or null if there's no
// usable object to inspect. Guards against the same ambiguity
// findTypesCondition's fallback has: with no explicit "." key, sibling
// "./subpath" keys must not be treated as part of the root's own conditions.
function rootExportsEntry(exportsField: unknown): unknown {
  if (!exportsField || typeof exportsField !== "object" || Array.isArray(exportsField)) {
    return null;
  }
  const obj = exportsField as Record<string, unknown>;
  if ("." in obj) return obj["."];
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (!key.startsWith(".")) filtered[key] = value;
  }
  return filtered;
}

function hasConditionDeep(node: unknown, condition: string): boolean {
  if (!node || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((entry) => hasConditionDeep(entry, condition));
  const obj = node as Record<string, unknown>;
  if (condition in obj) return true;
  return Object.values(obj).some((value) => hasConditionDeep(value, condition));
}

// Whether a package's root entry is reachable via CommonJS require() at all.
// No "exports" map (plain "main"-based resolution) or a string-shorthand
// entry both count as reachable — only an object-form exports map that
// declares conditions but omits "require"/"default" among them actually
// blocks require() for the root.
export function hasCjsRootEntry(packageInfo: PackageInfo): boolean {
  const exportsField = packageInfo.exports;
  if (exportsField === undefined || exportsField === null) return true;
  if (typeof exportsField === "string") return true;
  const rootEntry = rootExportsEntry(exportsField);
  if (typeof rootEntry === "string") return true;
  return hasConditionDeep(rootEntry, "require") || hasConditionDeep(rootEntry, "default");
}

// Flags a candidate that looks ESM-only relative to the control (installed)
// version — the one class of break `compat --test "tsc --noEmit"` (a type
// checker with no runner) structurally cannot see, since Node's module
// loader and Jest's CJS transform behave differently from tsc here. Fires on
// either of the two ways a package goes ESM-only: adding "type":"module", or
// — for an already dual-mode package — dropping the CJS "require"/"default"
// condition from its "exports" map without touching "type" at all.
export function esmOnlyAdvisory(
  controlInfo: PackageInfo | null,
  candidateInfo: PackageInfo,
): string | undefined {
  if (!controlInfo) return undefined;
  const controlIsModule = controlInfo.type === "module";
  const candidateIsModule = candidateInfo.type === "module";
  if (!controlIsModule && candidateIsModule) {
    return (
      'candidate adds "type":"module" (ESM-only) relative to the installed version; ' +
      "a CommonJS test runner (e.g. Jest with default transformIgnorePatterns) may fail " +
      "even though this static check passes — make sure --test runs your test suite, not just a type check"
    );
  }
  if (hasCjsRootEntry(controlInfo) && !hasCjsRootEntry(candidateInfo)) {
    return (
      'candidate drops the CJS "require"/"default" export condition (ESM-only via its ' +
      '"exports" map) relative to the installed version; a CommonJS test runner (e.g. Jest ' +
      "with default transformIgnorePatterns) may fail even though this static check passes " +
      "— make sure --test runs your test suite, not just a type check"
    );
  }
  return undefined;
}

async function diffOneVersion(
  pkgName: string,
  version: string,
  tarballUrl: string,
  usedSymbols: Set<string>,
  registryUrl: string,
  token: string | undefined,
  allowSyntheticDefault: boolean,
  controlInfo: PackageInfo | null,
): Promise<{
  missingSymbols: string[];
  unresolvedSymbols: string[];
  exportCount: number;
  typesSource: TypesSource;
  typesPackage?: string;
  typesPackageVersion?: string;
  typesPackageVersionMismatch?: boolean;
  esmOnlyAdvisory?: string;
}> {
  const buffer = await downloadTarball(tarballUrl, token);
  const { packageDir, cleanupDir } = await extractTarball(buffer);
  let extraCleanupDir: string | undefined;

  try {
    const packageInfo = await readJsonFile<PackageInfo>(
      path.join(packageDir, "package.json"),
    );
    if (!packageInfo) {
      throw new Error(
        `Invalid package.json in extracted tarball for ${pkgName}@${version}`,
      );
    }

    const resolved = await resolveExportsForVersion(
      pkgName,
      version,
      packageDir,
      packageInfo,
      registryUrl,
      token,
    );
    extraCleanupDir = resolved.extraCleanupDir;

    const exportedNames = new Set(resolved.exports.map((e) => e.name));

    // An unresolved barrel means we genuinely can't tell which used symbols
    // are present — reporting them all as "missing" would be a confident
    // false negative (worse than the pre-registry-auth 401 this replaced:
    // it now runs and looks authoritative). Report them as unresolved
    // instead, never as missing, when resolution itself couldn't verify.
    let missingSymbols: string[];
    let unresolvedSymbols: string[];
    if (resolved.unresolved) {
      missingSymbols = [];
      unresolvedSymbols = [...usedSymbols].sort();
    } else {
      // A symbol not found among resolved exports is only genuinely
      // "missing" when no unresolvable re-export statement could plausibly
      // have supplied it — a named re-export (`export { A } from X`) names
      // its affected symbols exactly; a wildcard/namespace re-export
      // (`export * from X`) could have supplied ANY unmatched symbol.
      const unresolvedSet = new Set<string>();
      for (const symbol of usedSymbols) {
        if (exportedNames.has(symbol)) continue;
        if (resolved.reexports.namedUnresolved.has(symbol) || resolved.reexports.wildcard) {
          unresolvedSet.add(symbol);
        }
      }
      unresolvedSymbols = [...unresolvedSet].sort();
      missingSymbols = [...usedSymbols]
        .filter((symbol) => !exportedNames.has(symbol) && !unresolvedSet.has(symbol))
        .sort();
    }

    // Sorted alphabetically (not scan/insertion order) so the same symbol
    // lands in the same relative position across every version's list —
    // that's what makes two versions' missing/unresolved lists diffable at
    // a glance instead of needing to be re-read symbol-by-symbol each time.
    if (allowSyntheticDefault) {
      missingSymbols = missingSymbols.filter((symbol) => symbol !== "default");
    }

    const advisory = esmOnlyAdvisory(controlInfo, packageInfo);
    return {
      missingSymbols,
      unresolvedSymbols,
      exportCount: resolved.exports.length,
      typesSource: resolved.typesSource,
      ...(resolved.typesPackage !== undefined ? { typesPackage: resolved.typesPackage } : {}),
      ...(resolved.typesPackageVersion !== undefined
        ? { typesPackageVersion: resolved.typesPackageVersion }
        : {}),
      ...(resolved.typesPackageVersionMismatch !== undefined
        ? { typesPackageVersionMismatch: resolved.typesPackageVersionMismatch }
        : {}),
      ...(advisory !== undefined ? { esmOnlyAdvisory: advisory } : {}),
    };
  } finally {
    await cleanupExtractedTarball(cleanupDir);
    if (extraCleanupDir) await cleanupExtractedTarball(extraCleanupDir);
  }
}

export async function runApiDiff(
  pkgName: string,
  options: ApiDiffOptions,
): Promise<ApiDiffReport> {
  const { symbols, hasDynamicUsage } = await scanImportedSymbols(
    options.appDir,
    pkgName,
  );

  const metadata = await fetchPackageMetadata(
    pkgName,
    options.registryUrl,
    options.token,
  );
  const versionsInRange = listVersionsInRange(metadata, options.range, {
    includePrerelease: options.includePrerelease,
    includeDeprecated: options.includeDeprecated,
  });

  const allowSyntheticDefault = consumerAllowsSyntheticDefault(options.appDir);
  const installedDir = await resolveInstalledPackage(pkgName, options.appDir);
  const controlInfo = installedDir
    ? await readJsonFile<PackageInfo>(path.join(installedDir, "package.json"))
    : null;

  const versions: ApiDiffVersionResult[] = [];
  for (const version of versionsInRange) {
    const dist = metadata.versions[version]?.dist;
    if (!dist) continue;

    const {
      missingSymbols,
      unresolvedSymbols,
      exportCount,
      typesSource,
      typesPackage,
      typesPackageVersion,
      typesPackageVersionMismatch,
      esmOnlyAdvisory: advisory,
    } = await diffOneVersion(
      pkgName,
      version,
      dist.tarball,
      symbols,
      options.registryUrl,
      options.token,
      allowSyntheticDefault,
      controlInfo,
    );

    // unresolvedSymbols is only non-empty when there was something to
    // verify and resolution couldn't — apiCompatible: null then means
    // "couldn't determine", never "incompatible". When the app doesn't
    // import anything (usedSymbols empty), unresolvedSymbols stays empty
    // even for an unresolved barrel, so apiCompatible correctly stays
    // `true` (nothing to miss) rather than downgrading to unknown.
    let apiCompatible: boolean | null =
      unresolvedSymbols.length > 0 ? null : missingSymbols.length === 0;
    // Types resolved via a @types/<pkg> version that doesn't share this
    // candidate's major aren't a verified match — don't let a resulting
    // false negative assert incompatibility with confidence it doesn't have.
    if (typesPackageVersionMismatch && apiCompatible === false) {
      apiCompatible = null;
    }

    versions.push({
      version,
      apiCompatible,
      missingSymbols,
      unresolvedSymbols,
      exportCount,
      typesSource,
      ...(typesPackage ? { typesPackage } : {}),
      ...(typesPackageVersion ? { typesPackageVersion } : {}),
      ...(typesPackageVersionMismatch ? { typesPackageVersionMismatch } : {}),
      ...(advisory ? { esmOnlyAdvisory: advisory } : {}),
    });
  }

  const compatibleVersions = versions.filter((v) => v.apiCompatible === true);
  const minimumCompatibleVersion = compatibleVersions[0]?.version ?? null;
  const recommendedVersion =
    compatibleVersions[compatibleVersions.length - 1]?.version ?? null;

  return {
    package: pkgName,
    range: options.range,
    usedSymbols: [...symbols].sort(),
    hasDynamicUsage,
    minimumCompatibleVersion,
    recommendedVersion,
    versions,
  };
}

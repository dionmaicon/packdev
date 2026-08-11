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
import { readJsonFile, type PackageInfo } from "./utils";
import {
  resolvePackageExportMap,
  resolveEntryPoint,
  extractRawExportHints,
  type ExportedSymbolWithSubpath,
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
  const bundled = await resolvePackageExportMap(packageDir, packageInfo);
  if (bundled.hasTypes) {
    const unresolved =
      bundled.exports.length === 0 &&
      (await hasUnresolvableBarrelContent(packageDir, packageInfo));
    return { exports: bundled.exports, typesSource: "bundled", unresolved };
  }

  const typesMatch = await resolveTypesPackageTarball(
    pkgName,
    version,
    registryUrl,
    token,
  );
  if (!typesMatch) {
    return { exports: [], typesSource: "none", unresolved: false };
  }

  const typesBuffer = await downloadTarball(typesMatch.tarball, token);
  const { packageDir: typesPkgDir, cleanupDir: typesCleanupDir } =
    await extractTarball(typesBuffer);

  const typesPkgInfo = await readJsonFile<PackageInfo>(
    path.join(typesPkgDir, "package.json"),
  );
  if (!typesPkgInfo) {
    await cleanupExtractedTarball(typesCleanupDir);
    return { exports: [], typesSource: "none", unresolved: false };
  }

  const resolved = await resolvePackageExportMap(typesPkgDir, typesPkgInfo);
  if (!resolved.hasTypes) {
    await cleanupExtractedTarball(typesCleanupDir);
    return { exports: [], typesSource: "none", unresolved: false };
  }

  const unresolved =
    resolved.exports.length === 0 &&
    (await hasUnresolvableBarrelContent(typesPkgDir, typesPkgInfo));

  return {
    exports: resolved.exports,
    typesSource: "types-package",
    extraCleanupDir: typesCleanupDir,
    unresolved,
  };
}

async function diffOneVersion(
  pkgName: string,
  version: string,
  tarballUrl: string,
  usedSymbols: Set<string>,
  registryUrl: string,
  token: string | undefined,
): Promise<{
  missingSymbols: string[];
  unresolvedSymbols: string[];
  exportCount: number;
  typesSource: TypesSource;
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
    // Sorted alphabetically (not scan/insertion order) so the same symbol
    // lands in the same relative position across every version's list —
    // that's what makes two versions' missing/unresolved lists diffable at
    // a glance instead of needing to be re-read symbol-by-symbol each time.
    const missingSymbols = resolved.unresolved
      ? []
      : [...usedSymbols].filter((symbol) => !exportedNames.has(symbol)).sort();
    const unresolvedSymbols = resolved.unresolved
      ? [...usedSymbols].sort()
      : [];

    return {
      missingSymbols,
      unresolvedSymbols,
      exportCount: resolved.exports.length,
      typesSource: resolved.typesSource,
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

  const versions: ApiDiffVersionResult[] = [];
  for (const version of versionsInRange) {
    const dist = metadata.versions[version]?.dist;
    if (!dist) continue;

    const { missingSymbols, unresolvedSymbols, exportCount, typesSource } =
      await diffOneVersion(
        pkgName,
        version,
        dist.tarball,
        symbols,
        options.registryUrl,
        options.token,
      );

    // unresolvedSymbols is only non-empty when there was something to
    // verify and resolution couldn't — apiCompatible: null then means
    // "couldn't determine", never "incompatible". When the app doesn't
    // import anything (usedSymbols empty), unresolvedSymbols stays empty
    // even for an unresolved barrel, so apiCompatible correctly stays
    // `true` (nothing to miss) rather than downgrading to unknown.
    const apiCompatible =
      unresolvedSymbols.length > 0 ? null : missingSymbols.length === 0;

    versions.push({
      version,
      apiCompatible,
      missingSymbols,
      unresolvedSymbols,
      exportCount,
      typesSource,
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

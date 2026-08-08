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
import { resolvePackageExportMap, type ExportedSymbolWithSubpath } from "./api";
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
  apiCompatible: boolean;
  missingSymbols: string[];
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
  includePrerelease?: boolean;
  includeDeprecated?: boolean;
}

interface ResolvedExports {
  exports: ExportedSymbolWithSubpath[];
  typesSource: TypesSource;
  extraCleanupDir?: string;
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
): Promise<ResolvedExports> {
  const bundled = await resolvePackageExportMap(packageDir, packageInfo);
  if (bundled.hasTypes) {
    return { exports: bundled.exports, typesSource: "bundled" };
  }

  const typesMatch = await resolveTypesPackageTarball(
    pkgName,
    version,
    registryUrl,
  );
  if (!typesMatch) {
    return { exports: [], typesSource: "none" };
  }

  const typesBuffer = await downloadTarball(typesMatch.tarball);
  const { packageDir: typesPkgDir, cleanupDir: typesCleanupDir } =
    await extractTarball(typesBuffer);

  const typesPkgInfo = await readJsonFile<PackageInfo>(
    path.join(typesPkgDir, "package.json"),
  );
  if (!typesPkgInfo) {
    await cleanupExtractedTarball(typesCleanupDir);
    return { exports: [], typesSource: "none" };
  }

  const resolved = await resolvePackageExportMap(typesPkgDir, typesPkgInfo);
  if (!resolved.hasTypes) {
    await cleanupExtractedTarball(typesCleanupDir);
    return { exports: [], typesSource: "none" };
  }

  return {
    exports: resolved.exports,
    typesSource: "types-package",
    extraCleanupDir: typesCleanupDir,
  };
}

async function diffOneVersion(
  pkgName: string,
  version: string,
  tarballUrl: string,
  usedSymbols: Set<string>,
  registryUrl: string,
): Promise<{
  missingSymbols: string[];
  exportCount: number;
  typesSource: TypesSource;
}> {
  const buffer = await downloadTarball(tarballUrl);
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
    );
    extraCleanupDir = resolved.extraCleanupDir;

    const exportedNames = new Set(resolved.exports.map((e) => e.name));

    const missingSymbols = [...usedSymbols].filter(
      (symbol) => !exportedNames.has(symbol),
    );

    return {
      missingSymbols,
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

  const metadata = await fetchPackageMetadata(pkgName, options.registryUrl);
  const versionsInRange = listVersionsInRange(metadata, options.range, {
    includePrerelease: options.includePrerelease,
    includeDeprecated: options.includeDeprecated,
  });

  const versions: ApiDiffVersionResult[] = [];
  for (const version of versionsInRange) {
    const dist = metadata.versions[version]?.dist;
    if (!dist) continue;

    const { missingSymbols, exportCount, typesSource } = await diffOneVersion(
      pkgName,
      version,
      dist.tarball,
      symbols,
      options.registryUrl,
    );

    versions.push({
      version,
      apiCompatible: missingSymbols.length === 0,
      missingSymbols,
      exportCount,
      typesSource,
    });
  }

  const compatibleVersions = versions.filter((v) => v.apiCompatible);
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

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
import { resolveEntryPoint, extractExportMap } from "./api";
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

interface ResolvedTypes {
  typesPath: string | null;
  typesSource: TypesSource;
  extraCleanupDir?: string;
}

// Bundled types win when present. Otherwise, since the tarball was extracted
// into an isolated temp dir with no node_modules tree, the local @types
// sibling-lookup fallback used by Phase 1's resolveEntryPoint has nothing to
// search — so fetch @types/<pkg> from the same registry instead.
async function resolveTypesForVersion(
  pkgName: string,
  version: string,
  packageDir: string,
  packageInfo: PackageInfo,
  registryUrl: string,
): Promise<ResolvedTypes> {
  const bundled = await resolveEntryPoint(packageDir, packageInfo);
  if (bundled.typesPath) {
    return { typesPath: bundled.typesPath, typesSource: "bundled" };
  }

  const typesMatch = await resolveTypesPackageTarball(
    pkgName,
    version,
    registryUrl,
  );
  if (!typesMatch) {
    return { typesPath: null, typesSource: "none" };
  }

  const typesBuffer = await downloadTarball(typesMatch.tarball);
  const { packageDir: typesPkgDir, cleanupDir: typesCleanupDir } =
    await extractTarball(typesBuffer);

  const typesPkgInfo = await readJsonFile<PackageInfo>(
    path.join(typesPkgDir, "package.json"),
  );
  if (!typesPkgInfo) {
    await cleanupExtractedTarball(typesCleanupDir);
    return { typesPath: null, typesSource: "none" };
  }

  const resolved = await resolveEntryPoint(typesPkgDir, typesPkgInfo);
  if (!resolved.typesPath) {
    await cleanupExtractedTarball(typesCleanupDir);
    return { typesPath: null, typesSource: "none" };
  }

  return {
    typesPath: resolved.typesPath,
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

    const resolved = await resolveTypesForVersion(
      pkgName,
      version,
      packageDir,
      packageInfo,
      registryUrl,
    );
    extraCleanupDir = resolved.extraCleanupDir;

    const exportsList = resolved.typesPath
      ? extractExportMap(resolved.typesPath)
      : [];
    const exportedNames = new Set(exportsList.map((e) => e.name));

    const missingSymbols = [...usedSymbols].filter(
      (symbol) => !exportedNames.has(symbol),
    );

    return {
      missingSymbols,
      exportCount: exportsList.length,
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

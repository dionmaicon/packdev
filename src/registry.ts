/**
 * npm registry access for the api-diff track: fetch package metadata, filter
 * versions by range, and download+extract tarballs without ever running
 * `npm install` or touching the consumer's node_modules.
 */

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as semver from "semver";
import * as tar from "tar";
import { toTypesPackageName } from "./api";

export interface RegistryVersionDist {
  tarball: string;
  shasum?: string;
}

export interface RegistryVersionInfo {
  version: string;
  dist: RegistryVersionDist;
  deprecated?: string;
}

export interface RegistryMetadata {
  name: string;
  versions: Record<string, RegistryVersionInfo>;
}

export async function fetchPackageMetadata(
  pkgName: string,
  registryUrl: string,
): Promise<RegistryMetadata> {
  const url = `${registryUrl.replace(/\/+$/, "")}/${encodeURIComponent(pkgName).replace(/^%40/, "@")}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Registry request failed for "${pkgName}" (${response.status} ${response.statusText}) at ${url}`,
    );
  }
  const body = (await response.json()) as {
    name: string;
    versions?: Record<string, RegistryVersionInfo>;
  };
  if (!body.versions) {
    throw new Error(`Registry response for "${pkgName}" had no versions`);
  }
  return { name: body.name, versions: body.versions };
}

export interface ListVersionsOptions {
  includePrerelease?: boolean | undefined;
  includeDeprecated?: boolean | undefined;
}

/**
 * Return the subset of published versions that satisfy `range`, sorted
 * ascending. Prerelease and deprecated versions are excluded by default to
 * keep the matrix free of registry noise.
 */
export function listVersionsInRange(
  metadata: RegistryMetadata,
  range: string,
  options: ListVersionsOptions = {},
): string[] {
  const candidates = Object.values(metadata.versions).filter((info) => {
    if (!semver.valid(info.version)) return false;
    if (!semver.satisfies(info.version, range, { includePrerelease: true })) {
      return false;
    }
    if (!options.includePrerelease && semver.prerelease(info.version)) {
      return false;
    }
    if (!options.includeDeprecated && info.deprecated) {
      return false;
    }
    return true;
  });

  return candidates
    .map((info) => info.version)
    .sort((a, b) => semver.compare(a, b));
}

export interface TypesPackageMatch {
  version: string;
  tarball: string;
}

/**
 * Find the best @types/<pkg> tarball for a source package version, for use
 * when a candidate tarball has no bundled type declarations (the common
 * case for older/plain-JS packages published without their own .d.ts).
 * Prefers a version matching the source's major, falling back to latest.
 * Returns null when no @types package exists at all (404) or has no usable
 * versions — a legitimate "no types available anywhere" outcome.
 */
export async function resolveTypesPackageTarball(
  pkgName: string,
  pkgVersion: string,
  registryUrl: string,
): Promise<TypesPackageMatch | null> {
  const typesPkgName = toTypesPackageName(pkgName);

  let metadata: RegistryMetadata;
  try {
    metadata = await fetchPackageMetadata(typesPkgName, registryUrl);
  } catch {
    return null;
  }

  const versions = Object.values(metadata.versions)
    .map((info) => info.version)
    .filter((v) => semver.valid(v) && !semver.prerelease(v));
  if (versions.length === 0) return null;

  const sourceMajor = semver.major(pkgVersion);
  const sameMajor = versions.filter((v) => semver.major(v) === sourceMajor);
  const pool = sameMajor.length > 0 ? sameMajor : versions;
  const chosen = pool.sort((a, b) => semver.compare(b, a))[0];
  if (!chosen) return null;

  const dist = metadata.versions[chosen]?.dist;
  if (!dist) return null;

  return { version: chosen, tarball: dist.tarball };
}

export async function downloadTarball(tarballUrl: string): Promise<Buffer> {
  const response = await fetch(tarballUrl);
  if (!response.ok) {
    throw new Error(
      `Failed to download tarball (${response.status} ${response.statusText}) from ${tarballUrl}`,
    );
  }
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Extract a downloaded .tgz buffer into a fresh temp directory and return
 * the path to its unpacked root directory. Caller owns cleanup of the
 * returned directory's parent.
 *
 * Tarballs created via `npm publish` always wrap contents in a `package/`
 * directory, but that's a packing convention, not a guarantee — @types/*
 * packages are published via DefinitelyTyped's own pipeline and use the
 * real package name instead (e.g. @types/semver unpacks to `semver/`, not
 * `package/`). Detect the actual single top-level directory instead of
 * assuming its name.
 */
export async function extractTarball(
  buffer: Buffer,
  tmpPrefix: string = "packdev-tarball-extract-",
): Promise<{ packageDir: string; cleanupDir: string }> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), tmpPrefix));
  const tarballPath = path.join(workDir, "package.tgz");
  await fs.writeFile(tarballPath, buffer);

  const extractDir = path.join(workDir, "extracted");
  await fs.mkdir(extractDir);
  await tar.x({ file: tarballPath, cwd: extractDir });

  const entries = await fs.readdir(extractDir, { withFileTypes: true });
  const rootEntry = entries.find((entry) => entry.isDirectory());
  if (!rootEntry) {
    throw new Error("Extracted tarball did not contain a package directory");
  }

  return {
    packageDir: path.join(extractDir, rootEntry.name),
    cleanupDir: workDir,
  };
}

export async function cleanupExtractedTarball(
  cleanupDir: string,
): Promise<void> {
  await fs.rm(cleanupDir, { recursive: true, force: true });
}

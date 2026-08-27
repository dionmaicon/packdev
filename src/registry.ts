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

// --- .npmrc / auth resolution -------------------------------------------
//
// A private scope (GitHub Packages, Artifactory, Verdaccio, ...) is the
// common case for the packages this tool is actually most useful against —
// first-party, mid-migration, least well-understood. Bare `fetch(url)` with
// no Authorization header always 401s there. This reads the same places npm
// itself does, so `--registry` usually doesn't even need to be passed by
// hand once a project's .npmrc already maps the scope.

export interface NpmrcConfig {
  /** host (e.g. "npm.pkg.github.com") -> bearer token */
  authTokens: Record<string, string>;
  /** "@scope" -> registry base URL */
  scopeRegistries: Record<string, string>;
  defaultRegistry?: string;
}

function interpolateEnvVars(value: string): string {
  return value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_, name) => process.env[name] ?? "");
}

async function parseNpmrcFile(filePath: string): Promise<NpmrcConfig> {
  const config: NpmrcConfig = { authTokens: {}, scopeRegistries: {} };
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return config;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;

    const key = line.slice(0, eq).trim();
    const rawValue = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    const value = interpolateEnvVars(rawValue);

    const authTokenMatch = key.match(/^\/\/(.+)\/:_authToken$/);
    if (authTokenMatch?.[1]) {
      config.authTokens[authTokenMatch[1]] = value;
      continue;
    }

    const scopeMatch = key.match(/^(@[^:]+):registry$/);
    if (scopeMatch?.[1]) {
      config.scopeRegistries[scopeMatch[1]] = value.replace(/\/+$/, "");
      continue;
    }

    if (key === "registry") {
      config.defaultRegistry = value.replace(/\/+$/, "");
    }
  }

  return config;
}

function mergeNpmrc(base: NpmrcConfig, override: NpmrcConfig): NpmrcConfig {
  const merged: NpmrcConfig = {
    authTokens: { ...base.authTokens, ...override.authTokens },
    scopeRegistries: { ...base.scopeRegistries, ...override.scopeRegistries },
  };
  const defaultRegistry = override.defaultRegistry ?? base.defaultRegistry;
  if (defaultRegistry) merged.defaultRegistry = defaultRegistry;
  return merged;
}

/**
 * Load and merge .npmrc config the way npm itself does for the values this
 * tool cares about: user-level (~/.npmrc) first, then project-level
 * (<cwd>/.npmrc) overriding it.
 */
export async function loadNpmrcConfig(cwd: string = process.cwd()): Promise<NpmrcConfig> {
  const userConfig = await parseNpmrcFile(path.join(os.homedir(), ".npmrc"));
  const projectConfig = await parseNpmrcFile(path.join(cwd, ".npmrc"));
  return mergeNpmrc(userConfig, projectConfig);
}

/**
 * Pick the registry for `pkgName`: an explicit `--registry` always wins;
 * otherwise a scoped package (`@scope/name`) checks .npmrc's
 * `@scope:registry` mapping before falling back to .npmrc's own default
 * `registry` line, then the public npm registry.
 */
export function resolveRegistryForPackage(
  pkgName: string,
  npmrc: NpmrcConfig,
  explicitRegistry?: string | undefined,
): string {
  if (explicitRegistry) return explicitRegistry;
  const scopeMatch = pkgName.match(/^(@[^/]+)\//);
  if (scopeMatch?.[1]) {
    const scoped = npmrc.scopeRegistries[scopeMatch[1]];
    if (scoped) return scoped;
  }
  return npmrc.defaultRegistry ?? "https://registry.npmjs.org";
}

/**
 * Resolve the bearer token for `registryUrl`, in priority order: an
 * explicit `--token` flag, then the CI-conventional `NPM_TOKEN` /
 * `NODE_AUTH_TOKEN` env vars, then .npmrc's `//<host>/:_authToken`.
 * Returns undefined when nothing is configured — a public registry never
 * needs one and this is not an error.
 */
export function resolveAuthToken(
  registryUrl: string,
  npmrc: NpmrcConfig,
  explicitToken?: string | undefined,
): string | undefined {
  if (explicitToken) return explicitToken;
  if (process.env["NPM_TOKEN"]) return process.env["NPM_TOKEN"];
  if (process.env["NODE_AUTH_TOKEN"]) return process.env["NODE_AUTH_TOKEN"];
  try {
    const host = new URL(registryUrl).host;
    return npmrc.authTokens[host];
  } catch {
    return undefined;
  }
}

function authHeaders(token?: string | undefined): Record<string, string> {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function unauthorizedHint(url: string, token: string | undefined): string {
  if (token) {
    return " — a token was sent but the registry rejected it; check it's valid and not expired.";
  }
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    host = url;
  }
  return (
    ` — private registry? packdev found no token for this host. Pass --token, ` +
    `set NPM_TOKEN or NODE_AUTH_TOKEN, or add "//${host}/:_authToken=<token>" to .npmrc.`
  );
}

export async function fetchPackageMetadata(
  pkgName: string,
  registryUrl: string,
  token?: string | undefined,
): Promise<RegistryMetadata> {
  const url = `${registryUrl.replace(/\/+$/, "")}/${encodeURIComponent(pkgName).replace(/^%40/, "@")}`;
  const response = await fetch(url, { headers: authHeaders(token) });
  if (!response.ok) {
    const hint = response.status === 401 ? unauthorizedHint(url, token) : "";
    throw new Error(
      `Registry request failed for "${pkgName}" (${response.status} ${response.statusText}) at ${url}${hint}`,
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
  // False when no @types version shares the source package's major, so the
  // "latest" fallback was used instead — the resolved type surface is not
  // actually versioned against this candidate and callers should not assert
  // compatibility off it with full confidence.
  majorMatched: boolean;
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
  token?: string | undefined,
): Promise<TypesPackageMatch | null> {
  const typesPkgName = toTypesPackageName(pkgName);

  let metadata: RegistryMetadata;
  try {
    metadata = await fetchPackageMetadata(typesPkgName, registryUrl, token);
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

  return { version: chosen, tarball: dist.tarball, majorMatched: sameMajor.length > 0 };
}

export async function downloadTarball(
  tarballUrl: string,
  token?: string | undefined,
): Promise<Buffer> {
  const response = await fetch(tarballUrl, { headers: authHeaders(token) });
  if (!response.ok) {
    const hint = response.status === 401 ? unauthorizedHint(tarballUrl, token) : "";
    throw new Error(
      `Failed to download tarball (${response.status} ${response.statusText}) from ${tarballUrl}${hint}`,
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

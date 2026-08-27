/**
 * `behavior-diff`: diffs a package's *shipped code* between two versions,
 * filtered down to the functions actually reachable from what the app
 * imports/passes — the one class of break neither `api-diff` (types only)
 * nor `compat` (pass/fail, no attribution) can point a human or an agent
 * at directly. It never claims "this broke behavior X" — it reports "these
 * lines changed and your code reaches them," the same evidence-not-verdict
 * discipline `apiCompatible: null` already uses elsewhere in this codebase.
 *
 * Deliberately experimental (--experimental gated in the CLI): matching
 * functions by name across two versions' shipped code, and "reachable" via
 * a one-more-hop textual-mention heuristic rather than a real call graph,
 * are both best-effort. False negatives (missing a real reachability path)
 * are expected. The bar is "surface the four lines that mattered," not
 * "prove no other line could possibly matter."
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as ts from "typescript";
import { readJsonFile, fileExists, resolveContainedPath, type PackageInfo } from "./utils";
import { downloadTarball, extractTarball, cleanupExtractedTarball, fetchPackageMetadata } from "./registry";
import { resolveInstalledPackage, getInstalledVersion } from "./api";
import { scanImportedSymbols, scanPassedOptionKeys } from "./appScan";

export interface BehaviorDiffOptions {
  appDir: string;
  registryUrl: string;
  token?: string | undefined;
  // Cap on local-require hops walked out from the entry file, per version.
  // Higher finds more, but costs more parse time and false-positive
  // reachability through unrelated internals.
  maxDepth?: number | undefined;
  // Cap on distinct changed/added/removed functions returned.
  maxResults?: number | undefined;
}

export type BehaviorDiffChangeKind = "added" | "removed" | "changed";

export interface BehaviorDiffChange {
  name: string;
  file: string;
  reachableVia: string[];
  kind: BehaviorDiffChangeKind;
  score: number;
  diff?: string[] | undefined;
}

export interface BehaviorDiffReport {
  package: string;
  from: string;
  to: string;
  seedSymbols: string[];
  seedOptionKeys: string[];
  // Non-null when the app also imports the package via a namespace import
  // (`import * as lib from "pkg"`) or a bare `require("pkg")` somewhere —
  // neither statically enumerates which symbols actually get used, so the
  // reachability seed here can be incomplete even when seedSymbols/
  // seedOptionKeys aren't empty. Independent of `degraded`: this is a
  // confidence caveat on a real result, not a reason none was produced.
  dynamicUsageCaveat: string | null;
  // Non-null when a meaningful diff couldn't be produced — minified/bundled
  // output, native/wasm, a package that ships no compiled JS at all, or (see
  // dynamicUsageCaveat) dynamic-only usage that leaves zero seed names to
  // even start from. `changes` is always [] when this is set; never
  // silently empty.
  degraded: string | null;
  changes: BehaviorDiffChange[];
  totalChanges: number;
  truncated: boolean;
}

const MAX_DIFF_LINES = 40;
const MAX_FILES_WALKED = 40;
const MAX_MENTION_HOPS = 2;

// --- entry resolution -----------------------------------------------------

// The root (".") entry of a package's "exports" map, or the map itself
// when it has no subpath keys at all (a package can declare root-level
// conditions with no explicit "." key — same ambiguity api.ts's own
// findTypesCondition/rootExportsEntry guard against for the types side).
function rootExportsEntry(exportsField: unknown): unknown {
  if (!exportsField || typeof exportsField !== "object" || Array.isArray(exportsField)) {
    return null;
  }
  const obj = exportsField as Record<string, unknown>;
  if ("." in obj) return obj["."];
  return Object.keys(obj).some((key) => key.startsWith(".")) ? null : obj;
}

// Walks a conditions object to a concrete file path. Prefers "require"
// first — this module's own local-require walker (collectRequireSpecifiers)
// only ever follows CommonJS require() calls, so picking an ESM-only
// ("import") entry here would make every subsequent hop resolve nothing.
function resolveConditionalString(node: unknown, depth = 0): string | null {
  if (typeof node === "string") return node;
  if (depth > 5 || !node || typeof node !== "object" || Array.isArray(node)) return null;
  const obj = node as Record<string, unknown>;
  for (const key of ["require", "node", "default", "import"]) {
    if (key in obj) {
      const resolved = resolveConditionalString(obj[key], depth + 1);
      if (resolved) return resolved;
    }
  }
  return null;
}

// Node resolves a package root through "exports" before ever consulting
// "main" — a package can keep "main" pointed at a legacy/compat entry while
// "exports" routes real consumers elsewhere, so checking main first can
// diff code the app never actually loads. Once "exports" is present AT
// ALL, Node also stops consulting "main" as a fallback entirely — a
// subpath-only map (e.g. only "./foo") or an unsupported root shape (an
// array) makes the bare package import unresolvable, not silently routed
// to "main". Returns null in that case so the caller can degrade instead
// of analyzing code the app could never actually load.
function resolveJsEntryRelative(packageInfo: PackageInfo): string | null {
  const exportsField = packageInfo.exports;
  if (exportsField !== undefined && exportsField !== null) {
    if (typeof exportsField === "string") return exportsField;
    return resolveConditionalString(rootExportsEntry(exportsField));
  }
  if (typeof packageInfo.main === "string" && packageInfo.main.length > 0) {
    return packageInfo.main;
  }
  return "index.js";
}

// --- degraded-input detection ----------------------------------------------

// Best-effort: a bundled/minified file reads as a handful of very long
// lines rather than normal formatting. Not "this diff is wrong" — a real
// diff would still be textually valid — just unattributable to anything a
// human/agent could act on, so it's reported as degraded rather than
// dumped as noise.
function looksMinified(content: string): boolean {
  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;
  const avgLen = lines.reduce((sum, l) => sum + l.length, 0) / lines.length;
  return avgLen > 400 || (lines.length <= 3 && content.length > 2000);
}

async function detectNativeOrWasm(pkgDir: string, packageInfo: PackageInfo): Promise<boolean> {
  if ((packageInfo as { gypfile?: boolean }).gypfile) return true;
  async function walk(dir: string, depth: number): Promise<boolean> {
    if (depth > 3) return false;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      if (entry.isDirectory()) {
        if (await walk(path.join(dir, entry.name), depth + 1)) return true;
      } else if (entry.name.endsWith(".node") || entry.name.endsWith(".wasm")) {
        return true;
      }
    }
    return false;
  }
  return walk(pkgDir, 0);
}

// --- local-require walking + function extraction ---------------------------

interface NamedFunction {
  name: string;
  file: string;
  text: string;
}

async function isRealFile(candidate: string): Promise<boolean> {
  try {
    return (await fs.stat(candidate)).isFile();
  } catch {
    return false;
  }
}

// `base` itself (the extensionless specifier target) is almost never a real
// file — require("./helper") resolves to helper.js, require("./dist") to
// dist/index.js (and "./dist" itself exists too, but as a *directory* —
// fileExists-style existence alone would wrongly accept it, then a later
// fs.readFile(directory) fails silently into the walker's own catch) — so
// each candidate must actually be checked, as a file specifically, in
// Node's own resolution order; returning the first merely-plausible one
// silently resolves to nothing for exactly the common cases.
async function resolveLocalRequireTarget(
  pkgDir: string,
  fromFile: string,
  specifier: string,
): Promise<string | null> {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [base, `${base}.js`, `${base}.cjs`, `${base}.mjs`, path.join(base, "index.js")];
  for (const candidate of candidates) {
    if (path.relative(pkgDir, candidate).startsWith("..")) continue;
    if (await isRealFile(candidate)) return candidate;
  }
  return null;
}

function collectRequireSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers: string[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0]!)
    ) {
      specifiers.push(node.arguments[0]!.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return specifiers;
}

function functionNameFromDeclaration(name: ts.Identifier | undefined): string | null {
  return name?.text ?? null;
}

function collectNamedFunctions(sourceFile: ts.SourceFile, relFile: string): NamedFunction[] {
  const out: NamedFunction[] = [];

  function record(name: string | null, node: ts.Node): void {
    if (!name) return;
    out.push({ name, file: relFile, text: node.getFullText(sourceFile).trim() });
  }

  function visit(node: ts.Node): void {
    if (ts.isFunctionDeclaration(node)) {
      record(functionNameFromDeclaration(node.name), node);
    } else if (ts.isMethodDeclaration(node) && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name))) {
      record(node.name.text, node);
    } else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (
          decl.initializer &&
          (ts.isFunctionExpression(decl.initializer) || ts.isArrowFunction(decl.initializer)) &&
          ts.isIdentifier(decl.name)
        ) {
          record(decl.name.text, node);
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return out;
}

/**
 * BFS out from the entry file through local (`./`-relative) `require()`
 * targets, parsing each with the TS parser in JS mode, up to `maxDepth`
 * hops and `MAX_FILES_WALKED` files total — a depth/file cap because a
 * package's internal module graph can be arbitrarily large and most of it
 * is irrelevant to any one app's usage.
 */
async function walkPackageFunctions(
  pkgDir: string,
  entryAbsPath: string,
  maxDepth: number,
): Promise<NamedFunction[]> {
  const visited = new Set<string>();
  const queue: { file: string; depth: number }[] = [{ file: entryAbsPath, depth: 0 }];
  const functions: NamedFunction[] = [];

  while (queue.length > 0 && visited.size < MAX_FILES_WALKED) {
    const { file, depth } = queue.shift()!;
    if (visited.has(file)) continue;
    if (!(await fileExists(file))) continue;
    visited.add(file);

    let content: string;
    try {
      content = await fs.readFile(file, "utf-8");
    } catch {
      continue;
    }
    const sourceFile = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const relFile = path.relative(pkgDir, file);
    functions.push(...collectNamedFunctions(sourceFile, relFile));

    if (depth >= maxDepth) continue;
    for (const specifier of collectRequireSpecifiers(sourceFile)) {
      const target = await resolveLocalRequireTarget(pkgDir, file, specifier);
      if (target && !visited.has(target)) {
        queue.push({ file: target, depth: depth + 1 });
      }
    }
  }

  return functions;
}

// --- reachability -----------------------------------------------------------

const WORD_BOUNDARY_CACHE = new Map<string, RegExp>();
function mentionsIdentifier(text: string, name: string): boolean {
  let re = WORD_BOUNDARY_CACHE.get(name);
  if (!re) {
    re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    WORD_BOUNDARY_CACHE.set(name, re);
  }
  return re.test(text);
}

/**
 * A function is reachable if its own name or body mentions a seed
 * identifier, or (up to MAX_MENTION_HOPS more rounds) mentions the name of
 * an already-reachable function — a cheap stand-in for a real call graph.
 * Returns a map of name -> the seed/caller names that pulled it in, for
 * `reachableVia` in the report.
 */
function computeReachable(
  functions: NamedFunction[],
  seedNames: Set<string>,
): Map<string, Set<string>> {
  const reachable = new Map<string, Set<string>>();
  // First-wins by name, matching how the reachable map itself dedupes —
  // needed here to look up an already-reachable *caller's* own body text
  // during the hop rounds below.
  const byName = new Map<string, NamedFunction>();
  for (const fn of functions) {
    if (!byName.has(fn.name)) byName.set(fn.name, fn);
  }

  for (const fn of functions) {
    if (reachable.has(fn.name)) continue;
    if (seedNames.has(fn.name)) {
      reachable.set(fn.name, new Set([fn.name]));
      continue;
    }
    for (const seed of seedNames) {
      if (mentionsIdentifier(fn.text, seed)) {
        reachable.set(fn.name, new Set([seed]));
        break;
      }
    }
  }

  // A callee is reachable if an already-reachable *caller's* body mentions
  // the callee's name (that's the actual call site) — not the other way
  // around. Checking the candidate's own body for the caller's name would
  // only catch a callee that happens to reference its caller back, which
  // is the rare case, not the normal one.
  for (let hop = 0; hop < MAX_MENTION_HOPS; hop++) {
    const callerNames = [...reachable.keys()];
    let grew = false;
    for (const fn of functions) {
      if (reachable.has(fn.name)) continue;
      for (const callerName of callerNames) {
        const caller = byName.get(callerName);
        if (caller && mentionsIdentifier(caller.text, fn.name)) {
          reachable.set(fn.name, new Set([callerName]));
          grew = true;
          break;
        }
      }
    }
    if (!grew) break;
  }

  return reachable;
}

// --- line diff + scoring -----------------------------------------------------

// Minimal LCS-based unified-style line diff — no external dependency, and
// the codebase has no diff library already in use. Adequate for the
// function-body-sized inputs here; not intended for large-file diffing.
function lineDiff(oldText: string, newText: string): string[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const m = a.length;
  const n = b.length;
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push(`  ${a[i]}`);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push(`- ${a[i]}`);
      i++;
    } else {
      out.push(`+ ${b[j]}`);
      j++;
    }
  }
  while (i < m) {
    out.push(`- ${a[i]}`);
    i++;
  }
  while (j < n) {
    out.push(`+ ${b[j]}`);
    j++;
  }
  return out;
}

function truncateDiff(lines: string[]): string[] {
  if (lines.length <= MAX_DIFF_LINES) return lines;
  const changed = lines.filter((l) => l.startsWith("+") || l.startsWith("-"));
  if (changed.length <= MAX_DIFF_LINES) return changed;
  return [...changed.slice(0, MAX_DIFF_LINES), `...[${changed.length - MAX_DIFF_LINES} more changed lines truncated]...`];
}

// The heuristic that makes the output readable instead of a diff dump:
// changed lines touching control flow / return values / defaults are what
// a human or agent actually needs to see first.
const HIGH_SIGNAL_PATTERN = /\breturn\b|\bthrow\b|\bif\s*\(|typeof\s|===|!==|\?\s*:|=\s*undefined|\bdefault\b/;

function scoreDiff(diffLines: string[]): number {
  let score = 0;
  for (const line of diffLines) {
    if (!line.startsWith("+") && !line.startsWith("-")) continue;
    score += HIGH_SIGNAL_PATTERN.test(line) ? 2 : 1;
  }
  return score;
}

// --- top-level orchestration -------------------------------------------------

async function resolveShippedVersion(
  pkgName: string,
  version: string,
  registryUrl: string,
  token: string | undefined,
): Promise<{ packageDir: string; cleanupDir: string }> {
  const metadata = await fetchPackageMetadata(pkgName, registryUrl, token);
  const versionInfo = metadata.versions[version];
  if (!versionInfo) {
    throw new Error(`${pkgName}@${version} was not found on ${registryUrl}`);
  }
  const buffer = await downloadTarball(versionInfo.dist.tarball, token);
  return extractTarball(buffer, `packdev-behavior-diff-${version}-`);
}

async function resolveFromInstalled(
  pkgName: string,
  appDir: string,
): Promise<{ version: string; packageDir: string } | null> {
  const dir = await resolveInstalledPackage(pkgName, appDir);
  if (!dir) return null;
  const version = await getInstalledVersion(dir);
  if (!version) return null;
  return { version, packageDir: dir };
}

export async function runBehaviorDiff(
  pkgName: string,
  toVersion: string,
  options: BehaviorDiffOptions,
): Promise<BehaviorDiffReport> {
  // Read "from" directly out of node_modules rather than re-downloading it
  // from the registry: a local/git/patched install may not even exist on
  // the registry under this exact version, or may have diverged from what
  // was actually published — the whole point of comparing against the
  // "installed (control)" version is that it's what's ACTUALLY installed.
  const fromInstalled = await resolveFromInstalled(pkgName, options.appDir);
  const fromVersion = fromInstalled?.version ?? null;
  if (!fromVersion) {
    throw new Error(
      `"${pkgName}" is not installed under ${options.appDir} — behavior-diff needs an installed ` +
        `version to diff "to" against (no --from override is currently supported; point --app at ` +
        `where it's installed).`,
    );
  }

  const { symbols: seedSymbolsSet, hasDynamicUsage } = await scanImportedSymbols(options.appDir, pkgName);
  const seedOptionKeysSet = await scanPassedOptionKeys(options.appDir, pkgName);
  const seedNames = new Set<string>([...seedSymbolsSet, ...seedOptionKeysSet]);
  const seedSymbols = [...seedSymbolsSet].sort();
  const seedOptionKeys = [...seedOptionKeysSet].sort();
  const dynamicUsageCaveat = hasDynamicUsage ? DYNAMIC_USAGE_CAVEAT : null;

  // A namespace import / bare require() with literally nothing else to
  // seed from means there is no reachability check to run at all — an
  // empty seed set otherwise produces changes:[] indistinguishable from
  // "verified nothing reachable changed," when in fact nothing was
  // checked. Only degrade outright in that specific empty case; when real
  // seed names exist alongside dynamic usage, run the diff and just carry
  // the caveat (dynamicUsageCaveat) instead of discarding a real result.
  if (hasDynamicUsage && seedNames.size === 0) {
    return degradedReport(
      pkgName,
      fromVersion,
      toVersion,
      seedSymbols,
      seedOptionKeys,
      "the app only accesses this package via a namespace import (import * as x) or a bare " +
        "require() with no destructured usage — neither can be statically enumerated, so " +
        "there are zero seed names to check reachability against",
      dynamicUsageCaveat,
    );
  }

  const maxDepth = options.maxDepth ?? 3;
  const maxResults = options.maxResults ?? 20;

  // Only "to" is ever extracted from a downloaded tarball — only it needs
  // cleanup. "from" is read straight from the real, already-installed
  // directory (see resolveFromInstalled above).
  const extracted: { packageDir: string; cleanupDir: string }[] = [];
  try {
    const fromExtracted = { packageDir: fromInstalled!.packageDir };
    const toExtracted = await resolveShippedVersion(pkgName, toVersion, options.registryUrl, options.token);
    extracted.push(toExtracted);

    const fromPackageInfo = await readJsonFile<PackageInfo>(path.join(fromExtracted.packageDir, "package.json"));
    const toPackageInfo = await readJsonFile<PackageInfo>(path.join(toExtracted.packageDir, "package.json"));
    if (!fromPackageInfo || !toPackageInfo) {
      throw new Error(`Invalid package.json in extracted tarball for ${pkgName}`);
    }

    if (
      (await detectNativeOrWasm(fromExtracted.packageDir, fromPackageInfo)) ||
      (await detectNativeOrWasm(toExtracted.packageDir, toPackageInfo))
    ) {
      return degradedReport(
        pkgName,
        fromVersion,
        toVersion,
        seedSymbols,
        seedOptionKeys,
        "package ships a native (.node) or WebAssembly (.wasm) binary — shipped JS source can't fully " +
          "account for its behavior, so a source diff here would be misleading",
        dynamicUsageCaveat,
      );
    }

    const fromEntryRel = resolveJsEntryRelative(fromPackageInfo);
    const toEntryRel = resolveJsEntryRelative(toPackageInfo);
    if (fromEntryRel === null || toEntryRel === null) {
      return degradedReport(
        pkgName,
        fromVersion,
        toVersion,
        seedSymbols,
        seedOptionKeys,
        'package.json declares an "exports" field but no root (".") entry could be resolved ' +
          "from it (a subpath-only map, or an unsupported root shape) — Node blocks root-level " +
          'resolution entirely once "exports" is present, it never falls back to "main" in that ' +
          "case, so there is no reachable compiled entry point to diff",
        dynamicUsageCaveat,
      );
    }
    // fromEntryRel/toEntryRel come from the tarball's OWN package.json
    // ("main" or an "exports" condition) — untrusted registry content, not
    // local input. A malicious/compromised package's manifest pointing at
    // "../../../../etc/passwd" must not escape the extracted tarball and
    // get its content read into this diff; resolveContainedPath rejects
    // that the same way an unresolvable entry already degrades below.
    const fromEntryAbs = resolveContainedPath(fromExtracted.packageDir, fromEntryRel);
    const toEntryAbs = resolveContainedPath(toExtracted.packageDir, toEntryRel);

    if (
      !fromEntryAbs ||
      !toEntryAbs ||
      !(await fileExists(fromEntryAbs)) ||
      !(await fileExists(toEntryAbs))
    ) {
      return degradedReport(
        pkgName,
        fromVersion,
        toVersion,
        seedSymbols,
        seedOptionKeys,
        "no resolvable compiled JS entry point found in one or both versions' tarballs — the package " +
          "may ship only TypeScript source with no compiled output",
        dynamicUsageCaveat,
      );
    }

    const [fromContent, toContent] = await Promise.all([
      fs.readFile(fromEntryAbs, "utf-8"),
      fs.readFile(toEntryAbs, "utf-8"),
    ]);
    if (looksMinified(fromContent) || looksMinified(toContent)) {
      return degradedReport(
        pkgName,
        fromVersion,
        toVersion,
        seedSymbols,
        seedOptionKeys,
        "shipped entry file looks minified/bundled (long, few lines) — a source diff here would be " +
          "line noise, not attributable to anything a human or agent could act on",
        dynamicUsageCaveat,
      );
    }

    const fromFunctions = await walkPackageFunctions(fromExtracted.packageDir, fromEntryAbs, maxDepth);
    const toFunctions = await walkPackageFunctions(toExtracted.packageDir, toEntryAbs, maxDepth);

    const fromReachable = computeReachable(fromFunctions, seedNames);
    const toReachable = computeReachable(toFunctions, seedNames);

    const fromByName = new Map(fromFunctions.map((fn) => [fn.name, fn]));
    const toByName = new Map(toFunctions.map((fn) => [fn.name, fn]));

    const allNames = new Set([...fromReachable.keys(), ...toReachable.keys()]);
    const changes: BehaviorDiffChange[] = [];

    for (const name of allNames) {
      const fromFn = fromByName.get(name);
      const toFn = toByName.get(name);
      const via = [...(fromReachable.get(name) ?? toReachable.get(name) ?? [])].sort();

      if (fromFn && !toFn) {
        changes.push({ name, file: fromFn.file, reachableVia: via, kind: "removed", score: 100 });
      } else if (!fromFn && toFn) {
        changes.push({ name, file: toFn.file, reachableVia: via, kind: "added", score: 100 });
      } else if (fromFn && toFn && fromFn.text !== toFn.text) {
        const diffLines = lineDiff(fromFn.text, toFn.text);
        changes.push({
          name,
          file: toFn.file,
          reachableVia: via,
          kind: "changed",
          score: scoreDiff(diffLines),
          diff: truncateDiff(diffLines),
        });
      }
    }

    changes.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
    const truncated = changes.length > maxResults;

    return {
      package: pkgName,
      from: fromVersion,
      to: toVersion,
      seedSymbols,
      seedOptionKeys,
      dynamicUsageCaveat,
      degraded: null,
      changes: changes.slice(0, maxResults),
      totalChanges: changes.length,
      truncated,
    };
  } finally {
    for (const { cleanupDir } of extracted) {
      await cleanupExtractedTarball(cleanupDir);
    }
  }
}

function degradedReport(
  pkgName: string,
  fromVersion: string,
  toVersion: string,
  seedSymbols: string[],
  seedOptionKeys: string[],
  reason: string,
  dynamicUsageCaveat: string | null = null,
): BehaviorDiffReport {
  return {
    package: pkgName,
    from: fromVersion,
    to: toVersion,
    seedSymbols,
    seedOptionKeys,
    dynamicUsageCaveat,
    degraded: reason,
    changes: [],
    totalChanges: 0,
    truncated: false,
  };
}

const DYNAMIC_USAGE_CAVEAT =
  "the app also imports this package via a namespace import (import * as x) or a bare " +
  "require() somewhere — neither statically enumerates which symbols actually get used, so " +
  "the reachability seed above may be incomplete even though it isn't empty";

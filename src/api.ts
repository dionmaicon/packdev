/**
 * API-compatibility tooling: inspect the export map of a package's
 * currently-installed version. Phase 1 of the api-compat feature — only
 * covers `packdev api <pkg>` (static, single-version export dump). Later
 * phases (api-diff, compat, bisect) build on top of this module.
 */

import * as path from "path";
import * as ts from "typescript";
import { fileExists, isDirectory, readJsonFile, resolveContainedPath, type PackageInfo } from "./utils";

export interface ResolvedEntryPoint {
  jsPath: string;
  typesPath: string | null;
}

export type ExportKind =
  | "function"
  | "class"
  | "interface"
  | "type"
  | "enum"
  | "namespace"
  | "const";

export interface ExportedSymbol {
  name: string;
  kind: ExportKind;
  signature: string;
}

export interface ExportedSymbolWithSubpath extends ExportedSymbol {
  subpath: string;
}

/**
 * Walk up from `fromDir` through `node_modules/<pkgName>` directories,
 * mirroring Node's own resolution algorithm so hoisted packages (installed
 * at a workspace/monorepo root rather than next to the consuming app) are
 * still found.
 */
export async function resolveInstalledPackage(
  pkgName: string,
  fromDir: string,
): Promise<string | null> {
  let dir = path.resolve(fromDir);
  for (;;) {
    const candidate = path.join(dir, "node_modules", pkgName);
    if (
      (await isDirectory(candidate)) &&
      (await fileExists(path.join(candidate, "package.json")))
    ) {
      return candidate;
    }

    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Maps a package name to npm's convention for its @types package,
// e.g. "@nestjs/common" -> "@types/nestjs__common", "lodash" -> "@types/lodash".
export function toTypesPackageName(name: string): string {
  const scoped = name.match(/^@([^/]+)\/(.+)$/);
  if (scoped) return `@types/${scoped[1]}__${scoped[2]}`;
  return `@types/${name}`;
}

// Recursively resolve a "types" (or "typings") condition out of a package.json
// "exports" map node, following the import/require/node/default fallback chain.
function findTypesCondition(node: unknown): string | null {
  if (!node || typeof node !== "object") return null;
  const obj = node as Record<string, unknown>;

  if (typeof obj["types"] === "string") return obj["types"];
  if (typeof obj["typings"] === "string") return obj["typings"];

  // "node"/"import"/"require"/"default" cover the common case. A package
  // whose root has ONLY environment condition keys and no "node" among them
  // (seen in the wild, e.g. @solana/kit 5.x: node/browser/workerd/edge-light/
  // react-native, no bare "."/no "node") still needs a deterministic pick —
  // fall back to the first condition key present, in manifest order, rather
  // than reporting no types at all.
  const preferredKeys = ["import", "require", "node", "default"];
  for (const key of preferredKeys) {
    if (key in obj) {
      const found = findTypesCondition(obj[key]);
      if (found) return found;
    }
  }
  for (const key of Object.keys(obj)) {
    if (preferredKeys.includes(key)) continue;
    // A key starting with "." is a subpath export (e.g. "./testing"), not a
    // condition — descending into it would let a subpath-only declaration
    // masquerade as the root's own types entry, even though the exports map
    // deliberately does not expose "." at all.
    if (key.startsWith(".")) continue;
    const found = findTypesCondition(obj[key]);
    if (found) return found;
  }
  return null;
}

function extractExportsTypes(exportsField: unknown): string | null {
  if (!exportsField || typeof exportsField !== "object") return null;
  const obj = exportsField as Record<string, unknown>;
  const rootEntry = "." in obj ? obj["."] : obj;
  return findTypesCondition(rootEntry);
}

/**
 * Resolve a package's JS entry point and its type declarations, checking (in
 * order): the "exports" map's types condition, "types"/"typings" fields, the
 * main field with its extension swapped to .d.ts, and finally a sibling
 * @types/<pkg> package. Returns typesPath: null for a valid pure-JS package
 * with no statically-resolvable declarations.
 */
export async function resolveEntryPoint(
  pkgDir: string,
  packageInfo: PackageInfo,
): Promise<ResolvedEntryPoint> {
  // A "main" that escapes pkgDir is treated the same as no "main" at all —
  // fall back to the untainted default rather than a path outside the
  // sandbox.
  const jsPath =
    (await resolveContainedPath(pkgDir, packageInfo.main || "index.js")) ??
    path.join(pkgDir, "index.js");

  const candidates: string[] = [];
  const exportsTypes = extractExportsTypes(packageInfo.exports);
  if (exportsTypes) candidates.push(exportsTypes);
  if (packageInfo.types) candidates.push(packageInfo.types);
  if (packageInfo.typings) candidates.push(packageInfo.typings);
  if (packageInfo.main) {
    candidates.push(packageInfo.main.replace(/\.jsx?$/, ".d.ts"));
  }
  // No main/types/typings/exports at all in the manifest (seen in the wild,
  // e.g. @nestjs/axios's published tarball) — fall back to the same
  // ./index.d.ts default Node/TS use for an untyped ./index.js main. Gated
  // on all four being absent: an explicit (even subpath-only) "exports" map
  // deliberately controls what's importable, and an incidental index.d.ts
  // sitting on disk must not be treated as a public root entry it blocks.
  if (!packageInfo.main && !packageInfo.types && !packageInfo.typings && !packageInfo.exports) {
    candidates.push("index.d.ts");
  }

  let typesPath: string | null = null;
  for (const candidate of candidates) {
    const absolute = await resolveContainedPath(pkgDir, candidate);
    if (absolute && (await fileExists(absolute))) {
      typesPath = absolute;
      break;
    }
  }

  if (!typesPath) {
    const typesPkgDir = await resolveInstalledPackage(
      toTypesPackageName(packageInfo.name),
      pkgDir,
    );
    if (typesPkgDir) {
      const typesPkgInfo = await readJsonFile<PackageInfo>(
        path.join(typesPkgDir, "package.json"),
      );
      const entry = typesPkgInfo?.types || typesPkgInfo?.typings || "index.d.ts";
      const absolute = await resolveContainedPath(typesPkgDir, entry);
      if (absolute && (await fileExists(absolute))) typesPath = absolute;
    }
  }

  return { jsPath, typesPath };
}

// Every subpath key in a package.json "exports" map besides the root "."
// entry, e.g. "./testing", "./utils" — packages commonly ship types for
// these separately from the main entry point (framework testing helpers,
// alternate builds), and resolveEntryPoint above only ever resolves ".".
export function listExportsSubpaths(packageInfo: PackageInfo): string[] {
  const exportsField = packageInfo.exports;
  if (
    !exportsField ||
    typeof exportsField !== "object" ||
    Array.isArray(exportsField)
  ) {
    return [];
  }
  return Object.keys(exportsField as Record<string, unknown>).filter(
    (key) => key.startsWith("./") && key !== "./package.json",
  );
}

async function resolveSubpathTypesPath(
  pkgDir: string,
  packageInfo: PackageInfo,
  subpath: string,
): Promise<string | null> {
  const exportsField = packageInfo.exports as Record<string, unknown>;
  const condition = findTypesCondition(exportsField[subpath]);
  if (!condition) return null;
  const absolute = await resolveContainedPath(pkgDir, condition);
  if (!absolute) return null;
  return (await fileExists(absolute)) ? absolute : null;
}

/**
 * Resolve the full export map for a package: the root "." entry (via
 * resolveEntryPoint's existing conditional-exports/types/typings/main-swap/
 * @types fallback chain) plus every subpath declared in its "exports" map,
 * merged into one list tagged with the subpath each symbol came from.
 * `hasTypes` is true when the root or any subpath resolved to a real .d.ts
 * file, regardless of whether that file happened to export zero symbols.
 */
export async function resolvePackageExportMap(
  pkgDir: string,
  packageInfo: PackageInfo,
): Promise<{ hasTypes: boolean; exports: ExportedSymbolWithSubpath[] }> {
  const exports: ExportedSymbolWithSubpath[] = [];
  let hasTypes = false;

  const root = await resolveEntryPoint(pkgDir, packageInfo);
  if (root.typesPath) {
    hasTypes = true;
    for (const symbol of extractExportMap(root.typesPath)) {
      exports.push({ ...symbol, subpath: "." });
    }
  }

  for (const subpath of listExportsSubpaths(packageInfo)) {
    const typesPath = await resolveSubpathTypesPath(pkgDir, packageInfo, subpath);
    if (!typesPath) continue;
    hasTypes = true;
    for (const symbol of extractExportMap(typesPath)) {
      exports.push({ ...symbol, subpath });
    }
  }

  return { hasTypes, exports };
}

function classifySymbol(symbol: ts.Symbol): ExportKind {
  const flags = symbol.getFlags();
  if (flags & ts.SymbolFlags.Class) return "class";
  if (flags & ts.SymbolFlags.Interface) return "interface";
  if (flags & ts.SymbolFlags.Enum) return "enum";
  if (flags & ts.SymbolFlags.TypeAlias) return "type";
  if (flags & ts.SymbolFlags.Function) return "function";
  if (flags & ts.SymbolFlags.NamespaceModule) return "namespace";
  return "const";
}

function describeSymbol(
  checker: ts.TypeChecker,
  symbol: ts.Symbol,
  kind: ExportKind,
  declaration: ts.Declaration,
): string {
  try {
    if (kind === "function") {
      const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
      const signatures = type.getCallSignatures();
      if (signatures.length > 0) {
        return signatures
          .map((sig) => checker.signatureToString(sig))
          .join(" | ");
      }
    }

    if (kind === "class" || kind === "interface" || kind === "enum") {
      return checker.typeToString(checker.getDeclaredTypeOfSymbol(symbol));
    }

    const type = checker.getTypeOfSymbolAtLocation(symbol, declaration);
    return checker.typeToString(type);
  } catch {
    return "";
  }
}

/**
 * Extract the top-level exported functions/classes/interfaces/types from a
 * .d.ts file. Intentionally shallow — no deep member enumeration of class
 * methods — Phase 1 only answers "what's exported", not "what's on it".
 */
export function extractExportMap(typesPath: string): ExportedSymbol[] {
  const program = ts.createProgram([typesPath], {
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    skipLibCheck: true,
    noResolve: false,
    // Node10 (classic Node resolution: extension-less specifiers, directory
    // specifiers falling back to <dir>/index.d.ts) is what actually follows
    // a barrel's local re-exports (`export * from "./dist"`,
    // `export { X } from "./client/client"`) — the module-kind-inferred
    // default (Bundler/Classic depending on TS version) does not.
    moduleResolution: ts.ModuleResolutionKind.Node10,
  });

  const sourceFile = program.getSourceFile(typesPath);
  if (!sourceFile) return [];

  const checker = program.getTypeChecker();
  const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
  if (!moduleSymbol) return [];

  const results: ExportedSymbol[] = [];

  // `export = X` (TypeScript's CommonJS export-assignment syntax — common
  // in @types/* packages for pre-ESM libraries, e.g. `export = isOdd;`)
  // never shows up in getExportsOfModule; it lives under the special
  // "export=" key and must be resolved through its alias. Report it as
  // "default" to match how appScan.ts records `import X from "pkg"" —
  // without this, api-diff always false-negatives such packages as
  // missing their entire default export.
  const exportEqualsSymbol = moduleSymbol.exports?.get(
    ts.InternalSymbolName.ExportEquals,
  );
  if (exportEqualsSymbol) {
    const resolved =
      exportEqualsSymbol.getFlags() & ts.SymbolFlags.Alias
        ? checker.getAliasedSymbol(exportEqualsSymbol)
        : exportEqualsSymbol;
    const declaration = resolved.declarations?.[0];
    if (declaration) {
      const kind = classifySymbol(resolved);
      results.push({
        name: "default",
        kind,
        signature: describeSymbol(checker, resolved, kind, declaration),
      });
    }
  }

  for (const symbol of checker.getExportsOfModule(moduleSymbol)) {
    const declaration = symbol.declarations?.[0];
    if (!declaration) continue;

    const kind = classifySymbol(symbol);
    results.push({
      name: symbol.getName(),
      kind,
      signature: describeSymbol(checker, symbol, kind, declaration),
    });
  }

  return results;
}

export interface UnresolvedReexports {
  // An `export * from "spec"` (or `export * as ns from "spec"`) whose target
  // couldn't be resolved. Since the re-exported names are unknown, ANY used
  // symbol not otherwise found might have come from it — a genuine "can't
  // tell", not "absent".
  wildcard: boolean;
  // `export { A, B } from "spec"` whose target couldn't be resolved — here
  // the affected names ARE known statically, so only those specific symbols
  // are unresolved rather than every unmatched symbol in the file.
  namedUnresolved: Set<string>;
}

// TS's own resolver substitutes a runtime extension for its declaration
// counterpart (a common `export * from "./foo.js"` targets "foo.d.ts", not a
// literal file named "foo.js.d.ts") — without this, a specifier that
// genuinely resolves gets treated as unresolvable, which downgrades what
// should be a real "missing" verdict on its symbols to a falsely-hedged
// "unresolved" one instead.
const JS_EXTENSION_TO_DECLARATION: Record<string, string> = {
  ".js": ".d.ts",
  ".jsx": ".d.ts",
  ".mjs": ".d.mts",
  ".cjs": ".d.cts",
};

// Resolves a *local* relative re-export specifier to the .d.ts file it
// actually points at, or null if nothing on disk matches. Shared by
// specifierResolves (which only needs a yes/no) and findUnresolvableReexports
// (which needs the path itself, to recurse into it).
async function resolveLocalReexportPath(
  specifier: string,
  fromFileDir: string,
): Promise<string | null> {
  const base = path.resolve(fromFileDir, specifier);
  const ext = path.extname(base);
  const declarationExt = JS_EXTENSION_TO_DECLARATION[ext];
  const candidates = declarationExt
    ? [base.slice(0, -ext.length) + declarationExt, base, `${base}.d.ts`]
    : [base, `${base}.d.ts`, `${base}.ts`, path.join(base, "index.d.ts")];
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate;
  }
  return null;
}

// Splits a bare specifier into its package name and subpath, honouring
// scoped package names ("@scope/pkg/sub" -> "@scope/pkg" + "sub") so the
// package name handed to resolveInstalledPackage is never itself a path.
function splitBareSpecifier(specifier: string): { pkgName: string; subpath: string | null } {
  const scoped = /^(@[^/]+\/[^/]+)(\/.*)?$/.exec(specifier);
  if (scoped?.[1]) {
    return { pkgName: scoped[1], subpath: scoped[2] ? scoped[2].slice(1) : null };
  }
  const slashIndex = specifier.indexOf("/");
  if (slashIndex === -1) return { pkgName: specifier, subpath: null };
  return { pkgName: specifier.slice(0, slashIndex), subpath: specifier.slice(slashIndex + 1) };
}

// Resolves a bare specifier (a sibling npm package, optionally with a
// subpath) the way Node/TS actually would: resolve the *package* first, then
// resolve the subpath against it — never treat "dep/subpath" as itself a
// package name to look up under node_modules (there is usually no
// node_modules/dep/subpath/package.json even for a perfectly valid subpath).
async function bareSpecifierResolves(specifier: string, pkgDir: string): Promise<boolean> {
  const { pkgName, subpath } = splitBareSpecifier(specifier);
  const depDir = await resolveInstalledPackage(pkgName, pkgDir);
  if (!depDir) return false;
  if (!subpath) return true;

  const depPackageInfo = await readJsonFile<PackageInfo>(path.join(depDir, "package.json"));
  if (depPackageInfo?.exports && typeof depPackageInfo.exports === "object") {
    return `./${subpath}` in (depPackageInfo.exports as Record<string, unknown>);
  }

  // No "exports" map — the subpath is just a normal relative file/dir inside
  // the package, resolved the same way a local re-export target is.
  return (
    (await resolveLocalReexportPath(`./${subpath}`, depDir)) !== null ||
    (await fileExists(path.join(depDir, subpath)))
  );
}

/**
 * Scan a .d.ts file's top-level `export ... from "spec"` statements for ones
 * whose target module can't be resolved on disk — the shape behind both a
 * barrel re-exporting from local files the checker's isolated single-file
 * program still can't see for some reason, and (more commonly) a re-export
 * from another npm package that simply isn't installed alongside this one
 * (e.g. a tarball extracted into an isolated temp dir with no node_modules
 * tree). Syntax-only, so it can't fail the way the checker-based walk can.
 */
export async function findUnresolvableReexports(
  typesPath: string,
  pkgDir: string,
): Promise<UnresolvedReexports> {
  const result: UnresolvedReexports = { wildcard: false, namedUnresolved: new Set() };
  const visited = new Set<string>();

  // A local re-export target resolving on disk isn't sufficient — the
  // checker's own extractExportMap walk (Node10 resolution) actually follows
  // it, so an unresolvable re-export *inside that local barrel* (typically a
  // sibling npm package it re-exports that isn't present in this isolated
  // extraction) is exactly as invisible to the used-symbol check as one at
  // the root. Recurse into every genuinely-resolvable local file so those
  // get caught too, instead of stopping one hop early because "this
  // specifier resolves" was treated as the whole answer.
  async function scan(filePath: string): Promise<void> {
    const resolvedPath = path.resolve(filePath);
    if (visited.has(resolvedPath)) return;
    visited.add(resolvedPath);

    const sourceText = ts.sys.readFile(resolvedPath);
    if (!sourceText) return;

    const sourceFile = ts.createSourceFile(resolvedPath, sourceText, ts.ScriptTarget.Latest, true);
    const fromFileDir = path.dirname(resolvedPath);

    for (const stmt of sourceFile.statements) {
      if (!ts.isExportDeclaration(stmt)) continue;
      const moduleSpecifier =
        stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
          ? stmt.moduleSpecifier.text
          : null;
      if (!moduleSpecifier) continue;

      if (moduleSpecifier.startsWith(".") || moduleSpecifier.startsWith("/")) {
        const localTarget = await resolveLocalReexportPath(moduleSpecifier, fromFileDir);
        if (localTarget) {
          await scan(localTarget);
          continue;
        }
      } else if (await bareSpecifierResolves(moduleSpecifier, pkgDir)) {
        continue;
      }

      if (!stmt.exportClause || ts.isNamespaceExport(stmt.exportClause)) {
        result.wildcard = true;
        continue;
      }
      if (ts.isNamedExports(stmt.exportClause)) {
        for (const element of stmt.exportClause.elements) {
          result.namedUnresolved.add(element.name.text);
        }
      }
    }
  }

  await scan(typesPath);
  return result;
}

/**
 * The same unresolvable-re-export scan as findUnresolvableReexports, but for
 * a whole package: the root "." entry plus every subpath declared in its
 * "exports" map, merged — matching how resolvePackageExportMap merges its
 * *resolved* exports across root+subpaths. A used symbol imported from a
 * subpath whose own types file has an unresolvable re-export needs the same
 * missing-vs-unresolved distinction the root already gets; without this, only
 * the root's own re-exports were ever checked.
 */
export async function findUnresolvableReexportsForPackage(
  pkgDir: string,
  packageInfo: PackageInfo,
): Promise<UnresolvedReexports> {
  const result: UnresolvedReexports = { wildcard: false, namedUnresolved: new Set() };

  const { typesPath } = await resolveEntryPoint(pkgDir, packageInfo);
  if (typesPath) {
    const rootResult = await findUnresolvableReexports(typesPath, pkgDir);
    result.wildcard = result.wildcard || rootResult.wildcard;
    for (const name of rootResult.namedUnresolved) result.namedUnresolved.add(name);
  }

  for (const subpath of listExportsSubpaths(packageInfo)) {
    const subpathTypesPath = await resolveSubpathTypesPath(pkgDir, packageInfo, subpath);
    if (!subpathTypesPath) continue;
    const subpathResult = await findUnresolvableReexports(subpathTypesPath, pkgDir);
    result.wildcard = result.wildcard || subpathResult.wildcard;
    for (const name of subpathResult.namedUnresolved) result.namedUnresolved.add(name);
  }

  return result;
}

export interface RawExportHint {
  name: string;
  note: string;
}

/**
 * Best-effort fallback for when extractExportMap's checker-based walk
 * legitimately finds nothing — e.g. a barrel `.d.ts` built from generic
 * factory wrappers (`export const Foo = EventClass<{...}>()`) whose
 * resulting type the checker can't reduce to a nameable signature, or a
 * pure re-export (`export * from "./generated"`) whose target file isn't
 * resolvable in this isolated single-file program. This is a syntax-only
 * scan (no type checker, no module resolution) so it can't fail the way
 * extractExportMap's checker-based walk does — it always finds *something*
 * if there's any top-level `export` syntax in the file at all. It never
 * claims signatures, only that a name exists and roughly what kind of
 * declaration produced it, so callers must not treat this as equivalent to
 * a resolved export (in particular: api-diff must never use this, since an
 * unresolved hint is not a verified "this symbol exists").
 */
export function extractRawExportHints(typesPath: string): RawExportHint[] {
  const sourceText = ts.sys.readFile(typesPath);
  if (!sourceText) return [];

  const sourceFile = ts.createSourceFile(
    typesPath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );

  const hints: RawExportHint[] = [];
  const hasExportModifier = (node: ts.Node): boolean =>
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword,
    );

  for (const stmt of sourceFile.statements) {
    if (ts.isExportDeclaration(stmt)) {
      const from = stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
        ? stmt.moduleSpecifier.text
        : null;
      if (!stmt.exportClause) {
        if (from) hints.push({ name: "*", note: `re-exported from "${from}"` });
        continue;
      }
      if (ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          hints.push({
            name: el.name.text,
            note: from ? `re-exported from "${from}"` : "re-exported",
          });
        }
      }
      continue;
    }

    if (ts.isExportAssignment(stmt)) {
      hints.push({
        name: "default",
        note: "export = assignment (complex expression, not statically resolved)",
      });
      continue;
    }

    if (!hasExportModifier(stmt)) continue;

    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      hints.push({ name: stmt.name.text, note: "function" });
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      hints.push({ name: stmt.name.text, note: "class" });
    } else if (ts.isInterfaceDeclaration(stmt)) {
      hints.push({ name: stmt.name.text, note: "interface" });
    } else if (ts.isTypeAliasDeclaration(stmt)) {
      hints.push({ name: stmt.name.text, note: "type" });
    } else if (ts.isEnumDeclaration(stmt)) {
      hints.push({ name: stmt.name.text, note: "enum" });
    } else if (ts.isModuleDeclaration(stmt) && ts.isIdentifier(stmt.name)) {
      hints.push({ name: stmt.name.text, note: "namespace" });
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          hints.push({
            name: decl.name.text,
            note: "const (complex/generic type not statically resolved)",
          });
        }
      }
    }
  }

  return hints;
}

export async function getInstalledVersion(
  pkgDir: string,
): Promise<string | null> {
  const info = await readJsonFile<PackageInfo>(
    path.join(pkgDir, "package.json"),
  );
  return info?.version ?? null;
}

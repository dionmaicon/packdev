/**
 * API-compatibility tooling: inspect the export map of a package's
 * currently-installed version. Phase 1 of the api-compat feature — only
 * covers `packdev api <pkg>` (static, single-version export dump). Later
 * phases (api-diff, compat, bisect) build on top of this module.
 */

import * as path from "path";
import * as ts from "typescript";
import { fileExists, isDirectory, readJsonFile, type PackageInfo } from "./utils";

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

  for (const key of ["import", "require", "node", "default"]) {
    if (key in obj) {
      const found = findTypesCondition(obj[key]);
      if (found) return found;
    }
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
  const jsPath = path.join(pkgDir, packageInfo.main || "index.js");

  const candidates: string[] = [];
  const exportsTypes = extractExportsTypes(packageInfo.exports);
  if (exportsTypes) candidates.push(exportsTypes);
  if (packageInfo.types) candidates.push(packageInfo.types);
  if (packageInfo.typings) candidates.push(packageInfo.typings);
  if (packageInfo.main) {
    candidates.push(packageInfo.main.replace(/\.jsx?$/, ".d.ts"));
  }

  let typesPath: string | null = null;
  for (const candidate of candidates) {
    const absolute = path.join(pkgDir, candidate);
    if (await fileExists(absolute)) {
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
      const absolute = path.join(typesPkgDir, entry);
      if (await fileExists(absolute)) typesPath = absolute;
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
  const absolute = path.join(pkgDir, condition);
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

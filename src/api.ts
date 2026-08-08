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

export async function getInstalledVersion(
  pkgDir: string,
): Promise<string | null> {
  const info = await readJsonFile<PackageInfo>(
    path.join(pkgDir, "package.json"),
  );
  return info?.version ?? null;
}

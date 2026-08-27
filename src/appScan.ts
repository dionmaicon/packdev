/**
 * Scan a consuming app's own source tree (not a dependency) for the symbols
 * it actually imports from a given package. Used by api-diff to check real
 * usage against each candidate version's export map, instead of just
 * diffing full export surfaces.
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as ts from "typescript";

export interface ScanResult {
  symbols: Set<string>;
  hasDynamicUsage: boolean;
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git"]);

async function collectSourceFiles(rootDir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        await walk(path.join(dir, entry.name));
        continue;
      }
      if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        results.push(path.join(dir, entry.name));
      }
    }
  }

  await walk(rootDir);
  return results;
}

function matchesModuleSpecifier(specifier: string, pkgName: string): boolean {
  return specifier === pkgName || specifier.startsWith(`${pkgName}/`);
}

// Returns true when the pattern can't be statically attributed to specific
// names (array destructure, rest element, bare identifier binding).
function collectFromBindingPattern(
  pattern: ts.BindingName,
  symbols: Set<string>,
): boolean {
  if (!ts.isObjectBindingPattern(pattern)) return true;

  for (const element of pattern.elements) {
    if (element.dotDotDotToken) return true;
    if (!ts.isIdentifier(element.name)) return true;
    const propertyName = element.propertyName
      ? ts.isIdentifier(element.propertyName)
        ? element.propertyName.text
        : undefined
      : element.name.text;
    if (!propertyName) return true;
    symbols.add(propertyName);
  }
  return false;
}

function scanSourceFile(
  sourceFile: ts.SourceFile,
  pkgName: string,
  symbols: Set<string>,
): boolean {
  let hasDynamicUsage = false;

  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      matchesModuleSpecifier(node.moduleSpecifier.text, pkgName)
    ) {
      const clause = node.importClause;
      if (clause) {
        if (clause.name) symbols.add("default");
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            hasDynamicUsage = true;
          } else if (ts.isNamedImports(clause.namedBindings)) {
            for (const element of clause.namedBindings.elements) {
              symbols.add(element.propertyName?.text ?? element.name.text);
            }
          }
        }
      }
    }

    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "require" &&
      node.initializer.arguments.length === 1
    ) {
      const arg = node.initializer.arguments[0];
      if (
        arg &&
        ts.isStringLiteral(arg) &&
        matchesModuleSpecifier(arg.text, pkgName) &&
        collectFromBindingPattern(node.name, symbols)
      ) {
        hasDynamicUsage = true;
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return hasDynamicUsage;
}

export async function scanImportedSymbols(
  appDir: string,
  pkgName: string,
): Promise<ScanResult> {
  const files = await collectSourceFiles(appDir);
  const symbols = new Set<string>();
  let hasDynamicUsage = false;

  for (const filePath of files) {
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch {
      continue;
    }

    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith(".tsx") || filePath.endsWith(".jsx")
        ? ts.ScriptKind.TSX
        : ts.ScriptKind.TS,
    );

    if (scanSourceFile(sourceFile, pkgName, symbols)) {
      hasDynamicUsage = true;
    }
  }

  return { symbols, hasDynamicUsage };
}

// The leftmost identifier of a call's callee: `Consumer.create(...)` and
// `Consumer.SQS.create(...)` both resolve to "Consumer", a bare `create(...)`
// resolves to "create". Not real binding resolution (same approximation
// scanSourceFile's import matching already makes) — good enough to catch
// the common "call a symbol imported from the package" shape.
function calleeRootIdentifier(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    return calleeRootIdentifier(expression.expression);
  }
  return null;
}

// Local binding names (as used at call sites in THIS file) that resolve to
// pkgName — as opposed to scanImportedSymbols' set, which is keyed by
// EXPORT name, not local name. Those two diverge exactly for a default
// import (`import Consumer from "pkg"` — export-name set holds "default",
// but calls use the local name "Consumer") and an aliased named import
// (`import { Consumer as C }` — export-name set holds "Consumer", calls use
// "C"). Matching call-site roots against export names silently misses both.
function collectLocalImportBindings(sourceFile: ts.SourceFile, pkgName: string): Set<string> {
  const localNames = new Set<string>();

  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier) &&
      matchesModuleSpecifier(node.moduleSpecifier.text, pkgName)
    ) {
      const clause = node.importClause;
      if (clause) {
        if (clause.name) localNames.add(clause.name.text);
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            localNames.add(clause.namedBindings.name.text);
          } else if (ts.isNamedImports(clause.namedBindings)) {
            for (const element of clause.namedBindings.elements) {
              localNames.add(element.name.text);
            }
          }
        }
      }
    }

    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      ts.isIdentifier(node.initializer.expression) &&
      node.initializer.expression.text === "require" &&
      node.initializer.arguments.length === 1
    ) {
      const arg = node.initializer.arguments[0];
      if (arg && ts.isStringLiteral(arg) && matchesModuleSpecifier(arg.text, pkgName)) {
        if (ts.isIdentifier(node.name)) {
          // Bare `const lib = require("pkg")` — "lib" itself is the local
          // binding; a call chain like `lib.Consumer.create(...)` still
          // starts with this root.
          localNames.add(node.name.text);
        } else if (ts.isObjectBindingPattern(node.name)) {
          for (const element of node.name.elements) {
            if (!element.dotDotDotToken && ts.isIdentifier(element.name)) {
              localNames.add(element.name.text);
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return localNames;
}

/**
 * For behavior-diff's reachability seed: option-bag keys the app passes
 * into a call whose callee traces back to a symbol imported from pkgName —
 * e.g. `Consumer.create({ handleMessage })` seeds "handleMessage". A plain
 * imported-symbol scan alone can't find this: `handleMessage` never
 * appears as an import, only as an object-literal key the app hands to the
 * package. Only direct (non-computed) property names are collected —
 * `{ [dynamicKey]: fn }` can't be attributed statically.
 */
export async function scanPassedOptionKeys(
  appDir: string,
  pkgName: string,
): Promise<Set<string>> {
  const { symbols: importedSymbols } = await scanImportedSymbols(appDir, pkgName);
  if (importedSymbols.size === 0) return new Set();

  const files = await collectSourceFiles(appDir);
  const optionKeys = new Set<string>();

  for (const filePath of files) {
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch {
      continue;
    }
    const sourceFile = ts.createSourceFile(
      filePath,
      content,
      ts.ScriptTarget.Latest,
      true,
      filePath.endsWith(".tsx") || filePath.endsWith(".jsx")
        ? ts.ScriptKind.TSX
        : ts.ScriptKind.TS,
    );

    const localImportBindings = collectLocalImportBindings(sourceFile, pkgName);

    function visit(node: ts.Node): void {
      if (ts.isCallExpression(node)) {
        const root = calleeRootIdentifier(node.expression);
        if (root && localImportBindings.has(root)) {
          for (const arg of node.arguments) {
            if (!ts.isObjectLiteralExpression(arg)) continue;
            for (const prop of arg.properties) {
              if (
                (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop) || ts.isMethodDeclaration(prop)) &&
                prop.name &&
                (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
              ) {
                optionKeys.add(prop.name.text);
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }

  return optionKeys;
}

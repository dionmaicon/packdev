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

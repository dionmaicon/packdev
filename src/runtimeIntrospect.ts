/**
 * Runtime fallback for when static .d.ts resolution finds nothing at all
 * (no bundled types, no @types/* sibling). Actually imports the package's
 * real JS and reflects its shape — walking the prototype chain, since a
 * naive Object.keys() on a class only sees instance-level enumerable
 * properties, never the methods that live on .prototype.
 *
 * Always runs in an isolated child process: importing a package can trigger
 * arbitrary side effects (network calls, file writes, a server that never
 * exits), so this must never run inline in the CLI's own process, must be
 * opt-in (never automatic), and must be timeout-bounded.
 */

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";

export interface RuntimeExportedSymbol {
  name: string;
  kind: "function" | "class" | "const";
  signature: string;
  members?: string[];
}

// Deliberately plain ESM (not TS) — this runs standalone via `node <file>`,
// never through the compiled dist bundle, so it's written out fresh each
// time rather than shipped as a build asset. Handles both CJS packages
// (import() exposes `module.exports` primarily via `.default`) and real
// ESM packages (named exports live directly on the namespace) with one
// heuristic: prefer `.default` when it looks like the real CJS export
// object, otherwise use the namespace itself.
const CHILD_SCRIPT = `import { pathToFileURL } from "node:url";

const entryPath = process.argv[2];
let ns;
try {
  ns = await import(pathToFileURL(entryPath).href);
} catch (err) {
  process.stdout.write(JSON.stringify({ error: String((err && err.message) || err) }));
  process.exit(0);
}

const looksLikeCjsInterop =
  ns && typeof ns === "object" && "default" in ns &&
  ns.default && typeof ns.default === "object" &&
  Object.keys(ns.default).length > 0;
const target = looksLikeCjsInterop ? ns.default : ns;

function collectMembers(fn) {
  const members = new Set();
  let proto = fn.prototype;
  while (proto && proto !== Object.prototype && proto !== Function.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name !== "constructor") members.add(name);
    }
    proto = Object.getPrototypeOf(proto);
  }
  return [...members];
}

const results = [];
const keys = new Set([
  ...Object.keys(target),
  ...Object.getOwnPropertyNames(target),
]);
for (const name of keys) {
  if (name === "default" || name === "__esModule") continue;
  let value;
  try {
    value = target[name];
  } catch {
    continue;
  }
  if (typeof value === "function") {
    const members = collectMembers(value);
    results.push({
      name,
      kind: members.length > 0 ? "class" : "function",
      signature: \`(\${value.length} args)\`,
      ...(members.length > 0 ? { members } : {}),
    });
  } else {
    results.push({ name, kind: "const", signature: "" });
  }
}

process.stdout.write(JSON.stringify(results));
`;

/**
 * Import `entryPath` in an isolated child process and reflect its runtime
 * shape. Returns null (never throws) when introspection fails, times out,
 * or the module's top-level code errors — a failed introspection is a
 * valid, reportable outcome, not a crash.
 */
export async function introspectModuleRuntime(
  entryPath: string,
  timeoutMs = 5000,
): Promise<RuntimeExportedSymbol[] | null> {
  const scriptDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "packdev-introspect-"),
  );
  const scriptPath = path.join(scriptDir, "introspect.mjs");
  await fs.writeFile(scriptPath, CHILD_SCRIPT);

  try {
    return await new Promise<RuntimeExportedSymbol[] | null>((resolve) => {
      const child = spawn("node", [scriptPath, entryPath]);
      let stdout = "";
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        resolve(null);
      }, timeoutMs);

      child.stdout?.on("data", (chunk) => (stdout += chunk.toString()));
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          resolve(null);
          return;
        }
        try {
          const parsed: unknown = JSON.parse(stdout);
          resolve(Array.isArray(parsed) ? (parsed as RuntimeExportedSymbol[]) : null);
        } catch {
          resolve(null);
        }
      });
      child.on("error", () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      });
    });
  } finally {
    await fs.rm(scriptDir, { recursive: true, force: true });
  }
}

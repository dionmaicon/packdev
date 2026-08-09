#!/usr/bin/env node
// Prepare a throwaway demo project for assets/api-compat-demo.tape and print
// its path + fake-registry URL, space-separated, on stdout.
//
// The scenario: a fictional "acme-utils" package where formatDate exists in
// 1.0.0 and 1.1.0, then gets dropped in 2.0.0 — a real-shaped breaking
// change `packdev api-diff` catches before you actually upgrade to it.
//
// Usage: api-compat-demo-setup.js <repo-root>

const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const tar = require(path.join(__dirname, "..", "node_modules", "tar"));

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const REPO = process.argv[2];

const ACME_FILES = {
  "1.0.0": {
    "index.js": "module.exports = { formatDate: (input) => new Date(input).toISOString() };\n",
    "index.d.ts": "export function formatDate(input: string): string;\n",
  },
  "1.1.0": {
    "index.js":
      "module.exports = {\n" +
      "  formatDate: (input) => new Date(input).toISOString(),\n" +
      "  parseDate: (input) => new Date(input),\n" +
      "};\n",
    "index.d.ts":
      "export function formatDate(input: string): string;\n" +
      "export function parseDate(input: string): Date;\n",
  },
  // formatDate dropped — a real-shaped breaking change api-diff should catch.
  "2.0.0": {
    "index.js": "module.exports = { parseDate: (input) => new Date(input) };\n",
    "index.d.ts": "export function parseDate(input: string): Date;\n",
  },
};

function writePackageFiles(dir, version, files) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "acme-utils", version, main: "index.js", types: "index.d.ts" }),
  );
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
}

async function buildTarball(version, files, registryDataDir) {
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), "packdev-demo-tarball-"));
  writePackageFiles(path.join(srcDir, "package"), version, files);
  const tgzPath = path.join(registryDataDir, `${version}.tgz`);
  await tar.c({ gzip: true, cwd: srcDir, file: tgzPath }, ["package"]);
  fs.rmSync(srcDir, { recursive: true, force: true });
}

async function main() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "packdev-api-compat-demo-"));

  // `packdev` wrapper on PATH that runs the local dist build.
  fs.mkdirSync(path.join(d, "bin"));
  fs.writeFileSync(
    path.join(d, "bin", "packdev"),
    `#!/bin/sh\nexec node "${REPO}/dist/index.js" "$@"\n`,
  );
  fs.chmodSync(path.join(d, "bin", "packdev"), 0o755);

  // The demo app: imports formatDate, currently on acme-utils@1.0.0.
  const appDir = path.join(d, "app");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(
    path.join(appDir, "package.json"),
    JSON.stringify({ name: "app", version: "1.0.0", dependencies: { "acme-utils": "^1.0.0" } }),
  );
  fs.writeFileSync(
    path.join(appDir, "index.ts"),
    'import { formatDate } from "acme-utils";\n\nformatDate("2024-01-01");\n',
  );
  writePackageFiles(
    path.join(appDir, "node_modules", "acme-utils"),
    "1.0.0",
    ACME_FILES["1.0.0"],
  );

  // Registry data for api-diff's --range check across all three versions.
  const registryDataDir = path.join(d, "registry-data");
  fs.mkdirSync(registryDataDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDataDir, "manifest.json"),
    JSON.stringify({ versions: ACME_FILES }),
  );
  for (const [version, files] of Object.entries(ACME_FILES)) {
    await buildTarball(version, files, registryDataDir);
  }

  const server = spawn(
    process.execPath,
    [path.join(__dirname, "api-compat-demo-server.js"), registryDataDir],
    { detached: true, stdio: "ignore" },
  );
  server.unref();

  const readyMarker = path.join(registryDataDir, "server.ready");
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(readyMarker) && Date.now() < deadline) {
    sleepSync(50);
  }

  const port = fs.readFileSync(readyMarker, "utf-8").trim();
  process.stdout.write(`${d} http://127.0.0.1:${port}\n`);
}

main();

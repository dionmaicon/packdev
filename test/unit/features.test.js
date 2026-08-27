#!/usr/bin/env node

/**
 * Unit tests for the agent-productivity feature set shipped alongside the core
 * commands: JSON output mode, stable exit codes, --dry-run, --no-install,
 * `packdev link` (monorepo/sibling auto-detect), `packdev watch`,
 * `packdev restore` (crash-safety backup), idempotent init, and stale-backup
 * detection.
 *
 * Each test runs in its own throwaway directory and drives the compiled CLI at
 * dist/index.js exactly as a user/agent would.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const tar = require('tar');

const BINARY_PATH = path.join(__dirname, '../../dist/index.js');

const colors = { reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m', blue: '\x1b[34m', cyan: '\x1b[36m' };
function log(message, color = 'reset') {
  console.log(`${colors[color] || ''}${message}${colors.reset}`);
}

// Run the CLI in `cwd`, resolving with { code, stdout, stderr }. stdout is kept
// separate so JSON-mode purity can be asserted.
// `env` values of `null` delete that key from the inherited environment
// entirely (rather than merging in the literal string "null") — needed so
// tests can assert "no token configured" behavior even when the runner
// itself has NPM_TOKEN/NODE_AUTH_TOKEN set (e.g. this repo's own publish CI).
function runPackdev(cwd, args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const mergedEnv = { ...process.env, ...env };
    for (const [key, value] of Object.entries(mergedEnv)) {
      if (value === null) delete mergedEnv[key];
    }
    const child = spawn('node', [BINARY_PATH, ...args], {
      stdio: 'pipe',
      cwd,
      env: mergedEnv,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', reject);
  });
}

// A minimal JSON-RPC client for `packdev mcp`: frames stdout by newline,
// resolves each request by matching its response `id` (never a fixed sleep,
// so it can't be killed early by a slow CI runner and can't wait longer than
// necessary either), and tracks stderr for diagnostics on timeout.
function createMcpClient(cwd) {
  const child = spawn('node', [BINARY_PATH, 'mcp'], { stdio: 'pipe', cwd });
  let buffer = '';
  let stderr = '';
  const pending = new Map();
  let nextId = 1;

  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const waiter = message.id !== undefined ? pending.get(message.id) : undefined;
      if (waiter) {
        pending.delete(message.id);
        waiter.resolve(message);
      }
    }
  });
  child.stderr.on('data', (d) => (stderr += d.toString()));

  function send(message) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  function request(method, params, timeoutMs = 15000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP request "${method}" (id ${id}) timed out after ${timeoutMs}ms — stderr: ${stderr}`));
      }, timeoutMs);
      pending.set(id, {
        resolve: (message) => {
          clearTimeout(timer);
          resolve(message);
        },
      });
      send({ jsonrpc: '2.0', id, method, params });
    });
  }

  return {
    async initialize() {
      await request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test', version: '0.0.1' },
      });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    },
    listTools() {
      return request('tools/list');
    },
    callTool(name, args) {
      return request('tools/call', { name, arguments: args });
    },
    get stderr() {
      return stderr;
    },
    async close() {
      child.kill();
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise((resolve) => child.once('close', resolve));
    },
  };
}

// Strips wall-clock-dependent fields (compat's per-version durationMs) before
// a deep-equal comparison between two independently-run reports — everything
// else about two runs of the same fixture should be identical, but real
// elapsed time inherently isn't.
function stripDurations(value) {
  if (Array.isArray(value)) return value.map(stripDurations);
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, v] of Object.entries(value)) {
      if (key === 'durationMs') continue;
      result[key] = stripDurations(v);
    }
    return result;
  }
  return value;
}

// Parse the single JSON line the CLI emits on stdout in --json mode. Fails the
// assertion (rather than throwing a raw SyntaxError) when stdout is polluted.
function parseJson(stdout, context) {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    throw new Error(`${context}: stdout was not a single JSON line:\n${JSON.stringify(stdout)}`);
  }
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

// Create an isolated temp project dir and return its path.
function makeTmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `packdev-${prefix}-`));
}

// Write a fake installed package under `<baseDir>/node_modules/<pkgName>`,
// with the given package.json contents plus a map of relative-path -> file
// content (e.g. { 'index.d.ts': 'export function foo(): void;' }).
function writeNodeModulesPackage(baseDir, pkgName, pkgJson, files = {}) {
  const pkgDir = path.join(baseDir, 'node_modules', pkgName);
  fs.mkdirSync(pkgDir, { recursive: true });
  writeJson(path.join(pkgDir, 'package.json'), pkgJson);
  for (const [relPath, content] of Object.entries(files)) {
    const filePath = path.join(pkgDir, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return pkgDir;
}

// Pack `files` (relative-path -> content) into an in-memory .tgz buffer
// rooted at "package/", the same layout every npm tarball uses.
async function buildFakeTarball(files) {
  const srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'packdev-fixture-'));
  const pkgDir = path.join(srcDir, 'package');
  fs.mkdirSync(pkgDir, { recursive: true });
  for (const [relPath, content] of Object.entries(files)) {
    const filePath = path.join(pkgDir, relPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  const tgzPath = path.join(srcDir, 'package.tgz');
  await tar.c({ gzip: true, cwd: srcDir, file: tgzPath }, ['package']);
  const buffer = fs.readFileSync(tgzPath);
  fs.rmSync(srcDir, { recursive: true, force: true });
  return buffer;
}

// Fake npm registry serving package docs + tarballs for `packages`
// ({ [pkgName]: { [version]: { tarballBuffer, deprecated? } } }), so a single
// server can serve both a package and its @types/<pkg> counterpart. No real
// network calls. Unregistered package names correctly 404, matching real
// registry behavior for "no @types package published".
function startFakeRegistry(packages) {
  return new Promise((resolve) => {
    let port;
    const server = http.createServer((req, res) => {
      const url = decodeURIComponent(req.url);

      const pkgName = Object.keys(packages).find((name) => url === `/${name}`);
      if (pkgName) {
        const versionsMap = packages[pkgName];
        const versions = {};
        for (const [version, info] of Object.entries(versionsMap)) {
          versions[version] = {
            version,
            dist: {
              tarball: `http://127.0.0.1:${port}/tarballs/${encodeURIComponent(pkgName)}/${version}.tgz`,
            },
            ...(info.deprecated ? { deprecated: info.deprecated } : {}),
            // npm decides whether to run lifecycle scripts from this
            // packument manifest, not by inspecting the extracted tarball —
            // omitting `scripts` here silently skips postinstall etc.
            ...(info.scripts ? { scripts: info.scripts } : {}),
            // Likewise, npm's arborist resolves the transitive dependency
            // tree from this packument manifest, not from the tarball's own
            // package.json — omitting `dependencies` here means npm never
            // learns this version needs anything installed under it.
            ...(info.dependencies ? { dependencies: info.dependencies } : {}),
          };
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ name: pkgName, versions }));
        return;
      }

      const match = url.match(/^\/tarballs\/(.+)\/(.+)\.tgz$/);
      const info = match && packages[match[1]] && packages[match[1]][match[2]];
      if (info) {
        res.setHeader('content-type', 'application/octet-stream');
        res.end(info.tarballBuffer);
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve(server);
    });
  });
}

// Same shape as startFakeRegistry, but 401s any request whose Authorization
// header isn't exactly `Bearer <expectedToken>` — for exercising packdev's
// registry auth (--token / NPM_TOKEN / NODE_AUTH_TOKEN / .npmrc) end to end.
function startAuthGatedRegistry(packages, expectedToken) {
  return new Promise((resolve) => {
    let port;
    const server = http.createServer((req, res) => {
      if (req.headers.authorization !== `Bearer ${expectedToken}`) {
        res.statusCode = 401;
        res.end('Unauthorized');
        return;
      }

      const url = decodeURIComponent(req.url);
      const pkgName = Object.keys(packages).find((name) => url === `/${name}`);
      if (pkgName) {
        const versionsMap = packages[pkgName];
        const versions = {};
        for (const [version, info] of Object.entries(versionsMap)) {
          versions[version] = {
            version,
            dist: { tarball: `http://127.0.0.1:${port}/tarballs/${encodeURIComponent(pkgName)}/${version}.tgz` },
          };
        }
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ name: pkgName, versions }));
        return;
      }

      const match = url.match(/^\/tarballs\/(.+)\/(.+)\.tgz$/);
      const info = match && packages[match[1]] && packages[match[1]][match[2]];
      if (info) {
        res.setHeader('content-type', 'application/octet-stream');
        res.end(info.tarballBuffer);
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve(server);
    });
  });
}

// A minimal build script (as a package.json "build" entry) that writes a marker
// file, avoiding shell-quoting pitfalls by using fromCharCode.
const MARKER = 'built.txt';
const BUILD_SCRIPT =
  `node -e "require(String.fromCharCode(102,115)).writeFileSync('${MARKER}','x')"`;

class FeatureTests {
  constructor() {
    this.passed = 0;
    this.total = 0;
    this.dirs = [];
    this.servers = [];
  }

  tmp(prefix) {
    const dir = makeTmpDir(prefix);
    this.dirs.push(dir);
    return dir;
  }

  async registry(pkgName, versionsMap) {
    return this.registryMulti({ [pkgName]: versionsMap });
  }

  async registryMulti(packages) {
    const server = await startFakeRegistry(packages);
    this.servers.push(server);
    return `http://127.0.0.1:${server.address().port}`;
  }

  async run(name, fn) {
    this.total++;
    try {
      log(`🧪 ${name}`, 'blue');
      await fn();
      this.passed++;
      log(`✅ ${name}`, 'green');
    } catch (error) {
      log(`❌ ${name}`, 'red');
      log(`   ${error.message}`, 'red');
      throw error;
    }
  }

  // --- Exit codes -----------------------------------------------------------

  async testExitCodeConfigNotFound() {
    await this.run('exit code 2 when config missing', async () => {
      const dir = this.tmp('exit2');
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: {} });
      const r = await runPackdev(dir, ['init', '--json']);
      assert.strictEqual(r.code, 2, `expected exit 2, got ${r.code}`);
      const json = parseJson(r.stdout, 'init');
      assert.strictEqual(json.success, false);
      assert.match(json.error, /Configuration file .* not found/i);
    });
  }

  async testExitCodePackageJsonNotFound() {
    await this.run('exit code 3 when package.json missing', async () => {
      const dir = this.tmp('exit3');
      fs.mkdirSync(path.join(dir, 'lib'));
      writeJson(path.join(dir, 'lib/package.json'), { name: 'lib', version: '1.0.0' });
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: { lib: '^1.0.0' } });
      writeJson(path.join(dir, 'package-lock.json'), { name: 'h', lockfileVersion: 2 });
      await runPackdev(dir, ['create-config']);
      await runPackdev(dir, ['add', 'lib', './lib', '--no-install']);
      fs.unlinkSync(path.join(dir, 'package.json'));
      const r = await runPackdev(dir, ['init', '--json']);
      assert.strictEqual(r.code, 3, `expected exit 3, got ${r.code}`);
      const json = parseJson(r.stdout, 'init');
      assert.match(json.error, /package\.json not found/i);
    });
  }

  async testExitCodeSuccess() {
    await this.run('exit code 0 on success', async () => {
      const dir = this.tmp('exit0');
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: {} });
      writeJson(path.join(dir, 'package-lock.json'), { name: 'h', lockfileVersion: 2 });
      const r = await runPackdev(dir, ['status', '--json']);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}`);
    });
  }

  // --- JSON output ----------------------------------------------------------

  async testJsonShape() {
    await this.run('status --json emits the documented shape', async () => {
      const dir = this.tmp('json-shape');
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: {} });
      const r = await runPackdev(dir, ['status', '--json']);
      const json = parseJson(r.stdout, 'status');
      assert.strictEqual(json.command, 'status');
      assert.strictEqual(typeof json.isInDevMode, 'boolean');
      assert.ok(Array.isArray(json.dependencies));
      assert.strictEqual(typeof json.hasStaleBackup, 'boolean');
    });
  }

  async testJsonStdoutPurityDuringInstall() {
    // Regression guard: install progress must go to stderr so stdout stays a
    // single parseable JSON line, even when a real install runs.
    await this.run('--json stdout stays pure while install runs', async () => {
      const dir = this.tmp('json-pure');
      fs.mkdirSync(path.join(dir, 'lib'));
      writeJson(path.join(dir, 'lib/package.json'), { name: 'lib', version: '1.0.0' });
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: { lib: '^1.0.0' } });
      writeJson(path.join(dir, 'package-lock.json'), { name: 'h', lockfileVersion: 2 });
      await runPackdev(dir, ['create-config']);
      await runPackdev(dir, ['add', 'lib', './lib', '--no-install']);
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: { lib: '^1.0.0' } });
      // No --no-install: exercises the install code path.
      const r = await runPackdev(dir, ['init', '--json']);
      // stdout must be exactly one JSON line regardless of install outcome.
      const json = parseJson(r.stdout, 'init');
      assert.strictEqual(json.command, 'init');
      assert.strictEqual(r.stdout.trim().split('\n').length, 1, 'stdout must be a single line');
    });
  }

  // --- --dry-run ------------------------------------------------------------

  async testDryRunNoWrites() {
    await this.run('init --dry-run writes nothing', async () => {
      const dir = this.tmp('dryrun');
      fs.mkdirSync(path.join(dir, 'lib'));
      writeJson(path.join(dir, 'lib/package.json'), { name: 'lib', version: '1.0.0' });
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: { lib: '^1.0.0' } });
      writeJson(path.join(dir, 'package-lock.json'), { name: 'h', lockfileVersion: 2 });
      await runPackdev(dir, ['create-config']);
      await runPackdev(dir, ['add', 'lib', './lib', '--no-install']);
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: { lib: '^1.0.0' } });
      const before = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
      const r = await runPackdev(dir, ['init', '--dry-run', '--no-install', '--json']);
      const after = fs.readFileSync(path.join(dir, 'package.json'), 'utf8');
      const json = parseJson(r.stdout, 'init');
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.dryRun, true);
      assert.strictEqual(before, after, 'package.json must be unchanged after dry run');
      assert.ok(!fs.existsSync(path.join(dir, 'node_modules')), 'no install during dry run');
    });
  }

  // --- --no-install ---------------------------------------------------------

  async testNoInstallSkipsInstall() {
    await this.run('init --no-install skips node_modules', async () => {
      const dir = this.tmp('noinstall');
      fs.mkdirSync(path.join(dir, 'lib'));
      writeJson(path.join(dir, 'lib/package.json'), { name: 'lib', version: '1.0.0' });
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: { lib: '^1.0.0' } });
      writeJson(path.join(dir, 'package-lock.json'), { name: 'h', lockfileVersion: 2 });
      await runPackdev(dir, ['create-config']);
      await runPackdev(dir, ['add', 'lib', './lib', '--no-install']);
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: { lib: '^1.0.0' } });
      const r = await runPackdev(dir, ['init', '--no-install', '--json']);
      const json = parseJson(r.stdout, 'init');
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.replacedCount, 1, 'should have replaced the dep in package.json');
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      assert.ok(pkg.dependencies.lib.startsWith('file:'), 'package.json rewritten to file: path');
      assert.ok(!fs.existsSync(path.join(dir, 'node_modules')), '--no-install must not create node_modules');
    });
  }

  // --- Idempotency ----------------------------------------------------------

  async testInitIdempotent() {
    await this.run('init is idempotent (second run replaces 0)', async () => {
      const dir = this.tmp('idem');
      fs.mkdirSync(path.join(dir, 'lib'));
      writeJson(path.join(dir, 'lib/package.json'), { name: 'lib', version: '1.0.0' });
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: { lib: '^1.0.0' } });
      writeJson(path.join(dir, 'package-lock.json'), { name: 'h', lockfileVersion: 2 });
      await runPackdev(dir, ['create-config']);
      await runPackdev(dir, ['add', 'lib', './lib', '--no-install']);
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: { lib: '^1.0.0' } });
      const first = parseJson((await runPackdev(dir, ['init', '--no-install', '--json'])).stdout, 'init#1');
      assert.strictEqual(first.replacedCount, 1, 'first init replaces 1');
      const second = parseJson((await runPackdev(dir, ['init', '--no-install', '--json'])).stdout, 'init#2');
      assert.strictEqual(second.replacedCount, 0, 'second init is a no-op');
    });
  }

  // --- link -----------------------------------------------------------------

  buildMonorepo(prefix) {
    const dir = this.tmp(prefix);
    fs.mkdirSync(path.join(dir, 'packages/ui'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'apps/web'), { recursive: true });
    writeJson(path.join(dir, 'package.json'), { name: 'root', private: true, workspaces: ['packages/*', 'apps/*'] });
    writeJson(path.join(dir, 'package-lock.json'), { name: 'root', lockfileVersion: 2 });
    writeJson(path.join(dir, 'packages/ui/package.json'), { name: '@acme/ui', version: '1.0.0' });
    writeJson(path.join(dir, 'apps/web/package.json'), { name: 'web', version: '1.0.0', dependencies: { '@acme/ui': '^1.0.0' } });
    return dir;
  }

  async testLinkFromWorkspaceChild() {
    await this.run('link auto-detects a workspace sibling from a child dir', async () => {
      const dir = this.buildMonorepo('link-child');
      const web = path.join(dir, 'apps/web');
      await runPackdev(web, ['create-config']);
      const r = await runPackdev(web, ['link', '@acme/ui', '--no-install', '--json']);
      const json = parseJson(r.stdout, 'link');
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}`);
      assert.strictEqual(json.success, true);
      assert.match(json.location, /packages[/\\]ui/, `location should point at packages/ui, got ${json.location}`);
    });
  }

  async testLinkNoMatch() {
    await this.run('link fails clearly when no local package matches', async () => {
      const dir = this.buildMonorepo('link-nomatch');
      const web = path.join(dir, 'apps/web');
      await runPackdev(web, ['create-config']);
      const r = await runPackdev(web, ['link', 'does-not-exist', '--no-install', '--json']);
      assert.notStrictEqual(r.code, 0, 'should exit non-zero');
      const json = parseJson(r.stdout, 'link');
      assert.strictEqual(json.success, false);
      assert.match(json.error, /No local package named/i);
    });
  }

  // --- api (export map of an installed package) -----------------------------

  async testApiHumanOutput() {
    await this.run('api prints the export map of the installed version', async () => {
      const dir = this.tmp('api-human');
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: {} });
      writeNodeModulesPackage(
        dir,
        'fake-lib',
        { name: 'fake-lib', version: '1.5.0', main: 'index.js', types: 'index.d.ts' },
        {
          'index.js': 'module.exports = {};',
          'index.d.ts': [
            'export function formatDate(input: string, fmt?: string): string;',
            'export declare class AuthService {}',
            'export interface AuthState { loggedIn: boolean; }',
          ].join('\n'),
        },
      );
      const r = await runPackdev(dir, ['api', 'fake-lib']);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      assert.match(r.stdout, /fake-lib@1\.5\.0/);
      assert.match(r.stdout, /formatDate/);
      assert.match(r.stdout, /AuthService/);
      assert.match(r.stdout, /AuthState/);
    });
  }

  async testApiJsonShape() {
    await this.run('api --json emits the documented shape', async () => {
      const dir = this.tmp('api-json');
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: {} });
      writeNodeModulesPackage(
        dir,
        'fake-lib',
        { name: 'fake-lib', version: '1.5.0', main: 'index.js', types: 'index.d.ts' },
        {
          'index.js': 'module.exports = {};',
          'index.d.ts': 'export function formatDate(input: string, fmt?: string): string;',
        },
      );
      const r = await runPackdev(dir, ['api', 'fake-lib', '--json']);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api');
      assert.strictEqual(json.command, 'api');
      assert.strictEqual(json.package, 'fake-lib');
      assert.strictEqual(json.version, '1.5.0');
      assert.strictEqual(json.hasTypes, true);
      assert.ok(Array.isArray(json.exports));
      const formatDate = json.exports.find((e) => e.name === 'formatDate');
      assert.ok(formatDate, 'expected formatDate in exports');
      assert.strictEqual(formatDate.kind, 'function');
    });
  }

  async testApiExportsMapResolution() {
    await this.run('api resolves types via a conditional "exports" map', async () => {
      const dir = this.tmp('api-exports-map');
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: {} });
      writeNodeModulesPackage(
        dir,
        'exports-lib',
        {
          name: 'exports-lib',
          version: '2.0.0',
          exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
        },
        {
          'dist/index.js': 'module.exports = {};',
          'dist/index.d.ts': 'export function foo(): void;',
        },
      );
      const r = await runPackdev(dir, ['api', 'exports-lib', '--json']);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api');
      assert.strictEqual(json.hasTypes, true);
      assert.ok(json.exports.some((e) => e.name === 'foo'), 'expected foo in exports');
    });
  }

  async testApiResolvesExportEqualsAsDefault() {
    await this.run('api reports a TS "export = X" declaration as the default export', async () => {
      const dir = this.tmp('api-export-equals');
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: {} });
      writeNodeModulesPackage(
        dir,
        'export-equals-lib',
        { name: 'export-equals-lib', version: '1.0.0', main: 'index.js', types: 'index.d.ts' },
        {
          'index.js': 'module.exports = (value) => value % 2 !== 0;',
          'index.d.ts': 'declare function isOdd(value: number): boolean;\nexport = isOdd;\n',
        },
      );
      const r = await runPackdev(dir, ['api', 'export-equals-lib', '--json']);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api');
      assert.strictEqual(json.hasTypes, true);
      const defaultExport = json.exports.find((e) => e.name === 'default');
      assert.ok(defaultExport, 'expected "export = isOdd" to surface as a "default" export, not be invisible');
      assert.strictEqual(defaultExport.kind, 'function');
    });
  }

  async testApiIncludesSubpathExports() {
    await this.run('api includes exports from subpaths declared in the "exports" map', async () => {
      const dir = this.tmp('api-subpath-exports');
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: {} });
      writeNodeModulesPackage(
        dir,
        'fake-lib',
        {
          name: 'fake-lib',
          version: '1.0.0',
          exports: {
            '.': { types: './index.d.ts', default: './index.js' },
            './testing': { types: './testing.d.ts', default: './testing.js' },
          },
        },
        {
          'index.js': 'module.exports = {};',
          'index.d.ts': 'export function formatDate(input: string): string;',
          'testing.js': 'module.exports = {};',
          'testing.d.ts': 'export function mockThing(): void;',
        },
      );
      const r = await runPackdev(dir, ['api', 'fake-lib', '--json']);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api');
      assert.strictEqual(json.hasTypes, true);
      const root = json.exports.find((e) => e.name === 'formatDate');
      const sub = json.exports.find((e) => e.name === 'mockThing');
      assert.ok(root, 'expected formatDate from the root export');
      assert.strictEqual(root.subpath, '.');
      assert.ok(sub, 'expected mockThing from the ./testing subpath export');
      assert.strictEqual(sub.subpath, './testing');
    });
  }

  async testApiNoTypesAvailable() {
    await this.run('api reports hasTypes:false for a pure-JS package', async () => {
      const dir = this.tmp('api-no-types');
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: {} });
      writeNodeModulesPackage(
        dir,
        'plain-js',
        { name: 'plain-js', version: '0.1.0', main: 'index.js' },
        { 'index.js': 'module.exports = {};' },
      );
      const r = await runPackdev(dir, ['api', 'plain-js', '--json']);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api');
      assert.strictEqual(json.hasTypes, false);
      assert.deepStrictEqual(json.exports, []);
    });
  }

  async testApiFallsBackToRawHintsOnUnresolvableBarrelExport() {
    await this.run('api falls back to raw export hints when types exist but resolve to zero exports (barrel re-export)', async () => {
      const dir = this.tmp('api-barrel-fallback');
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: {} });
      // A pure `export * from "./sibling"` where the sibling module itself
      // declares nothing statically resolvable — checker.getExportsOfModule
      // legitimately returns [] here even though hasTypes is true, which
      // used to render as a flatly wrong "no exported symbols found".
      writeNodeModulesPackage(
        dir,
        'barrel-lib',
        { name: 'barrel-lib', version: '1.0.0', main: 'index.js', types: 'index.d.ts' },
        {
          'index.js': 'module.exports = {};',
          'index.d.ts': 'export * from "./sibling";\n',
          'sibling.d.ts': '',
        },
      );
      const r = await runPackdev(dir, ['api', 'barrel-lib', '--json']);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api');
      assert.strictEqual(json.hasTypes, true);
      assert.deepStrictEqual(json.exports, []);
      assert.ok(json.rawExportHints, 'expected a non-null rawExportHints fallback');
      assert.strictEqual(json.rawExportHints[0].name, '*');
      assert.match(json.rawExportHints[0].note, /re-exported from "\.\/sibling"/);

      const human = await runPackdev(dir, ['api', 'barrel-lib']);
      assert.match(human.stdout, /couldn't be statically resolved/);
      assert.match(human.stdout, /re-exported from "\.\/sibling"/);
      assert.doesNotMatch(human.stdout, /\(no exported symbols found\)/);
    });
  }

  async testApiIntrospectFindsPrototypeMethods() {
    await this.run('api --introspect reflects class prototype methods a naive Object.keys() would miss', async () => {
      const dir = this.tmp('api-introspect-basic');
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: {} });
      writeNodeModulesPackage(
        dir,
        'plain-js',
        { name: 'plain-js', version: '0.1.0', main: 'index.js' },
        {
          'index.js':
            'class Foo { bar() {} baz() {} }\n' +
            'module.exports = { Foo, plainFn: function (a, b) {} };\n',
        },
      );
      const r = await runPackdev(dir, ['api', 'plain-js', '--introspect', '--json']);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api');
      assert.strictEqual(json.hasTypes, false, 'no static types exist for this fixture');
      assert.ok(json.runtimeIntrospection, 'expected a runtimeIntrospection result');
      const foo = json.runtimeIntrospection.exports.find((e) => e.name === 'Foo');
      const fn = json.runtimeIntrospection.exports.find((e) => e.name === 'plainFn');
      assert.ok(foo, 'expected Foo in runtime-introspected exports');
      assert.strictEqual(foo.kind, 'class');
      assert.deepStrictEqual([...foo.members].sort(), ['bar', 'baz']);
      assert.ok(fn, 'expected plainFn in runtime-introspected exports');
      assert.strictEqual(fn.kind, 'function');
      assert.strictEqual(fn.signature, '(2 args)');
    });
  }

  async testApiIntrospectWorksThroughProxy() {
    await this.run('api --introspect reflects members correctly through a Proxy-wrapped export', async () => {
      const dir = this.tmp('api-introspect-proxy');
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: {} });
      writeNodeModulesPackage(
        dir,
        'proxied-js',
        { name: 'proxied-js', version: '0.1.0', main: 'index.js' },
        {
          'index.js':
            'class Foo { bar() {} }\n' +
            'module.exports = new Proxy({ Foo, plainFn: function (a, b) {} }, {});\n',
        },
      );
      const r = await runPackdev(dir, ['api', 'proxied-js', '--introspect', '--json']);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api');
      assert.ok(json.runtimeIntrospection, 'expected a runtimeIntrospection result');
      const foo = json.runtimeIntrospection.exports.find((e) => e.name === 'Foo');
      assert.ok(foo, 'expected Foo to be visible through the wrapping Proxy');
      assert.deepStrictEqual(foo.members, ['bar']);
    });
  }

  async testApiIntrospectIsOptInOnly() {
    await this.run('api never executes the package without --introspect', async () => {
      const dir = this.tmp('api-introspect-optin');
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: {} });
      const pkgDir = writeNodeModulesPackage(
        dir,
        'plain-js',
        { name: 'plain-js', version: '0.1.0', main: 'index.js' },
        {
          'index.js':
            'require("fs").writeFileSync(require("path").join(__dirname, "loaded.marker"), "x");\n' +
            'module.exports = {};\n',
        },
      );
      const r = await runPackdev(dir, ['api', 'plain-js', '--json']);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api');
      assert.strictEqual(json.runtimeIntrospection, null);
      assert.ok(
        !fs.existsSync(path.join(pkgDir, 'loaded.marker')),
        'package must never be executed unless --introspect is passed',
      );
    });
  }

  async testApiIntrospectTimesOutSafely() {
    await this.run('api --introspect times out instead of hanging on a stuck module', async () => {
      const dir = this.tmp('api-introspect-timeout');
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: {} });
      writeNodeModulesPackage(
        dir,
        'hangs-js',
        { name: 'hangs-js', version: '0.1.0', main: 'index.js' },
        { 'index.js': 'while (true) {}\n' },
      );
      const r = await runPackdev(dir, [
        'api', 'hangs-js', '--introspect', '--introspect-timeout-ms', '1500', '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api');
      assert.strictEqual(json.runtimeIntrospection, null);
    });
  }

  async testApiPackageNotInstalled() {
    await this.run('api exits 4 when the package is not installed', async () => {
      const dir = this.tmp('api-not-installed');
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: {} });
      const r = await runPackdev(dir, ['api', 'missing-pkg', '--json']);
      assert.strictEqual(r.code, 4, `expected exit 4, got ${r.code}`);
      const json = parseJson(r.stdout, 'api');
      assert.strictEqual(json.success, false);
      assert.match(json.error, /is not installed/i);
    });
  }

  async testApiHoistedResolution() {
    await this.run('api resolves a package hoisted to a parent node_modules', async () => {
      const dir = this.tmp('api-hoisted');
      const appDir = path.join(dir, 'apps/app-a');
      fs.mkdirSync(appDir, { recursive: true });
      writeJson(path.join(dir, 'package.json'), { name: 'root', version: '1.0.0', workspaces: ['apps/*'] });
      writeJson(path.join(appDir, 'package.json'), { name: 'app-a', version: '1.0.0' });
      const hoistedDir = writeNodeModulesPackage(
        dir,
        'hoisted-lib',
        { name: 'hoisted-lib', version: '3.0.0', main: 'index.js', types: 'index.d.ts' },
        { 'index.js': 'module.exports = {};', 'index.d.ts': 'export function bar(): void;' },
      );
      const r = await runPackdev(appDir, ['api', 'hoisted-lib', '--json']);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api');
      assert.strictEqual(json.resolvedPath, hoistedDir);
      assert.ok(json.exports.some((e) => e.name === 'bar'), 'expected bar in exports');
    });
  }

  // --- api-diff (static version-range check against app usage) --------------

  async testApiDiffRangeEnumerationAndDiff() {
    await this.run('api-diff finds the minimum/recommended version satisfying app usage', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js', types: 'index.d.ts' }),
        'index.js': 'module.exports = {};',
        'index.d.ts': 'export function other(): void;',
      });
      const v2 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '2.0.0', main: 'index.js', types: 'index.d.ts' }),
        'index.js': 'module.exports = {};',
        'index.d.ts': 'export function other(): void;\nexport function formatDate(input: string): string;',
      });
      const registryUrl = await this.registry('fake-lib', {
        '1.0.0': { tarballBuffer: v1 },
        '2.0.0': { tarballBuffer: v2 },
      });

      const appDir = this.tmp('api-diff-app');
      fs.writeFileSync(path.join(appDir, 'index.ts'), 'import { formatDate } from "fake-lib";\nformatDate("x");\n');

      const r = await runPackdev(appDir, [
        'api-diff', 'fake-lib',
        '--range', '>=1.0.0 <3.0.0',
        '--app', appDir,
        '--registry', registryUrl,
        '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api-diff');
      assert.deepStrictEqual(json.usedSymbols, ['formatDate']);
      assert.strictEqual(json.minimumCompatibleVersion, '2.0.0');
      assert.strictEqual(json.recommendedVersion, '2.0.0');
      const v1Result = json.versions.find((v) => v.version === '1.0.0');
      assert.strictEqual(v1Result.apiCompatible, false);
      assert.deepStrictEqual(v1Result.missingSymbols, ['formatDate']);
    });
  }

  async testApiDiffMissingSymbolsAreSortedAlphabetically() {
    await this.run('api-diff sorts missingSymbols alphabetically, not in scan/insertion order, so lists are diffable across versions', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js', types: 'index.d.ts' }),
        'index.js': 'module.exports = {};',
        'index.d.ts': 'export {};',
      });
      const registryUrl = await this.registry('fake-lib', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('api-diff-sorted-missing');
      // Import order is deliberately NOT alphabetical (zeta before alpha
      // before mid), so a passing test here proves the output is sorted
      // rather than just happening to match insertion order.
      fs.writeFileSync(
        path.join(appDir, 'index.ts'),
        'import { zeta, alpha, mid } from "fake-lib";\nzeta();\nalpha();\nmid();\n',
      );

      const r = await runPackdev(appDir, [
        'api-diff', 'fake-lib', '--range', '>=1.0.0 <2.0.0', '--app', appDir, '--registry', registryUrl, '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api-diff');
      assert.deepStrictEqual(json.versions[0].missingSymbols, ['alpha', 'mid', 'zeta']);
    });
  }

  async testApiDiffDoesNotFalseNegativeOnExportEquals() {
    await this.run('api-diff does not false-negative a default import against a TS "export = X" package', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js', types: 'index.d.ts' }),
        'index.js': 'module.exports = (value) => value % 2 !== 0;',
        'index.d.ts': 'declare function isOdd(value: number): boolean;\nexport = isOdd;\n',
      });
      const registryUrl = await this.registry('fake-lib', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('api-diff-export-equals');
      fs.writeFileSync(path.join(appDir, 'index.ts'), 'import isOdd from "fake-lib";\nisOdd(3);\n');

      const r = await runPackdev(appDir, [
        'api-diff', 'fake-lib', '--range', '>=1.0.0 <2.0.0', '--app', appDir, '--registry', registryUrl, '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api-diff');
      assert.deepStrictEqual(json.usedSymbols, ['default']);
      const versionResult = json.versions[0];
      assert.strictEqual(
        versionResult.apiCompatible, true,
        '"export = isOdd" satisfies a default import and must not be reported as a missing symbol',
      );
      assert.deepStrictEqual(versionResult.missingSymbols, []);
    });
  }

  async testApiDiffExcludesPrereleaseByDefault() {
    await this.run('api-diff excludes prerelease versions unless --include-prerelease', async () => {
      const v2 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '2.0.0', main: 'index.js', types: 'index.d.ts' }),
        'index.js': 'module.exports = {};',
        'index.d.ts': 'export function formatDate(input: string): string;',
      });
      const registryUrl = await this.registry('fake-lib', {
        '2.0.0': { tarballBuffer: v2 },
        '3.0.0-beta.1': { tarballBuffer: v2 },
      });

      const appDir = this.tmp('api-diff-prerelease');
      fs.writeFileSync(path.join(appDir, 'index.ts'), '');

      const withoutFlag = await runPackdev(appDir, [
        'api-diff', 'fake-lib', '--range', '>=1.0.0 <4.0.0', '--app', appDir, '--registry', registryUrl, '--json',
      ]);
      const withoutJson = parseJson(withoutFlag.stdout, 'api-diff');
      assert.ok(!withoutJson.versions.some((v) => v.version === '3.0.0-beta.1'), 'prerelease should be excluded by default');

      const withFlag = await runPackdev(appDir, [
        'api-diff', 'fake-lib', '--range', '>=1.0.0 <4.0.0', '--app', appDir, '--registry', registryUrl, '--include-prerelease', '--json',
      ]);
      const withJson = parseJson(withFlag.stdout, 'api-diff');
      assert.ok(withJson.versions.some((v) => v.version === '3.0.0-beta.1'), 'prerelease should be included with --include-prerelease');
    });
  }

  async testApiDiffExcludesDeprecatedByDefault() {
    await this.run('api-diff excludes deprecated versions unless --include-deprecated', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js', types: 'index.d.ts' }),
        'index.js': 'module.exports = {};',
        'index.d.ts': 'export function formatDate(input: string): string;',
      });
      const v2 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '2.0.0', main: 'index.js', types: 'index.d.ts' }),
        'index.js': 'module.exports = {};',
        'index.d.ts': 'export function formatDate(input: string): string;',
      });
      const registryUrl = await this.registry('fake-lib', {
        '1.0.0': { tarballBuffer: v1 },
        '2.0.0': { tarballBuffer: v2, deprecated: 'superseded by 3.x' },
      });

      const appDir = this.tmp('api-diff-deprecated');
      fs.writeFileSync(path.join(appDir, 'index.ts'), '');

      const withoutFlag = await runPackdev(appDir, [
        'api-diff', 'fake-lib', '--range', '>=1.0.0 <3.0.0', '--app', appDir, '--registry', registryUrl, '--json',
      ]);
      const withoutJson = parseJson(withoutFlag.stdout, 'api-diff');
      assert.ok(!withoutJson.versions.some((v) => v.version === '2.0.0'), 'deprecated version should be excluded by default');

      const withFlag = await runPackdev(appDir, [
        'api-diff', 'fake-lib', '--range', '>=1.0.0 <3.0.0', '--app', appDir, '--registry', registryUrl, '--include-deprecated', '--json',
      ]);
      const withJson = parseJson(withFlag.stdout, 'api-diff');
      assert.ok(withJson.versions.some((v) => v.version === '2.0.0'), 'deprecated version should be included with --include-deprecated');
    });
  }

  async testApiDiffVsCompatDivergeOnBehaviorChange() {
    await this.run('api-diff (static) and compat (behavioral) can honestly disagree on the same version', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js', types: 'index.d.ts' }),
        'index.js': 'module.exports = { formatDate: () => "wrong-value" };',
        'index.d.ts': 'export function formatDate(input: string): string;',
      });
      const registryUrl = await this.registry('fake-lib', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('api-diff-vs-compat');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });
      fs.writeFileSync(path.join(appDir, 'index.ts'), 'import { formatDate } from "fake-lib";\nformatDate("x");\n');
      fs.writeFileSync(
        path.join(appDir, 'check.js'),
        'process.exit(require("fake-lib").formatDate("x") === "expected-value" ? 0 : 1);\n',
      );

      const diffResult = await runPackdev(appDir, [
        'api-diff', 'fake-lib', '--range', '>=1.0.0 <2.0.0', '--app', appDir, '--registry', registryUrl, '--json',
      ]);
      const diffJson = parseJson(diffResult.stdout, 'api-diff');
      const diffVersion = diffJson.versions.find((v) => v.version === '1.0.0');
      assert.strictEqual(diffVersion.apiCompatible, true, 'export shape matches, so api-diff should call it compatible');

      const compatResult = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir, '--registry', registryUrl, '--test', 'node check.js', '--json',
      ]);
      const compatJson = parseJson(compatResult.stdout, 'compat');
      assert.strictEqual(compatJson.versions[0].status, 'FAILED', 'runtime behavior differs, so compat should call it FAILED');
    });
  }

  async testApiDiffFlagsDynamicUsage() {
    await this.run('api-diff flags a namespace import as unverifiable dynamic usage', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js', types: 'index.d.ts' }),
        'index.js': 'module.exports = {};',
        'index.d.ts': 'export function formatDate(input: string): string;',
      });
      const registryUrl = await this.registry('fake-lib', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('api-diff-dynamic');
      fs.writeFileSync(path.join(appDir, 'index.ts'), 'import * as lib from "fake-lib";\nlib.formatDate("x");\n');

      const r = await runPackdev(appDir, [
        'api-diff', 'fake-lib', '--range', '>=1.0.0 <2.0.0', '--app', appDir, '--registry', registryUrl, '--json',
      ]);
      const json = parseJson(r.stdout, 'api-diff');
      assert.strictEqual(json.hasDynamicUsage, true);

      const human = await runPackdev(appDir, [
        'api-diff', 'fake-lib', '--range', '>=1.0.0 <2.0.0', '--app', appDir, '--registry', registryUrl,
      ]);
      assert.match(human.stdout, /could not be fully verified/i);
    });
  }

  async testApiDiffNoUsageMeansEveryVersionCompatible() {
    await this.run('api-diff reports every version compatible when the app never imports the package', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js', types: 'index.d.ts' }),
        'index.js': 'module.exports = {};',
        'index.d.ts': 'export function formatDate(input: string): string;',
      });
      const registryUrl = await this.registry('fake-lib', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('api-diff-nousage');
      fs.writeFileSync(path.join(appDir, 'index.ts'), 'export const x = 1;\n');

      const r = await runPackdev(appDir, [
        'api-diff', 'fake-lib', '--range', '>=1.0.0 <2.0.0', '--app', appDir, '--registry', registryUrl, '--json',
      ]);
      const json = parseJson(r.stdout, 'api-diff');
      assert.deepStrictEqual(json.usedSymbols, []);
      assert.ok(json.versions.every((v) => v.apiCompatible === true), 'every version should be compatible when nothing is used');
    });
  }

  async testApiDiffCleansUpTempDirs() {
    await this.run('api-diff leaves no packdev-api-diff-* temp dirs behind', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js', types: 'index.d.ts' }),
        'index.js': 'module.exports = {};',
        'index.d.ts': 'export function formatDate(input: string): string;',
      });
      const registryUrl = await this.registry('fake-lib', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('api-diff-cleanup');
      fs.writeFileSync(path.join(appDir, 'index.ts'), 'import { formatDate } from "fake-lib";\nformatDate("x");\n');

      const r = await runPackdev(appDir, [
        'api-diff', 'fake-lib', '--range', '>=1.0.0 <2.0.0', '--app', appDir, '--registry', registryUrl, '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);

      const leftover = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('packdev-tarball-extract-'));
      assert.deepStrictEqual(leftover, [], `expected no leftover temp dirs, found: ${leftover.join(', ')}`);
    });
  }

  async testApiDiffNeverInstallsAnything() {
    await this.run('api-diff never runs an install, even across a multi-version range', async () => {
      const versionsMap = {};
      for (let i = 1; i <= 5; i++) {
        const version = `${i}.0.0`;
        const tarball = await buildFakeTarball({
          'package.json': JSON.stringify({ name: 'fake-lib', version, main: 'index.js', types: 'index.d.ts' }),
          'index.js': 'module.exports = {};',
          'index.d.ts': 'export function formatDate(input: string): string;',
        });
        versionsMap[version] = { tarballBuffer: tarball };
      }
      const registryUrl = await this.registry('fake-lib', versionsMap);

      const appDir = this.tmp('api-diff-no-install');
      fs.writeFileSync(path.join(appDir, 'index.ts'), 'import { formatDate } from "fake-lib";\nformatDate("x");\n');

      const r = await runPackdev(appDir, [
        'api-diff', 'fake-lib', '--range', '>=1.0.0 <6.0.0', '--app', appDir, '--registry', registryUrl, '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api-diff');
      assert.strictEqual(json.versions.length, 5, 'expected all 5 versions diffed');
      assert.ok(
        !fs.existsSync(path.join(appDir, 'node_modules')),
        'api-diff must never install anything, even across a 5-version range',
      );
    });
  }

  async testApiDiffFallsBackToTypesPackage() {
    await this.run('api-diff resolves types via @types/<pkg> when the tarball has no bundled types', async () => {
      const libV1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'plain-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const typesV1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: '@types/plain-lib', version: '1.0.5', main: 'index.d.ts' }),
        'index.d.ts': 'export function formatDate(input: string): string;',
      });
      const registryUrl = await this.registryMulti({
        'plain-lib': { '1.0.0': { tarballBuffer: libV1 } },
        '@types/plain-lib': { '1.0.5': { tarballBuffer: typesV1 } },
      });

      const appDir = this.tmp('api-diff-types-fallback');
      fs.writeFileSync(path.join(appDir, 'index.ts'), 'import { formatDate } from "plain-lib";\nformatDate("x");\n');

      const r = await runPackdev(appDir, [
        'api-diff', 'plain-lib', '--range', '>=1.0.0 <2.0.0', '--app', appDir, '--registry', registryUrl, '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api-diff');
      const v1 = json.versions.find((v) => v.version === '1.0.0');
      assert.strictEqual(v1.typesSource, 'types-package');
      assert.strictEqual(v1.apiCompatible, true);
      assert.deepStrictEqual(v1.missingSymbols, []);
    });
  }

  async testApiDiffTypesSourceNoneWhenNoTypesAnywhere() {
    await this.run('api-diff reports typesSource:none when neither bundled nor @types types exist', async () => {
      const libV1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'no-types-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const registryUrl = await this.registry('no-types-lib', { '1.0.0': { tarballBuffer: libV1 } });

      const appDir = this.tmp('api-diff-no-types-anywhere');
      fs.writeFileSync(path.join(appDir, 'index.ts'), '');

      const r = await runPackdev(appDir, [
        'api-diff', 'no-types-lib', '--range', '>=1.0.0 <2.0.0', '--app', appDir, '--registry', registryUrl, '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api-diff');
      assert.strictEqual(json.versions[0].typesSource, 'none');
    });
  }

  async testApiDiffCountsSubpathExportsAsUsage() {
    await this.run('api-diff resolves symbols imported from a package subpath, not just the root export', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({
          name: 'fake-lib',
          version: '1.0.0',
          exports: {
            '.': { types: './index.d.ts', default: './index.js' },
            './testing': { types: './testing.d.ts', default: './testing.js' },
          },
        }),
        'index.js': 'module.exports = {};',
        'index.d.ts': 'export function formatDate(input: string): string;',
        'testing.js': 'module.exports = {};',
        'testing.d.ts': 'export function mockThing(): void;',
      });
      const registryUrl = await this.registry('fake-lib', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('api-diff-subpath-usage');
      fs.writeFileSync(
        path.join(appDir, 'index.ts'),
        'import { mockThing } from "fake-lib/testing";\nmockThing();\n',
      );

      const r = await runPackdev(appDir, [
        'api-diff', 'fake-lib', '--range', '>=1.0.0 <2.0.0', '--app', appDir, '--registry', registryUrl, '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api-diff');
      assert.deepStrictEqual(json.usedSymbols, ['mockThing']);
      assert.strictEqual(
        json.versions[0].apiCompatible,
        true,
        'mockThing is exported from the ./testing subpath and should not show up as missing',
      );
      assert.deepStrictEqual(json.versions[0].missingSymbols, []);
    });
  }

  async testApiDiffReportsUnresolvedNotMissingOnBarrelExport() {
    await this.run('api-diff reports unresolved (not missing) when types exist but resolve to zero exports (barrel re-export)', async () => {
      // A pure `export * from "./sibling"` where the sibling itself declares
      // nothing statically resolvable — checker.getExportsOfModule legitimately
      // returns [] here. Before the fix this made every used symbol show up in
      // missingSymbols as if genuinely absent: a confident false negative.
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'barrel-lib', version: '1.0.0', main: 'index.js', types: 'index.d.ts' }),
        'index.js': 'module.exports = {};',
        'index.d.ts': 'export * from "./sibling";\n',
        'sibling.d.ts': '',
      });
      const registryUrl = await this.registry('barrel-lib', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('api-diff-barrel-usage');
      fs.writeFileSync(
        path.join(appDir, 'index.ts'),
        'import { SomeRealExport } from "barrel-lib";\nSomeRealExport();\n',
      );

      const r = await runPackdev(appDir, [
        'api-diff', 'barrel-lib', '--range', '>=1.0.0 <2.0.0', '--app', appDir, '--registry', registryUrl, '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api-diff');
      assert.strictEqual(json.versions[0].apiCompatible, null, 'unresolved must be null, not false');
      assert.deepStrictEqual(json.versions[0].missingSymbols, [], 'must never report an unverifiable symbol as missing');
      assert.deepStrictEqual(json.versions[0].unresolvedSymbols, ['SomeRealExport']);
      assert.strictEqual(json.minimumCompatibleVersion, null);

      const human = await runPackdev(appDir, [
        'api-diff', 'barrel-lib', '--range', '>=1.0.0 <2.0.0', '--app', appDir, '--registry', registryUrl,
      ]);
      assert.match(human.stdout, /unresolved: SomeRealExport/);
      assert.match(human.stdout, /NOT a confirmed incompatibility/);
      assert.doesNotMatch(human.stdout, /missing: SomeRealExport/);
    });
  }

  async testApiDiffStillReportsGenuineMissingSymbols() {
    await this.run('api-diff still reports a genuinely missing symbol as missing, not unresolved', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js', types: 'index.d.ts' }),
        'index.js': 'module.exports = {};',
        'index.d.ts': 'export function formatDate(input: string): string;\n',
      });
      const registryUrl = await this.registry('fake-lib', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('api-diff-genuine-missing');
      fs.writeFileSync(
        path.join(appDir, 'index.ts'),
        'import { notExported } from "fake-lib";\nnotExported();\n',
      );

      const r = await runPackdev(appDir, [
        'api-diff', 'fake-lib', '--range', '>=1.0.0 <2.0.0', '--app', appDir, '--registry', registryUrl, '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api-diff');
      assert.strictEqual(json.versions[0].apiCompatible, false);
      assert.deepStrictEqual(json.versions[0].missingSymbols, ['notExported']);
      assert.deepStrictEqual(json.versions[0].unresolvedSymbols, []);
    });
  }

  // --- api-diff: no main/types/exports in manifest (issue #1) --------------

  async testApiDiffInfersDefaultEntryWhenManifestHasNoEntryFields() {
    await this.run('api-diff infers ./index.js + ./index.d.ts and follows export * into a directory, when the manifest declares no main/types/exports at all', async () => {
      const v1 = await buildFakeTarball({
        // Deliberately no main/types/typings/exports — the real-world
        // @nestjs/axios tarball shape.
        'package.json': JSON.stringify({ name: 'fx-no-entry', version: '1.0.0' }),
        'index.js': "module.exports = require('./dist');",
        'index.d.ts': "export * from './dist';\n",
        'dist/index.d.ts':
          'export declare class HttpService {}\nexport declare class HttpModule {}\n',
      });
      const registryUrl = await this.registry('fx-no-entry', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('api-diff-no-entry');
      fs.writeFileSync(
        path.join(appDir, 'index.ts'),
        'import { HttpModule, HttpService } from "fx-no-entry";\nHttpModule; HttpService;\n',
      );

      const r = await runPackdev(appDir, [
        'api-diff', 'fx-no-entry', '--range', '>=1.0.0 <2.0.0', '--app', appDir, '--registry', registryUrl, '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api-diff');
      assert.strictEqual(json.versions[0].apiCompatible, true);
      assert.deepStrictEqual(json.versions[0].missingSymbols, []);
      assert.ok(json.versions[0].exportCount >= 2);
    });
  }

  // --- api-diff: barrel of explicit named re-exports (issue #2) ------------

  async testApiDiffFollowsBarrelNamedReexports() {
    await this.run('api-diff follows a barrel .d.ts of explicit named re-exports across local files', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fx-barrel', version: '1.0.0', main: 'dist/index.js' }),
        'dist/index.js': 'module.exports = {};',
        'dist/index.d.ts':
          'export { Client } from "./client/client";\nexport * from "./models/models";\n',
        'dist/client/client.d.ts': 'export declare class Client {}\n',
        'dist/models/models.d.ts':
          'export declare enum FeeLevel { LOW, MEDIUM, HIGH }\nexport type TransactionRequest = { id: string };\n',
      });
      const registryUrl = await this.registry('fx-barrel', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('api-diff-barrel-reexport');
      fs.writeFileSync(
        path.join(appDir, 'index.ts'),
        'import { Client, FeeLevel, TransactionRequest } from "fx-barrel";\nClient; FeeLevel; TransactionRequest;\n',
      );

      const r = await runPackdev(appDir, [
        'api-diff', 'fx-barrel', '--range', '>=1.0.0 <2.0.0', '--app', appDir, '--registry', registryUrl, '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api-diff');
      assert.strictEqual(json.versions[0].apiCompatible, true, JSON.stringify(json.versions[0]));
      assert.deepStrictEqual(json.versions[0].missingSymbols, []);
    });
  }

  async testApiDiffBarrelPartialFailureOnlyFlagsGenuineMissing() {
    await this.run('api-diff regression guard: a barrel resolving 3 of 4 symbols reports only the 4th as missing, not all 4', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fx-barrel', version: '1.0.0', main: 'dist/index.js' }),
        'dist/index.js': 'module.exports = {};',
        'dist/index.d.ts':
          'export { Client } from "./client/client";\nexport * from "./models/models";\n',
        'dist/client/client.d.ts': 'export declare class Client {}\n',
        'dist/models/models.d.ts': 'export declare enum FeeLevel { LOW, MEDIUM, HIGH }\n',
      });
      const registryUrl = await this.registry('fx-barrel', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('api-diff-barrel-partial');
      fs.writeFileSync(
        path.join(appDir, 'index.ts'),
        'import { Client, FeeLevel, DoesNotExist } from "fx-barrel";\nClient; FeeLevel; DoesNotExist;\n',
      );

      const r = await runPackdev(appDir, [
        'api-diff', 'fx-barrel', '--range', '>=1.0.0 <2.0.0', '--app', appDir, '--registry', registryUrl, '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api-diff');
      assert.deepStrictEqual(json.versions[0].missingSymbols, ['DoesNotExist']);
      assert.strictEqual(json.versions[0].apiCompatible, false);
    });
  }

  // --- api-diff: cross-package re-exports (issue #3) ------------------------

  async testApiDiffCrossPackageReexportUnknownNotMissing() {
    await this.run('api-diff marks symbols behind an unresolvable cross-package export * as unresolved, never as a false ❌', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({
          name: 'fx-kit', version: '1.0.0', types: './dist/types/index.d.ts',
          dependencies: { 'fx-sub': '^1.0.0' },
        }),
        'index.js': 'module.exports = {};',
        // fx-sub is declared as a dependency but NOT bundled into this
        // tarball's own node_modules — exactly the isolated-extraction gap
        // issue #3 describes for @solana/kit's sibling @solana/* packages.
        'dist/types/index.d.ts': 'export * from "fx-sub";\n',
      });
      const registryUrl = await this.registry('fx-kit', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('api-diff-cross-pkg-unresolved');
      fs.writeFileSync(
        path.join(appDir, 'index.ts'),
        'import { address } from "fx-kit";\naddress("x");\n',
      );

      const r = await runPackdev(appDir, [
        'api-diff', 'fx-kit', '--range', '>=1.0.0 <2.0.0', '--app', appDir, '--registry', registryUrl, '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api-diff');
      assert.strictEqual(json.versions[0].apiCompatible, null, 'must never be false — unverifiable, not incompatible');
      assert.deepStrictEqual(json.versions[0].missingSymbols, []);
      assert.deepStrictEqual(json.versions[0].unresolvedSymbols, ['address']);
    });
  }

  async testApiDiffCrossPackageReexportResolvesWhenSiblingBundled() {
    await this.run('api-diff resolves a cross-package export * when the sibling package IS reachable on disk', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fx-kit', version: '1.0.0', types: './dist/types/index.d.ts' }),
        'index.js': 'module.exports = {};',
        'dist/types/index.d.ts': 'export * from "fx-sub";\n',
        // Bundled inside this package's own node_modules, so the walk-up
        // resolution used for bare specifiers finds it from pkgDir.
        'node_modules/fx-sub/package.json': JSON.stringify({ name: 'fx-sub', version: '1.0.0', types: 'index.d.ts' }),
        'node_modules/fx-sub/index.d.ts': 'export declare function address(s: string): string;\n',
      });
      const registryUrl = await this.registry('fx-kit', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('api-diff-cross-pkg-resolved');
      fs.writeFileSync(
        path.join(appDir, 'index.ts'),
        'import { address } from "fx-kit";\naddress("x");\n',
      );

      const r = await runPackdev(appDir, [
        'api-diff', 'fx-kit', '--range', '>=1.0.0 <2.0.0', '--app', appDir, '--registry', registryUrl, '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api-diff');
      assert.strictEqual(json.versions[0].apiCompatible, true, JSON.stringify(json.versions[0]));
      assert.deepStrictEqual(json.versions[0].unresolvedSymbols, []);
    });
  }

  async testApiDiffFollowsUnresolvableReexportThroughALocalBarrel() {
    await this.run('api-diff traverses a resolvable local barrel to find an unresolvable re-export one hop further in', async () => {
      // Root re-exports from "./inner", which DOES resolve locally — but
      // ./inner itself re-exports from an unbundled sibling package. The
      // root-only scan used to stop as soon as "./inner" resolved, treating
      // the whole chain as fine and reporting "address" as genuinely missing
      // instead of unresolved.
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fx-kit', version: '1.0.0', types: './dist/types/index.d.ts' }),
        'index.js': 'module.exports = {};',
        'dist/types/index.d.ts': 'export * from "./inner";\n',
        'dist/types/inner.d.ts': 'export * from "fx-sub";\n',
      });
      const registryUrl = await this.registry('fx-kit', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('api-diff-barrel-then-unresolvable');
      fs.writeFileSync(
        path.join(appDir, 'index.ts'),
        'import { address } from "fx-kit";\naddress("x");\n',
      );

      const r = await runPackdev(appDir, [
        'api-diff', 'fx-kit', '--range', '>=1.0.0 <2.0.0', '--app', appDir, '--registry', registryUrl, '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api-diff');
      assert.strictEqual(json.versions[0].apiCompatible, null, 'must never be false — unverifiable, not incompatible');
      assert.deepStrictEqual(json.versions[0].missingSymbols, []);
      assert.deepStrictEqual(json.versions[0].unresolvedSymbols, ['address']);
    });
  }

  async testApiDiffFollowsUnresolvableReexportInASubpath() {
    await this.run('api-diff checks a subpath\'s own re-exports for unresolvable targets too, not just the root\'s', async () => {
      // The root has real, fully-resolvable types — only the "./testing"
      // subpath's own types file has the unresolvable re-export. Before this
      // fix, reexports were only ever computed against the root, so a symbol
      // used from the subpath and not actually present anywhere got reported
      // as missing instead of unresolved.
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({
          name: 'fx-kit-subpath', version: '1.0.0',
          exports: {
            '.': { types: './index.d.ts', default: './index.js' },
            './testing': { types: './testing.d.ts', default: './testing.js' },
          },
        }),
        'index.js': 'module.exports = {};',
        'index.d.ts': 'export declare function formatDate(): void;',
        'testing.js': 'module.exports = {};',
        'testing.d.ts': 'export * from "fx-sub";\n',
      });
      const registryUrl = await this.registry('fx-kit-subpath', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('api-diff-subpath-unresolvable');
      fs.writeFileSync(
        path.join(appDir, 'index.ts'),
        'import { mockThing } from "fx-kit-subpath/testing";\nmockThing();\n',
      );

      const r = await runPackdev(appDir, [
        'api-diff', 'fx-kit-subpath', '--range', '>=1.0.0 <2.0.0', '--app', appDir, '--registry', registryUrl, '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api-diff');
      assert.strictEqual(json.versions[0].apiCompatible, null, 'must never be false — unverifiable, not incompatible');
      assert.deepStrictEqual(json.versions[0].missingSymbols, []);
      assert.deepStrictEqual(json.versions[0].unresolvedSymbols, ['mockThing']);
    });
  }

  async testApiDiffReexportExtensionSubstitutionMatchesTsResolution() {
    await this.run('api-diff regression guard: "export * from \\"./foo.js\\"" resolves to foo.d.ts (extension substitution), not treated as unresolvable', async () => {
      // The checker's own Node10-resolution walk (extractExportMap) already
      // follows this specifier correctly and finds `address` for real. The
      // re-export scanner has to agree, or it wrongly hedges a genuinely
      // present symbol as "unresolved" and a genuinely missing one too.
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fx-ext-sub', version: '1.0.0', types: './dist/index.d.ts' }),
        'index.js': 'module.exports = {};',
        'dist/index.d.ts': 'export * from "./inner.js";\n',
        'dist/inner.d.ts': 'export declare function address(s: string): string;\n',
      });
      const registryUrl = await this.registry('fx-ext-sub', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('api-diff-ext-substitution');
      fs.writeFileSync(
        path.join(appDir, 'index.ts'),
        'import { address, doesNotExist } from "fx-ext-sub";\naddress("x"); doesNotExist();\n',
      );

      const r = await runPackdev(appDir, [
        'api-diff', 'fx-ext-sub', '--range', '>=1.0.0 <2.0.0', '--app', appDir, '--registry', registryUrl, '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api-diff');
      // address is genuinely present (via extension-substituted resolution)
      // and doesNotExist is genuinely absent — neither should be hedged as
      // "unresolved" just because the re-export target had a .js extension.
      assert.deepStrictEqual(json.versions[0].unresolvedSymbols, []);
      assert.deepStrictEqual(json.versions[0].missingSymbols, ['doesNotExist']);
    });
  }

  async testApiDiffBareSpecifierSubpathReexportResolvesAgainstThePackageNotAPath() {
    await this.run('api-diff regression guard: "export * from \\"dep/subpath\\"" resolves the package first, not "dep/subpath" as a literal package name', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fx-bare-subpath', version: '1.0.0', types: './dist/index.d.ts' }),
        'index.js': 'module.exports = {};',
        'dist/index.d.ts': 'export * from "fx-sub/helpers";\n',
        // A real subpath declared via an "exports" map — there is no
        // node_modules/fx-sub/helpers/package.json, which is exactly what
        // the old (buggy) resolution incorrectly looked for.
        'node_modules/fx-sub/package.json': JSON.stringify({
          name: 'fx-sub', version: '1.0.0',
          exports: { '.': './index.js', './helpers': './helpers.js' },
        }),
        'node_modules/fx-sub/index.js': 'module.exports = {};',
        'node_modules/fx-sub/helpers.js': 'module.exports = {};',
      });
      const registryUrl = await this.registry('fx-bare-subpath', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('api-diff-bare-subpath');
      fs.writeFileSync(
        path.join(appDir, 'index.ts'),
        'import { address } from "fx-bare-subpath";\naddress("x");\n',
      );

      const r = await runPackdev(appDir, [
        'api-diff', 'fx-bare-subpath', '--range', '>=1.0.0 <2.0.0', '--app', appDir, '--registry', registryUrl, '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api-diff');
      // fx-sub/helpers is a real, resolvable subpath — "address" (which
      // doesn't actually exist anywhere) must be reported unresolved (the
      // re-export target is legitimate, we just can't see inside it),
      // never treated as if the whole specifier were unresolvable.
      assert.strictEqual(json.versions[0].apiCompatible, null, JSON.stringify(json.versions[0]));
      assert.deepStrictEqual(json.versions[0].missingSymbols, []);
      assert.deepStrictEqual(json.versions[0].unresolvedSymbols, ['address']);
    });
  }

  async testApiDiffExportsConditionMapWithNoDotKey() {
    await this.run('api-diff resolves types from an exports map that has only environment condition keys, no "."', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({
          name: 'fx-kit', version: '1.0.0',
          exports: {
            node: { types: './dist/node.d.ts', default: './dist/node.js' },
            browser: { types: './dist/browser.d.ts', default: './dist/browser.js' },
          },
        }),
        'dist/node.js': 'module.exports = {};',
        'dist/node.d.ts': 'export declare function address(s: string): string;\n',
        'dist/browser.js': 'module.exports = {};',
        'dist/browser.d.ts': 'export declare function address(s: string): string;\n',
      });
      const registryUrl = await this.registry('fx-kit', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('api-diff-exports-no-dot');
      fs.writeFileSync(
        path.join(appDir, 'index.ts'),
        'import { address } from "fx-kit";\naddress("x");\n',
      );

      const r = await runPackdev(appDir, [
        'api-diff', 'fx-kit', '--range', '>=1.0.0 <2.0.0', '--app', appDir, '--registry', registryUrl, '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api-diff');
      assert.strictEqual(json.versions[0].apiCompatible, true, JSON.stringify(json.versions[0]));
    });
  }

  async testApiSubpathOnlyExportsDoesNotDuplicateAsRootTypes() {
    await this.run('api regression guard: a subpath-only "exports" entry (no ".") is not also resolved (and duplicated) as the root\'s own types', async () => {
      // No "." key at all — only "./testing" is exported. resolveEntryPoint's
      // root resolution and the dedicated subpath loop both run independently;
      // the bug was the root resolution's condition-key fallback descending
      // into "./testing" as if it were a condition, so the same symbol got
      // added twice: once (wrongly) tagged subpath "." and once correctly
      // tagged "./testing".
      const dir = this.tmp('api-subpath-only-no-duplicate');
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: {} });
      writeNodeModulesPackage(
        dir,
        'fx-subpath-only',
        {
          name: 'fx-subpath-only', version: '1.0.0',
          exports: { './testing': { types: './dist/testing.d.ts', default: './dist/testing.js' } },
        },
        {
          'dist/testing.js': 'module.exports = {};',
          'dist/testing.d.ts': 'export declare function testingHelper(): void;',
        },
      );
      const r = await runPackdev(dir, ['api', 'fx-subpath-only', '--json']);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api');
      const matches = json.exports.filter((e) => e.name === 'testingHelper');
      assert.strictEqual(matches.length, 1, `expected testingHelper exactly once, got: ${JSON.stringify(matches)}`);
      assert.strictEqual(matches[0].subpath, './testing');
      assert.ok(!json.exports.some((e) => e.subpath === '.'), `expected no "." entries at all, got: ${JSON.stringify(json.exports)}`);
    });
  }

  async testApiSubpathOnlyExportsIgnoresIncidentalRootIndexDts() {
    await this.run('api regression guard: an incidental root index.d.ts is not used when "exports" is subpath-only', async () => {
      // No main/types/typings — the only entry-field information at all is
      // the subpath-only "exports" map. An index.d.ts still sitting at the
      // package root (a stale build artifact, common after a package adds an
      // exports map) must NOT be picked up as the root types entry: the
      // unconditional ./index.d.ts fallback is only valid when main, types,
      // typings, AND exports are all absent.
      const dir = this.tmp('api-subpath-only-stale-index');
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: {} });
      writeNodeModulesPackage(
        dir,
        'fx-subpath-only-stale-index',
        {
          name: 'fx-subpath-only-stale-index', version: '1.0.0',
          exports: { './testing': { types: './dist/testing.d.ts', default: './dist/testing.js' } },
        },
        {
          'dist/testing.js': 'module.exports = {};',
          'dist/testing.d.ts': 'export declare function testingSymbol(): void;',
          'index.d.ts': 'export declare function rootSymbol(): void;',
        },
      );
      const r = await runPackdev(dir, ['api', 'fx-subpath-only-stale-index', '--json']);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api');
      assert.ok(!json.exports.some((e) => e.name === 'rootSymbol'), `stale root index.d.ts must not be used: ${JSON.stringify(json.exports)}`);
    });
  }

  // --- api-diff: default-import interop + @types package (issue #4) --------

  async testApiDiffDefaultImportSatisfiedByInteropFlags() {
    await this.run('api-diff does not flag "default" missing for a default import against a named-only @types module, when esModuleInterop is on', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fx-agent', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = { startSegment(){} };',
      });
      const typesV1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: '@types/fx-agent', version: '1.0.0', types: 'index.d.ts' }),
        'index.d.ts': 'export declare function startSegment(name: string): void;\n',
      });
      const registryUrl = await this.registryMulti({
        'fx-agent': { '1.0.0': { tarballBuffer: v1 } },
        '@types/fx-agent': { '1.0.0': { tarballBuffer: typesV1 } },
      });

      const appDir = this.tmp('api-diff-interop-on');
      fs.writeFileSync(
        path.join(appDir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { esModuleInterop: true, allowSyntheticDefaultImports: true } }),
      );
      fs.writeFileSync(
        path.join(appDir, 'index.ts'),
        'import agent from "fx-agent";\nagent.startSegment("x");\n',
      );

      const r = await runPackdev(appDir, [
        'api-diff', 'fx-agent', '--range', '>=1.0.0 <2.0.0', '--app', appDir, '--registry', registryUrl, '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api-diff');
      assert.strictEqual(json.versions[0].apiCompatible, true, JSON.stringify(json.versions[0]));
      assert.deepStrictEqual(json.versions[0].missingSymbols, []);
    });
  }

  async testApiDiffDefaultMissingSurvivesWithoutInteropFlags() {
    await this.run('api-diff regression guard: with interop flags OFF, a genuinely-missing default import still reports missing', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fx-agent', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = { startSegment(){} };',
      });
      const typesV1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: '@types/fx-agent', version: '1.0.0', types: 'index.d.ts' }),
        'index.d.ts': 'export declare function startSegment(name: string): void;\n',
      });
      const registryUrl = await this.registryMulti({
        'fx-agent': { '1.0.0': { tarballBuffer: v1 } },
        '@types/fx-agent': { '1.0.0': { tarballBuffer: typesV1 } },
      });

      const appDir = this.tmp('api-diff-interop-off');
      fs.writeFileSync(
        path.join(appDir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { esModuleInterop: false, allowSyntheticDefaultImports: false } }),
      );
      fs.writeFileSync(
        path.join(appDir, 'index.ts'),
        'import agent from "fx-agent";\nagent.startSegment("x");\n',
      );

      const r = await runPackdev(appDir, [
        'api-diff', 'fx-agent', '--range', '>=1.0.0 <2.0.0', '--app', appDir, '--registry', registryUrl, '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api-diff');
      assert.strictEqual(json.versions[0].apiCompatible, false);
      assert.deepStrictEqual(json.versions[0].missingSymbols, ['default']);
    });
  }

  async testApiDiffTypesPackageMajorMismatchDowngradesFalseToUnknown() {
    await this.run('api-diff downgrades a would-be false negative to unresolved when the @types package major does not track the candidate', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fx-agent2', version: '13.0.0', main: 'index.js' }),
        'index.js': 'module.exports = { startSegment(){} };',
      });
      // @types package only ever published a 9.x — structurally can never
      // share a major with a 13.x source, the newrelic/@types/newrelic shape.
      const typesV1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: '@types/fx-agent2', version: '9.0.0', types: 'index.d.ts' }),
        'index.d.ts': 'export declare function unrelatedExport(): void;\n',
      });
      const registryUrl = await this.registryMulti({
        'fx-agent2': { '13.0.0': { tarballBuffer: v1 } },
        '@types/fx-agent2': { '9.0.0': { tarballBuffer: typesV1 } },
      });

      const appDir = this.tmp('api-diff-types-mismatch');
      fs.writeFileSync(
        path.join(appDir, 'index.ts'),
        'import { startSegment } from "fx-agent2";\nstartSegment();\n',
      );

      const r = await runPackdev(appDir, [
        'api-diff', 'fx-agent2', '--range', '>=13.0.0 <14.0.0', '--app', appDir, '--registry', registryUrl, '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api-diff');
      assert.strictEqual(json.versions[0].apiCompatible, null, 'a mismatched @types major must not assert incompatibility');
      assert.strictEqual(json.versions[0].typesPackageVersionMismatch, true);
      assert.strictEqual(json.versions[0].typesPackage, '@types/fx-agent2');
    });
  }

  // --- api-diff: ESM-only advisory (issue #8) -------------------------------

  async testApiDiffEsmOnlyAdvisoryFiresWhenCandidateAddsTypeModule() {
    await this.run('api-diff emits an ESM-only advisory when a candidate adds "type":"module" relative to the installed control version', async () => {
      writeNodeModulesPackage(this.tmp('api-diff-esm-control-holder'), 'fx-resil', { name: 'fx-resil', version: '3.0.0' });
      const appDir = this.tmp('api-diff-esm-advisory');
      writeNodeModulesPackage(appDir, 'fx-resil', { name: 'fx-resil', version: '3.0.0', main: 'dist/index.js' }, {
        'dist/index.js': 'exports.x = 1;',
      });

      const v4 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fx-resil', version: '4.0.0', main: 'dist/index.js', type: 'module' }),
        'dist/index.js': 'export const x = 1;',
        'dist/index.d.ts': 'export declare const x: number;\n',
      });
      const registryUrl = await this.registry('fx-resil', { '4.0.0': { tarballBuffer: v4 } });

      fs.writeFileSync(path.join(appDir, 'index.ts'), 'import { x } from "fx-resil";\nx;\n');

      const r = await runPackdev(appDir, [
        'api-diff', 'fx-resil', '--range', '>=4.0.0 <5.0.0', '--app', appDir, '--registry', registryUrl, '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api-diff');
      assert.strictEqual(json.versions[0].apiCompatible, true, 'ESM-only is an advisory, not a static incompatibility');
      assert.match(json.versions[0].esmOnlyAdvisory, /ESM-only/);
    });
  }

  async testApiDiffEsmOnlyAdvisoryFiresWhenCandidateDropsCjsExportCondition() {
    await this.run('api-diff emits an ESM-only advisory when a candidate drops the CJS require/default export condition, even without adding "type":"module"', async () => {
      // Control: dual-mode via an explicit exports map (import + require),
      // no "type" field at all. Candidate: same shape, but "require" is
      // gone — genuinely ESM-only via its exports map, without ever setting
      // "type":"module", which the older type===module-only check couldn't see.
      const appDir = this.tmp('api-diff-esm-drops-cjs-condition');
      writeNodeModulesPackage(appDir, 'fx-dual', {
        name: 'fx-dual', version: '1.0.0',
        exports: { '.': { types: './index.d.ts', import: './dist/index.mjs', require: './dist/index.js' } },
      }, {
        'index.d.ts': 'export declare const x: number;',
        'dist/index.js': 'exports.x = 1;',
      });

      const v2 = await buildFakeTarball({
        'package.json': JSON.stringify({
          name: 'fx-dual', version: '2.0.0',
          exports: { '.': { types: './index.d.ts', import: './dist/index.mjs' } },
        }),
        'index.d.ts': 'export declare const x: number;',
        'dist/index.mjs': 'export const x = 1;',
      });
      const registryUrl = await this.registry('fx-dual', { '2.0.0': { tarballBuffer: v2 } });

      fs.writeFileSync(path.join(appDir, 'index.ts'), 'import { x } from "fx-dual";\nx;\n');

      const r = await runPackdev(appDir, [
        'api-diff', 'fx-dual', '--range', '>=2.0.0 <3.0.0', '--app', appDir, '--registry', registryUrl, '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api-diff');
      assert.match(json.versions[0].esmOnlyAdvisory, /drops the CJS/);
    });
  }

  async testApiDiffNoEsmAdvisoryWhenCjsConditionSurvives() {
    await this.run('api-diff regression guard: no ESM-only advisory when the candidate keeps its CJS require/default condition', async () => {
      const appDir = this.tmp('api-diff-esm-keeps-cjs-condition');
      writeNodeModulesPackage(appDir, 'fx-dual-ok', {
        name: 'fx-dual-ok', version: '1.0.0',
        exports: { '.': { types: './index.d.ts', import: './dist/index.mjs', require: './dist/index.js' } },
      }, {
        'index.d.ts': 'export declare const x: number;',
        'dist/index.js': 'exports.x = 1;',
      });

      const v2 = await buildFakeTarball({
        'package.json': JSON.stringify({
          name: 'fx-dual-ok', version: '2.0.0',
          exports: { '.': { types: './index.d.ts', import: './dist/index.mjs', require: './dist/index.js' } },
        }),
        'index.d.ts': 'export declare const x: number;',
        'dist/index.js': 'exports.x = 1;',
        'dist/index.mjs': 'export const x = 1;',
      });
      const registryUrl = await this.registry('fx-dual-ok', { '2.0.0': { tarballBuffer: v2 } });

      fs.writeFileSync(path.join(appDir, 'index.ts'), 'import { x } from "fx-dual-ok";\nx;\n');

      const r = await runPackdev(appDir, [
        'api-diff', 'fx-dual-ok', '--range', '>=2.0.0 <3.0.0', '--app', appDir, '--registry', registryUrl, '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api-diff');
      assert.strictEqual(json.versions[0].esmOnlyAdvisory, undefined);
    });
  }

  // --- api-diff: ESM-only dep + CJS interop is safe (issue #9 regression) --

  async testApiDiffNoFalseAlarmOnEsmOnlyDependencyWithInteropSafeDefault() {
    await this.run('api-diff regression guard: an ESM-only dependency with a real default export is NOT reported incompatible (the p-limit case)', async () => {
      const v7 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fx-plimit', version: '7.0.0', types: './index.d.ts', type: 'module' }),
        'index.js': 'export default function limit() {}',
        'index.d.ts': 'export default function pLimit(concurrency: number): unknown;\n',
      });
      const registryUrl = await this.registry('fx-plimit', { '7.0.0': { tarballBuffer: v7 } });

      const appDir = this.tmp('api-diff-esm-safe-default');
      fs.writeFileSync(path.join(appDir, 'index.ts'), 'import limit from "fx-plimit";\nlimit(2);\n');

      const r = await runPackdev(appDir, [
        'api-diff', 'fx-plimit', '--range', '>=7.0.0 <8.0.0', '--app', appDir, '--registry', registryUrl, '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api-diff');
      assert.strictEqual(json.versions[0].apiCompatible, true, 'a real ESM default export must resolve fine, no false alarm');
      assert.deepStrictEqual(json.versions[0].missingSymbols, []);
      assert.strictEqual(json.versions[0].esmOnlyAdvisory, undefined, 'no control installed, so no advisory should fire either');
    });
  }

  // --- registry auth (--token / NPM_TOKEN / NODE_AUTH_TOKEN / .npmrc) ------

  async testApiDiffFailsWithHintOnPrivateRegistryWithoutToken() {
    await this.run('api-diff fails with a clear hint against a private registry when no token is configured', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0' }),
        'index.js': 'module.exports = {};',
        'index.d.ts': 'export function formatDate(): void;',
      });
      const server = await startAuthGatedRegistry({ 'fake-lib': { '1.0.0': { tarballBuffer: v1 } } }, 'secret-token');
      this.servers.push(server);
      const registryUrl = `http://127.0.0.1:${server.address().port}`;

      const appDir = this.tmp('api-diff-auth-missing');
      const r = await runPackdev(
        appDir,
        ['api-diff', 'fake-lib', '--range', '>=1.0.0', '--app', appDir, '--registry', registryUrl, '--json'],
        // The runner itself may have NPM_TOKEN/NODE_AUTH_TOKEN set (e.g.
        // this repo's own publish CI) — strip them so this test genuinely
        // exercises the no-token-configured path, not "wrong token sent".
        { NPM_TOKEN: null, NODE_AUTH_TOKEN: null },
      );
      assert.notStrictEqual(r.code, 0);
      const json = parseJson(r.stdout, 'api-diff');
      assert.match(json.error, /401/);
      assert.match(json.error, /packdev found no token for this host/i);
    });
  }

  async testApiDiffAuthenticatesWithTokenFlag() {
    await this.run('api-diff authenticates against a private registry with --token', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0' }),
        'index.js': 'module.exports = {};',
        'index.d.ts': 'export function formatDate(): void;',
      });
      const server = await startAuthGatedRegistry({ 'fake-lib': { '1.0.0': { tarballBuffer: v1 } } }, 'secret-token');
      this.servers.push(server);
      const registryUrl = `http://127.0.0.1:${server.address().port}`;

      const appDir = this.tmp('api-diff-auth-flag');
      const r = await runPackdev(appDir, [
        'api-diff', 'fake-lib', '--range', '>=1.0.0', '--app', appDir,
        '--registry', registryUrl, '--token', 'secret-token', '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api-diff');
      assert.strictEqual(json.versions[0].version, '1.0.0');
    });
  }

  async testApiDiffAuthenticatesWithNpmTokenEnv() {
    await this.run('api-diff authenticates against a private registry via NPM_TOKEN env var', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0' }),
        'index.js': 'module.exports = {};',
        'index.d.ts': 'export function formatDate(): void;',
      });
      const server = await startAuthGatedRegistry({ 'fake-lib': { '1.0.0': { tarballBuffer: v1 } } }, 'env-token');
      this.servers.push(server);
      const registryUrl = `http://127.0.0.1:${server.address().port}`;

      const appDir = this.tmp('api-diff-auth-env');
      const r = await runPackdev(
        appDir,
        ['api-diff', 'fake-lib', '--range', '>=1.0.0', '--app', appDir, '--registry', registryUrl, '--json'],
        { NPM_TOKEN: 'env-token' },
      );
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api-diff');
      assert.strictEqual(json.versions[0].version, '1.0.0');
    });
  }

  async testApiDiffAutoDetectsRegistryAndTokenFromNpmrc() {
    await this.run('api-diff auto-detects the scope registry and auth token from .npmrc, no --registry needed', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: '@myscope/fake-lib', version: '1.0.0' }),
        'index.js': 'module.exports = {};',
        'index.d.ts': 'export function formatDate(): void;',
      });
      const server = await startAuthGatedRegistry(
        { '@myscope/fake-lib': { '1.0.0': { tarballBuffer: v1 } } },
        'npmrc-token',
      );
      this.servers.push(server);
      const registryUrl = `http://127.0.0.1:${server.address().port}`;
      const host = new URL(registryUrl).host;

      const appDir = this.tmp('api-diff-auth-npmrc');
      fs.writeFileSync(
        path.join(appDir, '.npmrc'),
        `@myscope:registry=${registryUrl}\n//${host}/:_authToken=npmrc-token\n`,
      );

      const r = await runPackdev(
        appDir,
        ['api-diff', '@myscope/fake-lib', '--range', '>=1.0.0', '--app', appDir, '--json'],
        // Env vars outrank .npmrc in resolveAuthToken's priority order, so a
        // real NPM_TOKEN in the runner's environment would otherwise mask
        // exactly the .npmrc auto-detection this test exists to verify.
        { NPM_TOKEN: null, NODE_AUTH_TOKEN: null },
      );
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'api-diff');
      assert.strictEqual(json.versions[0].version, '1.0.0');
    });
  }

  // --- compat (runtime matrix: sandboxed install + test per version) -------

  async testCompatPassFailPerVersion() {
    await this.run('compat installs+tests each version in its own sandbox and picks the recommended one', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const v2 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '2.0.0', main: 'index.js' }),
        'index.js': 'module.exports = { formatDate: () => "ok" };',
      });
      const registryUrl = await this.registry('fake-lib', {
        '1.0.0': { tarballBuffer: v1 },
        '2.0.0': { tarballBuffer: v2 },
      });

      const appDir = this.tmp('compat-app');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });
      fs.writeFileSync(
        path.join(appDir, 'check.js'),
        'process.exit(typeof require("fake-lib").formatDate === "function" ? 0 : 1);\n',
      );

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib',
        '--versions', '1.0.0,2.0.0',
        '--app', appDir,
        '--registry', registryUrl,
        '--test', 'node check.js',
        '--json',
      ]);
      // Exit 7 (COMPAT_FAILED): v1.0.0 genuinely FAILED, so the run can't be
      // exit 0 — see testCompatExitsNonZeroOnFailure for the dedicated test.
      assert.strictEqual(r.code, 7, `expected exit 7, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'compat');
      const v1Result = json.versions.find((v) => v.version === '1.0.0');
      const v2Result = json.versions.find((v) => v.version === '2.0.0');
      assert.strictEqual(v1Result.status, 'FAILED');
      assert.strictEqual(v2Result.status, 'PASSED');
      assert.strictEqual(json.recommendedVersion, '2.0.0');
    });
  }

  async testCompatControlGateSuppressesRecommendationWhenInstalledVersionFails() {
    await this.run('compat auto-tests the installed (control) version and suppresses any recommendation when it FAILS', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const v2 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '2.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
        'helper.js': 'module.exports = "ok";',
      });
      const registryUrl = await this.registry('fake-lib', {
        '1.0.0': { tarballBuffer: v1 },
        '2.0.0': { tarballBuffer: v2 },
      });

      const appDir = this.tmp('compat-control-gate');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });
      // The currently-installed version, so compat can resolve a control.
      writeNodeModulesPackage(appDir, 'fake-lib', { name: 'fake-lib', version: '1.0.0', main: 'index.js' }, {
        'index.js': 'module.exports = {};',
      });
      // Fails against 1.0.0 (no helper.js) but passes against 2.0.0 — without
      // the control gate this would look like a clean "upgrade to 2.0.0"
      // recommendation even though the harness can't even confirm 1.0.0 (the
      // version actually running today) works.
      fs.writeFileSync(
        path.join(appDir, 'check.js'),
        'require("fake-lib/helper.js");\nprocess.exit(0);\n',
      );

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib',
        '--versions', '1.0.0,2.0.0',
        '--app', appDir,
        '--registry', registryUrl,
        '--test', 'node check.js',
        '--json',
      ]);
      assert.strictEqual(r.code, 7, `expected exit 7 (COMPAT_FAILED), got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'compat');
      assert.strictEqual(json.control.version, '1.0.0');
      assert.strictEqual(json.control.status, 'FAILED');
      assert.strictEqual(json.controlFailed, true);
      assert.strictEqual(json.minimumCompatibleVersion, null, 'recommendation must be suppressed when control fails');
      assert.strictEqual(json.recommendedVersion, null);
      // The 2.0.0 candidate itself still genuinely passed — the gate hides
      // the recommendation, it doesn't lie about the per-version result.
      const v2Result = json.versions.find((v) => v.version === '2.0.0');
      assert.strictEqual(v2Result.status, 'PASSED');

      const human = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0,2.0.0', '--app', appDir,
        '--registry', registryUrl, '--test', 'node check.js',
      ]);
      assert.match(human.stdout, /the test harness is broken, not the package/);
      assert.match(human.stdout, /No recommendation emitted/);
    });
  }

  async testCompatControlGateStaysQuietWhenInstalledVersionPasses() {
    await this.run('compat regression guard: a passing control does not suppress a real recommendation', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const registryUrl = await this.registry('fake-lib', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('compat-control-gate-ok');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });
      writeNodeModulesPackage(appDir, 'fake-lib', { name: 'fake-lib', version: '1.0.0', main: 'index.js' }, {
        'index.js': 'module.exports = {};',
      });
      fs.writeFileSync(path.join(appDir, 'check.js'), 'process.exit(0);\n');

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir,
        '--registry', registryUrl, '--test', 'node check.js', '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'compat');
      assert.strictEqual(json.control.version, '1.0.0');
      assert.strictEqual(json.control.status, 'PASSED');
      assert.strictEqual(json.controlFailed, false);
      assert.strictEqual(json.recommendedVersion, '1.0.0');
    });
  }

  async testCompatControlInstallFailedGetsInstallDiagnosticsNotHarnessHint() {
    await this.run('compat: a control that INSTALL_FAILED gets install diagnostics, not the "test harness is broken" hint', async () => {
      // The installed (control) version fails to even install (a registry
      // outage/auth failure/bad postinstall are all indistinguishable from
      // here) — it never reaches the test command at all, so the harness
      // guidance ("a dependency may be hoisted but undeclared") is actively
      // wrong: there's no harness result to blame here, only a failed install.
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({
          name: 'fake-lib', version: '1.0.0', main: 'index.js',
          scripts: { postinstall: 'node -e "process.exit(1)"' },
        }),
        'index.js': 'module.exports = {};',
      });
      const v2 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '2.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const registryUrl = await this.registry('fake-lib', {
        '1.0.0': { tarballBuffer: v1, scripts: { postinstall: 'node -e "process.exit(1)"' } },
        '2.0.0': { tarballBuffer: v2 },
      });

      const appDir = this.tmp('compat-control-install-failed');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });
      // The currently-installed version — this is what gets resolved as control.
      writeNodeModulesPackage(appDir, 'fake-lib', { name: 'fake-lib', version: '1.0.0', main: 'index.js' }, {
        'index.js': 'module.exports = {};',
      });
      fs.writeFileSync(path.join(appDir, 'check.js'), 'process.exit(0);\n');

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '2.0.0', '--app', appDir,
        '--registry', registryUrl, '--test', 'node check.js', '--json',
      ]);
      assert.strictEqual(r.code, 7, `expected exit 7 (COMPAT_FAILED), got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'compat');
      assert.strictEqual(json.control.status, 'INSTALL_FAILED');
      assert.strictEqual(json.controlFailed, true);
      assert.strictEqual(json.recommendedVersion, null);

      const human = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '2.0.0', '--app', appDir,
        '--registry', registryUrl, '--test', 'node check.js',
      ]);
      assert.match(human.stdout, /INSTALL_FAILED — the sandboxed install itself failed, before any test ran/);
      assert.match(human.stdout, /registry reachability\/auth/);
      assert.match(human.stdout, /No recommendation emitted/);
      assert.doesNotMatch(human.stdout, /the test harness is broken, not the package/);
    });
  }

  async testCompatCheckDupesFlagsARegressionAndFailsAPassingVersion() {
    await this.run('compat --check-dupes fails a version whose bump nests a second copy of a dependency, even though the test command itself passes', async () => {
      const inner1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fx-inner', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const inner2 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fx-inner', version: '2.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      // outer@1.0.0 needs inner ^1.0.0 (matches the app's own declared range
      // — hoists to a single copy). outer@2.0.0 needs inner ^2.0.0, which the
      // app's declared ^1.0.0 can't satisfy — npm nests a second inner copy
      // under outer's own node_modules. Same shape as sqs-consumer 15
      // requiring a newer @aws-sdk/client-sqs than the repo declared.
      const outer1 = await buildFakeTarball({
        'package.json': JSON.stringify({
          name: 'fx-outer', version: '1.0.0', main: 'index.js',
          dependencies: { 'fx-inner': '^1.0.0' },
        }),
        'index.js': 'module.exports = {};',
      });
      const outer2 = await buildFakeTarball({
        'package.json': JSON.stringify({
          name: 'fx-outer', version: '2.0.0', main: 'index.js',
          dependencies: { 'fx-inner': '^2.0.0' },
        }),
        'index.js': 'module.exports = {};',
      });
      const registryUrl = await this.registryMulti({
        'fx-inner': { '1.0.0': { tarballBuffer: inner1 }, '2.0.0': { tarballBuffer: inner2 } },
        'fx-outer': {
          '1.0.0': { tarballBuffer: outer1, dependencies: { 'fx-inner': '^1.0.0' } },
          '2.0.0': { tarballBuffer: outer2, dependencies: { 'fx-inner': '^2.0.0' } },
        },
      });

      const appDir = this.tmp('compat-check-dupes');
      writeJson(path.join(appDir, 'package.json'), {
        name: 'app', version: '1.0.0',
        dependencies: { 'fx-outer': '^1.0.0', 'fx-inner': '^1.0.0' },
      });
      writeNodeModulesPackage(appDir, 'fx-outer', { name: 'fx-outer', version: '1.0.0', main: 'index.js' });

      const r = await runPackdev(appDir, [
        'compat', 'fx-outer',
        '--versions', '1.0.0,2.0.0',
        '--app', appDir,
        '--registry', registryUrl,
        '--test', 'node -e "process.exit(0)"',
        '--check-dupes',
        '--json',
      ]);
      assert.strictEqual(r.code, 7, `expected exit 7 (COMPAT_FAILED), got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'compat');
      const v1Result = json.versions.find((v) => v.version === '1.0.0');
      const v2Result = json.versions.find((v) => v.version === '2.0.0');
      assert.strictEqual(v1Result.dupeCounts['fx-inner'], 1);
      assert.strictEqual(v1Result.status, 'PASSED');
      assert.strictEqual(v2Result.dupeCounts['fx-inner'], 2, JSON.stringify(v2Result));
      assert.strictEqual(v2Result.status, 'FAILED', 'a test command that passed must still be failed by the dupes regression');
      assert.deepStrictEqual(v2Result.dupesRegression, [
        { package: 'fx-inner', controlCopies: 1, candidateCopies: 2 },
      ]);
    });
  }

  async testCompatWithoutCheckDupesFlagDoesNotComputeDupeCounts() {
    await this.run('compat regression guard: without --check-dupes, no dupeCounts/dupesRegression are computed', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const registryUrl = await this.registry('fake-lib', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('compat-no-check-dupes');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });
      fs.writeFileSync(path.join(appDir, 'check.js'), 'process.exit(0);\n');

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir,
        '--registry', registryUrl, '--test', 'node check.js', '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'compat');
      assert.strictEqual(json.versions[0].dupeCounts, undefined);
      assert.strictEqual(json.versions[0].dupesRegression, undefined);
    });
  }

  async testCompatSeedLockfileCopiesLockfileIntoSandbox() {
    await this.run('createSandbox copies the source lockfile into the sandbox only when seedLockfileName is passed', async () => {
      const compat = require('../../dist/compat.js');
      const srcDir = this.tmp('seed-lockfile-source');
      writeJson(path.join(srcDir, 'package.json'), {
        name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' },
      });
      fs.writeFileSync(path.join(srcDir, 'package-lock.json'), '{"marker":"seed-me"}\n');

      const seededDir = await compat.createSandbox(
        srcDir, '1.0.0', [{ name: 'fake-lib', section: 'dependencies' }], '',
        undefined, 'package-lock.json',
      );
      try {
        assert.ok(
          fs.existsSync(path.join(seededDir, 'package-lock.json')),
          'expected package-lock.json to be copied into the sandbox when seedLockfileName is set',
        );
        assert.strictEqual(
          fs.readFileSync(path.join(seededDir, 'package-lock.json'), 'utf-8'),
          '{"marker":"seed-me"}\n',
        );
      } finally {
        await compat.cleanupSandbox(seededDir);
      }

      const unseededDir = await compat.createSandbox(
        srcDir, '1.0.0', [{ name: 'fake-lib', section: 'dependencies' }], '',
      );
      try {
        assert.ok(
          !fs.existsSync(path.join(unseededDir, 'package-lock.json')),
          'expected package-lock.json to stay excluded when seedLockfileName is not set',
        );
      } finally {
        await compat.cleanupSandbox(unseededDir);
      }
    });
  }

  async testCompatSeedLockfileReportFields() {
    await this.run('compat reports seededLockfile + lockfileSeedNote for the three states: off, on, and check-dupes-without-seed', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const registryUrl = await this.registry('fake-lib', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('compat-seed-lockfile-report');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });
      fs.writeFileSync(path.join(appDir, 'package-lock.json'), JSON.stringify({
        name: 'app', version: '1.0.0', lockfileVersion: 3, requires: true, packages: {},
      }));
      fs.writeFileSync(path.join(appDir, 'check.js'), 'process.exit(0);\n');

      // Neither flag: no note.
      const rNeither = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir,
        '--registry', registryUrl, '--test', 'node check.js', '--json',
      ]);
      const jsonNeither = parseJson(rNeither.stdout, 'compat');
      assert.strictEqual(jsonNeither.seededLockfile, false);
      assert.strictEqual(jsonNeither.lockfileSeedNote, null);

      // --seed-lockfile alone: hermeticity-reduced note.
      const rSeeded = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir,
        '--registry', registryUrl, '--test', 'node check.js', '--seed-lockfile', '--json',
      ]);
      const jsonSeeded = parseJson(rSeeded.stdout, 'compat');
      assert.strictEqual(jsonSeeded.seededLockfile, true);
      assert.match(jsonSeeded.lockfileSeedNote, /less hermetic/);

      // --check-dupes without --seed-lockfile: recommends turning it on.
      const rCheckDupesOnly = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir,
        '--registry', registryUrl, '--test', 'node check.js', '--check-dupes', '--json',
      ]);
      const jsonCheckDupesOnly = parseJson(rCheckDupesOnly.stdout, 'compat');
      assert.strictEqual(jsonCheckDupesOnly.seededLockfile, false);
      assert.match(jsonCheckDupesOnly.lockfileSeedNote, /Add --seed-lockfile/);
    });
  }

  async testCompatSeedLockfileFalseWhenRequestedButNoLockfilePresent() {
    await this.run('compat --seed-lockfile reports seededLockfile:false (not true) when no lockfile actually exists to seed', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const registryUrl = await this.registry('fake-lib', { '1.0.0': { tarballBuffer: v1 } });

      // No lockfile written at all — --seed-lockfile has nothing to copy.
      const appDir = this.tmp('compat-seed-lockfile-missing');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });
      fs.writeFileSync(path.join(appDir, 'check.js'), 'process.exit(0);\n');

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir,
        '--registry', registryUrl, '--test', 'node check.js', '--seed-lockfile', '--json',
      ]);
      const json = parseJson(r.stdout, 'compat');
      assert.strictEqual(json.seededLockfile, false, 'must not claim a seed that could not actually happen');
      assert.match(json.lockfileSeedNote, /no lockfile.*was found|nothing was actually seeded/);
    });
  }

  async testCompatRejectsBisectWithCheckDupes() {
    await this.run('compat rejects --bisect combined with --check-dupes rather than silently ignoring the regression check', async () => {
      const appDir = this.tmp('compat-bisect-check-dupes-rejected');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir,
        '--registry', 'http://127.0.0.1:1', '--test', 'node -e "process.exit(0)"',
        '--bisect', '--check-dupes', '--json',
      ]);
      assert.notStrictEqual(r.code, 0, 'expected a non-zero exit');
      const json = parseJson(r.stdout, 'compat');
      assert.match(json.error, /--bisect and --check-dupes cannot be combined/);
    });
  }

  async testCompatReportsHermeticModeAndDetectedPackageManager() {
    await this.run('compat reports hermetic sandbox mode + the detected package manager by default', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const registryUrl = await this.registry('fake-lib', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('compat-mode-default');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });
      writeJson(path.join(appDir, 'package-lock.json'), { name: 'app', lockfileVersion: 3 });
      fs.writeFileSync(path.join(appDir, 'check.js'), 'process.exit(0);\n');

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir,
        '--registry', registryUrl, '--test', 'node check.js', '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'compat');
      assert.strictEqual(json.sandboxMode, 'hermetic');
      assert.strictEqual(json.packageManager, 'npm');

      const human = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir,
        '--registry', registryUrl, '--test', 'node check.js',
      ]);
      assert.match(human.stdout, /Sandbox mode: hermetic, package manager: npm/);
    });
  }

  async testCompatHonoursPackageManagerFieldPin() {
    await this.run('compat honours a nearest-ancestor package.json "packageManager" field (corepack pin)', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const registryUrl = await this.registry('fake-lib', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('compat-pm-field');
      // Pinned to the real npm on this machine so the sandbox install still
      // actually succeeds — the point of this test is that the version comes
      // from the "packageManager" field, not that a different manager runs.
      const npmVersion = require('child_process')
        .execFileSync('npm', ['--version'], { encoding: 'utf8' })
        .trim();
      writeJson(path.join(appDir, 'package.json'), {
        name: 'app', version: '1.0.0',
        dependencies: { 'fake-lib': '^1.0.0' },
        packageManager: `npm@${npmVersion}`,
      });
      fs.writeFileSync(path.join(appDir, 'check.js'), 'process.exit(0);\n');

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir,
        '--registry', registryUrl, '--test', 'node check.js', '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'compat');
      assert.strictEqual(json.packageManager, `npm@${npmVersion}`);
    });
  }

  async testCompatAncestorPackageManagerFieldBeatsACloserLockfile() {
    await this.run('compat: an ancestor "packageManager" field wins over a closer directory\'s own lockfile', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const registryUrl = await this.registry('fake-lib', { '1.0.0': { tarballBuffer: v1 } });

      // Pinned to the real npm on this machine so the sandbox install still
      // actually succeeds — the point is that the ROOT's field wins over the
      // CHILD's own (unrelated-manager) lockfile, not that a different
      // manager actually runs.
      const npmVersion = require('child_process')
        .execFileSync('npm', ['--version'], { encoding: 'utf8' })
        .trim();

      const root = this.tmp('compat-pm-ancestor-root');
      writeJson(path.join(root, 'package.json'), {
        name: 'root', private: true, packageManager: `npm@${npmVersion}`,
      });

      const appDir = path.join(root, 'app');
      fs.mkdirSync(appDir, { recursive: true });
      writeJson(path.join(appDir, 'package.json'), {
        name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' },
      });
      // A stray lockfile for a DIFFERENT manager, closer than the root's
      // field. Before the ancestor-search-order fix, this would shadow the
      // root's pin — detectPackageManager checked field-then-lockfile at
      // each directory instead of exhausting the field search first.
      fs.writeFileSync(path.join(appDir, 'pnpm-lock.yaml'), 'lockfileVersion: 6.0\n');
      fs.writeFileSync(path.join(appDir, 'check.js'), 'process.exit(0);\n');

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir,
        '--registry', registryUrl, '--test', 'node check.js', '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'compat');
      assert.strictEqual(json.packageManager, `npm@${npmVersion}`, 'the ancestor field must win over the closer pnpm-lock.yaml');
    });
  }

  async testCompatPackageManagerCliOverrideWins() {
    await this.run('compat --package-manager overrides both the packageManager field and the lockfile', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const registryUrl = await this.registry('fake-lib', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('compat-pm-override');
      writeJson(path.join(appDir, 'package.json'), {
        name: 'app', version: '1.0.0',
        dependencies: { 'fake-lib': '^1.0.0' },
        packageManager: 'yarn@1.22.22',
      });
      fs.writeFileSync(path.join(appDir, 'check.js'), 'process.exit(0);\n');

      // The field says yarn, but --package-manager must win — and must still
      // actually drive the sandboxed install, so pin it to the real npm on
      // this machine rather than a manager that may not be installed here.
      const npmVersion = require('child_process')
        .execFileSync('npm', ['--version'], { encoding: 'utf8' })
        .trim();
      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir,
        '--registry', registryUrl, '--test', 'node check.js',
        '--package-manager', `npm@${npmVersion}`, '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'compat');
      assert.strictEqual(json.packageManager, `npm@${npmVersion}`);
    });
  }

  async testCompatPackageManagerPinIsWrittenIntoTheSandbox() {
    await this.run('compat writes the resolved packageManager pin into the sandboxed package.json, not just the report', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const registryUrl = await this.registry('fake-lib', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('compat-pm-pin-in-sandbox');
      writeJson(path.join(appDir, 'package.json'), {
        name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' },
      });
      // The test command runs inside the sandbox at the app's own directory,
      // so reading its own package.json here proves the pin was actually
      // written where an install-time tool (e.g. Corepack) would read it —
      // not just echoed back in the JSON report.
      fs.writeFileSync(
        path.join(appDir, 'check.js'),
        'const pkg = require("./package.json");\n' +
          'process.exit(pkg.packageManager === "npm@8.19.4" ? 0 : 1);\n',
      );

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir,
        '--registry', registryUrl, '--test', 'node check.js',
        '--package-manager', 'npm@8.19.4', '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0 (pin was written into the sandbox), got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'compat');
      assert.strictEqual(json.versions[0].status, 'PASSED');
      assert.strictEqual(json.packageManager, 'npm@8.19.4');
    });
  }

  async testCompatModeWorkspaceErrorsWithoutAMonorepoRoot() {
    await this.run('compat --mode workspace fails clearly when no workspaces root can be found', async () => {
      const appDir = this.tmp('compat-mode-workspace-no-root');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir,
        '--registry', 'http://127.0.0.1:1', '--test', 'node -e "process.exit(0)"',
        '--mode', 'workspace', '--json',
      ]);
      assert.notStrictEqual(r.code, 0, 'expected a non-zero exit');
      assert.match(r.stderr + r.stdout, /--mode workspace requested, but no workspaces root/);
    });
  }

  async testCompatModeRejectsInvalidValue() {
    await this.run('compat --mode rejects a value that is not hermetic or workspace', async () => {
      const appDir = this.tmp('compat-mode-invalid');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir,
        '--registry', 'http://127.0.0.1:1', '--test', 'node -e "process.exit(0)"',
        '--mode', 'bogus', '--json',
      ]);
      assert.notStrictEqual(r.code, 0, 'expected a non-zero exit');
      assert.match(r.stderr + r.stdout, /--mode must be/);
      assert.match(r.stderr + r.stdout, /hermetic/);
      assert.match(r.stderr + r.stdout, /workspace/);
    });
  }

  async testCompatDistinguishesInstallFailure() {
    await this.run('compat reports INSTALL_FAILED distinctly from a test failure', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({
          name: 'fake-lib', version: '1.0.0', main: 'index.js',
          scripts: { postinstall: 'node -e "process.exit(1)"' },
        }),
        'index.js': 'module.exports = {};',
      });
      const registryUrl = await this.registry('fake-lib', {
        '1.0.0': { tarballBuffer: v1, scripts: { postinstall: 'node -e "process.exit(1)"' } },
      });

      const appDir = this.tmp('compat-installfail');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });
      fs.writeFileSync(path.join(appDir, 'check.js'), 'process.exit(0);\n');

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir, '--registry', registryUrl, '--test', 'node check.js', '--json',
      ]);
      // Exit 7 (COMPAT_FAILED): INSTALL_FAILED counts as a real failure too.
      assert.strictEqual(r.code, 7, `expected exit 7, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'compat');
      assert.strictEqual(json.versions[0].status, 'INSTALL_FAILED');
    });
  }

  async testCompatSkipsAppsWithWorkspaceProtocolDeps() {
    await this.run('compat reports SKIPPED (not INSTALL_FAILED) when the app has workspace:* deps', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const registryUrl = await this.registry('fake-lib', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('compat-workspace-protocol');
      writeJson(path.join(appDir, 'package.json'), {
        name: 'app', version: '1.0.0',
        dependencies: { 'fake-lib': '^1.0.0', '@acme/shared': 'workspace:*' },
      });
      fs.writeFileSync(path.join(appDir, 'check.js'), 'process.exit(0);\n');

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir, '--registry', registryUrl, '--test', 'node check.js', '--json',
      ]);
      // Exit 6 (NOTHING_TESTED): every version came back SKIPPED, so nothing
      // was actually verified — see testCompatNothingTestedExitCodeAndMessage.
      assert.strictEqual(r.code, 6, `expected exit 6, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'compat');
      assert.strictEqual(json.versions[0].status, 'SKIPPED');
      assert.match(json.versions[0].output, /workspace:-protocol/);
      assert.match(json.versions[0].output, /@acme\/shared/);

      const human = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir, '--registry', registryUrl, '--test', 'node check.js',
      ]);
      assert.match(human.stdout, /SKIPPED/);
      assert.match(human.stdout, /@acme\/shared/);
    });
  }

  async testCompatAttemptsRealInstallWhenMonorepoRootFound() {
    await this.run('compat sandboxes the whole monorepo and attempts a real install when workspace:* deps exist and a root is found', async () => {
      // This proves the code path actually changed from "always SKIPPED" to
      // "attempt a real sandboxed install" — npm itself doesn't understand
      // the workspace: protocol (only yarn berry / pnpm do), so this fixture
      // can't reach PASSED, but it must NOT be SKIPPED either: that would
      // mean compat gave up without even trying, which is exactly the bug.
      // (Full PASSED-via-real-resolution was verified manually against a
      // real Yarn Berry 4.14.1 monorepo during development — see the
      // "compat workspace:* protocol" field-report fix.)
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const registryUrl = await this.registry('fake-lib', { '1.0.0': { tarballBuffer: v1 } });

      const monorepoRoot = this.tmp('compat-monorepo-root');
      writeJson(path.join(monorepoRoot, 'package.json'), {
        name: 'root', private: true, workspaces: ['packages/*'],
      });
      const sharedDir = path.join(monorepoRoot, 'packages', 'shared');
      fs.mkdirSync(sharedDir, { recursive: true });
      writeJson(path.join(sharedDir, 'package.json'), { name: '@acme/shared', version: '1.0.0' });

      const appDir = path.join(monorepoRoot, 'packages', 'app');
      fs.mkdirSync(appDir, { recursive: true });
      writeJson(path.join(appDir, 'package.json'), {
        name: 'app', version: '1.0.0',
        dependencies: { 'fake-lib': '^1.0.0', '@acme/shared': 'workspace:*' },
      });
      fs.writeFileSync(path.join(appDir, 'check.js'), 'process.exit(0);\n');

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir, '--registry', registryUrl, '--test', 'node check.js', '--json',
      ]);
      // npm doesn't understand the workspace: protocol at all, so this
      // fixture can't reach PASSED — it genuinely INSTALL_FAILED, which is
      // now a real failure (exit 7), not the SKIPPED bug this test guards
      // against (that would have been exit 6/0 with no install attempted).
      assert.strictEqual(r.code, 7, `expected exit 7, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'compat');
      assert.notStrictEqual(json.versions[0].status, 'SKIPPED', 'a real install must have been attempted, not skipped, once a monorepo root is discoverable');
      assert.strictEqual(json.sandboxMode, 'workspace');
    });
  }

  async testCompatFanOutCatchesABreakOnlyAConsumerHits() {
    await this.run('compat --fan-out catches a break the owning app misses but a consumer workspace hits', async () => {
      // The shape of the real-world gap this closes: the app declaring the
      // package passes its own tests, but a sibling workspace that actually
      // depends on the changed behavior fails. Testing --app alone would
      // report PASSED for 2.0.0; fan-out must report FAILED.
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = { thing: true };',
      });
      const v2 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '2.0.0', main: 'index.js' }),
        'index.js': 'module.exports = { thing: false };',
      });
      const registryUrl = await this.registry('fake-lib', {
        '1.0.0': { tarballBuffer: v1 }, '2.0.0': { tarballBuffer: v2 },
      });

      const monorepoRoot = this.tmp('compat-fanout-monorepo');
      writeJson(path.join(monorepoRoot, 'package.json'), {
        name: 'root', private: true, workspaces: ['packages/*'],
      });

      const appDir = path.join(monorepoRoot, 'packages', 'app');
      fs.mkdirSync(appDir, { recursive: true });
      writeJson(path.join(appDir, 'package.json'), {
        name: 'app', version: '1.0.0',
        dependencies: { 'fake-lib': '^1.0.0' },
        scripts: { test: 'node check.js' },
      });
      // The primary app never actually looks at fake-lib's behavior — this
      // is exactly why testing it alone can't catch the regression.
      fs.writeFileSync(path.join(appDir, 'check.js'), 'process.exit(0);\n');

      const consumerDir = path.join(monorepoRoot, 'packages', 'consumer');
      fs.mkdirSync(consumerDir, { recursive: true });
      writeJson(path.join(consumerDir, 'package.json'), {
        name: 'consumer', version: '1.0.0',
        dependencies: { 'fake-lib': '^1.0.0' },
        scripts: { test: 'node check.js' },
      });
      fs.writeFileSync(
        path.join(consumerDir, 'check.js'),
        'process.exit(require("fake-lib").thing ? 0 : 1);\n',
      );

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0,2.0.0', '--app', appDir, '--registry', registryUrl,
        '--test-script', 'test', '--fan-out', '--json',
      ]);
      const json = parseJson(r.stdout, 'compat');
      assert.deepStrictEqual(json.fanOutConsumers, ['packages/consumer']);

      const v1Result = json.versions.find((v) => v.version === '1.0.0');
      const v2Result = json.versions.find((v) => v.version === '2.0.0');
      assert.strictEqual(v1Result.status, 'PASSED', JSON.stringify(v1Result));
      assert.strictEqual(v1Result.consumers.length, 2);
      assert.deepStrictEqual(v1Result.consumers.map((c) => c.status), ['PASSED', 'PASSED']);

      assert.strictEqual(v2Result.status, 'FAILED', 'the app itself never exercises fake-lib, but the consumer must still fail the overall version');
      const primaryConsumer = v2Result.consumers.find((c) => c.dir === '.');
      const siblingConsumer = v2Result.consumers.find((c) => c.dir === 'packages/consumer');
      assert.strictEqual(primaryConsumer.status, 'PASSED', 'the primary app itself does not exercise the broken behavior');
      assert.strictEqual(siblingConsumer.status, 'FAILED', 'the consumer workspace does exercise it and must fail');
      assert.strictEqual(siblingConsumer.name, 'consumer');

      // Regression guard: the top-level exitCode/output must explain the
      // rollup, not silently mirror the passing primary — a client that
      // only reads status/exitCode/output (never `consumers`) must not see
      // "FAILED, exitCode 0, no output", which would be self-contradictory.
      assert.strictEqual(v2Result.exitCode, siblingConsumer.exitCode);
      assert.strictEqual(v2Result.exitCode, 1);
      assert.ok(v2Result.output, 'top-level output must be populated from the failing consumer');

      const human = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0,2.0.0', '--app', appDir, '--registry', registryUrl,
        '--test-script', 'test', '--fan-out',
      ]);
      assert.match(human.stdout, /Fan-out consumers: packages\/consumer/);
      assert.match(human.stdout, /consumer \(packages\/consumer\): FAILED/);
    });
  }

  async testCompatExplicitAppCommaListTestsExtraConsumers() {
    await this.run('compat --app a,b tests the extra comma-separated dirs as fan-out consumers', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const registryUrl = await this.registry('fake-lib', { '1.0.0': { tarballBuffer: v1 } });

      const monorepoRoot = this.tmp('compat-explicit-app-list');
      writeJson(path.join(monorepoRoot, 'package.json'), {
        name: 'root', private: true, workspaces: ['packages/*'],
      });
      const appDir = path.join(monorepoRoot, 'packages', 'app');
      fs.mkdirSync(appDir, { recursive: true });
      writeJson(path.join(appDir, 'package.json'), {
        name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' },
      });
      fs.writeFileSync(path.join(appDir, 'check.js'), 'process.exit(0);\n');

      const otherDir = path.join(monorepoRoot, 'packages', 'other');
      fs.mkdirSync(otherDir, { recursive: true });
      writeJson(path.join(otherDir, 'package.json'), {
        name: 'other', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' },
      });

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0',
        '--app', `${appDir},${otherDir}`,
        '--registry', registryUrl, '--test', 'node check.js', '--json',
      ]);
      const json = parseJson(r.stdout, 'compat');
      assert.deepStrictEqual(json.fanOutConsumers, ['packages/other']);
      assert.strictEqual(json.versions[0].consumers.length, 2);
      assert.deepStrictEqual(json.versions[0].consumers.map((c) => c.dir), ['.', 'packages/other']);
    });
  }

  async testCompatGlobAppSelectsPrimaryDeterministically() {
    await this.run('compat --app "packages/*" always picks the same (sorted) primary app, regardless of directory creation order', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const registryUrl = await this.registry('fake-lib', { '1.0.0': { tarballBuffer: v1 } });

      const monorepoRoot = this.tmp('compat-glob-app-order');
      writeJson(path.join(monorepoRoot, 'package.json'), { name: 'root', private: true, workspaces: ['packages/*'] });

      // Create "zzz" before "aaa" on disk — if primary selection ever
      // relied on unsorted readdir order, this would be the case most
      // likely to expose it.
      for (const name of ['zzz', 'aaa']) {
        const dir = path.join(monorepoRoot, 'packages', name);
        fs.mkdirSync(dir, { recursive: true });
        writeJson(path.join(dir, 'package.json'), { name, version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });
        fs.writeFileSync(path.join(dir, 'check.js'), 'process.exit(0);\n');
      }

      const r = await runPackdev(monorepoRoot, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', 'packages/*',
        '--registry', registryUrl, '--test', 'node check.js', '--json',
      ]);
      const json = parseJson(r.stdout, 'compat');
      // "aaa" sorts first — it must be the primary, "zzz" the fan-out consumer.
      assert.deepStrictEqual(json.fanOutConsumers, ['packages/zzz']);
      assert.deepStrictEqual(json.versions[0].consumers.map((c) => c.name), ['aaa', 'zzz']);
    });
  }

  async testCompatFanOutRequiresDiscoverableMonorepoRoot() {
    await this.run('compat --fan-out errors clearly when no workspaces root can be found', async () => {
      const appDir = this.tmp('compat-fanout-no-root');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir,
        '--test', 'node -e "process.exit(0)"', '--fan-out', '--json',
      ]);
      const json = parseJson(r.stdout, 'compat');
      assert.match(json.error, /Fan-out .* requires a discoverable workspaces root/);
    });
  }

  async testCompatRejectsExplicitAppListCombinedWithFanOut() {
    await this.run('compat rejects a multi-target --app combined with --fan-out rather than silently preferring the explicit list', async () => {
      const monorepoRoot = this.tmp('compat-fanout-both-modes');
      writeJson(path.join(monorepoRoot, 'package.json'), { name: 'root', private: true, workspaces: ['packages/*'] });
      const appDir = path.join(monorepoRoot, 'packages', 'app');
      fs.mkdirSync(appDir, { recursive: true });
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });
      const otherDir = path.join(monorepoRoot, 'packages', 'other');
      fs.mkdirSync(otherDir, { recursive: true });
      writeJson(path.join(otherDir, 'package.json'), { name: 'other', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', `${appDir},${otherDir}`,
        '--test', 'node -e "process.exit(0)"', '--fan-out', '--json',
      ]);
      const json = parseJson(r.stdout, 'compat');
      assert.match(json.error, /mutually exclusive/);
    });
  }

  async testCompatFanOutRejectsConsumerOutsideMonorepoRoot() {
    await this.run('compat rejects an explicit fan-out consumer that resolves outside the monorepo root', async () => {
      const monorepoRoot = this.tmp('compat-fanout-escape-monorepo');
      writeJson(path.join(monorepoRoot, 'package.json'), { name: 'root', private: true, workspaces: ['packages/*'] });
      const appDir = path.join(monorepoRoot, 'packages', 'app');
      fs.mkdirSync(appDir, { recursive: true });
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });
      fs.writeFileSync(path.join(appDir, 'check.js'), 'process.exit(0);\n');

      // A completely separate directory tree, not nested under monorepoRoot
      // at all — simulates an --app value (or a malicious/mistaken one)
      // that tries to point fan-out at something outside the sandbox.
      const outsideDir = this.tmp('compat-fanout-escape-outside');
      writeJson(path.join(outsideDir, 'package.json'), { name: 'outside', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', `${appDir},${outsideDir}`,
        '--test', 'node check.js', '--json',
      ]);
      const json = parseJson(r.stdout, 'compat');
      assert.match(json.error, /resolves outside the monorepo root/);
    });
  }

  async testCompatNothingTestedExitCodeAndMessage() {
    await this.run('compat exits 6 and says nothing was tested when every version is SKIPPED (not "no version passed")', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const registryUrl = await this.registry('fake-lib', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('compat-nothing-tested');
      writeJson(path.join(appDir, 'package.json'), {
        name: 'app', version: '1.0.0',
        dependencies: { 'fake-lib': '^1.0.0', '@acme/shared': 'workspace:*' },
      });
      fs.writeFileSync(path.join(appDir, 'check.js'), 'process.exit(0);\n');

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir, '--registry', registryUrl, '--test', 'node check.js',
      ]);
      assert.strictEqual(r.code, 6, `expected exit 6 (NOTHING_TESTED), got ${r.code}: ${r.stderr}`);
      assert.match(r.stdout, /nothing was actually tested/i);
      assert.doesNotMatch(r.stdout, /No version in range passed the test command/);
    });
  }

  async testCompatExitsNonZeroOnFailure() {
    await this.run('compat exits 7 (COMPAT_FAILED) when a candidate genuinely FAILED, so it can guard a CI job', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = { special: false };',
      });
      const registryUrl = await this.registry('fake-lib', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('compat-exit-on-failure');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });
      fs.writeFileSync(
        path.join(appDir, 'check.js'),
        'process.exit(require("fake-lib").special ? 0 : 1);\n',
      );

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir, '--registry', registryUrl, '--test', 'node check.js', '--json',
      ]);
      assert.strictEqual(r.code, 7, `expected exit 7 (COMPAT_FAILED), got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'compat');
      assert.strictEqual(json.versions[0].status, 'FAILED');

      // --bisect's per-step FAILED results are search mechanics, not a
      // verdict — must not trip the same exit code.
      const bisectAppDir = this.tmp('compat-exit-bisect-unaffected');
      writeJson(path.join(bisectAppDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });
      const v2 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '2.0.0', main: 'index.js' }),
        'index.js': 'module.exports = { special: true };',
      });
      const bisectRegistryUrl = await this.registry('fake-lib', {
        '1.0.0': { tarballBuffer: v1 },
        '2.0.0': { tarballBuffer: v2 },
      });
      fs.writeFileSync(
        path.join(bisectAppDir, 'check.js'),
        'process.exit(require("fake-lib").special ? 0 : 1);\n',
      );
      const bisectResult = await runPackdev(bisectAppDir, [
        'compat', 'fake-lib', '--versions', '1.0.0,2.0.0', '--app', bisectAppDir, '--registry', bisectRegistryUrl,
        '--test', 'node check.js', '--bisect',
      ]);
      assert.strictEqual(bisectResult.code, 0, `expected exit 0 for --bisect despite an interim FAILED step, got ${bisectResult.code}: ${bisectResult.stderr}`);
    });
  }

  async testCompatWarnsOnTranspileOnlyTestSetup() {
    await this.run('compat surfaces a caveat when --test looks like a transpile-only jest run', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const registryUrl = await this.registry('fake-lib', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('compat-transpile-only-caveat');
      writeJson(path.join(appDir, 'package.json'), {
        name: 'app', version: '1.0.0',
        dependencies: { 'fake-lib': '^1.0.0' },
        jest: { transform: { '^.+\\.ts$': ['ts-jest', { isolatedModules: true }] } },
      });
      fs.writeFileSync(path.join(appDir, 'check.js'), 'process.exit(0);\n');

      // Not a real jest invocation (jest isn't installed in this fixture) —
      // just needs the word "jest" in the command for the heuristic to fire,
      // while actually running check.js so the version still PASSES.
      const jestLikeCommand = 'node check.js # jest --silent';

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir, '--registry', registryUrl, '--test', jestLikeCommand, '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'compat');
      assert.match(json.testCommandCaveat, /isolatedModules/);

      const human = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir, '--registry', registryUrl, '--test', jestLikeCommand,
      ]);
      assert.match(human.stdout, /isolatedModules/);

      // A build/type-check command shouldn't trigger the caveat at all.
      const r2 = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir, '--registry', registryUrl, '--test', 'node check.js', '--json',
      ]);
      const json2 = parseJson(r2.stdout, 'compat');
      assert.strictEqual(json2.testCommandCaveat, null);
    });
  }

  async testCompatWarnsOnPassWithNoTests() {
    await this.run('compat surfaces a PASS_WITH_NO_TESTS caveat when --passWithNoTests is set', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const registryUrl = await this.registry('fake-lib', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('compat-pass-with-no-tests-caveat');
      writeJson(path.join(appDir, 'package.json'), {
        name: 'app', version: '1.0.0',
        dependencies: { 'fake-lib': '^1.0.0' },
      });
      fs.writeFileSync(path.join(appDir, 'check.js'), 'process.exit(0);\n');

      // Not a real jest invocation — just needs "jest" and "--passWithNoTests"
      // in the command for the heuristic to fire, while actually running
      // check.js so the version still PASSES.
      const jestLikeCommand = 'node check.js # jest --passWithNoTests';

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir, '--registry', registryUrl, '--test', jestLikeCommand, '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'compat');
      const codes = json.testCommandCaveats.map((c) => c.code);
      assert.ok(codes.includes('PASS_WITH_NO_TESTS'), `expected PASS_WITH_NO_TESTS in ${JSON.stringify(codes)}`);
    });
  }

  async testCompatTestScriptOnlyRunsStillGetHarnessAnalysis() {
    await this.run('compat --test-script (no --test) still analyzes the actual script body for harness caveats, not the empty invocation string', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const registryUrl = await this.registry('fake-lib', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('compat-test-script-only-harness');
      writeJson(path.join(appDir, 'package.json'), {
        name: 'app', version: '1.0.0',
        dependencies: { 'fake-lib': '^1.0.0' },
        // The literal invocation ("npm run test") never contains "jest" —
        // only the script BODY does. Harness analysis must read this, not
        // the empty/absent --test string.
        scripts: { test: 'node check.js # jest --passWithNoTests' },
      });
      fs.writeFileSync(path.join(appDir, 'check.js'), 'process.exit(0);\n');

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir, '--registry', registryUrl,
        '--test-script', 'test', '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'compat');
      const codes = json.testCommandCaveats.map((c) => c.code);
      assert.ok(codes.includes('PASS_WITH_NO_TESTS'), `expected PASS_WITH_NO_TESTS in ${JSON.stringify(codes)} — the script body must have been analyzed, not an empty testCommand`);
    });
  }

  async testCompatWarnsOnTypeCheckOnlyTestCommand() {
    await this.run('compat surfaces a TYPE_CHECK_ONLY caveat when --test is bare tsc', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const registryUrl = await this.registry('fake-lib', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('compat-type-check-only-caveat');
      writeJson(path.join(appDir, 'package.json'), {
        name: 'app', version: '1.0.0',
        dependencies: { 'fake-lib': '^1.0.0' },
      });

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir, '--registry', registryUrl, '--test', 'npx tsc --noEmit', '--json',
      ]);
      const json = parseJson(r.stdout, 'compat');
      const codes = json.testCommandCaveats.map((c) => c.code);
      assert.ok(codes.includes('TYPE_CHECK_ONLY'), `expected TYPE_CHECK_ONLY in ${JSON.stringify(codes)}`);

      // A command that chains a real runner after tsc isn't type-check-only.
      const r2 = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir, '--registry', registryUrl, '--test', 'tsc --noEmit && node -e "process.exit(0)"', '--json',
      ]);
      const json2 = parseJson(r2.stdout, 'compat');
      const codes2 = json2.testCommandCaveats.map((c) => c.code);
      assert.ok(!codes2.includes('TYPE_CHECK_ONLY'), `did not expect TYPE_CHECK_ONLY in ${JSON.stringify(codes2)}`);
    });
  }

  async testCompatWarnsOnEsmMismatchAgainstCjsBlindJest() {
    await this.run('compat surfaces a per-version esmMismatch when a candidate goes ESM-only under a CJS-blind jest command', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const v2 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '2.0.0', type: 'module', main: 'index.js' }),
        'index.js': 'export default {};',
      });
      const registryUrl = await this.registry('fake-lib', {
        '1.0.0': { tarballBuffer: v1 },
        '2.0.0': { tarballBuffer: v2 },
      });

      const appDir = this.tmp('compat-esm-mismatch');
      writeJson(path.join(appDir, 'package.json'), {
        name: 'app', version: '1.0.0',
        dependencies: { 'fake-lib': '1.0.0' },
      });
      writeNodeModulesPackage(appDir, 'fake-lib', { name: 'fake-lib', version: '1.0.0', main: 'index.js' });
      fs.writeFileSync(path.join(appDir, 'check.js'), 'process.exit(0);\n');

      const jestLikeCommand = 'node check.js # jest --silent';
      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0,2.0.0', '--app', appDir, '--registry', registryUrl, '--test', jestLikeCommand, '--json',
      ]);
      const json = parseJson(r.stdout, 'compat');
      const v2Result = json.versions.find((v) => v.version === '2.0.0');
      assert.ok(v2Result.esmMismatch, 'expected 2.0.0 to carry an esmMismatch advisory');
      assert.match(v2Result.esmMismatch, /type.*module/i);
      const v1Result = json.versions.find((v) => v.version === '1.0.0');
      assert.strictEqual(v1Result.esmMismatch, undefined, 'control-identical version should not carry an esmMismatch');
    });
  }

  async testCompatCleansUpSandboxOnSuccess() {
    await this.run('compat leaves no packdev-compat-sandbox-* dirs behind after a normal run', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const registryUrl = await this.registry('fake-lib', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('compat-cleanup');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });
      fs.writeFileSync(path.join(appDir, 'check.js'), 'process.exit(0);\n');

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir, '--registry', registryUrl, '--test', 'node check.js', '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);

      const leftover = fs.readdirSync(os.tmpdir()).filter((name) => name.startsWith('packdev-compat-sandbox-'));
      assert.deepStrictEqual(leftover, [], `expected no leftover sandbox dirs, found: ${leftover.join(', ')}`);
    });
  }

  async testCompatCleansUpSandboxOnSigint() {
    await this.run('compat removes the in-flight sandbox on SIGINT', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({
          name: 'fake-lib', version: '1.0.0', main: 'index.js',
          scripts: { postinstall: 'sleep 5' },
        }),
        'index.js': 'module.exports = {};',
      });
      const registryUrl = await this.registry('fake-lib', {
        '1.0.0': { tarballBuffer: v1, scripts: { postinstall: 'sleep 5' } },
      });

      const appDir = this.tmp('compat-sigint');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });
      fs.writeFileSync(path.join(appDir, 'check.js'), 'process.exit(0);\n');

      const before = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('packdev-compat-sandbox-')));

      const child = spawn('node', [
        BINARY_PATH, 'compat', 'fake-lib',
        '--versions', '1.0.0', '--app', appDir, '--registry', registryUrl, '--test', 'node check.js',
      ], { cwd: appDir, stdio: 'pipe' });

      let sandboxAppeared = false;
      for (let i = 0; i < 50; i++) {
        const dirs = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('packdev-compat-sandbox-') && !before.has(n));
        if (dirs.length > 0) { sandboxAppeared = true; break; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(sandboxAppeared, 'expected a sandbox directory to appear before timeout');

      child.kill('SIGINT');
      await new Promise((resolve) => child.on('close', resolve));

      const leftover = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('packdev-compat-sandbox-') && !before.has(n));
      assert.deepStrictEqual(leftover, [], `expected no leftover sandbox dirs after SIGINT, found: ${leftover.join(', ')}`);
    });
  }

  async testCompatDoesNotMutateRealApp() {
    await this.run('compat never mutates the real app package.json, only its sandbox copy', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const registryUrl = await this.registry('fake-lib', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('compat-untouched');
      const pkgJsonPath = path.join(appDir, 'package.json');
      writeJson(pkgJsonPath, { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });
      fs.writeFileSync(path.join(appDir, 'check.js'), 'process.exit(0);\n');
      const before = fs.readFileSync(pkgJsonPath, 'utf-8');

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir, '--registry', registryUrl, '--test', 'node check.js', '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);

      const after = fs.readFileSync(pkgJsonPath, 'utf-8');
      assert.strictEqual(after, before, 'app package.json must be byte-identical after compat run');
    });
  }

  // --- compat --snapshot-dir (E8: transitive dependency drift) -------------

  async testCompatCapturesLockfileSnapshot() {
    await this.run('compat --snapshot-dir captures a hashed lockfile snapshot per version', async () => {
      const transitiveV1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-transitive', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const libV1 = await buildFakeTarball({
        'package.json': JSON.stringify({
          name: 'fake-lib', version: '1.0.0', main: 'index.js',
          dependencies: { 'fake-transitive': '^1.0.0' },
        }),
        'index.js': 'module.exports = {};',
      });
      const registryUrl = await this.registryMulti({
        'fake-lib': { '1.0.0': { tarballBuffer: libV1 } },
        'fake-transitive': { '1.0.0': { tarballBuffer: transitiveV1 } },
      });

      const appDir = this.tmp('compat-snapshot-app');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });
      fs.writeFileSync(path.join(appDir, 'check.js'), 'process.exit(0);\n');
      const snapshotDir = this.tmp('compat-snapshot-dir');

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir, '--registry', registryUrl,
        '--test', 'node check.js', '--snapshot-dir', snapshotDir, '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'compat');
      assert.strictEqual(json.snapshotDir, snapshotDir);
      const versionResult = json.versions[0];
      assert.ok(versionResult.lockfileHash, 'expected a non-empty lockfileHash');
      assert.ok(versionResult.lockfileSnapshotPath, 'expected a lockfileSnapshotPath');
      assert.ok(
        fs.existsSync(versionResult.lockfileSnapshotPath),
        `expected snapshot file to exist at ${versionResult.lockfileSnapshotPath}`,
      );
    });
  }

  async testCompatSnapshotRevealsTransitiveDrift() {
    await this.run('compat --snapshot-dir makes transitive dependency drift visible across runs', async () => {
      const transitiveV1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-transitive', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const libV1 = await buildFakeTarball({
        'package.json': JSON.stringify({
          name: 'fake-lib', version: '1.0.0', main: 'index.js',
          dependencies: { 'fake-transitive': '^1.0.0' },
        }),
        'index.js': 'module.exports = {};',
      });

      const appDir = this.tmp('compat-drift-app');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });
      fs.writeFileSync(path.join(appDir, 'check.js'), 'process.exit(0);\n');

      // Two separate fake registries (distinct ports, so npm's own package
      // cache never conflates them) stand in for "the registry as it stood"
      // at two different points in time — registryB additionally has a
      // newer fake-transitive patch that still satisfies fake-lib's
      // "^1.0.0" range, simulating real transitive drift between runs.
      const registryUrlA = await this.registryMulti({
        'fake-lib': { '1.0.0': { tarballBuffer: libV1 } },
        'fake-transitive': { '1.0.0': { tarballBuffer: transitiveV1 } },
      });
      const dirA = this.tmp('compat-drift-a');
      const runA = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir, '--registry', registryUrlA,
        '--test', 'node check.js', '--snapshot-dir', dirA, '--json',
      ]);
      assert.strictEqual(runA.code, 0, `expected exit 0, got ${runA.code}: ${runA.stderr}`);
      const jsonA = parseJson(runA.stdout, 'compat');

      const transitiveV1_1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-transitive', version: '1.1.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const registryUrlB = await this.registryMulti({
        'fake-lib': { '1.0.0': { tarballBuffer: libV1 } },
        'fake-transitive': {
          '1.0.0': { tarballBuffer: transitiveV1 },
          '1.1.0': { tarballBuffer: transitiveV1_1 },
        },
      });
      const dirB = this.tmp('compat-drift-b');
      const runB = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir, '--registry', registryUrlB,
        '--test', 'node check.js', '--snapshot-dir', dirB, '--json',
      ]);
      assert.strictEqual(runB.code, 0, `expected exit 0, got ${runB.code}: ${runB.stderr}`);
      const jsonB = parseJson(runB.stdout, 'compat');

      assert.notStrictEqual(
        jsonA.versions[0].lockfileHash,
        jsonB.versions[0].lockfileHash,
        'transitive drift between the two runs should change the resolved lockfile hash',
      );
      const contentA = fs.readFileSync(jsonA.versions[0].lockfileSnapshotPath, 'utf-8');
      const contentB = fs.readFileSync(jsonB.versions[0].lockfileSnapshotPath, 'utf-8');
      assert.notStrictEqual(contentA, contentB, 'the two snapshot files should be diffable and different');
    });
  }

  // --- compat --concurrency / --prefer-offline (E10: cost blowup) ---------

  async testCompatConcurrencyOverlapsInstalls() {
    await this.run('compat --concurrency actually runs installs in parallel, within the limit', async () => {
      const versionsMap = {};
      for (let i = 1; i <= 4; i++) {
        const version = `${i}.0.0`;
        const tarball = await buildFakeTarball({
          'package.json': JSON.stringify({ name: 'fake-lib', version, main: 'index.js' }),
          'index.js': 'module.exports = {};',
        });
        versionsMap[version] = { tarballBuffer: tarball };
      }
      const registryUrl = await this.registry('fake-lib', versionsMap);

      const appDir = this.tmp('compat-concurrency-app');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });

      const logDir = this.tmp('compat-concurrency-log');
      const logPath = path.join(logDir, 'events.log');
      fs.writeFileSync(
        path.join(appDir, 'check.js'),
        `const fs = require('fs');\n` +
        `const logPath = ${JSON.stringify(logPath)};\n` +
        `fs.appendFileSync(logPath, JSON.stringify({ event: 'start', t: Date.now() }) + '\\n');\n` +
        `const until = Date.now() + 400;\n` +
        `while (Date.now() < until) {}\n` +
        `fs.appendFileSync(logPath, JSON.stringify({ event: 'end', t: Date.now() }) + '\\n');\n` +
        `process.exit(0);\n`,
      );

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0,2.0.0,3.0.0,4.0.0', '--app', appDir, '--registry', registryUrl,
        '--test', 'node check.js', '--concurrency', '2', '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'compat');
      assert.strictEqual(json.concurrency, 2);
      assert.ok(json.versions.every((v) => v.status === 'PASSED'), 'all 4 versions should pass');

      const events = fs.readFileSync(logPath, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .sort((a, b) => a.t - b.t);
      let active = 0;
      let maxActive = 0;
      for (const event of events) {
        active += event.event === 'start' ? 1 : -1;
        maxActive = Math.max(maxActive, active);
      }
      assert.ok(maxActive > 1, `expected overlapping test-command windows, saw max concurrent = ${maxActive}`);
      assert.ok(maxActive <= 2, `expected at most 2 concurrent test commands (the configured limit), saw ${maxActive}`);
    });
  }

  async testCompatPreferOfflineDoesNotBreakNormalRun() {
    await this.run('compat --prefer-offline still passes a normal run through correctly', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const registryUrl = await this.registry('fake-lib', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('compat-prefer-offline');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });
      fs.writeFileSync(path.join(appDir, 'check.js'), 'process.exit(0);\n');

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir, '--registry', registryUrl,
        '--test', 'node check.js', '--prefer-offline', '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'compat');
      assert.strictEqual(json.versions[0].status, 'PASSED');
    });
  }

  // --- compat --group -----------------------------------------------------

  async buildFakeFamilyRegistry(versions) {
    const packages = {};
    for (const name of ['fake-core', 'fake-common', 'fake-express']) {
      const versionsMap = {};
      for (const version of versions) {
        const tarball = await buildFakeTarball({
          'package.json': JSON.stringify({ name, version, main: 'index.js' }),
          'index.js': 'module.exports = {};',
        });
        versionsMap[version] = { tarballBuffer: tarball };
      }
      packages[name] = versionsMap;
    }
    return this.registryMulti(packages);
  }

  async testCompatGroupWithoutFlagSurfacesMismatch() {
    await this.run('compat without --group leaves peer packages mismatched and FAILED', async () => {
      const registryUrl = await this.buildFakeFamilyRegistry(['1.0.0', '2.0.0']);

      const appDir = this.tmp('compat-group-mismatch');
      writeJson(path.join(appDir, 'package.json'), {
        name: 'app',
        version: '1.0.0',
        dependencies: { 'fake-core': '1.0.0', 'fake-common': '1.0.0', 'fake-express': '1.0.0' },
      });
      fs.writeFileSync(
        path.join(appDir, 'check.js'),
        'const c=require("fake-core/package.json").version,m=require("fake-common/package.json").version,e=require("fake-express/package.json").version;\n' +
        'process.exit(c===m && m===e ? 0 : 1);\n',
      );

      const r = await runPackdev(appDir, [
        'compat', 'fake-core', '--versions', '2.0.0', '--app', appDir, '--registry', registryUrl, '--test', 'node check.js', '--json',
      ]);
      // Exit 7 (COMPAT_FAILED): the mismatch is a real FAILED result.
      assert.strictEqual(r.code, 7, `expected exit 7, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'compat');
      assert.strictEqual(json.versions[0].status, 'FAILED', 'pinning only fake-core should leave the family mismatched');
    });
  }

  async testCompatGroupMovesFamilyTogether() {
    await this.run('compat --group pins the whole family to the same version', async () => {
      const registryUrl = await this.buildFakeFamilyRegistry(['1.0.0', '2.0.0']);

      const appDir = this.tmp('compat-group-together');
      writeJson(path.join(appDir, 'package.json'), {
        name: 'app',
        version: '1.0.0',
        dependencies: { 'fake-core': '1.0.0', 'fake-common': '1.0.0', 'fake-express': '1.0.0' },
      });
      fs.writeFileSync(
        path.join(appDir, 'check.js'),
        'const c=require("fake-core/package.json").version,m=require("fake-common/package.json").version,e=require("fake-express/package.json").version;\n' +
        'process.exit(c===m && m===e ? 0 : 1);\n',
      );

      const r = await runPackdev(appDir, [
        'compat', 'fake-core', '--versions', '2.0.0', '--group', 'fake-common,fake-express',
        '--app', appDir, '--registry', registryUrl, '--test', 'node check.js', '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'compat');
      assert.strictEqual(json.versions[0].status, 'PASSED');
      assert.deepStrictEqual(json.group, ['fake-common', 'fake-express']);
    });
  }

  async testCompatGroupErrorsOnUndeclaredMember() {
    await this.run('compat --group errors clearly when a group member is not declared', async () => {
      const registryUrl = await this.buildFakeFamilyRegistry(['1.0.0', '2.0.0']);

      const appDir = this.tmp('compat-group-undeclared');
      writeJson(path.join(appDir, 'package.json'), {
        name: 'app',
        version: '1.0.0',
        dependencies: { 'fake-core': '1.0.0', 'fake-common': '1.0.0' },
      });
      fs.writeFileSync(path.join(appDir, 'check.js'), 'process.exit(0);\n');

      const r = await runPackdev(appDir, [
        'compat', 'fake-core', '--versions', '2.0.0', '--group', 'fake-common,fake-express',
        '--app', appDir, '--registry', registryUrl, '--test', 'node check.js',
      ]);
      assert.notStrictEqual(r.code, 0, 'expected a non-zero exit for an undeclared group member');
      assert.match(r.stderr, /fake-express/);
      assert.match(r.stderr, /not declared/i);
    });
  }

  async testCompatUndeclaredPackageNamesSiblingWorkspacesThatDeclareIt() {
    await this.run('compat names sibling workspaces that DO declare the package, when --app does not', async () => {
      const monorepoRoot = this.tmp('compat-undeclared-workspace-hint');
      writeJson(path.join(monorepoRoot, 'package.json'), {
        name: 'root', private: true, workspaces: ['packages/*'],
      });

      const appDir = path.join(monorepoRoot, 'packages', 'app');
      fs.mkdirSync(appDir, { recursive: true });
      writeJson(path.join(appDir, 'package.json'), {
        name: 'app', version: '1.0.0', dependencies: {},
      });
      fs.writeFileSync(path.join(appDir, 'check.js'), 'process.exit(0);\n');

      const apiDir = path.join(monorepoRoot, 'packages', 'api');
      fs.mkdirSync(apiDir, { recursive: true });
      writeJson(path.join(apiDir, 'package.json'), {
        name: '@acme/api', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' },
      });

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir,
        '--registry', 'http://127.0.0.1:1', '--test', 'node check.js',
      ]);
      assert.notStrictEqual(r.code, 0, 'expected a non-zero exit for an undeclared package');
      assert.match(r.stderr, /not declared/i);
      assert.match(r.stderr, /@acme\/api/, 'error should name the sibling workspace that declares fake-lib');
    });
  }

  async testCompatGroupComposesWithBisect() {
    await this.run('compat --group composes with --bisect across the whole family', async () => {
      const registryUrl = await this.buildFakeFamilyRegistry(['1.0.0', '2.0.0', '3.0.0']);

      const appDir = this.tmp('compat-group-bisect');
      writeJson(path.join(appDir, 'package.json'), {
        name: 'app',
        version: '1.0.0',
        dependencies: { 'fake-core': '1.0.0', 'fake-common': '1.0.0', 'fake-express': '1.0.0' },
      });
      fs.writeFileSync(
        path.join(appDir, 'check.js'),
        'const c=require("fake-core/package.json").version,m=require("fake-common/package.json").version,e=require("fake-express/package.json").version;\n' +
        'process.exit(c===m && m===e ? 0 : 1);\n',
      );

      const r = await runPackdev(appDir, [
        'compat', 'fake-core', '--versions', '1.0.0,2.0.0,3.0.0', '--group', 'fake-common,fake-express',
        '--bisect', '--app', appDir, '--registry', registryUrl, '--test', 'node check.js', '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'compat');
      assert.strictEqual(json.minimumCompatibleVersion, '1.0.0');
      assert.strictEqual(json.recommendedVersion, '3.0.0');
      assert.ok(!json.versions.some((v) => v.status !== 'PASSED'), 'grouping should keep every tested version consistent and PASSED');
    });
  }

  // --- compat --bisect --------------------------------------------------

  async testCompatBisectFindsBoundaryInFewerRuns() {
    await this.run('compat --bisect finds the pass/fail boundary without testing every version', async () => {
      // v1-v4: no `special` export (test fails). v5-v9: has it (test passes).
      const versionsMap = {};
      for (let i = 1; i <= 9; i++) {
        const version = `${i}.0.0`;
        const tarball = await buildFakeTarball({
          'package.json': JSON.stringify({ name: 'fake-lib', version, main: 'index.js' }),
          'index.js': `module.exports = { special: ${i >= 5} };`,
        });
        versionsMap[version] = { tarballBuffer: tarball };
      }
      const registryUrl = await this.registry('fake-lib', versionsMap);

      const appDir = this.tmp('compat-bisect-boundary');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });
      fs.writeFileSync(
        path.join(appDir, 'check.js'),
        'process.exit(require("fake-lib").special ? 0 : 1);\n',
      );

      const allVersions = Array.from({ length: 9 }, (_, i) => `${i + 1}.0.0`).join(',');
      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', allVersions, '--app', appDir, '--registry', registryUrl,
        '--test', 'node check.js', '--bisect', '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'compat');
      assert.strictEqual(json.bisected, true);
      assert.strictEqual(json.minimumCompatibleVersion, '5.0.0');
      assert.strictEqual(json.recommendedVersion, '9.0.0');
      assert.strictEqual(json.totalVersionCount, 9);
      assert.ok(
        json.testedVersionCount < json.totalVersionCount,
        `expected fewer than 9 versions tested, got ${json.testedVersionCount}`,
      );
      assert.strictEqual(json.fellBackToLinearScan, false);
    });
  }

  async testCompatBisectEverythingPasses() {
    await this.run('compat --bisect converges in 2 runs when every version passes', async () => {
      const versionsMap = {};
      for (let i = 1; i <= 3; i++) {
        const version = `${i}.0.0`;
        const tarball = await buildFakeTarball({
          'package.json': JSON.stringify({ name: 'fake-lib', version, main: 'index.js' }),
          'index.js': 'module.exports = { special: true };',
        });
        versionsMap[version] = { tarballBuffer: tarball };
      }
      const registryUrl = await this.registry('fake-lib', versionsMap);

      const appDir = this.tmp('compat-bisect-allpass');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });
      fs.writeFileSync(
        path.join(appDir, 'check.js'),
        'process.exit(require("fake-lib").special ? 0 : 1);\n',
      );

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0,2.0.0,3.0.0', '--app', appDir, '--registry', registryUrl,
        '--test', 'node check.js', '--bisect', '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'compat');
      assert.strictEqual(json.testedVersionCount, 2);
      assert.strictEqual(json.minimumCompatibleVersion, '1.0.0');
      assert.strictEqual(json.recommendedVersion, '3.0.0');
    });
  }

  async testCompatBisectNothingPasses() {
    await this.run('compat --bisect stops after 1 run when the top version fails', async () => {
      const versionsMap = {};
      for (let i = 1; i <= 3; i++) {
        const version = `${i}.0.0`;
        const tarball = await buildFakeTarball({
          'package.json': JSON.stringify({ name: 'fake-lib', version, main: 'index.js' }),
          'index.js': 'module.exports = { special: false };',
        });
        versionsMap[version] = { tarballBuffer: tarball };
      }
      const registryUrl = await this.registry('fake-lib', versionsMap);

      const appDir = this.tmp('compat-bisect-nopass');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });
      fs.writeFileSync(
        path.join(appDir, 'check.js'),
        'process.exit(require("fake-lib").special ? 0 : 1);\n',
      );

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0,2.0.0,3.0.0', '--app', appDir, '--registry', registryUrl,
        '--test', 'node check.js', '--bisect', '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'compat');
      assert.strictEqual(json.testedVersionCount, 1);
      assert.strictEqual(json.minimumCompatibleVersion, null);
      assert.strictEqual(json.recommendedVersion, null);
    });
  }

  async testCompatBisectFallsBackOnFlakyBoundary() {
    await this.run('compat --bisect falls back to a full scan when the boundary version is flaky', async () => {
      const appDir = this.tmp('compat-bisect-flaky');
      // v2's own test result flips between its first (bisect-loop) run and
      // its confirmation re-run, simulating a flaky/non-monotonic boundary.
      const counterPath = path.join(appDir, 'bisect-counter.txt');

      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = { marker: "v1" };',
      });
      const v2 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '2.0.0', main: 'index.js' }),
        'index.js': 'module.exports = { marker: "v2" };',
      });
      const v3 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '3.0.0', main: 'index.js' }),
        'index.js': 'module.exports = { marker: "v3" };',
      });
      const registryUrl = await this.registry('fake-lib', {
        '1.0.0': { tarballBuffer: v1 },
        '2.0.0': { tarballBuffer: v2 },
        '3.0.0': { tarballBuffer: v3 },
      });

      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });
      fs.writeFileSync(
        path.join(appDir, 'check.js'),
        [
          'const fs = require("fs");',
          'const lib = require("fake-lib");',
          `const counterPath = ${JSON.stringify(counterPath)};`,
          'if (lib.marker === "v1") process.exit(1);',
          'if (lib.marker === "v3") process.exit(0);',
          // v2: passes exactly once, fails on every subsequent run.
          'let count = 0;',
          'try { count = parseInt(fs.readFileSync(counterPath, "utf-8"), 10) || 0; } catch {}',
          'fs.writeFileSync(counterPath, String(count + 1));',
          'process.exit(count === 0 ? 0 : 1);',
        ].join('\n'),
      );

      const r = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0,2.0.0,3.0.0', '--app', appDir, '--registry', registryUrl,
        '--test', 'node check.js', '--bisect', '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'compat');
      assert.strictEqual(json.fellBackToLinearScan, true);
      assert.strictEqual(json.testedVersionCount, 3);
      assert.strictEqual(json.totalVersionCount, 3);
      assert.strictEqual(json.versions.length, 3, 'fallback should report exactly one result per version');
    });
  }

  // --- behavior-diff (experimental) ------------------------------------------

  async testBehaviorDiffRequiresExperimentalFlag() {
    await this.run('behavior-diff refuses to run without --experimental', async () => {
      const appDir = this.tmp('behavior-diff-no-flag');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '1.0.0' } });
      writeNodeModulesPackage(appDir, 'fake-lib', { name: 'fake-lib', version: '1.0.0', main: 'index.js' });

      const r = await runPackdev(appDir, [
        'behavior-diff', 'fake-lib', '--to', '2.0.0', '--app', appDir, '--json',
      ]);
      assert.notStrictEqual(r.code, 0);
      const json = parseJson(r.stdout, 'behavior-diff');
      assert.match(json.error, /--experimental/);
    });
  }

  async testBehaviorDiffDegradesOnDynamicOnlyUsageWithNoSeeds() {
    await this.run('behavior-diff reports degraded (not a false-clean empty result) when the app only uses the package dynamically', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'function realEntry() { return "v1"; }\nmodule.exports = { realEntry };\n',
      });
      const v2 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '2.0.0', main: 'index.js' }),
        'index.js': 'function realEntry() { return "v2"; }\nmodule.exports = { realEntry };\n',
      });
      const registryUrl = await this.registry('fake-lib', {
        '1.0.0': { tarballBuffer: v1 }, '2.0.0': { tarballBuffer: v2 },
      });

      const appDir = this.tmp('behavior-diff-dynamic-only');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '1.0.0' } });
      writeNodeModulesPackage(appDir, 'fake-lib', { name: 'fake-lib', version: '1.0.0', main: 'index.js' });
      // Namespace import — no destructured symbol names, so a plain scan
      // finds zero seeds even though realEntry genuinely changed and is
      // genuinely reachable (lib.realEntry()).
      fs.writeFileSync(
        path.join(appDir, 'app.js'),
        "const lib = require('fake-lib');\nlib.realEntry();\n",
      );

      const r = await runPackdev(appDir, [
        'behavior-diff', 'fake-lib', '--to', '2.0.0', '--app', appDir,
        '--registry', registryUrl, '--experimental', '--json',
      ]);
      const json = parseJson(r.stdout, 'behavior-diff');
      assert.ok(json.degraded, 'must not silently report changes:[] as if verified clean when there were zero seeds to check');
      assert.deepStrictEqual(json.changes, []);
      assert.strictEqual(json.seedSymbols.length, 0);
    });
  }

  async testBehaviorDiffSurfacesDynamicUsageCaveatAlongsideRealResults() {
    await this.run('behavior-diff still runs and reports a dynamicUsageCaveat (not degraded) when dynamic usage coexists with real named seeds', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'function namedThing() { return "v1"; }\nmodule.exports = { namedThing };\n',
      });
      const v2 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '2.0.0', main: 'index.js' }),
        'index.js': 'function namedThing() { return "v2"; }\nmodule.exports = { namedThing };\n',
      });
      const registryUrl = await this.registry('fake-lib', {
        '1.0.0': { tarballBuffer: v1 }, '2.0.0': { tarballBuffer: v2 },
      });

      const appDir = this.tmp('behavior-diff-mixed-dynamic');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '1.0.0' } });
      writeNodeModulesPackage(
        appDir, 'fake-lib', { name: 'fake-lib', version: '1.0.0', main: 'index.js' },
        { 'index.js': 'function namedThing() { return "v1"; }\nmodule.exports = { namedThing };\n' },
      );
      // A real destructured seed (namedThing) alongside an unrelated
      // namespace import elsewhere in the app — a real result should still
      // come back, just with the caveat attached.
      fs.writeFileSync(
        path.join(appDir, 'app.js'),
        "const { namedThing } = require('fake-lib');\nconst ns = require('fake-lib');\nnamedThing();\n",
      );

      const r = await runPackdev(appDir, [
        'behavior-diff', 'fake-lib', '--to', '2.0.0', '--app', appDir,
        '--registry', registryUrl, '--experimental', '--json',
      ]);
      const json = parseJson(r.stdout, 'behavior-diff');
      assert.strictEqual(json.degraded, null);
      assert.ok(json.dynamicUsageCaveat, 'expected a dynamicUsageCaveat even though a real result was produced');
      assert.ok(json.changes.some((c) => c.name === 'namedThing'), JSON.stringify(json.changes));
    });
  }

  async testBehaviorDiffFindsTheReachableSemanticChange() {
    await this.run('behavior-diff surfaces a semantic change reachable via an option key passed to an imported symbol', async () => {
      // Mirrors the sqs-consumer shape: handleMessage returning undefined
      // changes meaning between versions, in a function whose parameter is
      // literally named after the option key the app passes in — nothing
      // about the app's own import list changes, only shipped behavior.
      const makeIndexJs = (returnOnUndefined) => `
function executeHandler(message, handleMessage) {
  var result = handleMessage(message);
  if (result === undefined) {
    return ${returnOnUndefined};
  }
  return result;
}
class Consumer {
  static create(options) {
    return new Consumer(options);
  }
  constructor(options) {
    this.handleMessage = options.handleMessage;
  }
}
module.exports = { Consumer, executeHandler };
`;
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': makeIndexJs('message'),
      });
      const v2 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '2.0.0', main: 'index.js' }),
        'index.js': makeIndexJs('null'),
      });
      const registryUrl = await this.registry('fake-lib', {
        '1.0.0': { tarballBuffer: v1 }, '2.0.0': { tarballBuffer: v2 },
      });

      const appDir = this.tmp('behavior-diff-reachable');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '1.0.0' } });
      writeNodeModulesPackage(
        appDir, 'fake-lib', { name: 'fake-lib', version: '1.0.0', main: 'index.js' },
        { 'index.js': makeIndexJs('message') },
      );
      fs.writeFileSync(
        path.join(appDir, 'app.js'),
        "const { Consumer } = require('fake-lib');\nConsumer.create({ handleMessage: (m) => {} });\n",
      );

      const r = await runPackdev(appDir, [
        'behavior-diff', 'fake-lib', '--to', '2.0.0', '--app', appDir,
        '--registry', registryUrl, '--experimental', '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'behavior-diff');
      assert.strictEqual(json.degraded, null);
      assert.strictEqual(json.from, '1.0.0');
      assert.strictEqual(json.to, '2.0.0');
      assert.ok(json.seedSymbols.includes('Consumer'), JSON.stringify(json.seedSymbols));
      assert.ok(json.seedOptionKeys.includes('handleMessage'), JSON.stringify(json.seedOptionKeys));

      const executeHandlerChange = json.changes.find((c) => c.name === 'executeHandler');
      assert.ok(executeHandlerChange, `expected executeHandler in changes: ${JSON.stringify(json.changes.map((c) => c.name))}`);
      assert.strictEqual(executeHandlerChange.kind, 'changed');
      assert.ok(executeHandlerChange.reachableVia.includes('handleMessage'), JSON.stringify(executeHandlerChange.reachableVia));
      assert.ok(executeHandlerChange.diff.some((l) => l.startsWith('-') && l.includes('return message')), JSON.stringify(executeHandlerChange.diff));
      assert.ok(executeHandlerChange.diff.some((l) => l.startsWith('+') && l.includes('return null')), JSON.stringify(executeHandlerChange.diff));

      // Ranked first: it's the only change, but also confirm score > 0 so
      // the ranking heuristic actually fired on a return-statement change.
      assert.strictEqual(json.changes[0].name, 'executeHandler');
      assert.ok(json.changes[0].score > 0);

      const human = await runPackdev(appDir, [
        'behavior-diff', 'fake-lib', '--to', '2.0.0', '--app', appDir,
        '--registry', registryUrl, '--experimental',
      ]);
      assert.match(human.stdout, /EXPERIMENTAL/);
      assert.match(human.stdout, /executeHandler/);
      assert.match(human.stdout, /reachable via: handleMessage/);
    });
  }

  async testBehaviorDiffSeedsOptionKeysThroughDefaultAndAliasedImports() {
    await this.run('behavior-diff seeds option keys through default imports and aliased named imports, not just plain named imports', async () => {
      const makeIndexJs = (returnOnUndefined) => `
function executeHandler(message, handleMessage) {
  var result = handleMessage(message);
  if (result === undefined) {
    return ${returnOnUndefined};
  }
  return result;
}
class Consumer {
  static create(options) {
    return new Consumer(options);
  }
  constructor(options) {
    this.handleMessage = options.handleMessage;
  }
}
module.exports = Consumer;
module.exports.executeHandler = executeHandler;
`;
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': makeIndexJs('message'),
      });
      const v2 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '2.0.0', main: 'index.js' }),
        'index.js': makeIndexJs('null'),
      });
      const registryUrl = await this.registry('fake-lib', {
        '1.0.0': { tarballBuffer: v1 }, '2.0.0': { tarballBuffer: v2 },
      });

      const appDir = this.tmp('behavior-diff-default-aliased-import');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '1.0.0' } });
      writeNodeModulesPackage(
        appDir, 'fake-lib', { name: 'fake-lib', version: '1.0.0', main: 'index.js' },
        { 'index.js': makeIndexJs('message') },
      );
      // Default import, called under a LOCAL name ("MyConsumer") that
      // shares nothing textually with the package's own export name
      // ("default") — the old export-name-based matching could never
      // catch this call site at all.
      fs.writeFileSync(
        path.join(appDir, 'app.ts'),
        "import MyConsumer from 'fake-lib';\nMyConsumer.create({ handleMessage: (m) => {} });\n",
      );

      const r = await runPackdev(appDir, [
        'behavior-diff', 'fake-lib', '--to', '2.0.0', '--app', appDir,
        '--registry', registryUrl, '--experimental', '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'behavior-diff');
      assert.ok(json.seedOptionKeys.includes('handleMessage'), `expected handleMessage seeded via the default import's local name: ${JSON.stringify(json.seedOptionKeys)}`);
      assert.ok(json.changes.some((c) => c.name === 'executeHandler'), JSON.stringify(json.changes));
    });
  }

  async testBehaviorDiffFollowsOneMoreHopThroughACaller() {
    await this.run('behavior-diff marks a callee reachable when an already-reachable caller\'s body mentions it, not just direct seed mentions', async () => {
      // publicApi is the seed (imported); it calls helper() by name, but
      // the app never imports/mentions "helper" itself. Reachability must
      // follow that one hop: an already-reachable caller's own body
      // mentioning "helper" is what makes helper reachable — not the
      // reverse (checking whether helper's body mentions "publicApi").
      const makeIndexJs = (helperReturn) => `
function helper() {
  return "${helperReturn}";
}
function publicApi() {
  return helper();
}
module.exports = { publicApi };
`;
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': makeIndexJs('v1'),
      });
      const v2 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '2.0.0', main: 'index.js' }),
        'index.js': makeIndexJs('v2'),
      });
      const registryUrl = await this.registry('fake-lib', {
        '1.0.0': { tarballBuffer: v1 }, '2.0.0': { tarballBuffer: v2 },
      });

      const appDir = this.tmp('behavior-diff-one-hop');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '1.0.0' } });
      writeNodeModulesPackage(
        appDir, 'fake-lib', { name: 'fake-lib', version: '1.0.0', main: 'index.js' },
        { 'index.js': makeIndexJs('v1') },
      );
      fs.writeFileSync(
        path.join(appDir, 'app.js'),
        "const { publicApi } = require('fake-lib');\npublicApi();\n",
      );

      const r = await runPackdev(appDir, [
        'behavior-diff', 'fake-lib', '--to', '2.0.0', '--app', appDir,
        '--registry', registryUrl, '--experimental', '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'behavior-diff');
      const helperChange = json.changes.find((c) => c.name === 'helper');
      assert.ok(helperChange, `expected helper (reachable one hop through publicApi) in changes: ${JSON.stringify(json.changes.map((c) => c.name))}`);
      assert.deepStrictEqual(helperChange.reachableVia, ['publicApi']);
    });
  }

  async testBehaviorDiffIgnoresUnreachableChanges() {
    await this.run('behavior-diff does not report a changed function the app never reaches', async () => {
      const makeIndexJs = (internalConstant) => `
function unrelatedInternal() {
  return ${internalConstant};
}
function publicApi() {
  return "stable";
}
module.exports = { publicApi };
`;
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': makeIndexJs('1'),
      });
      const v2 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '2.0.0', main: 'index.js' }),
        'index.js': makeIndexJs('2'),
      });
      const registryUrl = await this.registry('fake-lib', {
        '1.0.0': { tarballBuffer: v1 }, '2.0.0': { tarballBuffer: v2 },
      });

      const appDir = this.tmp('behavior-diff-unreachable');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '1.0.0' } });
      writeNodeModulesPackage(
        appDir, 'fake-lib', { name: 'fake-lib', version: '1.0.0', main: 'index.js' },
        { 'index.js': makeIndexJs('1') },
      );
      fs.writeFileSync(
        path.join(appDir, 'app.js'),
        "const { publicApi } = require('fake-lib');\npublicApi();\n",
      );

      const r = await runPackdev(appDir, [
        'behavior-diff', 'fake-lib', '--to', '2.0.0', '--app', appDir,
        '--registry', registryUrl, '--experimental', '--json',
      ]);
      const json = parseJson(r.stdout, 'behavior-diff');
      assert.strictEqual(json.degraded, null);
      assert.ok(!json.changes.some((c) => c.name === 'unrelatedInternal'), JSON.stringify(json.changes));
      assert.ok(!json.changes.some((c) => c.name === 'publicApi'), 'publicApi text is identical across versions, must not be reported as changed');
    });
  }

  async testBehaviorDiffWalksExtensionlessAndDirectoryRequires() {
    await this.run('behavior-diff resolves require("./helper") (extensionless -> helper.js) and require("./dist") (directory -> dist/index.js), not just the entry file itself', async () => {
      const makeHelperJs = (returnValue) => `
function doThing() {
  return "${returnValue}";
}
module.exports = { doThing };
`;
      // index.js only re-exports from two local requires that need real
      // resolution: an extensionless specifier where only "helper.js"
      // exists on disk, and a directory specifier where only
      // "dist/index.js" exists — neither "helper" nor "dist" themselves
      // are real files.
      const indexJs = `
module.exports = { ...require('./helper'), ...require('./dist') };
`;
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': indexJs,
        'helper.js': makeHelperJs('v1-helper'),
        'dist/index.js': makeHelperJs('v1-dist').replace('doThing', 'doOtherThing'),
      });
      const v2 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '2.0.0', main: 'index.js' }),
        'index.js': indexJs,
        'helper.js': makeHelperJs('v2-helper'),
        'dist/index.js': makeHelperJs('v2-dist').replace('doThing', 'doOtherThing'),
      });
      const registryUrl = await this.registry('fake-lib', {
        '1.0.0': { tarballBuffer: v1 }, '2.0.0': { tarballBuffer: v2 },
      });

      const appDir = this.tmp('behavior-diff-nested-requires');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '1.0.0' } });
      writeNodeModulesPackage(
        appDir, 'fake-lib', { name: 'fake-lib', version: '1.0.0', main: 'index.js' },
        {
          'index.js': indexJs,
          'helper.js': makeHelperJs('v1-helper'),
          'dist/index.js': makeHelperJs('v1-dist').replace('doThing', 'doOtherThing'),
        },
      );
      fs.writeFileSync(
        path.join(appDir, 'app.js'),
        "const { doThing, doOtherThing } = require('fake-lib');\ndoThing();\ndoOtherThing();\n",
      );

      const r = await runPackdev(appDir, [
        'behavior-diff', 'fake-lib', '--to', '2.0.0', '--app', appDir,
        '--registry', registryUrl, '--experimental', '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'behavior-diff');
      assert.strictEqual(json.degraded, null);
      const names = json.changes.map((c) => c.name);
      assert.ok(names.includes('doThing'), `expected doThing (from helper.js) in changes: ${JSON.stringify(names)}`);
      assert.ok(names.includes('doOtherThing'), `expected doOtherThing (from dist/index.js) in changes: ${JSON.stringify(names)}`);
    });
  }

  async testBehaviorDiffReadsFromInstalledDirNotRegistry() {
    await this.run('behavior-diff reads "from" from the actual installed directory, not by re-downloading that version from the registry', async () => {
      // Only "2.0.0" exists on the registry — the installed version below
      // is a locally-patched build that was never published under this
      // version string at all. If behavior-diff tried to re-download
      // "1.0.0-local" from the registry, this would fail outright.
      const v2 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '2.0.0', main: 'index.js' }),
        'index.js': 'function realEntry() { return "v2"; }\nmodule.exports = { realEntry };\n',
      });
      const registryUrl = await this.registry('fake-lib', { '2.0.0': { tarballBuffer: v2 } });

      const appDir = this.tmp('behavior-diff-installed-not-registry');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '1.0.0-local' } });
      // A locally-patched install, content deliberately distinct from
      // anything ever published, so the assertion can tell whether the
      // installed content or the (nonexistent) registry content was used.
      writeNodeModulesPackage(
        appDir, 'fake-lib',
        { name: 'fake-lib', version: '1.0.0-local', main: 'index.js' },
        { 'index.js': 'function realEntry() { return "installed-local-patch"; }\nmodule.exports = { realEntry };\n' },
      );
      fs.writeFileSync(
        path.join(appDir, 'app.js'),
        "const { realEntry } = require('fake-lib');\nrealEntry();\n",
      );

      const r = await runPackdev(appDir, [
        'behavior-diff', 'fake-lib', '--to', '2.0.0', '--app', appDir,
        '--registry', registryUrl, '--experimental', '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0 (from should never hit the registry), got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'behavior-diff');
      assert.strictEqual(json.from, '1.0.0-local');
      assert.strictEqual(json.degraded, null);
      const change = json.changes.find((c) => c.name === 'realEntry');
      assert.ok(change, JSON.stringify(json.changes));
      assert.ok(change.diff.some((l) => l.startsWith('-') && l.includes('installed-local-patch')), `expected the installed content, not a registry re-download: ${JSON.stringify(change.diff)}`);
    });
  }

  async testBehaviorDiffPrefersExportsMapOverMainField() {
    await this.run('behavior-diff resolves the entry through "exports" (not "main") when both are present, matching real Node resolution', async () => {
      const makeModernJs = (returnValue) => `
function realEntry() {
  return "${returnValue}";
}
module.exports = { realEntry };
`;
      // "main" points at a legacy file the app can never actually load
      // once "exports" is present — Node ignores "main" entirely in that
      // case. If behavior-diff analyzed "main" instead, it would parse
      // legacy.js (which never changes) and report zero changes.
      const legacyJs = 'function realEntry() { return "legacy-unused"; }\nmodule.exports = { realEntry };\n';

      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({
          name: 'fake-lib', version: '1.0.0', main: 'legacy.js',
          exports: { '.': { require: './modern.js' } },
        }),
        'legacy.js': legacyJs,
        'modern.js': makeModernJs('v1'),
      });
      const v2 = await buildFakeTarball({
        'package.json': JSON.stringify({
          name: 'fake-lib', version: '2.0.0', main: 'legacy.js',
          exports: { '.': { require: './modern.js' } },
        }),
        'legacy.js': legacyJs,
        'modern.js': makeModernJs('v2'),
      });
      const registryUrl = await this.registry('fake-lib', {
        '1.0.0': { tarballBuffer: v1 }, '2.0.0': { tarballBuffer: v2 },
      });

      const appDir = this.tmp('behavior-diff-exports-over-main');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '1.0.0' } });
      writeNodeModulesPackage(
        appDir, 'fake-lib',
        { name: 'fake-lib', version: '1.0.0', main: 'legacy.js', exports: { '.': { require: './modern.js' } } },
        { 'legacy.js': legacyJs, 'modern.js': makeModernJs('v1') },
      );
      fs.writeFileSync(
        path.join(appDir, 'app.js'),
        "const { realEntry } = require('fake-lib');\nrealEntry();\n",
      );

      const r = await runPackdev(appDir, [
        'behavior-diff', 'fake-lib', '--to', '2.0.0', '--app', appDir,
        '--registry', registryUrl, '--experimental', '--json',
      ]);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'behavior-diff');
      assert.strictEqual(json.degraded, null);
      const change = json.changes.find((c) => c.name === 'realEntry');
      assert.ok(change, `expected realEntry (from modern.js via exports) in changes: ${JSON.stringify(json.changes)}`);
      assert.strictEqual(change.file, 'modern.js', 'must have analyzed the exports-mapped file, not legacy.js from "main"');
    });
  }

  async testBehaviorDiffReportsNativeBinaryAsDegraded() {
    await this.run('behavior-diff reports degraded, not a misleading diff, for a package shipping a native binary', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
        'build/Release/native.node': 'not-really-a-binary',
      });
      const v2 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '2.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
        'build/Release/native.node': 'not-really-a-binary-v2',
      });
      const registryUrl = await this.registry('fake-lib', {
        '1.0.0': { tarballBuffer: v1 }, '2.0.0': { tarballBuffer: v2 },
      });

      const appDir = this.tmp('behavior-diff-native');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '1.0.0' } });
      writeNodeModulesPackage(
        appDir, 'fake-lib', { name: 'fake-lib', version: '1.0.0', main: 'index.js' },
        { 'index.js': 'module.exports = {};', 'build/Release/native.node': 'not-really-a-binary' },
      );

      const r = await runPackdev(appDir, [
        'behavior-diff', 'fake-lib', '--to', '2.0.0', '--app', appDir,
        '--registry', registryUrl, '--experimental', '--json',
      ]);
      const json = parseJson(r.stdout, 'behavior-diff');
      assert.match(json.degraded, /native|WebAssembly/);
      assert.deepStrictEqual(json.changes, []);
    });
  }

  // --- dupes (duplicate package instances in the tree) ----------------------

  async testDupesFindsDuplicate() {
    await this.run('dupes finds a package resolved at two different depths', async () => {
      const dir = this.tmp('dupes-duplicate');
      writeNodeModulesPackage(dir, 'left-pad', { name: 'left-pad', version: '1.3.0' });
      writeNodeModulesPackage(path.join(dir, 'node_modules', 'some-dep'), 'left-pad', { name: 'left-pad', version: '1.1.2' });

      const r = await runPackdev(dir, ['dupes', 'left-pad', '--json']);
      // Exit code 5 (DUPLICATE_FOUND) so `dupes` can be used as a CI guard.
      assert.strictEqual(r.code, 5, `expected exit 5, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'dupes');
      assert.strictEqual(json.duplicate, true);
      assert.strictEqual(json.copies.length, 2);
      const versions = json.copies.map((res) => res.version).sort();
      assert.deepStrictEqual(versions, ['1.1.2', '1.3.0']);
      assert.ok(json.copies.every((res) => typeof res.realpath === 'string'));
    });
  }

  async testDupesSingleResolution() {
    await this.run('dupes reports a single resolution as not duplicate', async () => {
      const dir = this.tmp('dupes-single');
      writeNodeModulesPackage(dir, 'left-pad', { name: 'left-pad', version: '1.3.0' });

      const r = await runPackdev(dir, ['dupes', 'left-pad', '--json']);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'dupes');
      assert.strictEqual(json.duplicate, false);
      assert.strictEqual(json.copies.length, 1);
    });
  }

  async testDupesNotInstalled() {
    await this.run('dupes reports an empty result when the package is nowhere in the tree', async () => {
      const dir = this.tmp('dupes-none');
      fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });

      const r = await runPackdev(dir, ['dupes', 'left-pad', '--json']);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'dupes');
      assert.strictEqual(json.duplicate, false);
      assert.deepStrictEqual(json.copies, []);
    });
  }

  async testDupesSymlinkCycleSafety() {
    await this.run('dupes does not hang on a symlink cycle in node_modules', async () => {
      const dir = this.tmp('dupes-symlink');
      writeNodeModulesPackage(dir, 'left-pad', { name: 'left-pad', version: '1.3.0' });
      writeNodeModulesPackage(path.join(dir, 'node_modules', 'some-dep'), 'left-pad', { name: 'left-pad', version: '1.1.2' });

      // Symlink some-dep's node_modules back to the root node_modules,
      // simulating a pnpm-style hoisting cycle.
      const cyclePath = path.join(dir, 'node_modules', 'some-dep', 'node_modules', 'cycle-back');
      fs.symlinkSync(path.join(dir, 'node_modules'), cyclePath, 'dir');

      const r = await runPackdev(dir, ['dupes', 'left-pad', '--json']);
      // Two real distinct copies -> exit 5 (DUPLICATE_FOUND), but the key
      // assertion here is that it terminated at all (no hang/crash on the cycle).
      assert.strictEqual(r.code, 5, `expected exit 5 (no hang/crash), got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'dupes');
      assert.strictEqual(json.copies.length, 2, 'should still find both real resolutions despite the cycle');
    });
  }

  async testDupesWorkspaceAware() {
    await this.run('dupes scans workspace-nested node_modules by default', async () => {
      const dir = this.tmp('dupes-workspaces');
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'root', workspaces: ['apps/*'] }),
      );
      fs.mkdirSync(path.join(dir, 'apps', 'a'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'apps', 'a', 'package.json'),
        JSON.stringify({ name: 'a', dependencies: { 'shared-lib': '^2.0.0' } }),
      );
      writeNodeModulesPackage(dir, 'shared-lib', { name: 'shared-lib', version: '1.0.0' });
      writeNodeModulesPackage(path.join(dir, 'apps', 'a'), 'shared-lib', { name: 'shared-lib', version: '2.0.0' });

      // Root-only scan used to report a false "single resolution" here —
      // the whole point of this test is that it no longer does.
      const r = await runPackdev(dir, ['dupes', 'shared-lib', '--json']);
      assert.strictEqual(r.code, 5, `expected exit 5, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'dupes');
      assert.strictEqual(json.duplicate, true);
      assert.strictEqual(json.copies.length, 2);
      assert.deepStrictEqual(json.scannedWorkspaces.length, 1);
      const versions = json.copies.map((res) => res.version).sort();
      assert.deepStrictEqual(versions, ['1.0.0', '2.0.0']);
    });
  }

  async testDupesNoWorkspacesFlagHedgesVerdict() {
    await this.run('dupes --no-workspaces skips workspace scan and hedges the verdict', async () => {
      const dir = this.tmp('dupes-no-workspaces');
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'root', workspaces: ['apps/*'] }),
      );
      fs.mkdirSync(path.join(dir, 'apps', 'a'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'apps', 'a', 'package.json'), JSON.stringify({ name: 'a' }));
      writeNodeModulesPackage(dir, 'shared-lib', { name: 'shared-lib', version: '1.0.0' });
      writeNodeModulesPackage(path.join(dir, 'apps', 'a'), 'shared-lib', { name: 'shared-lib', version: '2.0.0' });

      const r = await runPackdev(dir, ['dupes', 'shared-lib', '--no-workspaces', '--json']);
      assert.strictEqual(r.code, 0, `expected exit 0 (workspace copy not scanned), got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'dupes');
      assert.strictEqual(json.duplicate, false);
      assert.strictEqual(json.copies.length, 1);
      assert.strictEqual(json.workspacesDetected.length, 1);
      assert.strictEqual(json.scannedWorkspaces.length, 0);
    });
  }

  async testDupesSameVersionDifferentPathIsDuplicate() {
    await this.run('dupes treats same-version copies at different paths as a duplicate', async () => {
      const dir = this.tmp('dupes-same-version');
      writeNodeModulesPackage(dir, 'left-pad', { name: 'left-pad', version: '1.3.0' });
      writeNodeModulesPackage(path.join(dir, 'node_modules', 'some-dep'), 'left-pad', { name: 'left-pad', version: '1.3.0' });

      const r = await runPackdev(dir, ['dupes', 'left-pad', '--json']);
      assert.strictEqual(r.code, 5, `expected exit 5, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'dupes');
      assert.strictEqual(json.duplicate, true, 'same version at two different realpaths is still a duplicate');
      assert.strictEqual(json.copies.length, 2);
    });
  }

  async testDupesExplainsPrereleaseHoistingIssue() {
    await this.run('dupes explains the prerelease/hoisting mechanism when it can confirm the blocking range', async () => {
      const dir = this.tmp('dupes-prerelease-hoisting');
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'root', workspaces: ['apps/*'] }),
      );
      fs.mkdirSync(path.join(dir, 'apps', 'a'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'apps', 'b'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'apps', 'a', 'package.json'),
        JSON.stringify({ name: 'a', dependencies: { 'shared-lib': '1.0.199-abc123' } }),
      );
      fs.writeFileSync(
        path.join(dir, 'apps', 'b', 'package.json'),
        JSON.stringify({ name: 'b', dependencies: { 'shared-lib': '^1.0.195' } }),
      );
      writeNodeModulesPackage(dir, 'shared-lib', { name: 'shared-lib', version: '1.0.196' });
      writeNodeModulesPackage(path.join(dir, 'apps', 'a'), 'shared-lib', { name: 'shared-lib', version: '1.0.199-abc123' });
      writeNodeModulesPackage(path.join(dir, 'apps', 'b'), 'shared-lib', { name: 'shared-lib', version: '1.0.196' });

      const r = await runPackdev(dir, ['dupes', 'shared-lib', '--json']);
      assert.strictEqual(r.code, 5, `expected exit 5, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'dupes');
      assert.ok(json.prereleaseHoistingNote, 'expected a prereleaseHoistingNote to be present');
      assert.strictEqual(json.prereleaseHoistingNote.prereleaseVersion, '1.0.199-abc123');
      assert.deepStrictEqual(json.prereleaseHoistingNote.pinnedWorkspaces, ['apps/a']);
      assert.strictEqual(json.prereleaseHoistingNote.blockedRange, '^1.0.195');

      const human = await runPackdev(dir, ['dupes', 'shared-lib']);
      assert.match(human.stdout, /PRERELEASE \(1\.0\.199-abc123\)/);
      assert.match(human.stdout, /\^1\.0\.195/);
      assert.match(human.stdout, /NOT interchangeable/);
    });
  }

  async testDupesPrereleaseNoteCitesMajorityRangeAcrossHoistedWorkspaces() {
    await this.run('dupes cites the majority blocking range, including workspaces with no physical duplicate copy of their own', async () => {
      // Regression for a real bug: the first version of this feature only
      // scanned `resolutions` (workspaces with a PHYSICAL duplicate copy),
      // silently missing every hoisted workspace (no copy of its own,
      // resolves via the root) -- which is most of them in a real repo.
      // Reproduces the exact reported distribution: 30 workspaces on
      // ^1.0.195 (hoisted, no dupe), 4 pinning the prerelease (dupes), 1
      // outlier on ^1.0.198 (also hoisted, no dupe).
      const dir = this.tmp('dupes-prerelease-majority');
      fs.writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'root', workspaces: ['apps/*'] }),
      );
      writeNodeModulesPackage(dir, 'shared-lib', { name: 'shared-lib', version: '1.0.196' });

      for (let i = 0; i < 30; i++) {
        const wsDir = path.join(dir, 'apps', `a${i}`);
        fs.mkdirSync(wsDir, { recursive: true });
        fs.writeFileSync(path.join(wsDir, 'package.json'), JSON.stringify({ name: `a${i}`, dependencies: { 'shared-lib': '^1.0.195' } }));
      }
      for (let i = 0; i < 4; i++) {
        const wsDir = path.join(dir, 'apps', `pre${i}`);
        fs.mkdirSync(wsDir, { recursive: true });
        fs.writeFileSync(path.join(wsDir, 'package.json'), JSON.stringify({ name: `pre${i}`, dependencies: { 'shared-lib': '1.0.199-abc123' } }));
        writeNodeModulesPackage(wsDir, 'shared-lib', { name: 'shared-lib', version: '1.0.199-abc123' });
      }
      const outlierDir = path.join(dir, 'apps', 'outlier');
      fs.mkdirSync(outlierDir, { recursive: true });
      fs.writeFileSync(path.join(outlierDir, 'package.json'), JSON.stringify({ name: 'outlier', dependencies: { 'shared-lib': '^1.0.198' } }));

      const r = await runPackdev(dir, ['dupes', 'shared-lib', '--json']);
      assert.strictEqual(r.code, 5, `expected exit 5, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'dupes');
      const note = json.prereleaseHoistingNote;
      assert.ok(note, 'expected a prereleaseHoistingNote to be present');
      assert.strictEqual(note.blockedRange, '^1.0.195', 'must cite the majority range (30 workspaces), not the 1-workspace outlier');
      assert.strictEqual(note.blockedWorkspaces.length, 30);
      assert.strictEqual(note.totalBlockedWorkspaces, 31);
      assert.strictEqual(note.allBlockedRanges.length, 2);

      const human = await runPackdev(dir, ['dupes', 'shared-lib']);
      assert.match(human.stdout, /\^1\.0\.195/);
      assert.match(human.stdout, /31 workspaces/);
    });
  }

  async testDupesNoPrereleaseNoteWhenAllSameVersion() {
    await this.run('dupes omits prereleaseHoistingNote when there is no prerelease involved', async () => {
      const dir = this.tmp('dupes-no-prerelease-note');
      writeNodeModulesPackage(dir, 'left-pad', { name: 'left-pad', version: '1.3.0' });
      writeNodeModulesPackage(path.join(dir, 'node_modules', 'some-dep'), 'left-pad', { name: 'left-pad', version: '1.1.2' });

      const r = await runPackdev(dir, ['dupes', 'left-pad', '--json']);
      assert.strictEqual(r.code, 5);
      const json = parseJson(r.stdout, 'dupes');
      assert.strictEqual(json.prereleaseHoistingNote, null);
    });
  }

  async testDupesResolvedViaParent() {
    await this.run('dupes distinguishes resolved-via-parent from not-a-dependency', async () => {
      const dir = this.tmp('dupes-resolved-via-parent');
      writeNodeModulesPackage(dir, 'left-pad', { name: 'left-pad', version: '1.3.0' });
      const childDir = path.join(dir, 'child');
      fs.mkdirSync(childDir, { recursive: true });

      const r = await runPackdev(dir, ['dupes', 'left-pad', '--root', childDir, '--json']);
      assert.strictEqual(r.code, 0);
      const json = parseJson(r.stdout, 'dupes');
      assert.strictEqual(json.copies.length, 0);
      assert.ok(json.resolvedViaParent, 'should report the parent resolution instead of a bare empty result');
      assert.strictEqual(json.resolvedViaParent.version, '1.3.0');
    });
  }

  async testDupesGenuinelyNotADependency() {
    await this.run('dupes reports resolvedViaParent: null when the package is nowhere at all', async () => {
      const dir = this.tmp('dupes-genuinely-missing');
      fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });

      const r = await runPackdev(dir, ['dupes', 'totally-nonexistent-pkg-xyz', '--json']);
      assert.strictEqual(r.code, 0);
      const json = parseJson(r.stdout, 'dupes');
      assert.strictEqual(json.copies.length, 0);
      assert.strictEqual(json.resolvedViaParent, null);
    });
  }

  // --- mcp --------------------------------------------------------------

  async testMcpServerListsAllFourTools() {
    await this.run('mcp lists api_diff/compat/dupes/behavior_diff as MCP tools over stdio', async () => {
      const dir = this.tmp('mcp-list-tools');
      const client = createMcpClient(dir);
      try {
        await client.initialize();
        const listResponse = await client.listTools();
        assert.ok(!client.stderr.trim(), `expected no stderr output, got: ${client.stderr}`);
        const toolNames = listResponse.result.tools.map((t) => t.name).sort();
        assert.deepStrictEqual(toolNames, ['api_diff', 'behavior_diff', 'compat', 'dupes']);
      } finally {
        await client.close();
      }
    });
  }

  async testMcpDupesToolMatchesCliOutput() {
    await this.run('mcp dupes tool call returns exactly the same JSON as `packdev dupes --json`', async () => {
      const dir = this.tmp('mcp-call-dupes');
      writeJson(path.join(dir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: {} });
      writeNodeModulesPackage(dir, 'fake-lib', { name: 'fake-lib', version: '1.0.0', main: 'index.js' }, {
        'index.js': 'module.exports = {};',
      });

      const client = createMcpClient(dir);
      let payload;
      try {
        await client.initialize();
        const callResponse = await client.callTool('dupes', { package: 'fake-lib', root: dir });
        payload = JSON.parse(callResponse.result.content[0].text);
      } finally {
        await client.close();
      }

      const cli = await runPackdev(dir, ['dupes', 'fake-lib', '--root', dir, '--json']);
      assert.strictEqual(cli.code, 0, `expected exit 0, got ${cli.code}: ${cli.stderr}`);
      const cliJson = parseJson(cli.stdout, 'dupes');
      // Full deep-compare, not a handful of hand-picked fields — any field
      // the MCP tool's serialization drops or renames relative to the CLI's
      // own --json output must fail this test, not just the ones we thought
      // to check by name.
      assert.deepStrictEqual(payload, cliJson);
    });
  }

  async testMcpApiDiffToolMatchesCliOutput() {
    await this.run('mcp api_diff tool call returns exactly the same JSON as `packdev api-diff --json`', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js', types: 'index.d.ts' }),
        'index.js': 'module.exports = {};',
        'index.d.ts': 'export function formatDate(input: string): string;',
      });
      const registryUrl = await this.registry('fake-lib', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('mcp-call-api-diff');
      fs.writeFileSync(path.join(appDir, 'index.ts'), 'import { formatDate } from "fake-lib";\nformatDate("x");\n');

      const client = createMcpClient(appDir);
      let payload;
      try {
        await client.initialize();
        const callResponse = await client.callTool('api_diff', {
          package: 'fake-lib', range: '>=1.0.0 <2.0.0', app: appDir, registry: registryUrl,
        });
        payload = JSON.parse(callResponse.result.content[0].text);
      } finally {
        await client.close();
      }

      const cli = await runPackdev(appDir, [
        'api-diff', 'fake-lib', '--range', '>=1.0.0 <2.0.0', '--app', appDir, '--registry', registryUrl, '--json',
      ]);
      assert.strictEqual(cli.code, 0, `expected exit 0, got ${cli.code}: ${cli.stderr}`);
      const cliJson = parseJson(cli.stdout, 'api-diff');
      assert.deepStrictEqual(payload, cliJson);
      assert.strictEqual(payload.versions[0].apiCompatible, true);
    });
  }

  async testMcpApiDiffToolReturnsIsErrorOnFailure() {
    await this.run('mcp api_diff tool call returns isError:true (not a thrown transport error) on failure', async () => {
      const appDir = this.tmp('mcp-call-api-diff-error');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: {} });

      const client = createMcpClient(appDir);
      try {
        await client.initialize();
        // No registry reachable at all — fetchPackageMetadata must throw,
        // which the tool handler should turn into an isError result rather
        // than letting the JSON-RPC call itself fail.
        const callResponse = await client.callTool('api_diff', {
          package: 'fake-lib', range: '>=1.0.0', app: appDir, registry: 'http://127.0.0.1:1',
        });
        assert.strictEqual(callResponse.result.isError, true);
        const payload = JSON.parse(callResponse.result.content[0].text);
        assert.strictEqual(payload.success, false);
        assert.ok(payload.error, 'expected an error message');
      } finally {
        await client.close();
      }
    });
  }

  async testMcpCompatToolMatchesCliOutput() {
    await this.run('mcp compat tool call returns exactly the same JSON as `packdev compat --json`, including new options', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const registryUrl = await this.registry('fake-lib', { '1.0.0': { tarballBuffer: v1 } });

      const appDir = this.tmp('mcp-call-compat');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });
      fs.writeFileSync(path.join(appDir, 'check.js'), 'process.exit(0);\n');
      // Shared explicit snapshotDir so both invocations resolve to the same
      // path — otherwise each independently mkdtemps its own, which would
      // fail a deep-equal comparison for a reason that has nothing to do
      // with whether the two tools actually agree.
      const snapshotDir = path.join(appDir, 'snapshots');

      const client = createMcpClient(appDir);
      let payload;
      try {
        await client.initialize();
        const callResponse = await client.callTool('compat', {
          package: 'fake-lib', versions: ['1.0.0'], app: appDir, registry: registryUrl,
          test: 'node check.js', checkDupes: true, snapshotDir,
        });
        payload = JSON.parse(callResponse.result.content[0].text);
      } finally {
        await client.close();
      }

      const cli = await runPackdev(appDir, [
        'compat', 'fake-lib', '--versions', '1.0.0', '--app', appDir, '--registry', registryUrl,
        '--test', 'node check.js', '--check-dupes', '--snapshot-dir', snapshotDir, '--json',
      ]);
      assert.strictEqual(cli.code, 0, `expected exit 0, got ${cli.code}: ${cli.stderr}`);
      const cliJson = parseJson(cli.stdout, 'compat');
      // durationMs is real elapsed time from two separate sandboxed runs —
      // never equal, and not part of the "shape" this test is guarding.
      assert.deepStrictEqual(stripDurations(payload), stripDurations(cliJson));
      assert.strictEqual(payload.versions[0].status, 'PASSED');
      assert.ok(payload.versions[0].dupeCounts, 'expected checkDupes to have been forwarded to compat');
    });
  }

  async testMcpCompatToolSupportsRangeAndBisect() {
    await this.run('mcp compat tool supports `range` (not just explicit `versions`) and `bisect`', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const v2 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '2.0.0', main: 'index.js' }),
        'index.js': 'module.exports = {};',
      });
      const registryUrl = await this.registry('fake-lib', {
        '1.0.0': { tarballBuffer: v1 },
        '2.0.0': { tarballBuffer: v2 },
      });

      const appDir = this.tmp('mcp-call-compat-range-bisect');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });
      fs.writeFileSync(path.join(appDir, 'check.js'), 'process.exit(0);\n');

      const client = createMcpClient(appDir);
      try {
        await client.initialize();
        const callResponse = await client.callTool('compat', {
          package: 'fake-lib', range: '>=1.0.0 <3.0.0', app: appDir, registry: registryUrl,
          test: 'node check.js', bisect: true,
        });
        const payload = JSON.parse(callResponse.result.content[0].text);
        assert.strictEqual(payload.bisected, true, 'expected bisect:true to select runCompatBisect');
        assert.strictEqual(payload.recommendedVersion, '2.0.0');
      } finally {
        await client.close();
      }
    });
  }

  async testMcpCompatToolRejectsMissingRangeAndVersions() {
    await this.run('mcp compat tool errors clearly when neither range nor versions is given', async () => {
      const appDir = this.tmp('mcp-call-compat-no-range-no-versions');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '^1.0.0' } });

      const client = createMcpClient(appDir);
      try {
        await client.initialize();
        const callResponse = await client.callTool('compat', {
          package: 'fake-lib', app: appDir, registry: 'http://127.0.0.1:1', test: 'node -e "process.exit(0)"',
        });
        assert.strictEqual(callResponse.result.isError, true);
        const payload = JSON.parse(callResponse.result.content[0].text);
        assert.match(payload.error, /Either `range` or `versions` must be provided/);
      } finally {
        await client.close();
      }
    });
  }

  async testMcpBehaviorDiffToolMatchesCliOutput() {
    await this.run('mcp behavior_diff tool call returns exactly the same JSON as `packdev behavior-diff --experimental --json`', async () => {
      const v1 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '1.0.0', main: 'index.js' }),
        'index.js': 'function greet() { return "hi"; }\nmodule.exports = { greet };\n',
      });
      const v2 = await buildFakeTarball({
        'package.json': JSON.stringify({ name: 'fake-lib', version: '2.0.0', main: 'index.js' }),
        'index.js': 'function greet() { return "hello"; }\nmodule.exports = { greet };\n',
      });
      const registryUrl = await this.registry('fake-lib', {
        '1.0.0': { tarballBuffer: v1 }, '2.0.0': { tarballBuffer: v2 },
      });

      const appDir = this.tmp('mcp-call-behavior-diff');
      writeJson(path.join(appDir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { 'fake-lib': '1.0.0' } });
      writeNodeModulesPackage(
        appDir, 'fake-lib', { name: 'fake-lib', version: '1.0.0', main: 'index.js' },
        { 'index.js': 'function greet() { return "hi"; }\nmodule.exports = { greet };\n' },
      );
      fs.writeFileSync(path.join(appDir, 'app.js'), "const { greet } = require('fake-lib');\ngreet();\n");

      const client = createMcpClient(appDir);
      let payload;
      try {
        await client.initialize();
        const callResponse = await client.callTool('behavior_diff', {
          package: 'fake-lib', to: '2.0.0', app: appDir, registry: registryUrl,
        });
        payload = JSON.parse(callResponse.result.content[0].text);
      } finally {
        await client.close();
      }

      const cli = await runPackdev(appDir, [
        'behavior-diff', 'fake-lib', '--to', '2.0.0', '--app', appDir,
        '--registry', registryUrl, '--experimental', '--json',
      ]);
      assert.strictEqual(cli.code, 0, `expected exit 0, got ${cli.code}: ${cli.stderr}`);
      const cliJson = parseJson(cli.stdout, 'behavior-diff');
      assert.deepStrictEqual(payload, cliJson);
      assert.ok(payload.changes.some((c) => c.name === 'greet'), JSON.stringify(payload.changes));
    });
  }

  // --- git dependencies -----------------------------------------------------

  async testGitFileUrlClassified() {
    await this.run('add classifies a git+file URL as a git dependency', async () => {
      const dir = this.tmp('gitfile');
      writeJson(path.join(dir, 'package.json'), { name: 'app', version: '1.0.0', dependencies: { gitlib: '^1.0.0' } });
      writeJson(path.join(dir, 'package-lock.json'), { name: 'app', lockfileVersion: 2 });
      await runPackdev(dir, ['create-config']);
      const url = 'git+file:///tmp/does-not-need-to-exist/remote.git';
      const add = await runPackdev(dir, ['add', 'gitlib', url, '--original-version', '^1.0.0', '--no-install', '--json']);
      const addJson = parseJson(add.stdout, 'add');
      assert.strictEqual(addJson.success, true, `add failed: ${addJson.error}`);
      const list = parseJson((await runPackdev(dir, ['list', '--json'])).stdout, 'list');
      const dep = list.dependencies.find((d) => d.package === 'gitlib');
      assert.ok(dep, 'gitlib should be tracked');
      assert.strictEqual(dep.type, 'git', 'git+file URL must be classified as git, not a local path');
      assert.strictEqual(dep.location, url);
    });
  }

  // --- remove ---------------------------------------------------------------

  async testRemoveDependency() {
    await this.run('remove drops a tracked dependency', async () => {
      const dir = this.tmp('remove');
      fs.mkdirSync(path.join(dir, 'lib'));
      writeJson(path.join(dir, 'lib/package.json'), { name: 'lib', version: '1.0.0' });
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: { lib: '^1.0.0' } });
      writeJson(path.join(dir, 'package-lock.json'), { name: 'h', lockfileVersion: 2 });
      await runPackdev(dir, ['create-config']);
      await runPackdev(dir, ['add', 'lib', './lib', '--no-install']);
      const r = await runPackdev(dir, ['remove', 'lib', '--json']);
      assert.strictEqual(r.code, 0);
      assert.strictEqual(parseJson(r.stdout, 'remove').success, true);
      const list = parseJson((await runPackdev(dir, ['list', '--json'])).stdout, 'list');
      assert.strictEqual(list.dependencies.length, 0, 'dependency should be gone after remove');
    });
  }

  async testRemoveNonexistent() {
    await this.run('remove reports a clear error for an unknown dependency', async () => {
      const dir = this.tmp('remove-missing');
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: {} });
      writeJson(path.join(dir, 'package-lock.json'), { name: 'h', lockfileVersion: 2 });
      await runPackdev(dir, ['create-config']);
      const r = await runPackdev(dir, ['remove', 'ghost', '--json']);
      assert.notStrictEqual(r.code, 0, 'should exit non-zero');
      const json = parseJson(r.stdout, 'remove');
      assert.strictEqual(json.success, false);
      assert.match(json.error, /not found/i);
    });
  }

  // --- watch ----------------------------------------------------------------

  async testWatchBuildFailed() {
    await this.run('watch --once reports build-failed when a build errors', async () => {
      const dir = this.tmp('watch-fail');
      fs.mkdirSync(path.join(dir, 'lib'));
      writeJson(path.join(dir, 'lib/package.json'), {
        name: 'lib', version: '1.0.0', scripts: { build: 'node -e "process.exit(1)"' },
      });
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: { lib: '^1.0.0' } });
      writeJson(path.join(dir, 'package-lock.json'), { name: 'h', lockfileVersion: 2 });
      await runPackdev(dir, ['create-config']);
      await runPackdev(dir, ['add', 'lib', './lib', '--no-install']);
      const r = await runPackdev(dir, ['watch', '--once', '--json']);
      const events = r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      assert.ok(events.some((e) => e.event === 'build-failed'), 'should emit a build-failed event');
      assert.ok(!events.some((e) => e.event === 'build-success'), 'must not report success for a failing build');
    });
  }

  async testWatchOnce() {
    await this.run('watch --once builds each target once and exits', async () => {
      const dir = this.tmp('watch-once');
      fs.mkdirSync(path.join(dir, 'lib'));
      writeJson(path.join(dir, 'lib/package.json'), { name: 'lib', version: '1.0.0', scripts: { build: BUILD_SCRIPT } });
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: { lib: '^1.0.0' } });
      writeJson(path.join(dir, 'package-lock.json'), { name: 'h', lockfileVersion: 2 });
      await runPackdev(dir, ['create-config']);
      await runPackdev(dir, ['add', 'lib', './lib', '--no-install']);
      const r = await runPackdev(dir, ['watch', '--once', '--json']);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}`);
      const events = r.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      assert.ok(events.some((e) => e.event === 'build-success'), 'should report a build-success event');
      assert.ok(fs.existsSync(path.join(dir, 'lib', MARKER)), 'build script should have produced its marker');
    });
  }

  // --- restore / backup -----------------------------------------------------

  async testRestoreNoBackup() {
    await this.run('restore is a safe no-op when no backup exists', async () => {
      const dir = this.tmp('restore-none');
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: {} });
      const r = await runPackdev(dir, ['restore', '--json']);
      assert.strictEqual(r.code, 0);
      const json = parseJson(r.stdout, 'restore');
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.restored, false);
    });
  }

  async testRestoreRecoversAndClears() {
    await this.run('restore recovers package.json and clears the backup', async () => {
      const dir = this.tmp('restore-recover');
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: { lib: 'file:./lib' } });
      writeJson(path.join(dir, '.packdev.backup.json'), {
        timestamp: '2026-01-01T00:00:00Z',
        packageJson: { name: 'h', version: '1.0.0', dependencies: { lib: '^1.0.0' } },
      });
      const r = await runPackdev(dir, ['restore', '--json']);
      const json = parseJson(r.stdout, 'restore');
      assert.strictEqual(json.success, true);
      assert.strictEqual(json.restored, true);
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      assert.strictEqual(pkg.dependencies.lib, '^1.0.0', 'original version restored');
      assert.ok(!fs.existsSync(path.join(dir, '.packdev.backup.json')), 'backup cleared after restore');
    });
  }

  async testSetupHooksBakesAbsoluteBinaryPath() {
    await this.run('setup-hooks bakes an absolute path to the running packdev binary into the generated hook, not a cwd-relative guess', async () => {
      const dir = this.tmp('setup-hooks-absolute-path');
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: {} });
      const { execSync } = require('child_process');
      execSync('git init', { cwd: dir, stdio: 'pipe' });
      execSync('git config user.email "t@t.com" && git config user.name "t"', { cwd: dir, stdio: 'pipe' });

      const r = await runPackdev(dir, ['setup-hooks', '--force', '--json']);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);

      const hookScript = fs.readFileSync(path.join(dir, '.git', 'hooks', 'check-local-deps.js'), 'utf8');
      // The old bug: a hardcoded, cwd-relative guess that only happened to
      // resolve correctly for one specific test-runner directory depth.
      assert.doesNotMatch(hookScript, /'node \.\.\/dist\/index\.js'/);
      // The fix: the exact absolute path of the packdev binary that
      // generated this hook, valid regardless of the hook's cwd at commit
      // time.
      assert.match(hookScript, new RegExp(`node "${BINARY_PATH.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
    });
  }

  async testStaleBackupDetected() {
    await this.run('status flags a stale backup (backup present, not in dev mode)', async () => {
      const dir = this.tmp('stale');
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: {} });
      writeJson(path.join(dir, '.packdev.backup.json'), { timestamp: 'x', packageJson: {} });
      const r = await runPackdev(dir, ['status', '--json']);
      const json = parseJson(r.stdout, 'status');
      assert.strictEqual(json.hasStaleBackup, true);
    });
  }

  async testCleanInitNoStaleWarning() {
    // Regression: init keeps a backup as the restore escape hatch while in dev
    // mode. That backup must NOT be reported as "stale" during normal dev work.
    await this.run('clean init does not raise a false stale-backup warning', async () => {
      const dir = this.tmp('nostale');
      fs.mkdirSync(path.join(dir, 'lib'));
      writeJson(path.join(dir, 'lib/package.json'), { name: 'lib', version: '1.0.0' });
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: { lib: '^1.0.0' } });
      writeJson(path.join(dir, 'package-lock.json'), { name: 'h', lockfileVersion: 2 });
      await runPackdev(dir, ['create-config']);
      await runPackdev(dir, ['add', 'lib', './lib', '--no-install']);
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: { lib: '^1.0.0' } });
      await runPackdev(dir, ['init', '--no-install']);
      // Backup should exist (escape hatch) but not be flagged stale in dev mode.
      assert.ok(fs.existsSync(path.join(dir, '.packdev.backup.json')), 'init should leave a backup');
      const json = parseJson((await runPackdev(dir, ['status', '--json'])).stdout, 'status');
      assert.strictEqual(json.isInDevMode, true, 'should be in dev mode after init');
      assert.strictEqual(json.hasStaleBackup, false, 'backup in dev mode must not be flagged stale');
      assert.strictEqual(json.isValid, true, 'a normal dev session must stay valid');
    });
  }

  async runAll() {
    log('🚀 PackDev Feature Tests', 'cyan');
    log('=========================', 'cyan');
    try {
      await this.testExitCodeConfigNotFound();
      await this.testExitCodePackageJsonNotFound();
      await this.testExitCodeSuccess();
      await this.testJsonShape();
      await this.testJsonStdoutPurityDuringInstall();
      await this.testDryRunNoWrites();
      await this.testNoInstallSkipsInstall();
      await this.testInitIdempotent();
      await this.testLinkFromWorkspaceChild();
      await this.testLinkNoMatch();
      await this.testApiHumanOutput();
      await this.testApiJsonShape();
      await this.testApiExportsMapResolution();
      await this.testApiResolvesExportEqualsAsDefault();
      await this.testApiIncludesSubpathExports();
      await this.testApiNoTypesAvailable();
      await this.testApiFallsBackToRawHintsOnUnresolvableBarrelExport();
      await this.testApiIntrospectFindsPrototypeMethods();
      await this.testApiIntrospectWorksThroughProxy();
      await this.testApiIntrospectIsOptInOnly();
      await this.testApiIntrospectTimesOutSafely();
      await this.testApiPackageNotInstalled();
      await this.testApiHoistedResolution();
      await this.testApiDiffRangeEnumerationAndDiff();
      await this.testApiDiffMissingSymbolsAreSortedAlphabetically();
      await this.testApiDiffDoesNotFalseNegativeOnExportEquals();
      await this.testApiDiffExcludesPrereleaseByDefault();
      await this.testApiDiffExcludesDeprecatedByDefault();
      await this.testApiDiffVsCompatDivergeOnBehaviorChange();
      await this.testApiDiffFlagsDynamicUsage();
      await this.testApiDiffNoUsageMeansEveryVersionCompatible();
      await this.testApiDiffCleansUpTempDirs();
      await this.testApiDiffNeverInstallsAnything();
      await this.testApiDiffFallsBackToTypesPackage();
      await this.testApiDiffTypesSourceNoneWhenNoTypesAnywhere();
      await this.testApiDiffCountsSubpathExportsAsUsage();
      await this.testApiDiffReportsUnresolvedNotMissingOnBarrelExport();
      await this.testApiDiffStillReportsGenuineMissingSymbols();
      await this.testApiDiffInfersDefaultEntryWhenManifestHasNoEntryFields();
      await this.testApiDiffFollowsBarrelNamedReexports();
      await this.testApiDiffBarrelPartialFailureOnlyFlagsGenuineMissing();
      await this.testApiDiffCrossPackageReexportUnknownNotMissing();
      await this.testApiDiffCrossPackageReexportResolvesWhenSiblingBundled();
      await this.testApiDiffFollowsUnresolvableReexportThroughALocalBarrel();
      await this.testApiDiffFollowsUnresolvableReexportInASubpath();
      await this.testApiDiffReexportExtensionSubstitutionMatchesTsResolution();
      await this.testApiDiffBareSpecifierSubpathReexportResolvesAgainstThePackageNotAPath();
      await this.testApiDiffExportsConditionMapWithNoDotKey();
      await this.testApiSubpathOnlyExportsDoesNotDuplicateAsRootTypes();
      await this.testApiSubpathOnlyExportsIgnoresIncidentalRootIndexDts();
      await this.testApiDiffDefaultImportSatisfiedByInteropFlags();
      await this.testApiDiffDefaultMissingSurvivesWithoutInteropFlags();
      await this.testApiDiffTypesPackageMajorMismatchDowngradesFalseToUnknown();
      await this.testApiDiffEsmOnlyAdvisoryFiresWhenCandidateAddsTypeModule();
      await this.testApiDiffEsmOnlyAdvisoryFiresWhenCandidateDropsCjsExportCondition();
      await this.testApiDiffNoEsmAdvisoryWhenCjsConditionSurvives();
      await this.testApiDiffNoFalseAlarmOnEsmOnlyDependencyWithInteropSafeDefault();
      await this.testApiDiffFailsWithHintOnPrivateRegistryWithoutToken();
      await this.testApiDiffAuthenticatesWithTokenFlag();
      await this.testApiDiffAuthenticatesWithNpmTokenEnv();
      await this.testApiDiffAutoDetectsRegistryAndTokenFromNpmrc();
      await this.testCompatPassFailPerVersion();
      await this.testCompatControlGateSuppressesRecommendationWhenInstalledVersionFails();
      await this.testCompatControlGateStaysQuietWhenInstalledVersionPasses();
      await this.testCompatControlInstallFailedGetsInstallDiagnosticsNotHarnessHint();
      await this.testCompatCheckDupesFlagsARegressionAndFailsAPassingVersion();
      await this.testCompatRejectsBisectWithCheckDupes();
      await this.testCompatWithoutCheckDupesFlagDoesNotComputeDupeCounts();
      await this.testCompatSeedLockfileCopiesLockfileIntoSandbox();
      await this.testCompatSeedLockfileReportFields();
      await this.testCompatSeedLockfileFalseWhenRequestedButNoLockfilePresent();
      await this.testCompatReportsHermeticModeAndDetectedPackageManager();
      await this.testCompatHonoursPackageManagerFieldPin();
      await this.testCompatAncestorPackageManagerFieldBeatsACloserLockfile();
      await this.testCompatPackageManagerCliOverrideWins();
      await this.testCompatPackageManagerPinIsWrittenIntoTheSandbox();
      await this.testCompatModeWorkspaceErrorsWithoutAMonorepoRoot();
      await this.testCompatModeRejectsInvalidValue();
      await this.testCompatDistinguishesInstallFailure();
      await this.testCompatSkipsAppsWithWorkspaceProtocolDeps();
      await this.testCompatAttemptsRealInstallWhenMonorepoRootFound();
      await this.testCompatFanOutCatchesABreakOnlyAConsumerHits();
      await this.testCompatExplicitAppCommaListTestsExtraConsumers();
      await this.testCompatGlobAppSelectsPrimaryDeterministically();
      await this.testCompatFanOutRequiresDiscoverableMonorepoRoot();
      await this.testCompatRejectsExplicitAppListCombinedWithFanOut();
      await this.testCompatFanOutRejectsConsumerOutsideMonorepoRoot();
      await this.testCompatNothingTestedExitCodeAndMessage();
      await this.testCompatExitsNonZeroOnFailure();
      await this.testCompatWarnsOnTranspileOnlyTestSetup();
      await this.testCompatWarnsOnPassWithNoTests();
      await this.testCompatTestScriptOnlyRunsStillGetHarnessAnalysis();
      await this.testCompatWarnsOnTypeCheckOnlyTestCommand();
      await this.testCompatWarnsOnEsmMismatchAgainstCjsBlindJest();
      await this.testCompatCleansUpSandboxOnSuccess();
      await this.testCompatCleansUpSandboxOnSigint();
      await this.testCompatDoesNotMutateRealApp();
      await this.testCompatCapturesLockfileSnapshot();
      await this.testCompatSnapshotRevealsTransitiveDrift();
      await this.testCompatConcurrencyOverlapsInstalls();
      await this.testCompatPreferOfflineDoesNotBreakNormalRun();
      await this.testCompatGroupWithoutFlagSurfacesMismatch();
      await this.testCompatGroupMovesFamilyTogether();
      await this.testCompatGroupErrorsOnUndeclaredMember();
      await this.testCompatUndeclaredPackageNamesSiblingWorkspacesThatDeclareIt();
      await this.testCompatGroupComposesWithBisect();
      await this.testCompatBisectFindsBoundaryInFewerRuns();
      await this.testCompatBisectEverythingPasses();
      await this.testCompatBisectNothingPasses();
      await this.testCompatBisectFallsBackOnFlakyBoundary();
      await this.testBehaviorDiffRequiresExperimentalFlag();
      await this.testBehaviorDiffDegradesOnDynamicOnlyUsageWithNoSeeds();
      await this.testBehaviorDiffSurfacesDynamicUsageCaveatAlongsideRealResults();
      await this.testBehaviorDiffFindsTheReachableSemanticChange();
      await this.testBehaviorDiffSeedsOptionKeysThroughDefaultAndAliasedImports();
      await this.testBehaviorDiffFollowsOneMoreHopThroughACaller();
      await this.testBehaviorDiffIgnoresUnreachableChanges();
      await this.testBehaviorDiffWalksExtensionlessAndDirectoryRequires();
      await this.testBehaviorDiffReadsFromInstalledDirNotRegistry();
      await this.testBehaviorDiffPrefersExportsMapOverMainField();
      await this.testBehaviorDiffReportsNativeBinaryAsDegraded();
      await this.testDupesFindsDuplicate();
      await this.testDupesSingleResolution();
      await this.testDupesNotInstalled();
      await this.testDupesSymlinkCycleSafety();
      await this.testDupesWorkspaceAware();
      await this.testDupesNoWorkspacesFlagHedgesVerdict();
      await this.testDupesSameVersionDifferentPathIsDuplicate();
      await this.testDupesExplainsPrereleaseHoistingIssue();
      await this.testDupesPrereleaseNoteCitesMajorityRangeAcrossHoistedWorkspaces();
      await this.testDupesNoPrereleaseNoteWhenAllSameVersion();
      await this.testDupesResolvedViaParent();
      await this.testDupesGenuinelyNotADependency();
      await this.testMcpServerListsAllFourTools();
      await this.testMcpDupesToolMatchesCliOutput();
      await this.testMcpApiDiffToolMatchesCliOutput();
      await this.testMcpApiDiffToolReturnsIsErrorOnFailure();
      await this.testMcpCompatToolMatchesCliOutput();
      await this.testMcpCompatToolSupportsRangeAndBisect();
      await this.testMcpCompatToolRejectsMissingRangeAndVersions();
      await this.testMcpBehaviorDiffToolMatchesCliOutput();
      await this.testGitFileUrlClassified();
      await this.testRemoveDependency();
      await this.testRemoveNonexistent();
      await this.testWatchBuildFailed();
      await this.testWatchOnce();
      await this.testRestoreNoBackup();
      await this.testRestoreRecoversAndClears();
      await this.testSetupHooksBakesAbsoluteBinaryPath();
      await this.testStaleBackupDetected();
      await this.testCleanInitNoStaleWarning();

      log(`\n🎉 Feature tests complete: ${this.passed}/${this.total}`, 'green');
    } catch (error) {
      log(`\n💥 Feature tests failed: ${this.passed}/${this.total}`, 'red');
      throw error;
    } finally {
      for (const dir of this.dirs) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      }
      for (const server of this.servers) {
        try {
          server.close();
        } catch {
          // ignore cleanup errors
        }
      }
    }
  }
}

async function main() {
  const tests = new FeatureTests();
  try {
    await tests.runAll();
    process.exit(0);
  } catch {
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
}

module.exports = { FeatureTests };

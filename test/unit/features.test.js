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
function runPackdev(cwd, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [BINARY_PATH, ...args], { stdio: 'pipe', cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', reject);
  });
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
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'compat');
      const v1Result = json.versions.find((v) => v.version === '1.0.0');
      const v2Result = json.versions.find((v) => v.version === '2.0.0');
      assert.strictEqual(v1Result.status, 'FAILED');
      assert.strictEqual(v2Result.status, 'PASSED');
      assert.strictEqual(json.recommendedVersion, '2.0.0');
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
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'compat');
      assert.strictEqual(json.versions[0].status, 'INSTALL_FAILED');
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
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
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

  // --- dupes (duplicate package instances in the tree) ----------------------

  async testDupesFindsDuplicate() {
    await this.run('dupes finds a package resolved at two different depths', async () => {
      const dir = this.tmp('dupes-duplicate');
      writeNodeModulesPackage(dir, 'left-pad', { name: 'left-pad', version: '1.3.0' });
      writeNodeModulesPackage(path.join(dir, 'node_modules', 'some-dep'), 'left-pad', { name: 'left-pad', version: '1.1.2' });

      const r = await runPackdev(dir, ['dupes', 'left-pad', '--json']);
      assert.strictEqual(r.code, 0, `expected exit 0, got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'dupes');
      assert.strictEqual(json.duplicate, true);
      assert.strictEqual(json.resolutions.length, 2);
      const versions = json.resolutions.map((res) => res.version).sort();
      assert.deepStrictEqual(versions, ['1.1.2', '1.3.0']);
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
      assert.strictEqual(json.resolutions.length, 1);
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
      assert.deepStrictEqual(json.resolutions, []);
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
      assert.strictEqual(r.code, 0, `expected exit 0 (no hang/crash), got ${r.code}: ${r.stderr}`);
      const json = parseJson(r.stdout, 'dupes');
      assert.strictEqual(json.resolutions.length, 2, 'should still find both real resolutions despite the cycle');
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
      await this.testApiIncludesSubpathExports();
      await this.testApiNoTypesAvailable();
      await this.testApiPackageNotInstalled();
      await this.testApiHoistedResolution();
      await this.testApiDiffRangeEnumerationAndDiff();
      await this.testApiDiffExcludesPrereleaseByDefault();
      await this.testApiDiffExcludesDeprecatedByDefault();
      await this.testApiDiffVsCompatDivergeOnBehaviorChange();
      await this.testApiDiffFlagsDynamicUsage();
      await this.testApiDiffNoUsageMeansEveryVersionCompatible();
      await this.testApiDiffCleansUpTempDirs();
      await this.testApiDiffFallsBackToTypesPackage();
      await this.testApiDiffTypesSourceNoneWhenNoTypesAnywhere();
      await this.testApiDiffCountsSubpathExportsAsUsage();
      await this.testCompatPassFailPerVersion();
      await this.testCompatDistinguishesInstallFailure();
      await this.testCompatCleansUpSandboxOnSuccess();
      await this.testCompatCleansUpSandboxOnSigint();
      await this.testCompatDoesNotMutateRealApp();
      await this.testCompatGroupWithoutFlagSurfacesMismatch();
      await this.testCompatGroupMovesFamilyTogether();
      await this.testCompatGroupErrorsOnUndeclaredMember();
      await this.testCompatGroupComposesWithBisect();
      await this.testCompatBisectFindsBoundaryInFewerRuns();
      await this.testCompatBisectEverythingPasses();
      await this.testCompatBisectNothingPasses();
      await this.testCompatBisectFallsBackOnFlakyBoundary();
      await this.testDupesFindsDuplicate();
      await this.testDupesSingleResolution();
      await this.testDupesNotInstalled();
      await this.testDupesSymlinkCycleSafety();
      await this.testGitFileUrlClassified();
      await this.testRemoveDependency();
      await this.testRemoveNonexistent();
      await this.testWatchBuildFailed();
      await this.testWatchOnce();
      await this.testRestoreNoBackup();
      await this.testRestoreRecoversAndClears();
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

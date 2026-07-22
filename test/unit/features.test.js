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
const { spawn } = require('child_process');

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
  }

  tmp(prefix) {
    const dir = makeTmpDir(prefix);
    this.dirs.push(dir);
    return dir;
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

  // --- watch ----------------------------------------------------------------

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
    await this.run('status flags a stale backup', async () => {
      const dir = this.tmp('stale');
      writeJson(path.join(dir, 'package.json'), { name: 'h', version: '1.0.0', dependencies: {} });
      writeJson(path.join(dir, '.packdev.backup.json'), { timestamp: 'x', packageJson: {} });
      const r = await runPackdev(dir, ['status', '--json']);
      const json = parseJson(r.stdout, 'status');
      assert.strictEqual(json.hasStaleBackup, true);
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
      await this.testGitFileUrlClassified();
      await this.testWatchOnce();
      await this.testRestoreNoBackup();
      await this.testRestoreRecoversAndClears();
      await this.testStaleBackupDetected();

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

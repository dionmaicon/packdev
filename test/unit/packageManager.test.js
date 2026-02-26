#!/usr/bin/env node

/**
 * Unit Tests for Package Manager Functionality
 *
 * This file tests the new package manager detection, auto-install functionality,
 * and enhanced add command that updates package.json.
 */

const assert = require('assert');
const fs = require('fs/promises');
const path = require('path');
const { execSync, spawn } = require('child_process');

// Test configuration
const TEST_DIR = path.join(__dirname, 'test-workspace');
const ORIGINAL_CWD = process.cwd();

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function colorize(text, color) {
  return `${colors[color]}${text}${colors.reset}`;
}

function log(message, color = 'reset') {
  console.log(colorize(message, color));
}

// Test utilities
async function createTestDirectory() {
  try {
    await fs.mkdir(TEST_DIR, { recursive: true });
    process.chdir(TEST_DIR);
  } catch (error) {
    throw new Error(`Failed to create test directory: ${error.message}`);
  }
}

async function cleanupTestDirectory() {
  try {
    process.chdir(ORIGINAL_CWD);
    await fs.rm(TEST_DIR, { recursive: true, force: true });
  } catch (error) {
    // Ignore cleanup errors
  }
}

async function createPackageJson(dependencies = {}, devDependencies = {}) {
  const packageJson = {
    name: "test-package",
    version: "1.0.0",
    dependencies,
    devDependencies
  };
  await fs.writeFile('package.json', JSON.stringify(packageJson, null, 2));
}

async function createLockFile(type) {
  const lockFiles = {
    npm: 'package-lock.json',
    yarn: 'yarn.lock',
    pnpm: 'pnpm-lock.yaml'
  };

  const filename = lockFiles[type];
  if (!filename) throw new Error(`Unknown lock file type: ${type}`);

  const content = type === 'npm'
    ? JSON.stringify({ name: "test-package", lockfileVersion: 2 }, null, 2)
    : `# ${type} lock file`;

  await fs.writeFile(filename, content);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Import the functions we need to test
// Since these are internal functions, we'll test them through the public API
const BINARY_PATH = path.join(__dirname, '../../dist/index.js');

async function runPackdevCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    const fullCommand = [BINARY_PATH, command, ...args];
    const child = spawn('node', fullCommand, {
      stdio: 'pipe',
      cwd: TEST_DIR
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });

    child.on('error', reject);
  });
}

// Test suite
class PackageManagerTests {
  constructor() {
    this.testsPassed = 0;
    this.totalTests = 0;
  }

  async runTest(testName, testFn) {
    this.totalTests++;
    try {
      log(`🧪 Running: ${testName}`, 'blue');
      await testFn();
      this.testsPassed++;
      log(`✅ Passed: ${testName}`, 'green');
    } catch (error) {
      log(`❌ Failed: ${testName}`, 'red');
      log(`   Error: ${error.message}`, 'red');
      throw error;
    }
  }

  async testPackageManagerDetection() {
    await this.runTest('Package Manager Detection - NPM', async () => {
      await createLockFile('npm');
      const result = await runPackdevCommand('create-config');
      assert(result.code === 0, 'Should create config successfully');

      // Clean up for next test
      await fs.unlink('package-lock.json');
    });

    await this.runTest('Package Manager Detection - Yarn', async () => {
      await createLockFile('yarn');
      const result = await runPackdevCommand('create-config');
      assert(result.code === 0, 'Should create config successfully');

      // Clean up for next test
      await fs.unlink('yarn.lock');
    });

    await this.runTest('Package Manager Detection - PNPM', async () => {
      await createLockFile('pnpm');
      const result = await runPackdevCommand('create-config');
      assert(result.code === 0, 'Should create config successfully');

      // Clean up for next test
      await fs.unlink('pnpm-lock.yaml');
    });
  }

  async testAddCommandUpdatesPackageJson() {
    await this.runTest('Add command updates package.json', async () => {
      // Setup
      await createPackageJson({ 'test-package': '^1.0.0' });
      await createLockFile('npm');

      // Create a fake local package directory
      await fs.mkdir('local-package', { recursive: true });
      await fs.writeFile('local-package/package.json', JSON.stringify({
        name: 'test-package',
        version: '1.0.0'
      }, null, 2));

      // Create config
      await runPackdevCommand('create-config');

      // Add local dependency with --no-install to avoid running npm install
      const result = await runPackdevCommand('add', [
        'test-package',
        './local-package',
        '--no-install'
      ]);

      assert(result.code === 0, 'Add command should succeed');

      // Check that package.json WAS updated by the add command
      const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));
      assert(packageJson.dependencies['test-package'].startsWith('file:'),
        'Package.json should have file: path after add command');
    });
  }

  async testNoInstallFlag() {
    await this.runTest('--no-install flag prevents auto-install', async () => {
      // Setup
      await createPackageJson({ 'test-package': '^1.0.0' });
      await createLockFile('npm');
      await runPackdevCommand('create-config');

      // Create a fake local package directory
      await fs.mkdir('local-package-2', { recursive: true });
      await fs.writeFile('local-package-2/package.json', JSON.stringify({
        name: 'test-package',
        version: '1.0.0'
      }, null, 2));

      // Add dependency first
      await runPackdevCommand('add', [
        'test-package',
        './local-package-2',
        '--no-install'
      ]);

      // Reset package.json to test init
      await createPackageJson({ 'test-package': '^1.0.0' });

      // Test init with --no-install
      const result = await runPackdevCommand('init', ['--no-install']);



      assert(result.code === 0, 'Init with --no-install should succeed');

      // Just test that it completes successfully for now
      assert(result.stdout.includes('Development mode initialized successfully'),
        'Should initialize successfully');
    });
  }

  async testInitWithAutoInstall() {
    await this.runTest('Init with auto-install (mocked)', async () => {
      // Setup
      await createPackageJson({ 'test-package': '^1.0.0' });
      await createLockFile('npm');

      // Create config and add dependency
      await runPackdevCommand('create-config');

      // Create a fake local package directory
      await fs.mkdir('local-package-3', { recursive: true });
      await fs.writeFile('local-package-3/package.json', JSON.stringify({
        name: 'test-package',
        version: '1.0.0'
      }, null, 2));

      await runPackdevCommand('add', [
        'test-package',
        './local-package-3',
        '--no-install'
      ]);

      // Since we can't easily test actual npm install without side effects,
      // we'll test that the command completes successfully and the package.json
      // is updated correctly
      const result = await runPackdevCommand('init', ['--no-install']);

      assert(result.code === 0, 'Init should succeed');

      // Verify package.json was updated
      const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));
      assert(packageJson.dependencies['test-package'].startsWith('file:'),
        'Package.json should have file: path');
    });
  }

  async testFinishRestoresOriginalVersions() {
    await this.runTest('Finish command restores original versions', async () => {
      // Setup
      await createPackageJson({ 'test-package': '^1.0.0' });
      await createLockFile('npm');

      // Create config and add dependency
      await runPackdevCommand('create-config');

      // Create a fake local package directory
      await fs.mkdir('local-package-4', { recursive: true });
      await fs.writeFile('local-package-4/package.json', JSON.stringify({
        name: 'test-package',
        version: '1.0.0'
      }, null, 2));

      await runPackdevCommand('add', [
        'test-package',
        './local-package-4',
        '--no-install'
      ]);

      // Init to switch to local
      await runPackdevCommand('init', ['--no-install']);

      // Verify it's in local mode
      let packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));
      assert(packageJson.dependencies['test-package'].startsWith('file:'),
        'Should be in local mode');

      // Finish to restore
      const finishResult = await runPackdevCommand('finish', ['--no-install']);



      assert(finishResult.code === 0, 'Finish should succeed');

      // Verify it's restored
      packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));
      assert(packageJson.dependencies['test-package'] === '^1.0.0',
        'Should restore original version');
    });
  }

  async testStatusCommand() {
    await this.runTest('Status command shows correct state', async () => {
      // Clean start - remove any existing config
      try {
        await fs.unlink('.packdev.json');
      } catch {}

      // Setup
      await createPackageJson({ 'test-package': '^1.0.0' });
      await createLockFile('npm');

      // Create config and add dependency
      await runPackdevCommand('create-config');

      // Create a fake local package directory
      await fs.mkdir('local-package-5', { recursive: true });
      await fs.writeFile('local-package-5/package.json', JSON.stringify({
        name: 'test-package',
        version: '1.0.0'
      }, null, 2));

      await runPackdevCommand('add', [
        'test-package',
        './local-package-5',
        '--no-install'
      ]);

      // Reset package.json to original state to test inactive status
      await createPackageJson({ 'test-package': '^1.0.0' });

      // Test status before init
      let statusResult = await runPackdevCommand('status');
      assert(statusResult.code === 0, 'Status should succeed');
      assert(statusResult.stdout.includes('Inactive'),
        'Should show inactive before init');

      // Init and test status
      await runPackdevCommand('init', ['--no-install']);
      statusResult = await runPackdevCommand('status');
      assert(statusResult.code === 0, 'Status should succeed');
      assert(statusResult.stdout.includes('Active'),
        'Should show active after init');
    });
  }

  async testConfigFileManagement() {
    await this.runTest('Config file management', async () => {
      // Test create-config
      let result = await runPackdevCommand('create-config');
      assert(result.code === 0, 'Create config should succeed');
      assert(await fileExists('.packdev.json'), 'Config file should exist');

      // Test list with empty config
      result = await runPackdevCommand('list');
      assert(result.code === 0, 'List should succeed');
      assert(result.stdout.includes('No dependencies configured'),
        'Should show no dependencies initially');

      // Add a dependency and test list
      await createPackageJson({ 'test-package': '^1.0.0' });
      await fs.mkdir('local-package-6', { recursive: true });
      await fs.writeFile('local-package-6/package.json', JSON.stringify({
        name: 'test-package',
        version: '1.0.0'
      }, null, 2));

      await runPackdevCommand('add', [
        'test-package',
        './local-package-6',
        '--no-install'
      ]);

      result = await runPackdevCommand('list');
      assert(result.code === 0, 'List should succeed');
      assert(result.stdout.includes('test-package'),
        'Should show added dependency');
    });
  }

  async testGitUrlDetection() {
    await this.runTest('Git URL Detection', async () => {
      // Setup
      await createPackageJson({ 'react-components': '^1.0.0' });
      await createLockFile('npm');
      await runPackdevCommand('create-config');

      // Test adding git URL
      const gitUrl = 'https://github.com/myorg/react-components.git#feature-branch';
      const result = await runPackdevCommand('add', [
        'react-components',
        gitUrl,
        '--no-install'
      ]);

      assert(result.code === 0, 'Add with git URL should succeed');

      // Verify git URL is stored correctly in config
      const config = JSON.parse(await fs.readFile('.packdev.json', 'utf8'));
      const dependency = config.dependencies.find(d => d.package === 'react-components');

      assert(dependency, 'Dependency should be added to config');
      assert(dependency.location === gitUrl, 'Git URL should be stored as location');
      assert(dependency.type === 'git', 'Type should be detected as git');

      // Test init with git URL
      const initResult = await runPackdevCommand('init', ['--no-install']);
      assert(initResult.code === 0, 'Init with git URL should succeed');

      // Verify package.json has git URL (not file: path)
      const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));
      assert(packageJson.dependencies['react-components'] === gitUrl,
        'Package.json should have git URL, not file: path');
    });
  }

  async testMixedDependencies() {
    await this.runTest('Mixed Local and Git Dependencies', async () => {
      // Setup
      await createPackageJson({
        'local-lib': '^1.0.0',
        'git-lib': '^2.0.0'
      });
      await createLockFile('npm');
      await runPackdevCommand('create-config');

      // Create local package
      await fs.mkdir('local-package', { recursive: true });
      await fs.writeFile('local-package/package.json', JSON.stringify({
        name: 'local-lib',
        version: '1.0.0'
      }, null, 2));

      // Add both local and git dependencies
      await runPackdevCommand('add', [
        'local-lib',
        './local-package',
        '--no-install'
      ]);

      await runPackdevCommand('add', [
        'git-lib',
        'https://github.com/myorg/git-lib.git',
        '--no-install'
      ]);

      // Test init with mixed dependencies
      const result = await runPackdevCommand('init', ['--no-install']);
      assert(result.code === 0, 'Init with mixed dependencies should succeed');

      // Verify package.json has correct formats
      const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));
      assert(packageJson.dependencies['local-lib'].startsWith('file:'),
        'Local dependency should use file: path');
      assert(packageJson.dependencies['git-lib'].startsWith('https://'),
        'Git dependency should use git URL');
    });
  }

  async testErrorHandling() {
    await this.runTest('Error handling', async () => {
      // Clean start - remove any existing config
      try {
        await fs.unlink('.packdev.json');
      } catch {}

      // Test init without config
      let result = await runPackdevCommand('init', ['--no-install']);
      assert(result.code !== 0, 'Init without config should fail');

      // Test add with non-existent package
      await runPackdevCommand('create-config');
      await createPackageJson();

      result = await runPackdevCommand('add', [
        'non-existent-package',
        './non-existent-path',
        '--no-install'
      ]);
      assert(result.code !== 0, 'Add with non-existent path should fail');

      // Test add with package not in package.json
      result = await runPackdevCommand('add', [
        'unknown-package',
        './',
        '--no-install'
      ]);
      assert(result.code !== 0, 'Add with unknown package should fail');
    });
  }

  async testReleaseOverride() {
    await this.runTest('Release override - add stores type as release', async () => {
      await createPackageJson({ 'lodash': '^4.17.21' });
      await createLockFile('npm');
      await runPackdevCommand('create-config');

      const result = await runPackdevCommand('add', [
        'lodash',
        '^3.10.1',
        '--no-install'
      ]);

      assert(result.code === 0, 'Add with release version should succeed');

      const config = JSON.parse(await fs.readFile('.packdev.json', 'utf8'));
      const dep = config.dependencies.find(d => d.package === 'lodash');

      assert(dep, 'Dependency should be added to config');
      assert(dep.location === '^3.10.1', 'Location should be the release version');
      assert(dep.type === 'release', 'Type should be detected as release');
      assert(dep.version === '^4.17.21', 'Original version should be stored');
    });

    await this.runTest('Release override - init updates package.json with release version', async () => {
      await createPackageJson({ 'lodash': '^4.17.21' });
      await createLockFile('npm');
      await runPackdevCommand('create-config');

      await runPackdevCommand('add', ['lodash', '^3.10.1', '--no-install']);

      // Reset package.json to original
      await createPackageJson({ 'lodash': '^4.17.21' });

      const initResult = await runPackdevCommand('init', ['--no-install']);
      assert(initResult.code === 0, 'Init with release override should succeed');

      const packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));
      assert(packageJson.dependencies['lodash'] === '^3.10.1',
        'package.json should have the release override version');
    });

    await this.runTest('Release override - finish restores original version', async () => {
      await createPackageJson({ 'lodash': '^4.17.21' });
      await createLockFile('npm');
      await runPackdevCommand('create-config');

      await runPackdevCommand('add', ['lodash', '^3.10.1', '--no-install']);
      await runPackdevCommand('init', ['--no-install']);

      // Verify it's in override mode
      let packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));
      assert(packageJson.dependencies['lodash'] === '^3.10.1', 'Should be in release override mode');

      const finishResult = await runPackdevCommand('finish', ['--no-install']);
      assert(finishResult.code === 0, 'Finish should succeed');

      packageJson = JSON.parse(await fs.readFile('package.json', 'utf8'));
      assert(packageJson.dependencies['lodash'] === '^4.17.21',
        'Should restore original version');
    });

    await this.runTest('Release override - validate reports dev mode as active', async () => {
      await createPackageJson({ 'lodash': '^4.17.21' });
      await createLockFile('npm');
      await runPackdevCommand('create-config');

      await runPackdevCommand('add', ['lodash', '^3.10.1', '--no-install']);
      await runPackdevCommand('init', ['--no-install']);

      const statusResult = await runPackdevCommand('status');
      assert(statusResult.code === 0, 'Status should succeed');
      assert(statusResult.stdout.includes('Active'),
        'Status should show Active when release override is applied');
    });

    await this.runTest('Release override - add guards against saving active release as original', async () => {
      await createPackageJson({ 'lodash': '^4.17.21' });
      await createLockFile('npm');
      await runPackdevCommand('create-config');

      // Set up an active release override
      await runPackdevCommand('add', ['lodash', '^3.10.1', '--no-install']);
      await runPackdevCommand('init', ['--no-install']);

      // Now try to add a new override without --original-version
      // package.json currently has ^3.10.1 (the release override)
      // It should fail because it can't determine the original version
      const result = await runPackdevCommand('add', ['lodash', '^2.0.0', '--no-install']);
      assert(result.code !== 0, 'Should fail when package.json has active release override');
    });
  }

  async runAllTests() {
    log('🚀 Starting PackDev Package Manager Unit Tests', 'cyan');
    log('=====================================', 'cyan');

    try {
      await createTestDirectory();

      await this.testPackageManagerDetection();
      await this.testAddCommandUpdatesPackageJson();
      await this.testNoInstallFlag();
      await this.testInitWithAutoInstall();
      await this.testFinishRestoresOriginalVersions();
      await this.testStatusCommand();
      await this.testConfigFileManagement();
      await this.testGitUrlDetection();
      await this.testMixedDependencies();
      await this.testErrorHandling();
      await this.testReleaseOverride();

      log('\n🎉 All PackDev Package Manager Tests Completed!', 'green');
      log(`✅ Passed: ${this.testsPassed}/${this.totalTests}`, 'green');
      log(`🏆 Success Rate: ${Math.round((this.testsPassed / this.totalTests) * 100)}%`, 'green');

    } catch (error) {
      log('\n❌ Test Suite Failed!', 'red');
      log(`✅ Passed: ${this.testsPassed}/${this.totalTests}`, 'yellow');
      log(`💥 Error: ${error.message}`, 'red');
      throw error;
    } finally {
      await cleanupTestDirectory();
    }
  }
}

// Run tests if this file is executed directly
async function main() {
  const tests = new PackageManagerTests();
  try {
    await tests.runAllTests();
    process.exit(0);
  } catch (error) {
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
}

module.exports = { PackageManagerTests };

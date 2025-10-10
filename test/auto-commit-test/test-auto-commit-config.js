#!/usr/bin/env node

/**
 * Test Auto-Commit Flow Configuration
 *
 * This test verifies that:
 * 1. The --auto-commit option saves the preference to .packdev.json
 * 2. The configuration is properly loaded and used by the pre-commit hook
 * 3. The setupGitHooks function works with the new parameters
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const os = require('os');

// Create a temporary test directory
const testDir = path.join(os.tmpdir(), `packdev-auto-commit-test-${Date.now()}`);
const originalCwd = process.cwd();

function log(message, color = '\x1b[0m') {
  console.log(`${color}${message}\x1b[0m`);
}

function logSuccess(message) {
  log(`✅ ${message}`, '\x1b[32m');
}

function logError(message) {
  log(`❌ ${message}`, '\x1b[31m');
}

function logInfo(message) {
  log(`📋 ${message}`, '\x1b[36m');
}

function cleanup() {
  try {
    process.chdir(originalCwd);
    if (fs.existsSync(testDir)) {
      execSync(`rm -rf "${testDir}"`, { stdio: 'pipe' });
    }
  } catch (error) {
    // Ignore cleanup errors
  }
}

async function runTest() {
  try {
    logInfo('Setting up test environment...');

    // Create test directory
    fs.mkdirSync(testDir, { recursive: true });
    process.chdir(testDir);

    // Initialize git repo
    execSync('git init', { stdio: 'pipe' });
    execSync('git config user.name "Test User"', { stdio: 'pipe' });
    execSync('git config user.email "test@example.com"', { stdio: 'pipe' });

    // Create a basic package.json
    const packageJson = {
      name: 'test-project',
      version: '1.0.0',
      dependencies: {}
    };
    fs.writeFileSync('package.json', JSON.stringify(packageJson, null, 2));

    // Create initial .packdev.json without autoCommitFlow
    const initialConfig = {
      version: '0.1.0',
      dependencies: [],
      created: new Date().toISOString()
    };
    fs.writeFileSync('.packdev.json', JSON.stringify(initialConfig, null, 2));

    logSuccess('Test environment created');

    // Test 1: Setup hooks without auto-commit (should not add autoCommitFlow)
    logInfo('Test 1: Setup hooks without --auto-commit...');
    const packdevPath = path.join(originalCwd, 'dist/index.js');
    execSync(`node "${packdevPath}" setup-hooks --force`, { stdio: 'pipe' });

    const configAfterBasicSetup = JSON.parse(fs.readFileSync('.packdev.json', 'utf8'));
    if (configAfterBasicSetup.autoCommitFlow === undefined) {
      logSuccess('Basic setup correctly does not set autoCommitFlow');
    } else {
      logError('Basic setup incorrectly set autoCommitFlow');
      return false;
    }

    // Test 2: Setup hooks with auto-commit (should add autoCommitFlow: true)
    logInfo('Test 2: Setup hooks with --auto-commit...');
    execSync(`node "${packdevPath}" setup-hooks --auto-commit --force`, { stdio: 'pipe' });

    const configAfterAutoCommit = JSON.parse(fs.readFileSync('.packdev.json', 'utf8'));
    if (configAfterAutoCommit.autoCommitFlow === true) {
      logSuccess('Auto-commit setup correctly set autoCommitFlow to true');
    } else {
      logError(`Auto-commit setup failed. autoCommitFlow is: ${configAfterAutoCommit.autoCommitFlow}`);
      return false;
    }

    // Test 3: Verify lastModified was updated
    if (configAfterAutoCommit.lastModified && configAfterAutoCommit.lastModified !== initialConfig.created) {
      logSuccess('lastModified field was correctly updated');
    } else {
      logError('lastModified field was not updated');
      return false;
    }

    // Test 4: Verify hook files were created
    const preCommitPath = '.git/hooks/pre-commit';
    const checkScriptPath = '.git/hooks/check-local-deps.js';

    if (fs.existsSync(preCommitPath) && fs.existsSync(checkScriptPath)) {
      logSuccess('Hook files were created');
    } else {
      logError('Hook files were not created');
      return false;
    }

    // Test 5: Verify the check script contains auto-commit flow code
    const checkScriptContent = fs.readFileSync(checkScriptPath, 'utf8');
    if (checkScriptContent.includes('executeAutoCommitFlow') &&
        checkScriptContent.includes('askYesNo') &&
        checkScriptContent.includes('loadPackdevConfig')) {
      logSuccess('Check script contains auto-commit flow functionality');
    } else {
      logError('Check script missing auto-commit flow functionality');
      return false;
    }

    // Test 6: Test disabling hooks (should not affect config)
    logInfo('Test 3: Test disabling hooks...');
    execSync(`node "${packdevPath}" setup-hooks --disable`, { stdio: 'pipe' });

    const configAfterDisable = JSON.parse(fs.readFileSync('.packdev.json', 'utf8'));
    if (configAfterDisable.autoCommitFlow === true) {
      logSuccess('Disabling hooks preserved autoCommitFlow setting');
    } else {
      logError('Disabling hooks incorrectly modified autoCommitFlow setting');
      return false;
    }

    // Verify hook files were removed
    if (!fs.existsSync(preCommitPath) && !fs.existsSync(checkScriptPath)) {
      logSuccess('Hook files were properly removed');
    } else {
      logError('Hook files were not properly removed');
      return false;
    }

    logSuccess('All tests passed! Auto-commit flow configuration works correctly.');
    return true;

  } catch (error) {
    logError(`Test failed with error: ${error.message}`);
    console.error(error);
    return false;
  } finally {
    cleanup();
  }
}

// Run the test
runTest().then(success => {
  process.exit(success ? 0 : 1);
}).catch(error => {
  logError(`Unexpected error: ${error.message}`);
  cleanup();
  process.exit(1);
});

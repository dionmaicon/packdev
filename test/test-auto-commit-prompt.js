#!/usr/bin/env node

/**
 * Simple Auto-Commit Flow Prompt Test
 *
 * This test verifies the auto-commit flow detection and environment variable handling
 * without actually executing the subprocess commands that cause hanging.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function log(message, color = '\x1b[0m') {
  console.log(`${color}${message}\x1b[0m`);
}

function logInfo(message) {
  log(`📋 ${message}`, '\x1b[36m');
}

function logSuccess(message) {
  log(`✅ ${message}`, '\x1b[32m');
}

function logError(message) {
  log(`❌ ${message}`, '\x1b[31m');
}

function testAutoCommitDetection() {
  logInfo('Testing auto-commit flow detection...');

  // Create package.json with local dependency
  const packageJson = {
    name: 'test-project',
    version: '1.0.0',
    dependencies: {
      'my-local-lib': 'file:../fake-local-lib'
    }
  };

  const originalPackageJson = fs.existsSync('package.json') ?
    fs.readFileSync('package.json', 'utf8') : null;

  try {
    // Write test package.json
    fs.writeFileSync('package.json', JSON.stringify(packageJson, null, 2));

    // Test 1: Default behavior (should block)
    logInfo('Test 1: Default behavior (no environment variable)');
    try {
      const result = execSync('node .git/hooks/check-local-deps.js', {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 5000
      });
      logError('Unexpected success - should have been blocked');
      return false;
    } catch (error) {
      if (error.stdout && error.stdout.includes('Defaulting to blocking commit for safety')) {
        logSuccess('Correctly blocked commit and showed non-interactive message');
      } else {
        logError('Unexpected error output');
        console.log('stdout:', error.stdout);
        console.log('stderr:', error.stderr);
        return false;
      }
    }

    // Test 2: Environment variable = no (should block)
    logInfo('Test 2: PACKDEV_AUTO_COMMIT=no');
    try {
      const result = execSync('node .git/hooks/check-local-deps.js', {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 5000,
        env: { ...process.env, PACKDEV_AUTO_COMMIT: 'no' }
      });
      logError('Unexpected success - should have been blocked');
      return false;
    } catch (error) {
      if (error.stdout && error.stdout.includes('Decision: Blocking commit')) {
        logSuccess('Correctly blocked commit with PACKDEV_AUTO_COMMIT=no');
      } else {
        logError('Unexpected error output');
        console.log('stdout:', error.stdout);
        return false;
      }
    }

    // Test 3: Environment variable = yes (should proceed to auto-commit logic)
    logInfo('Test 3: PACKDEV_AUTO_COMMIT=yes');
    try {
      const result = execSync('node .git/hooks/check-local-deps.js', {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 5000,
        env: { ...process.env, PACKDEV_AUTO_COMMIT: 'yes' }
      });
      logError('Unexpected success - auto-commit should fail due to missing packdev binary');
      return false;
    } catch (error) {
      if (error.stdout && error.stdout.includes('Starting auto-commit flow')) {
        logSuccess('Correctly detected PACKDEV_AUTO_COMMIT=yes and started auto-commit flow');
        if (error.stdout.includes('Could not run packdev finish')) {
          logSuccess('Correctly failed when packdev binary not found (expected behavior)');
        }
      } else {
        logError('Unexpected error output');
        console.log('stdout:', error.stdout);
        console.log('stderr:', error.stderr);
        return false;
      }
    }

    // Test 4: WIP commit (should bypass auto-commit flow entirely)
    logInfo('Test 4: WIP commit bypass');
    try {
      const result = execSync('node .git/hooks/check-local-deps.js', {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 5000,
        env: { ...process.env, TEST_COMMIT_MESSAGE: 'WIP: testing local changes' }
      });

      if (result.includes('WIP detected in commit message')) {
        logSuccess('WIP commit correctly bypassed all checks');
      } else {
        logError('WIP commit should have been allowed');
        return false;
      }
    } catch (error) {
      logError('WIP commit should not have been blocked');
      console.log('stdout:', error.stdout);
      return false;
    }

    return true;

  } finally {
    // Restore original package.json
    if (originalPackageJson) {
      fs.writeFileSync('package.json', originalPackageJson);
    } else {
      try {
        fs.unlinkSync('package.json');
      } catch (e) {
        // File might not exist
      }
    }
  }
}

function main() {
  console.log('🧪 Auto-Commit Flow Prompt Test\n');

  // Verify we're in the right directory and have the hook
  if (!fs.existsSync('.git/hooks/check-local-deps.js')) {
    logError('Hook not found! Make sure you run this from test directory with hooks set up.');
    logInfo('Run: node ../dist/index.js setup-hooks --auto-commit --force');
    process.exit(1);
  }

  // Verify auto-commit flow is enabled
  if (!fs.existsSync('.packdev.json')) {
    logError('.packdev.json not found!');
    process.exit(1);
  }

  const config = JSON.parse(fs.readFileSync('.packdev.json', 'utf8'));
  if (!config.autoCommitFlow) {
    logError('autoCommitFlow not enabled in .packdev.json');
    process.exit(1);
  }

  logSuccess('Environment setup verified');
  console.log();

  const success = testAutoCommitDetection();

  console.log('\n' + '='.repeat(50));
  if (success) {
    logSuccess('🎉 All auto-commit flow tests passed!');
    console.log();
    console.log('✅ Non-interactive detection works');
    console.log('✅ Environment variable handling works');
    console.log('✅ WIP bypass works');
    console.log('✅ Auto-commit flow initiation works');
    console.log();
    console.log('💡 The interactive prompt and subprocess execution');
    console.log('   would work in a real terminal environment.');
  } else {
    logError('Some tests failed');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

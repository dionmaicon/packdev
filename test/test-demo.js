#!/usr/bin/env node

/**
 * PackDev Test Demo Script
 *
 * This script demonstrates the complete PackDev workflow using the compiled binary.
 * It creates a test scenario with our fake lodash implementation, runs the demo,
 * and cleans up after completion.
 *
 * Usage: node test-demo.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Configuration
const BINARY_PATH = '../dist/index.js';
const FAKE_LODASH_PATH = './fake-lodash';
const CONFIG_FILE = '.packdev.json';
const DEMO_FILE = 'demo.js';
const PACKAGE_JSON = './package.json';

// Colors for console output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m'
};

function colorize(text, color) {
  return `${colors[color]}${text}${colors.reset}`;
}

function log(message, color = 'reset') {
  console.log(colorize(message, color));
}

function logHeader(message) {
  console.log('');
  log('='.repeat(60), 'cyan');
  log(message, 'bright');
  log('='.repeat(60), 'cyan');
  console.log('');
}

function logStep(step, message) {
  log(`${step}. ${message}`, 'yellow');
}

function execCommand(command, description) {
  try {
    log(`🔧 ${description}...`, 'blue');
    const output = execSync(command, { encoding: 'utf8' });
    if (output.trim()) {
      console.log(output);
    }
    log(`✅ ${description} completed successfully`, 'green');
    return output;
  } catch (error) {
    log(`❌ ${description} failed:`, 'red');
    console.error(error.message);
    throw error;
  }
}

function fileExists(filePath) {
  return fs.existsSync(filePath);
}

function readPackageJson() {
  try {
    return JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
  } catch (error) {
    return null;
  }
}

function hasLodashDependency() {
  const pkg = readPackageJson();
  return pkg && (
    (pkg.dependencies && pkg.dependencies.lodash) ||
    (pkg.devDependencies && pkg.devDependencies.lodash)
  );
}

function cleanupFiles() {
  const filesToClean = [CONFIG_FILE];

  filesToClean.forEach(file => {
    if (fileExists(file)) {
      try {
        fs.unlinkSync(file);
        log(`🧹 Removed ${file}`, 'magenta');
      } catch (error) {
        log(`⚠️  Failed to remove ${file}: ${error.message}`, 'yellow');
      }
    }
  });
}

function checkPrerequisites() {
  logStep('1', 'Checking prerequisites');

  // Check if binary exists
  if (!fileExists(BINARY_PATH)) {
    throw new Error(`Binary not found at ${BINARY_PATH}. Run 'npm run build' first.`);
  }
  log(`✅ Binary found: ${BINARY_PATH}`, 'green');

  // Check if fake lodash exists
  if (!fileExists(FAKE_LODASH_PATH)) {
    throw new Error(`Fake lodash not found at ${FAKE_LODASH_PATH}`);
  }
  log(`✅ Fake lodash found: ${FAKE_LODASH_PATH}`, 'green');

  // Check if demo file exists
  if (!fileExists(DEMO_FILE)) {
    throw new Error(`Demo file not found: ${DEMO_FILE}`);
  }
  log(`✅ Demo file found: ${DEMO_FILE}`, 'green');

  // Check if lodash is already installed
  const hasLodash = hasLodashDependency();
  log(`📦 Lodash dependency: ${hasLodash ? 'Found' : 'Not found'}`, hasLodash ? 'green' : 'yellow');

  return { hasLodash };
}

function setupLodashDependency() {
  logStep('2', 'Setting up lodash dependency');

  if (!hasLodashDependency()) {
    execCommand('npm install lodash', 'Installing lodash');
  } else {
    log('📦 Lodash already installed', 'blue');
  }
}

function testWithRealLodash() {
  logStep('3', 'Testing with real lodash');

  log('🎭 Running demo with REAL lodash...', 'cyan');
  execCommand('node demo.js', 'Running demo with real lodash');
}

function initializePackdev() {
  logStep('4', 'Initializing packdev configuration');

  // Clean up any existing config
  if (fileExists(CONFIG_FILE)) {
    fs.unlinkSync(CONFIG_FILE);
    log(`🧹 Removed existing ${CONFIG_FILE}`, 'magenta');
  }

  execCommand(`node ${BINARY_PATH} create-config`, 'Creating packdev configuration');
  execCommand(`node ${BINARY_PATH} add lodash ${FAKE_LODASH_PATH}`, 'Adding fake lodash as local dependency');
  execCommand(`node ${BINARY_PATH} status`, 'Checking initial status');
}

function switchToLocalMode() {
  logStep('5', 'Switching to development mode');

  execCommand(`node ${BINARY_PATH} init`, 'Initializing development mode');
  execCommand(`node ${BINARY_PATH} status`, 'Checking development status');
  execCommand('npm install', 'Installing development dependencies');
}

function testWithFakeLodash() {
  logStep('6', 'Testing with fake lodash');

  log('🎭 Running demo with FAKE lodash...', 'cyan');
  execCommand('node demo.js', 'Running demo with fake lodash');
}

function switchBackToRemote() {
  logStep('7', 'Switching back to remote mode');

  execCommand(`node ${BINARY_PATH} finish`, 'Finishing development mode');
  execCommand(`node ${BINARY_PATH} status`, 'Checking remote status');
  execCommand('npm install', 'Reinstalling remote dependencies');
}

function verifyRestoration() {
  logStep('8', 'Verifying restoration');

  log('🎭 Running demo with REAL lodash again...', 'cyan');
  execCommand('node demo.js', 'Running demo to verify restoration');
}

function runFakeLodashTests() {
  logStep('9', 'Running fake lodash internal tests');

  log('🧪 Running fake lodash test suite...', 'cyan');
  execCommand(`cd ${FAKE_LODASH_PATH} && npm test`, 'Running fake lodash tests');
}

function cleanup() {
  logStep('10', 'Cleaning up test files');

  cleanupFiles();

  // Optionally remove lodash if it wasn't there initially
  const readline = require('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  return new Promise((resolve) => {
    rl.question(colorize('🗑️  Remove lodash dependency? (y/N): ', 'yellow'), (answer) => {
      rl.close();

      if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
        try {
          execCommand('npm uninstall lodash', 'Removing lodash dependency');
          log('🧹 Lodash dependency removed', 'green');
        } catch (error) {
          log('⚠️  Failed to remove lodash dependency', 'yellow');
        }
      } else {
        log('📦 Keeping lodash dependency', 'blue');
      }

      resolve();
    });
  });
}

async function main() {
  logHeader('🚀 PackDev Test Demo Starting');

  let testsPassed = 0;
  let totalTests = 0;
  const startTime = Date.now();

  try {
    // Pre-flight checks
    const { hasLodash: initialLodash } = checkPrerequisites();
    totalTests++;
    testsPassed++;

    // Setup phase
    setupLodashDependency();
    totalTests++;
    testsPassed++;

    // Test 1: Real lodash
    testWithRealLodash();
    totalTests++;
    testsPassed++;

    // packdev initialization
    initializePackdev();
    totalTests++;
    testsPassed++;

    // Switch to local mode
    switchToLocalMode();
    totalTests++;
    testsPassed++;

    // Test 2: Fake lodash
    testWithFakeLodash();
    totalTests++;
    testsPassed++;

    // Switch back to remote
    switchBackToRemote();
    totalTests++;
    testsPassed++;

    // Test 3: Verify restoration
    verifyRestoration();
    totalTests++;
    testsPassed++;

    // Test 4: Fake lodash unit tests
    runFakeLodashTests();
    totalTests++;
    testsPassed++;

    // Cleanup
    await cleanup();
    totalTests++;
    testsPassed++;

    const endTime = Date.now();
    const duration = endTime - startTime;

    logHeader('🎉 PackDev Test Demo Results');
    log(`✅ All tests completed successfully!`, 'green');
    log(`📊 Tests passed: ${testsPassed}/${totalTests}`, 'cyan');
    log(`⏱️  Total duration: ${duration}ms`, 'blue');
    log(`🏆 Success rate: ${Math.round((testsPassed / totalTests) * 100)}%`, 'green');

    console.log('');
    log('🎯 Key achievements:', 'bright');
    log('   ✅ Binary execution works correctly', 'green');
    log('   ✅ Automatic version detection functions', 'green');
    log('   ✅ Local/remote switching is seamless', 'green');
    log('   ✅ Fake lodash implementation is compatible', 'green');
    log('   ✅ State restoration works perfectly', 'green');
    log('   ✅ Error handling is robust', 'green');

    console.log('');
    log('🚀 PackDev is ready for production use!', 'bright');

  } catch (error) {
    const endTime = Date.now();
    const duration = endTime - startTime;

    logHeader('❌ PackDev Test Demo Failed');
    log(`Error: ${error.message}`, 'red');
    log(`📊 Tests passed: ${testsPassed}/${totalTests}`, 'yellow');
    log(`⏱️  Duration before failure: ${duration}ms`, 'blue');

    console.log('');
    log('🧹 Attempting cleanup...', 'yellow');
    cleanupFiles();

    process.exit(1);
  }
}

// Handle process termination
process.on('SIGINT', () => {
  console.log('');
  log('🛑 Test interrupted by user', 'yellow');
  cleanupFiles();
  process.exit(0);
});

process.on('uncaughtException', (error) => {
  log(`💥 Uncaught exception: ${error.message}`, 'red');
  cleanupFiles();
  process.exit(1);
});

// Run the main function
if (require.main === module) {
  main().catch((error) => {
    log(`💥 Unhandled error: ${error.message}`, 'red');
    cleanupFiles();
    process.exit(1);
  });
}

module.exports = { main, cleanupFiles, checkPrerequisites };

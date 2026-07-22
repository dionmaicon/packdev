#!/usr/bin/env node

/**
 * PackDev Comprehensive Test Runner
 *
 * This script runs all tests for the PackDev project:
 * - Unit tests for package manager functionality
 * - Integration tests (existing test-demo.js)
 *
 * Usage: node run-all-tests.js [--unit-only] [--integration-only]
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// Configuration
const UNIT_TESTS_PATH = path.join(__dirname, 'unit/packageManager.test.js');
const FEATURE_TESTS_PATH = path.join(__dirname, 'unit/features.test.js');
const INTEGRATION_TESTS_PATH = path.join(__dirname, 'test-demo.js');
const GIT_AUTOCOMMIT_TESTS_PATH = path.join(__dirname, 'git/autocommit.test.js');
const GIT_WORKFLOWS_TESTS_PATH = path.join(__dirname, 'git/workflows.test.js');
const GIT_EDGE_CASES_TESTS_PATH = path.join(__dirname, 'git/edge-cases.test.js');
const BINARY_PATH = '../dist/index.js';

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
  log('='.repeat(70), 'cyan');
  log(message, 'bright');
  log('='.repeat(70), 'cyan');
  console.log('');
}

function logSection(message) {
  console.log('');
  log('-'.repeat(50), 'yellow');
  log(message, 'yellow');
  log('-'.repeat(50), 'yellow');
  console.log('');
}

function execCommand(command, description, options = {}) {
  try {
    log(`🔧 ${description}...`, 'blue');
    const output = execSync(command, {
      encoding: 'utf8',
      stdio: 'inherit',
      ...options
    });
    log(`✅ ${description} completed`, 'green');
    return { success: true, output };
  } catch (error) {
    log(`❌ ${description} failed`, 'red');
    return { success: false, error: error.message, code: error.status };
  }
}

function parseArguments() {
  const args = process.argv.slice(2);
  return {
    unitOnly: args.includes('--unit-only'),
    integrationOnly: args.includes('--integration-only'),
    gitOnly: args.includes('--git-only'),
    gitAutocommitOnly: args.includes('--git-autocommit-only'),
    gitWorkflowsOnly: args.includes('--git-workflows-only'),
    gitEdgeCasesOnly: args.includes('--git-edge-cases-only'),
    help: args.includes('--help') || args.includes('-h')
  };
}

function showHelp() {
  log('PackDev Test Runner', 'bright');
  console.log('');
  log('Usage:', 'yellow');
  log('  node run-all-tests.js [options]', 'cyan');
  console.log('');
  log('Options:', 'yellow');
  log('  --unit-only             Run only unit tests', 'cyan');
  log('  --integration-only      Run only integration tests', 'cyan');
  log('  --git-only              Run all git tests', 'cyan');
  log('  --git-autocommit-only   Run only git autocommit tests', 'cyan');
  log('  --git-workflows-only    Run only git workflow tests', 'cyan');
  log('  --git-edge-cases-only   Run only git edge case tests', 'cyan');
  log('  --help, -h              Show this help message', 'cyan');
  console.log('');
  log('Examples:', 'yellow');
  log('  node run-all-tests.js', 'cyan');
  log('  node run-all-tests.js --unit-only', 'cyan');
  log('  node run-all-tests.js --integration-only', 'cyan');
  log('  node run-all-tests.js --git-only', 'cyan');
  log('  node run-all-tests.js --git-autocommit-only', 'cyan');
}

function checkPrerequisites() {
  logSection('🔍 Checking Prerequisites');

  // Check if binary exists
  if (!fs.existsSync(BINARY_PATH)) {
    log('❌ Binary not found. Building project...', 'yellow');
    const buildResult = execCommand('npm run build', 'Building project');
    if (!buildResult.success) {
      throw new Error('Failed to build project. Please run "npm run build" manually.');
    }
  } else {
    log('✅ Binary found', 'green');
  }

  // Check if unit test file exists
  if (fs.existsSync(UNIT_TESTS_PATH)) {
    log('✅ Unit tests found', 'green');
  } else {
    log('⚠️  Unit tests not found', 'yellow');
  }

  // Check if integration test file exists
  if (fs.existsSync(INTEGRATION_TESTS_PATH)) {
    log('✅ Integration tests found', 'green');
  } else {
    log('⚠️  Integration tests not found', 'yellow');
  }

  // Check if git test files exist
  if (fs.existsSync(GIT_AUTOCOMMIT_TESTS_PATH)) {
    log('✅ Git autocommit tests found', 'green');
  } else {
    log('⚠️  Git autocommit tests not found', 'yellow');
  }

  if (fs.existsSync(GIT_WORKFLOWS_TESTS_PATH)) {
    log('✅ Git workflow tests found', 'green');
  } else {
    log('⚠️  Git workflow tests not found', 'yellow');
  }

  if (fs.existsSync(GIT_EDGE_CASES_TESTS_PATH)) {
    log('✅ Git edge case tests found', 'green');
  } else {
    log('⚠️  Git edge case tests not found', 'yellow');
  }

  log('✅ Prerequisites check completed', 'green');
}

async function runUnitTests() {
  logSection('🧪 Running Unit Tests');

  if (!fs.existsSync(UNIT_TESTS_PATH)) {
    log('⚠️  Unit tests not found, skipping...', 'yellow');
    return { success: true, skipped: true };
  }

  const result = execCommand(
    `node ${UNIT_TESTS_PATH}`,
    'Executing unit tests'
  );

  if (!result.success) {
    log('💥 Unit tests failed!', 'red');
    return result;
  }

  const featureResult = execCommand(
    `node ${FEATURE_TESTS_PATH}`,
    'Executing feature tests'
  );

  if (featureResult.success) {
    log('🎉 Unit tests completed successfully!', 'green');
  } else {
    log('💥 Feature tests failed!', 'red');
  }

  return featureResult;
}

async function runGitAutocommitTests() {
  logSection('🔀 Running Git Autocommit Tests');

  if (!fs.existsSync(GIT_AUTOCOMMIT_TESTS_PATH)) {
    log('⚠️  Git autocommit tests not found, skipping...', 'yellow');
    return { success: true, skipped: true };
  }

  const result = execCommand(
    `node ${GIT_AUTOCOMMIT_TESTS_PATH}`,
    'Executing git autocommit tests'
  );

  if (result.success) {
    log('🎉 Git autocommit tests completed successfully!', 'green');
  } else {
    log('💥 Git autocommit tests failed!', 'red');
  }

  return result;
}

async function runGitWorkflowTests() {
  logSection('🌳 Running Git Workflow Tests');

  if (!fs.existsSync(GIT_WORKFLOWS_TESTS_PATH)) {
    log('⚠️  Git workflow tests not found, skipping...', 'yellow');
    return { success: true, skipped: true };
  }

  const result = execCommand(
    `node ${GIT_WORKFLOWS_TESTS_PATH}`,
    'Executing git workflow tests'
  );

  if (result.success) {
    log('🎉 Git workflow tests completed successfully!', 'green');
  } else {
    log('💥 Git workflow tests failed!', 'red');
  }

  return result;
}

async function runGitEdgeCaseTests() {
  logSection('⚠️ Running Git Edge Case Tests');

  if (!fs.existsSync(GIT_EDGE_CASES_TESTS_PATH)) {
    log('⚠️  Git edge case tests not found, skipping...', 'yellow');
    return { success: true, skipped: true };
  }

  const result = execCommand(
    `node ${GIT_EDGE_CASES_TESTS_PATH}`,
    'Executing git edge case tests'
  );

  if (result.success) {
    log('🎉 Git edge case tests completed successfully!', 'green');
  } else {
    log('💥 Git edge case tests failed!', 'red');
  }

  return result;
}

async function runIntegrationTests() {
  logSection('🔄 Running Integration Tests');

  if (!fs.existsSync(INTEGRATION_TESTS_PATH)) {
    log('⚠️  Integration tests not found, skipping...', 'yellow');
    return { success: true, skipped: true };
  }

  // Integration tests are interactive, so we need special handling
  log('🚀 Starting integration test demo...', 'cyan');
  log('⚠️  This test is interactive and may require user input', 'yellow');

  const result = execCommand(
    `node ${INTEGRATION_TESTS_PATH}`,
    'Executing integration tests'
  );

  if (result.success) {
    log('🎉 Integration tests completed successfully!', 'green');
  } else {
    log('💥 Integration tests failed!', 'red');
  }

  return result;
}

function generateTestReport(results) {
  logHeader('📊 Test Report');

  let totalTests = 0;
  let passedTests = 0;
  let failedTests = 0;
  let skippedTests = 0;

  Object.entries(results).forEach(([testType, result]) => {
    totalTests++;

    if (result.skipped) {
      skippedTests++;
      log(`⏭️  ${testType}: Skipped`, 'yellow');
    } else if (result.success) {
      passedTests++;
      log(`✅ ${testType}: Passed`, 'green');
    } else {
      failedTests++;
      log(`❌ ${testType}: Failed`, 'red');
    }
  });

  console.log('');
  log(`📈 Summary:`, 'bright');
  log(`   Total test suites: ${totalTests}`, 'cyan');
  log(`   Passed: ${passedTests}`, 'green');
  log(`   Failed: ${failedTests}`, failedTests > 0 ? 'red' : 'cyan');
  log(`   Skipped: ${skippedTests}`, 'yellow');

  const successRate = totalTests > 0 ? Math.round(((passedTests) / (totalTests - skippedTests)) * 100) : 0;
  log(`   Success Rate: ${successRate}%`, successRate === 100 ? 'green' : 'yellow');

  return {
    total: totalTests,
    passed: passedTests,
    failed: failedTests,
    skipped: skippedTests,
    successRate
  };
}

async function main() {
  const startTime = Date.now();
  const options = parseArguments();

  if (options.help) {
    showHelp();
    return;
  }

  logHeader('🚀 PackDev Comprehensive Test Suite');

  try {
    // Check prerequisites
    checkPrerequisites();

    const results = {};

    // Run unit tests
    if (!options.integrationOnly && !options.gitOnly && !options.gitAutocommitOnly &&
        !options.gitWorkflowsOnly && !options.gitEdgeCasesOnly) {
      results['Unit Tests'] = await runUnitTests();
    }

    // Run integration tests
    if (!options.unitOnly && !options.gitOnly && !options.gitAutocommitOnly &&
        !options.gitWorkflowsOnly && !options.gitEdgeCasesOnly) {
      results['Integration Tests'] = await runIntegrationTests();
    }

    // Run git tests
    if (!options.unitOnly && !options.integrationOnly) {
      if (options.gitOnly || options.gitAutocommitOnly ||
          (!options.gitWorkflowsOnly && !options.gitEdgeCasesOnly)) {
        results['Git Autocommit Tests'] = await runGitAutocommitTests();
      }

      if (options.gitOnly || options.gitWorkflowsOnly ||
          (!options.gitAutocommitOnly && !options.gitEdgeCasesOnly)) {
        results['Git Workflow Tests'] = await runGitWorkflowTests();
      }

      if (options.gitOnly || options.gitEdgeCasesOnly ||
          (!options.gitAutocommitOnly && !options.gitWorkflowsOnly)) {
        results['Git Edge Case Tests'] = await runGitEdgeCaseTests();
      }
    }

    // Generate report
    const report = generateTestReport(results);

    const endTime = Date.now();
    const duration = Math.round((endTime - startTime) / 1000);

    logHeader('🏁 Test Suite Complete');

    if (report.failed === 0) {
      log('🎉 All tests passed successfully!', 'green');
    } else {
      log(`⚠️  ${report.failed} test suite(s) failed`, 'red');
    }

    log(`⏱️  Total execution time: ${duration}s`, 'blue');

    // Exit with appropriate code
    process.exit(report.failed > 0 ? 1 : 0);

  } catch (error) {
    const endTime = Date.now();
    const duration = Math.round((endTime - startTime) / 1000);

    logHeader('💥 Test Suite Failed');
    log(`Error: ${error.message}`, 'red');
    log(`⏱️  Execution time: ${duration}s`, 'blue');

    process.exit(1);
  }
}

// Handle process termination
process.on('SIGINT', () => {
  console.log('');
  log('🛑 Test suite interrupted by user', 'yellow');
  process.exit(130);
});

process.on('uncaughtException', (error) => {
  log(`💥 Uncaught exception: ${error.message}`, 'red');
  process.exit(1);
});

// Run main function
if (require.main === module) {
  main().catch((error) => {
    log(`💥 Unhandled error: ${error.message}`, 'red');
    process.exit(1);
  });
}

module.exports = { main };

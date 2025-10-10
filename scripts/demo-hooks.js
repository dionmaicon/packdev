#!/usr/bin/env node

/**
 * Demo script to showcase GitHub hooks functionality
 * This script simulates the git commit workflow with local dependencies
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

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

function logStep(message) {
  log(`🔧 ${message}`, '\x1b[34m');
}

function logWarning(message) {
  log(`⚠️  ${message}`, '\x1b[33m');
}

function logHeader(message) {
  console.log('\n' + '='.repeat(60));
  log(`🚀 ${message}`, '\x1b[35m');
  console.log('='.repeat(60));
}

class HookDemo {
  constructor() {
    this.projectRoot = process.cwd();
    this.originalPackageJson = null;
  }

  async setup() {
    // Backup original package.json
    this.originalPackageJson = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  }

  async createLocalDependency() {
    logStep('Creating a scenario with local dependencies...');

    const packageJson = { ...this.originalPackageJson };

    // Add some fake local dependencies
    packageJson.dependencies = {
      ...packageJson.dependencies,
      'my-local-utils': 'file:../shared/utils',
      'test-package': 'file:./local-packages/test-package'
    };

    packageJson.devDependencies = {
      ...packageJson.devDependencies,
      'dev-tools': 'file:../dev-tools'
    };

    fs.writeFileSync('package.json', JSON.stringify(packageJson, null, 2));
    logSuccess('Added local file dependencies to package.json');
  }

  async restorePackageJson() {
    if (this.originalPackageJson) {
      fs.writeFileSync('package.json', JSON.stringify(this.originalPackageJson, null, 2));
      logSuccess('Restored original package.json');
    }
  }

  async runHookCheck(commitMessage = '', verbose = false) {
    try {
      const env = { ...process.env };
      if (commitMessage) {
        env.TEST_COMMIT_MESSAGE = commitMessage;
      }
      if (verbose) {
        env.PACKDEV_VERBOSE = '1';
      }

      const result = execSync('node .github/hooks/check-local-deps.js', {
        encoding: 'utf8',
        stdio: 'pipe',
        env
      });

      return { success: true, output: result };
    } catch (error) {
      return {
        success: false,
        output: error.stdout || '',
        error: error.stderr || error.message
      };
    }
  }

  async demonstrateScenario(title, setup, commitMessage, expectation) {
    logHeader(title);

    await setup();

    logInfo(`Attempting commit with message: "${commitMessage}"`);
    logInfo(`Expected result: ${expectation}`);
    console.log();

    const result = await this.runHookCheck(commitMessage);

    if (result.success) {
      logSuccess('Hook check passed - commit would be allowed');
      if (result.output) {
        console.log(result.output);
      }
    } else {
      logError('Hook check failed - commit would be blocked');
      if (result.output) {
        console.log(result.output);
      }
      if (result.error && result.error !== result.output) {
        console.log(result.error);
      }
    }

    console.log();
  }

  async runDemo() {
    logHeader('packdev GitHub Hooks Demo');
    console.log();
    logInfo('This demo shows how the safety hooks prevent accidental commits with local dependencies');
    console.log();

    await this.setup();

    // Scenario 1: Clean package.json (should pass)
    await this.demonstrateScenario(
      'Scenario 1: Clean Dependencies',
      async () => {
        logStep('Using clean package.json with no local dependencies...');
      },
      'Add new feature implementation',
      '✅ Should allow commit'
    );

    // Scenario 2: Local dependencies, normal commit (should fail)
    await this.demonstrateScenario(
      'Scenario 2: Local Dependencies + Normal Commit',
      async () => {
        await this.createLocalDependency();
      },
      'Add new feature with improvements',
      '❌ Should block commit'
    );

    // Scenario 3: Local dependencies, WIP commit (should pass)
    await this.demonstrateScenario(
      'Scenario 3: Local Dependencies + WIP Commit',
      async () => {
        // Keep the local dependencies from previous scenario
      },
      'WIP: testing new feature with local packages',
      '✅ Should allow WIP commit'
    );

    // Scenario 4: Different WIP formats
    await this.demonstrateScenario(
      'Scenario 4: Different WIP Format',
      async () => {
        // Keep the local dependencies
      },
      'work in progress - debugging issue',
      '✅ Should recognize WIP variations'
    );

    // Scenario 5: Case insensitive WIP
    await this.demonstrateScenario(
      'Scenario 5: Case Insensitive WIP',
      async () => {
        // Keep the local dependencies
      },
      'wip: fixing bugs in authentication',
      '✅ Should work with lowercase'
    );

    // Scenario 6: Draft commits
    await this.demonstrateScenario(
      'Scenario 6: Draft Commits',
      async () => {
        // Keep the local dependencies
      },
      'draft: initial implementation of feature',
      '✅ Should recognize draft commits'
    );

    // Scenario 7: Temporary commits
    await this.demonstrateScenario(
      'Scenario 7: Temporary Commits',
      async () => {
        // Keep the local dependencies
      },
      'temp fix for testing locally',
      '✅ Should recognize temp commits'
    );

    // Scenario 8: Bracketed WIP
    await this.demonstrateScenario(
      'Scenario 8: Bracketed WIP',
      async () => {
        // Keep the local dependencies
      },
      '[WIP] refactoring authentication module',
      '✅ Should recognize [WIP] format'
    );

    // Scenario 9: Verbose mode demo
    logHeader('Scenario 9: Verbose Mode');
    logStep('Running hook with verbose output...');
    console.log();

    const verboseResult = await this.runHookCheck('', true);
    if (!verboseResult.success && verboseResult.output) {
      console.log(verboseResult.output);
    }

    // Cleanup
    await this.restorePackageJson();

    logHeader('Demo Summary');
    console.log();
    logInfo('Key Features Demonstrated:');
    console.log('✅ Detects file: protocol dependencies');
    console.log('✅ Detects relative path dependencies');
    console.log('✅ Blocks normal commits with local deps');
    console.log('✅ Allows WIP commits (case insensitive)');
    console.log('✅ Recognizes "work in progress" phrase');
    console.log('✅ Supports "draft" and "temp" keywords');
    console.log('✅ Handles bracketed formats like [WIP]');
    console.log('✅ Provides clear error messages');
    console.log('✅ Supports verbose mode for debugging');
    console.log();

    logSuccess('🎉 Demo completed successfully!');
    console.log();
    logInfo('To use in your project:');
    console.log('1. Run: packdev setup-hooks');
    console.log('2. Configure: git config core.hooksPath .github/hooks');
    console.log('3. Commit safely knowing local deps are protected!');
  }

  async interactiveDemo() {
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const question = (prompt) => new Promise(resolve => rl.question(prompt, resolve));

    logHeader('Interactive Hook Demo');
    console.log();
    logInfo('This interactive demo lets you test commit messages against local dependencies');
    console.log();

    await this.setup();
    await this.createLocalDependency();

    console.log('Current package.json has these local dependencies:');
    console.log('  📦 my-local-utils: file:../shared/utils');
    console.log('  📦 test-package: file:./local-packages/test-package');
    console.log('  📦 dev-tools: file:../dev-tools (devDependencies)');
    console.log();
    console.log('💡 Try these WIP patterns:');
    console.log('  - "WIP: your message"');
    console.log('  - "work in progress - testing"');
    console.log('  - "draft implementation"');
    console.log('  - "temp fix for debugging"');
    console.log('  - "[WIP] refactoring code"');
    console.log();

    while (true) {
      const commitMessage = await question('Enter a commit message (or "quit" to exit): ');

      if (commitMessage.toLowerCase() === 'quit') {
        break;
      }

      console.log();
      const result = await this.runHookCheck(commitMessage, true);

      if (result.success) {
        logSuccess('✅ Commit would be ALLOWED');
      } else {
        logError('❌ Commit would be BLOCKED');
      }

      if (result.output) {
        console.log(result.output);
      }
      console.log();
    }

    await this.restorePackageJson();
    rl.close();

    logInfo('Interactive demo ended. Package.json restored.');
  }
}

async function main() {
  const args = process.argv.slice(2);
  const demo = new HookDemo();

  try {
    // Check if hooks are set up
    if (!fs.existsSync('.github/hooks/check-local-deps.js')) {
      logError('Hooks not found! Please run: packdev setup-hooks');
      process.exit(1);
    }

    if (args.includes('--interactive') || args.includes('-i')) {
      await demo.interactiveDemo();
    } else {
      await demo.runDemo();
    }

  } catch (error) {
    logError(`Demo failed: ${error.message}`);
    await demo.restorePackageJson();
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { HookDemo };

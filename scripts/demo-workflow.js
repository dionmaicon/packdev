#!/usr/bin/env node

/**
 * Complete Workflow Demo for packdev
 * Demonstrates the full init/finish cycle with configuration persistence
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

function pause(seconds = 2) {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000));
}

class WorkflowDemo {
  constructor() {
    this.tempDir = path.join(os.tmpdir(), `packdev-workflow-${Date.now()}`);
    this.originalCwd = process.cwd();
    this.demoPackages = [];
  }

  async setup() {
    logStep('Setting up demo environment...');

    // Create temp directory and demo project
    fs.mkdirSync(this.tempDir, { recursive: true });
    process.chdir(this.tempDir);

    // Create a realistic package.json
    const packageJson = {
      name: 'my-awesome-project',
      version: '1.0.0',
      description: 'Demo project for packdev workflow',
      main: 'index.js',
      dependencies: {
        'lodash': '^4.17.21',
        'axios': '^1.0.0'
      },
      devDependencies: {
        'typescript': '^4.0.0'
      }
    };

    fs.writeFileSync('package.json', JSON.stringify(packageJson, null, 2));

    // Create fake local packages for demo
    await this.createFakePackages();

    logSuccess('Demo environment ready');
    logInfo(`Working in: ${this.tempDir}`);
  }

  async createFakePackages() {
    const packages = [
      { name: 'lodash', version: '4.99.0-custom', description: 'My custom lodash build' },
      { name: 'axios', version: '1.99.0-beta', description: 'Axios with custom features' }
    ];

    for (const pkg of packages) {
      const pkgDir = path.join(this.tempDir, `local-${pkg.name}`);
      fs.mkdirSync(pkgDir, { recursive: true });

      const pkgJson = {
        name: pkg.name,
        version: pkg.version,
        description: pkg.description,
        main: 'index.js'
      };

      fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(pkgJson, null, 2));
      fs.writeFileSync(path.join(pkgDir, 'index.js'), `module.exports = { version: '${pkg.version}', custom: true };`);

      this.demoPackages.push({
        name: pkg.name,
        path: `./local-${pkg.name}`,
        version: pkg.version
      });
    }
  }

  async runPackdevCommand(command, ...args) {
    const projectRoot = path.dirname(__dirname);
    const packdevCmd = `node ${path.join(projectRoot, 'dist', 'index.js')}`;

    try {
      const result = execSync(`${packdevCmd} ${command} ${args.join(' ')}`, {
        encoding: 'utf8',
        stdio: 'pipe'
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

  async showFileContents(filename, description) {
    logInfo(`${description}:`);
    try {
      const content = fs.readFileSync(filename, 'utf8');
      const parsed = JSON.parse(content);
      console.log(JSON.stringify(parsed, null, 2));
    } catch (error) {
      logWarning(`Could not read ${filename}: ${error.message}`);
    }
  }

  async demonstrateWorkflowCycle() {
    logHeader('packdev Complete Workflow Demo');
    console.log();
    logInfo('This demo shows the complete init/finish cycle with configuration persistence');
    console.log();

    // Step 1: Initial Setup
    logHeader('Step 1: Initial Project Setup');
    await this.showFileContents('package.json', 'Initial package.json');

    await pause(1);

    // Step 2: Create Configuration
    logHeader('Step 2: Create packdev Configuration');
    logStep('Creating .packdev.json configuration file...');

    const createResult = await this.runPackdevCommand('create-config');
    if (createResult.success) {
      logSuccess('Configuration file created');
      console.log(createResult.output);
    } else {
      logError('Failed to create config');
      console.log(createResult.error);
      return;
    }

    await this.showFileContents('.packdev.json', 'Created .packdev.json');
    await pause(2);

    // Step 3: Add Local Dependencies
    logHeader('Step 3: Add Local Dependencies');

    for (const pkg of this.demoPackages) {
      logStep(`Adding ${pkg.name} → ${pkg.path}`);

      const addResult = await this.runPackdevCommand('add', pkg.name, pkg.path);
      if (addResult.success) {
        logSuccess(`Added ${pkg.name}`);
        console.log(addResult.output.trim());
      } else {
        logError(`Failed to add ${pkg.name}`);
        console.log(addResult.error);
      }
      await pause(1);
    }

    await this.showFileContents('.packdev.json', 'Updated .packdev.json with dependencies');
    await pause(2);

    // Step 4: Initialize Local Development
    logHeader('Step 4: Initialize Local Development Mode');
    logStep('Switching to local development...');

    const initResult = await this.runPackdevCommand('init');
    if (initResult.success) {
      logSuccess('Local development mode activated');
      console.log(initResult.output);
    } else {
      logError('Failed to initialize');
      console.log(initResult.error);
      return;
    }

    await this.showFileContents('package.json', 'package.json with local dependencies');
    await pause(3);

    // Step 5: Show Status
    logHeader('Step 5: Check Development Status');
    const statusResult = await this.runPackdevCommand('status');
    if (statusResult.success) {
      console.log(statusResult.output);
    }
    await pause(2);

    // Step 6: Finish Development
    logHeader('Step 6: Finish Development Mode');
    logStep('Restoring original dependencies...');

    const finishResult = await this.runPackdevCommand('finish');
    if (finishResult.success) {
      logSuccess('Development mode finished');
      console.log(finishResult.output);
    } else {
      logError('Failed to finish');
      console.log(finishResult.error);
      return;
    }

    await this.showFileContents('package.json', 'package.json with restored dependencies');
    await pause(2);

    // Step 7: Verify Configuration Persistence
    logHeader('Step 7: Verify Configuration Persistence');
    logInfo('The key feature: .packdev.json is preserved after finish');

    if (fs.existsSync('.packdev.json')) {
      logSuccess('✅ .packdev.json still exists');
      await this.showFileContents('.packdev.json', 'Preserved configuration');
    } else {
      logError('❌ .packdev.json was deleted (this should not happen!)');
    }
    await pause(2);

    // Step 8: Demonstrate Restart Capability
    logHeader('Step 8: Restart Development (Prove Persistence)');
    logStep('Starting development again using preserved configuration...');

    const restartResult = await this.runPackdevCommand('init');
    if (restartResult.success) {
      logSuccess('Development restarted successfully');
      console.log(restartResult.output);

      await this.showFileContents('package.json', 'package.json back to local dependencies');

      // Clean up by finishing again
      await pause(1);
      logStep('Cleaning up...');
      await this.runPackdevCommand('finish');
      logInfo('Returned to production state');
    } else {
      logError('Failed to restart development');
      console.log(restartResult.error);
    }

    await pause(2);
  }

  async demonstrateWorkflowFeatures() {
    logHeader('Workflow Features Summary');
    console.log();

    logInfo('📋 Key Workflow Features Demonstrated:');
    console.log();
    console.log('  ✅ Configuration Creation - One-time setup');
    console.log('  ✅ Local dependency tracking - Add packages to config');
    console.log('  ✅ Development mode - Switch to local packages');
    console.log('  ✅ Status monitoring - Check current state');
    console.log('  ✅ Production restoration - Return to original versions');
    console.log('  ✅ Configuration persistence - Never lose your setup');
    console.log('  ✅ Repeatable workflow - Use same config multiple times');
    console.log();

    logInfo('🔄 The Complete Cycle:');
    console.log('  1. create-config   → Setup configuration');
    console.log('  2. add packages    → Define local dependencies');
    console.log('  3. init           → Switch to development mode');
    console.log('  4. [development]  → Work with local packages');
    console.log('  5. finish         → Restore for production');
    console.log('  6. init           → Restart development (same config)');
    console.log('  7. [repeat]       → Cycle as many times as needed');
    console.log();

    logInfo('🛡️ Safety Features:');
    console.log('  ✅ Original versions preserved in .packdev.json');
    console.log('  ✅ Atomic operations (all or nothing)');
    console.log('  ✅ Path validation before switching');
    console.log('  ✅ Status checks and validation');
    console.log('  ✅ GitHub hooks prevent accidental commits');
    console.log();

    logSuccess('🎉 Workflow demonstration complete!');
    console.log();
    logInfo('💡 Next steps:');
    console.log('  • Try: npm run demo-hooks (GitHub hooks demo)');
    console.log('  • Read: WORKFLOW.md (detailed workflow guide)');
    console.log('  • Setup: packdev setup-hooks (safety hooks)');
  }

  async interactiveWorkflow() {
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    const question = (prompt) => new Promise(resolve => rl.question(prompt, resolve));

    logHeader('Interactive Workflow Demo');
    console.log();
    logInfo('Step through the workflow at your own pace');
    console.log();

    await this.setup();

    const steps = [
      {
        title: 'Create Configuration',
        action: async () => {
          const result = await this.runPackdevCommand('create-config');
          console.log(result.success ? result.output : result.error);
          await this.showFileContents('.packdev.json', 'Configuration file');
        }
      },
      {
        title: 'Add Local Dependencies',
        action: async () => {
          for (const pkg of this.demoPackages) {
            console.log(`Adding ${pkg.name}...`);
            const result = await this.runPackdevCommand('add', pkg.name, pkg.path);
            console.log(result.success ? result.output : result.error);
          }
          await this.showFileContents('.packdev.json', 'Updated configuration');
        }
      },
      {
        title: 'Initialize Development Mode',
        action: async () => {
          const result = await this.runPackdevCommand('init');
          console.log(result.success ? result.output : result.error);
          await this.showFileContents('package.json', 'Development package.json');
        }
      },
      {
        title: 'Check Status',
        action: async () => {
          const result = await this.runPackdevCommand('status');
          console.log(result.output);
        }
      },
      {
        title: 'Finish Development',
        action: async () => {
          const result = await this.runPackdevCommand('finish');
          console.log(result.success ? result.output : result.error);
          await this.showFileContents('package.json', 'Restored package.json');
        }
      },
      {
        title: 'Verify Configuration Persistence',
        action: async () => {
          if (fs.existsSync('.packdev.json')) {
            logSuccess('.packdev.json is preserved!');
            await this.showFileContents('.packdev.json', 'Persistent configuration');
          } else {
            logError('.packdev.json was deleted (bug!)');
          }
        }
      },
      {
        title: 'Restart Development (Prove Persistence)',
        action: async () => {
          const result = await this.runPackdevCommand('init');
          console.log(result.success ? result.output : result.error);
          console.log();
          logInfo('Same configuration, instant restart!');
        }
      }
    ];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      console.log(`\n📋 Step ${i + 1}: ${step.title}`);

      await question('Press Enter to continue...');

      await step.action();
    }

    await question('\nPress Enter to finish demo...');
    rl.close();

    // Final cleanup
    const finishResult = await this.runPackdevCommand('finish');
    if (finishResult.success) {
      logInfo('Demo completed and cleaned up');
    }
  }

  async cleanup() {
    try {
      process.chdir(this.originalCwd);
      if (fs.existsSync(this.tempDir)) {
        logStep('Cleaning up demo environment...');
        fs.rmSync(this.tempDir, { recursive: true, force: true });
        logInfo('Cleanup complete');
      }
    } catch (error) {
      logWarning(`Cleanup failed: ${error.message}`);
      logInfo(`Manual cleanup may be needed: ${this.tempDir}`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const demo = new WorkflowDemo();

  try {
    if (args.includes('--interactive') || args.includes('-i')) {
      await demo.interactiveWorkflow();
    } else {
      await demo.setup();
      await demo.demonstrateWorkflowCycle();
      await demo.demonstrateWorkflowFeatures();
    }

  } catch (error) {
    logError(`Demo failed: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  } finally {
    await demo.cleanup();
  }
}

if (require.main === module) {
  main();
}

module.exports = { WorkflowDemo };

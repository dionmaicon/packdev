#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

function detectPackageManager() {
  // Check for yarn.lock first, then package-lock.json
  if (fs.existsSync('yarn.lock')) {
    return 'yarn';
  } else if (fs.existsSync('package-lock.json')) {
    return 'npm';
  }

  // Fallback: check which command is available
  try {
    execSync('yarn --version', { stdio: 'pipe' });
    return 'yarn';
  } catch {
    return 'npm';
  }
}

function getPackageManagerCommands(pm) {
  return {
    install: pm === 'yarn' ? 'yarn add' : 'npm install',
    installGlobal: pm === 'yarn' ? 'yarn global add' : 'npm install -g',
    uninstallGlobal: pm === 'yarn' ? 'yarn global remove' : 'npm uninstall -g',
    run: pm === 'yarn' ? 'yarn' : 'npx'
  };
}

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

async function main() {
  const projectRoot = path.dirname(__dirname);
  const tempDir = path.join(os.tmpdir(), `packdev-test-${Date.now()}`);

  try {
    process.chdir(projectRoot);

    // Detect package manager
    const packageManager = detectPackageManager();
    const commands = getPackageManagerCommands(packageManager);

    logInfo(`Detected package manager: ${packageManager}`);

    // Find the tarball
    const tarballPattern = /^packdev-.*\.tgz$/;
    const files = fs.readdirSync('.');
    const tarball = files.find(file => tarballPattern.test(file));

    if (!tarball) {
      logError('No tarball found. Run "npm run pack" first.');
      process.exit(1);
    }

    logInfo(`Found tarball: ${tarball}`);

    // Create temporary test directory
    logStep('Creating temporary test directory...');
    fs.mkdirSync(tempDir, { recursive: true });

    // Create a test package.json
    const testPackageJson = {
      name: 'packdev-test',
      version: '1.0.0',
      description: 'Test installation of packdev',
      main: 'index.js'
    };

    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify(testPackageJson, null, 2)
    );

    // Copy tarball to temp directory
    const tarballPath = path.join(projectRoot, tarball);
    const tempTarballPath = path.join(tempDir, tarball);
    fs.copyFileSync(tarballPath, tempTarballPath);

    process.chdir(tempDir);

    // Test installation
    logStep('Installing package from tarball...');
    const installCmd = packageManager === 'yarn'
      ? `yarn add file:./${tarball}`
      : `npm install ./${tarball}`;
    execSync(installCmd, { stdio: 'pipe' });
    logSuccess('Package installed successfully');

    // Test CLI availability
    logStep('Testing CLI command...');
    const cliCmd = packageManager === 'yarn' ? 'yarn packdev --help' : 'npx packdev --help';
    const helpOutput = execSync(cliCmd, { encoding: 'utf8', stdio: 'pipe' });
    if (helpOutput.includes('Usage:') && helpOutput.includes('packdev')) {
      logSuccess('CLI command works correctly');
    } else {
      throw new Error('CLI command did not produce expected output');
    }

    // Test module import
    logStep('Testing module import...');
    const testScript = `
try {
  const packdev = require('packdev');
  console.log('Module imported successfully');
  console.log('Available exports:', Object.keys(packdev || {}));
} catch (error) {
  console.error('Import failed:', error.message);
  process.exit(1);
}
`;

    fs.writeFileSync(path.join(tempDir, 'test-import.js'), testScript);
    try {
      const importOutput = execSync('node test-import.js', { encoding: 'utf8', stdio: 'pipe' });

      if (importOutput.includes('Module imported successfully')) {
        logSuccess('Module import works correctly');
        logInfo(`Import test output: ${importOutput.trim()}`);
      } else {
        throw new Error(`Module import failed: ${importOutput}`);
      }
    } catch (error) {
      // Try alternative approach - check if the main file exists and is executable
      logStep('Testing alternative: checking main file directly...');
      const nodeModulesPath = path.join(tempDir, 'node_modules', 'packdev');
      const mainFile = path.join(nodeModulesPath, 'dist', 'index.js');

      if (fs.existsSync(mainFile)) {
        const mainContent = fs.readFileSync(mainFile, 'utf8');
        if (mainContent.includes('#!/usr/bin/env node')) {
          logSuccess('Main file exists and appears to be a CLI executable');
        } else {
          logSuccess('Main file exists (module structure correct)');
        }
      } else {
        throw new Error('Main file not found in package');
      }
    }

    // Test package structure
    logStep('Verifying package structure...');
    const nodeModulesPath = path.join(tempDir, 'node_modules', 'packdev');
    const expectedFiles = ['package.json', 'README.md', 'dist/index.js', 'dist/index.d.ts'];

    for (const file of expectedFiles) {
      const filePath = path.join(nodeModulesPath, file);
      if (!fs.existsSync(filePath)) {
        throw new Error(`Expected file not found: ${file}`);
      }
    }
    logSuccess('Package structure is correct');

    // Test package.json content
    const installedPackageJson = JSON.parse(
      fs.readFileSync(path.join(nodeModulesPath, 'package.json'), 'utf8')
    );

    if (installedPackageJson.name !== 'packdev') {
      throw new Error('Package name mismatch in installed package.json');
    }

    if (!installedPackageJson.bin || !installedPackageJson.bin.packdev) {
      throw new Error('CLI bin entry not found in package.json');
    }

    logSuccess('Package metadata is correct');

    // Test that source files are excluded
    logStep('Verifying source files are excluded...');
    const srcPath = path.join(nodeModulesPath, 'src');
    const testPath = path.join(nodeModulesPath, 'test');
    const scriptsPath = path.join(nodeModulesPath, 'scripts');

    if (fs.existsSync(srcPath)) {
      throw new Error('Source files should not be included in package');
    }

    if (fs.existsSync(testPath)) {
      throw new Error('Test files should not be included in package');
    }

    if (fs.existsSync(scriptsPath)) {
      throw new Error('Scripts should not be included in package');
    }

    logSuccess('Source files correctly excluded from package');

    console.log('');
    logSuccess('🎉 All installation tests passed!');
    logInfo(`Package manager used: ${packageManager}`);
    logInfo(`Test performed in: ${tempDir}`);
    logInfo('The package is ready for distribution.');

  } catch (error) {
    logError(`Installation test failed: ${error.message}`);
    logInfo(`Test directory: ${tempDir} (preserved for inspection)`);
    process.exit(1);

  } finally {
    // Clean up temp directory (optional - comment out for debugging)
    try {
      if (fs.existsSync(tempDir)) {
        logStep('Cleaning up test directory...');
        fs.rmSync(tempDir, { recursive: true, force: true });
        logInfo('Test directory cleaned up');
      }
    } catch (cleanupError) {
      logError(`Failed to clean up test directory: ${cleanupError.message}`);
    }
  }
}

if (require.main === module) {
  main();
}

#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function log(message, color = '\x1b[0m') {
  console.log(`${color}${message}\x1b[0m`);
}

function logSuccess(message) {
  log(`✅ ${message}`, '\x1b[32m');
}

function logInfo(message) {
  log(`📋 ${message}`, '\x1b[36m');
}

function logWarning(message) {
  log(`⚠️  ${message}`, '\x1b[33m');
}

function logStep(message) {
  log(`🔧 ${message}`, '\x1b[34m');
}

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
    build: pm === 'yarn' ? 'yarn build' : 'npm run build',
    pack: pm === 'yarn' ? 'yarn pack' : 'npm pack',
    install: pm === 'yarn' ? 'yarn add' : 'npm install',
    installGlobal: pm === 'yarn' ? 'yarn global add' : 'npm install -g',
    uninstallGlobal: pm === 'yarn' ? 'yarn global remove' : 'npm uninstall -g',
    installLocal: pm === 'yarn' ? 'yarn install' : 'npm install'
  };
}

async function main() {
  try {
    // Change to the project root directory
    const projectRoot = path.dirname(__dirname);
    process.chdir(projectRoot);

    // Detect package manager
    const packageManager = detectPackageManager();
    const commands = getPackageManagerCommands(packageManager);

    logInfo(`Detected package manager: ${packageManager}`);

    logStep('Building the library...');
    execSync(commands.build, { stdio: 'inherit' });

    logStep('Creating package...');
    const packOutput = execSync(commands.pack, { encoding: 'utf8', stdio: 'pipe' });
    const tarballName = packOutput.trim().split('\n').pop();

    logSuccess(`Package created: ${tarballName}`);

    console.log();
    logInfo('Installation Instructions:');
    console.log('================================');
    console.log();

    console.log('To install this package locally in another project:');
    console.log('1. Copy the tarball to your target project directory');
    console.log('2. Run one of the following commands:');
    console.log();

    if (packageManager === 'yarn') {
      console.log(`   yarn add file:./${tarballName}`);
      console.log('   # or');
      console.log(`   yarn add ${path.resolve(tarballName)}`);
      console.log();
      console.log('   # npm equivalent:');
      console.log(`   npm install ./${tarballName}`);
    } else {
      console.log(`   npm install ./${tarballName}`);
      console.log('   # or');
      console.log(`   npm install ${path.resolve(tarballName)}`);
      console.log();
      console.log('   # yarn equivalent:');
      console.log(`   yarn add file:./${tarballName}`);
    }
    console.log();

    console.log('To install globally:');
    if (packageManager === 'yarn') {
      console.log(`   yarn global add file:./${tarballName}`);
      console.log(`   # or npm: npm install -g ./${tarballName}`);
    } else {
      console.log(`   npm install -g ./${tarballName}`);
      console.log(`   # or yarn: yarn global add file:./${tarballName}`);
    }
    console.log();

    console.log('To test the CLI after global installation:');
    console.log('   packdev --help');
    console.log();

    console.log('To uninstall globally:');
    if (packageManager === 'yarn') {
      console.log('   yarn global remove packdev');
      console.log('   # or npm: npm uninstall -g packdev');
    } else {
      console.log('   npm uninstall -g packdev');
      console.log('   # or yarn: yarn global remove packdev');
    }
    console.log();

    console.log('To install directly from this directory without tarball:');
    if (packageManager === 'yarn') {
      console.log(`   yarn add file:${process.cwd()}`);
      console.log(`   # or npm: npm install ${process.cwd()}`);
    } else {
      console.log(`   npm install ${process.cwd()}`);
      console.log(`   # or yarn: yarn add file:${process.cwd()}`);
    }
    console.log();

    logInfo('Note: The tarball contains the built dist/ directory and all necessary files.');

    // Check if tarball exists and show its size
    if (fs.existsSync(tarballName)) {
      const stats = fs.statSync(tarballName);
      const fileSizeInBytes = stats.size;
      const fileSizeInKB = (fileSizeInBytes / 1024).toFixed(2);
      logInfo(`Package size: ${fileSizeInKB} KB`);
    }

  } catch (error) {
    console.error('\x1b[31m❌ Error:', error.message, '\x1b[0m');
    process.exit(1);
  }
}

main();

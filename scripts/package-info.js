#!/usr/bin/env node

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

function logHeader(message) {
  log(`\n🚀 ${message}`, '\x1b[35m');
}

function detectPackageManager() {
  const fs = require('fs');

  // Check for yarn.lock first, then package-lock.json
  if (fs.existsSync('yarn.lock')) {
    return 'yarn';
  } else if (fs.existsSync('package-lock.json')) {
    return 'npm';
  }

  // Fallback: check which command is available
  try {
    const { execSync } = require('child_process');
    execSync('yarn --version', { stdio: 'pipe' });
    return 'yarn';
  } catch {
    return 'npm';
  }
}

function main() {
  const projectRoot = path.dirname(__dirname);

  try {
    // Change to project root and detect package manager
    process.chdir(projectRoot);
    const packageManager = detectPackageManager();

    // Read package.json
    const packageJsonPath = path.join(projectRoot, 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

    console.log('\x1b[36m' + '='.repeat(60) + '\x1b[0m');
    logHeader(`${packageJson.name} - Package Information`);
    console.log('\x1b[36m' + '='.repeat(60) + '\x1b[0m');

    logInfo(`Version: ${packageJson.version}`);
    logInfo(`Description: ${packageJson.description}`);
    logInfo(`Main Entry: ${packageJson.main}`);
    logInfo(`CLI Binary: ${packageJson.bin ? packageJson.bin.packdev : 'Not configured'}`);
    logInfo(`Package Manager: ${packageManager}`);

    // Check build status
    logHeader('Build Status');
    const distPath = path.join(projectRoot, 'dist');
    if (fs.existsSync(distPath)) {
      const files = fs.readdirSync(distPath);
      logSuccess(`Built files available (${files.length} files)`);
      logInfo(`Dist files: ${files.join(', ')}`);
    } else {
      logWarning('No built files found. Run "npm run build" first.');
    }

    // Check for existing tarballs
    logHeader('Available Packages');
    const tarballPattern = /^.*\.tgz$/;
    const projectFiles = fs.readdirSync(projectRoot);
    const tarballs = projectFiles.filter(file => tarballPattern.test(file));

    if (tarballs.length > 0) {
      logSuccess(`Found ${tarballs.length} package tarball(s):`);
      tarballs.forEach(tarball => {
        const stats = fs.statSync(path.join(projectRoot, tarball));
        const sizeKB = (stats.size / 1024).toFixed(2);
        logInfo(`  ${tarball} (${sizeKB} KB)`);
      });
    } else {
      logWarning('No package tarballs found.');
    }

    logHeader('Available Commands');

    console.log('\n📦 Packaging Commands:');
    if (packageManager === 'yarn') {
      console.log('  yarn pack            - Build and create package tarball');
      console.log('  yarn pack:bash       - Create package using bash script');
      console.log('  yarn test-install    - Test package installation');
    } else {
      console.log('  npm run pack         - Build and create package tarball');
      console.log('  npm run pack:bash    - Create package using bash script');
      console.log('  npm run test-install - Test package installation');
    }

    console.log('\n🔧 Development Commands:');
    if (packageManager === 'yarn') {
      console.log('  yarn build           - Compile TypeScript to JavaScript');
      console.log('  yarn dev             - Run in development mode');
      console.log('  yarn watch           - Watch mode for development');
      console.log('  yarn clean           - Remove dist directory');
    } else {
      console.log('  npm run build        - Compile TypeScript to JavaScript');
      console.log('  npm run dev          - Run in development mode');
      console.log('  npm run watch        - Watch mode for development');
      console.log('  npm run clean        - Remove dist directory');
    }

    console.log('\n🧪 Testing Commands:');
    if (packageManager === 'yarn') {
      console.log('  yarn test-demo       - Run comprehensive demo tests');
      console.log('  yarn test-install    - Test package installation');
      console.log('  yarn typecheck       - TypeScript type checking');
    } else {
      console.log('  npm run test-demo    - Run comprehensive demo tests');
      console.log('  npm run test-install - Test package installation');
      console.log('  npm run typecheck    - TypeScript type checking');
    }

    logHeader('Installation Options');

    console.log('\n🎯 Local Installation (in another project):');
    if (tarballs.length > 0) {
      if (packageManager === 'yarn') {
        console.log(`  yarn add file:./${tarballs[0]}`);
        console.log(`  yarn add ${path.resolve(projectRoot, tarballs[0])}`);
        console.log(`  # npm: npm install ./${tarballs[0]}`);
      } else {
        console.log(`  npm install ./${tarballs[0]}`);
        console.log(`  npm install ${path.resolve(projectRoot, tarballs[0])}`);
        console.log(`  # yarn: yarn add file:./${tarballs[0]}`);
      }
    } else {
      if (packageManager === 'yarn') {
        console.log('  yarn add file:./packdev-1.0.0.tgz  # After running yarn pack');
        console.log('  # npm: npm install ./packdev-1.0.0.tgz');
      } else {
        console.log('  npm install ./packdev-1.0.0.tgz  # After running npm run pack');
        console.log('  # yarn: yarn add file:./packdev-1.0.0.tgz');
      }
    }
    if (packageManager === 'yarn') {
      console.log(`  yarn add file:${projectRoot}  # Direct from directory`);
      console.log(`  # npm: npm install ${projectRoot}`);
    } else {
      console.log(`  npm install ${projectRoot}  # Direct from directory`);
      console.log(`  # yarn: yarn add file:${projectRoot}`);
    }

    console.log('\n🌐 Global Installation:');
    if (tarballs.length > 0) {
      if (packageManager === 'yarn') {
        console.log(`  yarn global add file:./${tarballs[0]}`);
        console.log(`  # npm: npm install -g ./${tarballs[0]}`);
      } else {
        console.log(`  npm install -g ./${tarballs[0]}`);
        console.log(`  # yarn: yarn global add file:./${tarballs[0]}`);
      }
    } else {
      if (packageManager === 'yarn') {
        console.log('  yarn global add file:./packdev-1.0.0.tgz  # After running yarn pack');
        console.log('  # npm: npm install -g ./packdev-1.0.0.tgz');
      } else {
        console.log('  npm install -g ./packdev-1.0.0.tgz  # After running npm run pack');
        console.log('  # yarn: yarn global add file:./packdev-1.0.0.tgz');
      }
    }
    if (packageManager === 'yarn') {
      console.log(`  yarn global add file:${projectRoot}  # Direct from directory`);
      console.log(`  # npm: npm install -g ${projectRoot}`);
    } else {
      console.log(`  npm install -g ${projectRoot}  # Direct from directory`);
      console.log(`  # yarn: yarn global add file:${projectRoot}`);
    }

    console.log('\n🔍 Testing Installation:');
    if (packageManager === 'yarn') {
      console.log('  yarn packdev --help   # Test local installation');
      console.log('  packdev --help        # Test global installation');
      console.log('  # npm: npx packdev --help');
    } else {
      console.log('  npx packdev --help    # Test local installation');
      console.log('  packdev --help        # Test global installation');
      console.log('  # yarn: yarn packdev --help');
    }

    console.log('\n🗑️  Uninstalling:');
    if (packageManager === 'yarn') {
      console.log('  yarn remove packdev       # Local uninstall');
      console.log('  yarn global remove packdev # Global uninstall');
      console.log('  # npm: npm uninstall packdev');
    } else {
      console.log('  npm uninstall packdev     # Local uninstall');
      console.log('  npm uninstall -g packdev  # Global uninstall');
      console.log('  # yarn: yarn remove packdev');
    }

    logHeader('Package Contents');

    console.log('\n✅ Included in package:');
    console.log('  • dist/ - Compiled JavaScript and type definitions');
    console.log('  • package.json - Package metadata');
    console.log('  • README.md - Documentation');
    console.log('  • LICENSE - License file (if present)');

    console.log('\n❌ Excluded from package:');
    console.log('  • src/ - TypeScript source files');
    console.log('  • test/ - Test files and demos');
    console.log('  • scripts/ - Development scripts');
    console.log('  • node_modules/ - Dependencies');
    console.log('  • Configuration files (tsconfig.json, etc.)');

    logHeader('Quick Start Guide');

    console.log('\n1️⃣  Build and package:');
    if (packageManager === 'yarn') {
      console.log('   yarn pack');
    } else {
      console.log('   npm run pack');
    }

    console.log('\n2️⃣  Test the package:');
    if (packageManager === 'yarn') {
      console.log('   yarn test-install');
    } else {
      console.log('   npm run test-install');
    }

    console.log('\n3️⃣  Install in another project:');
    if (tarballs.length > 0) {
      if (packageManager === 'yarn') {
        console.log(`   yarn add file:./${tarballs[0]}`);
      } else {
        console.log(`   npm install ./${tarballs[0]}`);
      }
    } else {
      if (packageManager === 'yarn') {
        console.log('   yarn add file:./packdev-1.0.0.tgz');
      } else {
        console.log('   npm install ./packdev-1.0.0.tgz');
      }
    }

    console.log('\n4️⃣  Use the CLI:');
    if (packageManager === 'yarn') {
      console.log('   yarn packdev --help');
    } else {
      console.log('   npx packdev --help');
    }

    logHeader('Documentation');

    console.log('\n📖 For detailed information:');
    console.log('  • README.md - Complete usage guide');
    console.log('  • PACKAGING.md - Detailed packaging instructions');

    console.log('\n\x1b[36m' + '='.repeat(60) + '\x1b[0m');
    logSuccess('Package information displayed successfully!');
    console.log('\x1b[36m' + '='.repeat(60) + '\x1b[0m\n');

  } catch (error) {
    console.error('\x1b[31m❌ Error reading package information:', error.message, '\x1b[0m');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

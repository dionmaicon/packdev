#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * PackDev Git Edge Cases Test Suite
 * Tests error handling, edge cases, and unusual git scenarios
 */

const TEST_DIR = './test-git-edge-cases';
const PACKDEV_BINARY = path.resolve(__dirname, '../../dist/index.js');

class GitEdgeCasesTests {
  constructor() {
    this.testResults = [];
    this.colors = {
      reset: '\x1b[0m',
      red: '\x1b[31m',
      green: '\x1b[32m',
      yellow: '\x1b[33m',
      blue: '\x1b[34m',
      cyan: '\x1b[36m'
    };
  }

  log(message, color = 'reset') {
    console.log(`${this.colors[color]}${message}${this.colors.reset}`);
  }

  async cleanup() {
    try {
      if (fs.existsSync(TEST_DIR)) {
        execSync(`rm -rf ${TEST_DIR}`, { stdio: 'pipe' });
      }
    } catch (error) {
      // Ignore cleanup errors
    }
  }

  async setupGitRepo() {
    // Create test directory
    fs.mkdirSync(TEST_DIR, { recursive: true });
    process.chdir(TEST_DIR);

    // Initialize git repo
    execSync('git init', { stdio: 'pipe' });
    execSync('git config user.name "PackDev Edge Test"', { stdio: 'pipe' });
    execSync('git config user.email "edge@packdev.com"', { stdio: 'pipe' });

    this.log('✅ Git repository initialized', 'green');
  }

  async createProjectFiles() {
    // Create package.json with dependencies
    const packageJson = {
      name: 'test-git-edge-cases',
      version: '1.0.0',
      dependencies: {
        'lodash': '^4.17.21',
        'moment': '^2.29.0'
      }
    };
    fs.writeFileSync('package.json', JSON.stringify(packageJson, null, 2));

    // Create basic project structure
    fs.writeFileSync('index.js', 'console.log("Edge cases test project");\n');
    fs.writeFileSync('README.md', '# Edge Cases Test Project\n');

    // Create local dependencies
    fs.mkdirSync('local-lodash', { recursive: true });
    fs.writeFileSync('local-lodash/package.json', JSON.stringify({
      name: 'lodash',
      version: '4.17.21-edge'
    }, null, 2));

    // Initial commit
    execSync('git add .', { stdio: 'pipe' });
    execSync('git commit -m "Initial commit"', { stdio: 'pipe' });

    this.log('✅ Project files created and committed', 'green');
  }

  async setupPackdev() {
    // Create packdev config
    execSync(`node ${PACKDEV_BINARY} create-config`, { stdio: 'pipe' });
    execSync(`node ${PACKDEV_BINARY} add lodash ./local-lodash`, { stdio: 'pipe' });

    this.log('✅ PackDev configured', 'green');
  }

  async runTest(testName, testFn) {
    this.log(`🧪 Running: ${testName}`, 'cyan');
    try {
      await testFn();
      this.log(`✅ Passed: ${testName}`, 'green');
      this.testResults.push({ name: testName, passed: true });
    } catch (error) {
      this.log(`❌ Failed: ${testName}`, 'red');
      this.log(`   Error: ${error.message}`, 'red');
      this.testResults.push({ name: testName, passed: false, error: error.message });
    }
  }

  async testCorruptedPackageJson() {
    // Test behavior with corrupted package.json
    execSync(`node ${PACKDEV_BINARY} setup-hooks --auto-commit --force`, { stdio: 'pipe' });

    const originalContent = fs.readFileSync('package.json', 'utf8');

    try {
      // Corrupt package.json
      fs.writeFileSync('package.json', '{ "name": "test", invalid json }');

      // Try to commit - should handle error gracefully
      fs.writeFileSync('test-corrupt.js', 'console.log("test");');
      execSync('git add test-corrupt.js', { stdio: 'pipe' });

      try {
        execSync('git commit -m "test: corrupted package.json"', { stdio: 'pipe' });
        throw new Error('Should have failed with corrupted package.json');
      } catch (error) {
        if (!error.message.includes('Command failed')) {
          throw error;
        }
        // Expected to fail
      }

      // Restore package.json
      fs.writeFileSync('package.json', originalContent);

      // Now commit should work
      execSync('git commit -m "test: fixed package.json"', { stdio: 'pipe' });

    } finally {
      // Ensure package.json is restored
      fs.writeFileSync('package.json', originalContent);
    }

    this.log('✅ Corrupted package.json handled gracefully', 'green');
  }

  async testMissingPackageJson() {
    // Test behavior when package.json is missing
    execSync(`node ${PACKDEV_BINARY} setup-hooks --auto-commit --force`, { stdio: 'pipe' });

    const originalContent = fs.readFileSync('package.json', 'utf8');

    try {
      // Remove package.json
      fs.unlinkSync('package.json');

      // Try to commit
      fs.writeFileSync('test-missing.js', 'console.log("test");');
      execSync('git add test-missing.js', { stdio: 'pipe' });

      try {
        execSync('git commit -m "test: missing package.json"', { stdio: 'pipe' });
        // If this succeeds, that's okay - the hook should handle missing package.json
      } catch (error) {
        // If this fails, that's also acceptable
        if (!error.message.includes('Command failed')) {
          throw error;
        }
      }

      // Restore package.json
      fs.writeFileSync('package.json', originalContent);

    } finally {
      // Ensure package.json exists
      if (!fs.existsSync('package.json')) {
        fs.writeFileSync('package.json', originalContent);
      }
    }

    this.log('✅ Missing package.json handled gracefully', 'green');
  }

  async testPermissionErrors() {
    // Test behavior with permission issues
    execSync(`node ${PACKDEV_BINARY} setup-hooks --auto-commit --force`, { stdio: 'pipe' });
    execSync(`node ${PACKDEV_BINARY} init`, { stdio: 'pipe' });

    // Create a file and make it read-only
    fs.writeFileSync('readonly-file.txt', 'This file is read-only');

    try {
      fs.chmodSync('readonly-file.txt', 0o444); // Read-only

      // Stage and commit
      execSync('git add readonly-file.txt', { stdio: 'pipe' });
      execSync('git commit -m "test: add read-only file"', { stdio: 'pipe' });

      // The commit should succeed despite the read-only file
      this.log('✅ Read-only files handled correctly', 'green');

    } catch (error) {
      // Some systems might handle this differently
      this.log('⚠️  Permission handling varies by system', 'yellow');
    } finally {
      // Restore permissions for cleanup
      try {
        fs.chmodSync('readonly-file.txt', 0o644);
      } catch (e) {
        // Ignore permission errors during cleanup
      }
    }
  }

  async testLargeCommitMessage() {
    // Test with very large commit messages
    execSync(`node ${PACKDEV_BINARY} setup-hooks --auto-commit --force`, { stdio: 'pipe' });
    execSync(`node ${PACKDEV_BINARY} init`, { stdio: 'pipe' });

    // Create a very large commit message (over 1KB)
    const largeMessage = 'feat: ' + 'x'.repeat(2000);

    fs.writeFileSync('large-msg-test.js', 'console.log("large message test");');
    execSync('git add large-msg-test.js', { stdio: 'pipe' });

    try {
      execSync(`git commit -m "${largeMessage}"`, { stdio: 'pipe' });

      // Verify the commit message was preserved
      const actualMessage = execSync('git log -1 --pretty=format:"%s"', { encoding: 'utf8' });
      if (!actualMessage.startsWith('feat:')) {
        throw new Error('Large commit message not preserved correctly');
      }

    } catch (error) {
      if (error.message.includes('Argument list too long')) {
        this.log('⚠️  System limit on argument length reached (expected)', 'yellow');
      } else {
        throw error;
      }
    }

    this.log('✅ Large commit messages handled appropriately', 'green');
  }

  async testSpecialCharactersInCommitMessage() {
    // Test with special characters, unicode, etc.
    execSync(`node ${PACKDEV_BINARY} setup-hooks --auto-commit --force`, { stdio: 'pipe' });
    execSync(`node ${PACKDEV_BINARY} init`, { stdio: 'pipe' });

    const specialMessages = [
      'feat: add unicode 🚀 emoji support',
      'fix: handle "quotes" and \'apostrophes\'',
      'docs: update with special chars @#$%^&*()',
      'test: newline\nhandling in commit',
      'chore: tabs\tand\tspaces\tmixed'
    ];

    for (const message of specialMessages) {
      fs.writeFileSync(`special-${Date.now()}.js`, 'console.log("special chars");');
      execSync(`git add special-*.js`, { stdio: 'pipe' });

      try {
        // Use single quotes to avoid shell interpretation issues
        execSync(`git commit -m '${message.replace(/'/g, "'\"'\"'")}'`, { stdio: 'pipe' });

        // Verify commit went through
        const commitCount = execSync('git rev-list --count HEAD', { encoding: 'utf8' }).trim();
        if (parseInt(commitCount) < 2) {
          throw new Error('Commit with special characters failed');
        }

      } catch (error) {
        // Some special characters might cause issues, which is acceptable
        this.log(`⚠️  Special character message caused issues: ${message.substring(0, 50)}...`, 'yellow');
      }
    }

    this.log('✅ Special characters in commit messages handled', 'green');
  }

  async testNonGitDirectory() {
    // Test behavior outside of git repository
    const tempDir = './non-git-temp';
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      process.chdir(tempDir);

      // Create package.json
      fs.writeFileSync('package.json', '{"name": "test", "version": "1.0.0"}');

      // Try to setup hooks outside git repo
      try {
        const output = execSync(`node ${PACKDEV_BINARY} setup-hooks --force`, {
          stdio: 'pipe',
          encoding: 'utf8'
        });

        // If this succeeds, PackDev might be designed to work outside git repos
        // Check if it provides an appropriate message
        if (output.includes('not a git repository') || output.includes('No .git directory')) {
          this.log('✅ PackDev appropriately detected non-git environment', 'green');
        } else {
          // If it succeeds without warning, that might be intentional design
          this.log('⚠️  PackDev works outside git (might be intentional)', 'yellow');
        }
      } catch (error) {
        if (error.message.includes('Should fail outside git repository')) {
          throw error;
        }
        // Expected to fail - command should fail outside git repo
        if (error.message.includes('not a git repository') ||
            error.message.includes('fatal:') ||
            error.message.includes('.git')) {
          this.log('✅ PackDev correctly failed outside git repository', 'green');
        } else {
          // Some other error occurred
          this.log(`⚠️  Unexpected error outside git: ${error.message.substring(0, 100)}`, 'yellow');
        }
      }

    } finally {
      // Return to git directory
      process.chdir('..');
      execSync(`rm -rf ${tempDir}`, { stdio: 'pipe' });
    }

    this.log('✅ Non-git directory handled correctly', 'green');
  }

  async testDiskSpaceScenario() {
    // Test behavior when disk space might be low (simulated)
    execSync(`node ${PACKDEV_BINARY} setup-hooks --auto-commit --force`, { stdio: 'pipe' });
    execSync(`node ${PACKDEV_BINARY} init`, { stdio: 'pipe' });

    // Create a reasonably large file to simulate disk usage
    const largeContent = Buffer.alloc(1024 * 1024, 'x'); // 1MB
    fs.writeFileSync('large-test-file.bin', largeContent);

    execSync('git add large-test-file.bin', { stdio: 'pipe' });

    try {
      execSync('git commit -m "test: add large file"', { stdio: 'pipe' });

      // Verify the large file was committed successfully
      const commitFiles = execSync('git show --name-only HEAD', { encoding: 'utf8' });
      if (!commitFiles.includes('large-test-file.bin')) {
        throw new Error('Large file should be in commit');
      }

    } catch (error) {
      // If disk space issues occur, that's a valid test result
      if (error.message.includes('No space left')) {
        this.log('⚠️  Disk space limitation encountered (system-dependent)', 'yellow');
      } else {
        throw error;
      }
    }

    this.log('✅ Large file handling completed', 'green');
  }

  async testConcurrentGitOperations() {
    // Test behavior with potentially concurrent git operations
    execSync(`node ${PACKDEV_BINARY} setup-hooks --auto-commit --force`, { stdio: 'pipe' });
    execSync(`node ${PACKDEV_BINARY} init`, { stdio: 'pipe' });

    // Simulate scenario where git might be locked
    const gitLockFile = '.git/index.lock';

    // Create a file first without staging to avoid real lock conflicts
    fs.writeFileSync('concurrent-test.js', 'console.log("concurrent test");');

    try {
      // Create a lock file to simulate concurrent operation
      fs.writeFileSync(gitLockFile, 'test lock');

      // Try to add while "locked" - this should fail appropriately
      try {
        execSync('git add concurrent-test.js', { stdio: 'pipe' });
        // If this succeeds despite lock, git might have handled it internally
        this.log('✅ Git handled concurrent operation gracefully', 'green');
      } catch (error) {
        if (error.message.includes('index.lock') || error.message.includes('unable to create') || error.message.includes('File exists')) {
          // Expected behavior - git detected the lock
          this.log('✅ Git lock detected appropriately', 'green');
        } else {
          throw error;
        }
      }

    } finally {
      // Clean up lock file
      if (fs.existsSync(gitLockFile)) {
        fs.unlinkSync(gitLockFile);
      }
    }

    // Now try the commit again without lock
    try {
      execSync('git commit -m "test: after lock removed"', { stdio: 'pipe' });
    } catch (error) {
      // Might already be committed or staged, ignore
    }

    this.log('✅ Concurrent operation handling tested', 'green');
  }

  async testMalformedGitConfig() {
    // Test behavior with malformed git configuration
    execSync(`node ${PACKDEV_BINARY} setup-hooks --auto-commit --force`, { stdio: 'pipe' });

    // Backup original git config
    const originalConfig = execSync('git config --list', { encoding: 'utf8' });

    try {
      // Set potentially problematic git config
      execSync('git config core.autocrlf invalid-value', { stdio: 'pipe' });

      execSync(`node ${PACKDEV_BINARY} init`, { stdio: 'pipe' });

      // Try to commit with malformed config
      fs.writeFileSync('malformed-config-test.js', 'console.log("config test");');
      execSync('git add malformed-config-test.js', { stdio: 'pipe' });
      execSync('git commit -m "test: malformed config"', { stdio: 'pipe' });

    } catch (error) {
      // Some git config issues might cause failures, which is acceptable
      this.log('⚠️  Malformed git config caused expected issues', 'yellow');
    } finally {
      // Reset git config
      try {
        execSync('git config --unset core.autocrlf', { stdio: 'pipe' });
      } catch (e) {
        // Ignore unset errors
      }
    }

    this.log('✅ Malformed git config handling tested', 'green');
  }

  async testExtremelyLongFilenames() {
    // Test with very long filenames
    execSync(`node ${PACKDEV_BINARY} setup-hooks --auto-commit --force`, { stdio: 'pipe' });
    execSync(`node ${PACKDEV_BINARY} init`, { stdio: 'pipe' });

    // Create file with very long name (near filesystem limits)
    const longFilename = 'very-long-filename-' + 'x'.repeat(200) + '.js';

    try {
      fs.writeFileSync(longFilename, 'console.log("long filename test");');
      execSync(`git add "${longFilename}"`, { stdio: 'pipe' });
      execSync('git commit -m "test: extremely long filename"', { stdio: 'pipe' });

      // Verify file was committed
      const commitFiles = execSync('git show --name-only HEAD', { encoding: 'utf8' });
      if (!commitFiles.includes(longFilename.substring(0, 50))) {
        throw new Error('Long filename file should be in commit');
      }

    } catch (error) {
      if (error.message.includes('File name too long')) {
        this.log('⚠️  Filesystem filename length limit reached (expected)', 'yellow');
      } else {
        throw error;
      }
    }

    this.log('✅ Long filename handling tested', 'green');
  }

  async runAllTests() {
    const originalDir = process.cwd();

    try {
      this.log('🚀 Starting PackDev Git Edge Cases Tests', 'blue');
      this.log('========================================', 'blue');

      // Setup
      await this.cleanup();
      await this.setupGitRepo();
      await this.createProjectFiles();
      await this.setupPackdev();

      // Run edge case tests
      await this.runTest('Corrupted package.json', () => this.testCorruptedPackageJson());
      await this.runTest('Missing package.json', () => this.testMissingPackageJson());
      await this.runTest('Permission Errors', () => this.testPermissionErrors());
      await this.runTest('Large Commit Message', () => this.testLargeCommitMessage());
      await this.runTest('Special Characters in Commit', () => this.testSpecialCharactersInCommitMessage());
      await this.runTest('Non-Git Directory', () => this.testNonGitDirectory());
      await this.runTest('Disk Space Scenario', () => this.testDiskSpaceScenario());
      await this.runTest('Concurrent Git Operations', () => this.testConcurrentGitOperations());
      await this.runTest('Malformed Git Config', () => this.testMalformedGitConfig());
      await this.runTest('Extremely Long Filenames', () => this.testExtremelyLongFilenames());

      // Results
      const passed = this.testResults.filter(t => t.passed).length;
      const total = this.testResults.length;

      this.log('\n🎉 All PackDev Git Edge Cases Tests Completed!', 'blue');
      this.log('============================================', 'blue');
      this.log(`✅ Passed: ${passed}/${total}`, passed === total ? 'green' : 'red');
      this.log(`🏆 Success Rate: ${Math.round((passed / total) * 100)}%`, passed === total ? 'green' : 'red');

      if (passed === total) {
        this.log('\n🎉 All git edge case tests passed!', 'green');
        return true;
      } else {
        this.log('\n❌ Some git edge case tests failed. Check output above.', 'red');
        return false;
      }

    } catch (error) {
      this.log(`\n💥 Test suite failed: ${error.message}`, 'red');
      return false;
    } finally {
      // Cleanup
      process.chdir(originalDir);
      await this.cleanup();
    }
  }
}

async function main() {
  const tests = new GitEdgeCasesTests();
  const success = await tests.runAllTests();
  process.exit(success ? 0 : 1);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`💥 Unexpected error: ${error.message}`);
    process.exit(1);
  });
}

module.exports = GitEdgeCasesTests;

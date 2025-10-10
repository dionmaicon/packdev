# PackDev Git Tests Documentation

This directory contains comprehensive tests for PackDev's git integration features, particularly the auto-commit functionality that manages local dependencies during commits.

## Overview

The git test suite ensures that PackDev's git hooks work correctly across various scenarios, from basic auto-commit flows to complex edge cases and real-world git workflows.

## Test Structure

### 📂 Test Files

- **`autocommit.test.js`** - Core auto-commit functionality tests
- **`workflows.test.js`** - Git workflow integration tests
- **`edge-cases.test.js`** - Error handling and edge case tests
- **`README.md`** - This documentation file

### 🧪 Test Categories

#### 1. Auto-Commit Tests (`autocommit.test.js`)
Tests the core functionality of PackDev's auto-commit feature:

- **Hook Setup**: Testing hook installation with and without auto-commit
- **Auto-Commit Flow**: Verifying dependencies are restored during commits
- **WIP Bypass**: Testing that WIP commits can bypass dependency checks
- **Multiple Dependencies**: Handling projects with multiple local dependencies
- **Partial Commits**: Ensuring only staged files are included in commits
- **Error Recovery**: Graceful handling of corrupted or missing files
- **Performance**: Testing with large repositories and many files
- **Hook Management**: Enabling and disabling hooks

**Key Features Tested:**
- Dependencies are automatically restored before commits
- Original commit messages and history are preserved
- Only necessary files are included in commits
- WIP detection works for rapid development cycles
- Performance remains acceptable with large codebases

#### 2. Workflow Tests (`workflows.test.js`)
Tests PackDev integration with common git workflows:

- **Feature Branches**: Creating, committing, and merging feature branches
- **Hotfix Workflow**: Urgent fixes with WIP commits and final restoration
- **Rebase Operations**: Rebasing branches with dependency management
- **Cherry-Picking**: Selective commit integration between branches
- **Submodule Compatibility**: Working alongside git submodules
- **Large Files**: Handling binary and large text files
- **Concurrent Development**: Team collaboration scenarios
- **Release Workflow**: Complete release preparation and tagging

**Real-World Scenarios:**
- Multi-developer team workflows
- CI/CD pipeline compatibility
- Production release processes
- Emergency hotfix deployments

#### 3. Edge Cases Tests (`edge-cases.test.js`)
Tests error handling and unusual scenarios:

- **Corrupted Files**: Malformed package.json handling
- **Missing Files**: Graceful degradation when files are absent
- **Permission Issues**: Read-only files and permission errors
- **Large Data**: Extremely large commit messages and filenames
- **Special Characters**: Unicode, emojis, and special symbols in commits
- **Non-Git Environments**: Behavior outside git repositories
- **System Limits**: Disk space and concurrent operation scenarios
- **Git Configuration**: Malformed git config handling

**Robustness Testing:**
- Graceful error handling
- System resource limitations
- Filesystem edge cases
- Git configuration issues

## Running Tests

### 🚀 Quick Start

```bash
# Run all git tests
npm run test:git

# Or using the test runner directly
node test/run-all-tests.js --git-only
```

### 🎯 Specific Test Categories

```bash
# Auto-commit functionality only
node test/run-all-tests.js --git-autocommit-only

# Git workflows only
node test/run-all-tests.js --git-workflows-only

# Edge cases only
node test/run-all-tests.js --git-edge-cases-only
```

### 🔧 Individual Test Files

```bash
# Run specific test file directly
node test/git/autocommit.test.js
node test/git/workflows.test.js
node test/git/edge-cases.test.js
```

## Test Environment

### 📋 Prerequisites

- Node.js runtime environment
- Git installed and configured
- PackDev binary built (`npm run build`)
- Sufficient disk space for temporary test repositories

### 🔧 Test Setup

Each test file:
1. Creates isolated temporary directories
2. Initializes fresh git repositories
3. Sets up PackDev configuration
4. Runs tests in isolation
5. Cleans up all temporary files

### 🧹 Cleanup

Tests automatically clean up:
- Temporary test directories
- Git repositories
- PackDev configuration files
- Any created lock files or artifacts

## Test Architecture

### 🏗 Design Principles

1. **Isolation**: Each test runs in its own environment
2. **Realism**: Tests simulate real-world usage scenarios
3. **Reliability**: Tests are deterministic and repeatable
4. **Performance**: Tests complete in reasonable time
5. **Coverage**: Tests cover both happy path and error cases

### 📊 Test Reporting

Each test suite provides:
- Individual test pass/fail status
- Detailed error messages for failures
- Performance metrics for timing-sensitive tests
- Overall success rate and summary statistics

### 🔍 Debugging

For test debugging:
1. Tests output detailed logs during execution
2. Temporary directories can be preserved for inspection
3. Git operations are logged for troubleshooting
4. Error messages include context and suggestions

## Known Limitations

### ⚠️ WIP Detection
- Command-line WIP detection may not work in all git hook contexts
- Environment variable method is used as fallback
- Process detection works but has limitations in test environments

### 🖥 Platform Differences
- Some filesystem operations vary between operating systems
- Permission handling differs on Windows vs Unix systems
- Git behavior may vary slightly between versions

### 🔧 Git Versions
- Tests are designed for modern git versions (2.x+)
- Default branch handling supports both `main` and `master`
- Some advanced git features may not be available in older versions

## Contributing

### 📝 Adding New Tests

When adding new git tests:

1. **Choose the Right File**:
   - Core functionality → `autocommit.test.js`
   - Workflow scenarios → `workflows.test.js`
   - Error cases → `edge-cases.test.js`

2. **Follow Patterns**:
   - Use the existing test class structure
   - Include setup and cleanup methods
   - Provide descriptive test names and messages

3. **Test Structure**:
   ```javascript
   async testNewFeature() {
     // Setup test environment
     // Perform test actions
     // Verify results
     // Log success message
   }
   ```

4. **Error Handling**:
   - Expect and handle known failure modes
   - Provide helpful error messages
   - Clean up on both success and failure

### 🧪 Test Guidelines

- **Be Descriptive**: Test names should clearly indicate what's being tested
- **Be Realistic**: Test real-world scenarios, not just happy paths
- **Be Isolated**: Don't rely on other tests or external state
- **Be Fast**: Keep tests efficient while maintaining coverage
- **Be Reliable**: Tests should pass consistently

## Future Enhancements

### 🚀 Planned Improvements

1. **Enhanced WIP Detection**: Improve command-line WIP pattern recognition
2. **Performance Optimization**: Reduce test execution time
3. **More Edge Cases**: Additional error scenarios and recovery testing
4. **Integration Testing**: End-to-end workflow testing
5. **Cross-Platform Testing**: Better Windows and macOS support

### 🔧 Technical Debt

1. **Code Duplication**: Some setup code is repeated across test files
2. **Async Patterns**: Could benefit from more modern async/await patterns
3. **Error Messages**: Some error messages could be more descriptive
4. **Test Data**: Could use more realistic test data and scenarios

---

## Summary

The PackDev git test suite provides comprehensive coverage of git integration features, ensuring that the auto-commit functionality works reliably across diverse real-world scenarios. The tests are designed to be maintainable, reliable, and informative, helping developers confidently use PackDev's git features in their daily workflows.

For questions or issues with the git tests, please refer to the main PackDev documentation or create an issue in the project repository.
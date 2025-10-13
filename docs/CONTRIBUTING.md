# Contributing to PackDev

Thank you for your interest in contributing to PackDev! This guide will help you get started.

## 📋 Table of Contents

- [Code of Conduct](#code-of-conduct)
- [Getting Started](#getting-started)
- [Development Setup](#development-setup)
- [Project Structure](#project-structure)
- [Development Workflow](#development-workflow)
- [Testing](#testing)
- [Code Standards](#code-standards)
- [Submitting Changes](#submitting-changes)
- [Release Process](#release-process)

## Code of Conduct

### Our Standards

- **Be respectful**: Treat everyone with respect and kindness
- **Be collaborative**: Work together towards common goals
- **Be constructive**: Provide helpful feedback and criticism
- **Be inclusive**: Welcome contributors of all backgrounds and experience levels

## Getting Started

### Prerequisites

- Node.js >= 16.0.0
- npm or Yarn
- Git
- TypeScript knowledge (helpful but not required)

### Fork and Clone

1. Fork the repository on GitHub
2. Clone your fork locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/packdev.git
   cd packdev/packdev-lib
   ```

3. Add upstream remote:
   ```bash
   git remote add upstream https://github.com/ORIGINAL_OWNER/packdev.git
   ```

## Development Setup

### Install Dependencies

```bash
# Install all dependencies
npm install

# Or with Yarn
yarn install
```

### Build the Project

```bash
# Build TypeScript to JavaScript
npm run build

# Watch mode for continuous development
npm run watch

# Clean build artifacts
npm run clean
```

### Development Mode

```bash
# Run in development mode without building
npm run dev -- <command>

# Examples:
npm run dev -- init
npm run dev -- status
npm run dev -- --help
```

## Project Structure

```
packdev-lib/
├── src/
│   ├── index.ts           # CLI entry point
│   ├── packageManager.ts  # Core package management logic
│   └── utils.ts          # Utility functions
├── dist/                  # Compiled JavaScript (generated)
├── test/
│   ├── unit/             # Unit tests
│   ├── integration/      # Integration tests
│   ├── git-hooks/        # Git hooks tests
│   └── run-all-tests.js  # Test runner
├── scripts/              # Build and utility scripts
├── docs/                 # Documentation
├── .github/
│   └── workflows/        # GitHub Actions
├── package.json
├── tsconfig.json
└── README.md
```

### Key Files

- **`src/index.ts`**: Main CLI application with Commander.js
- **`src/packageManager.ts`**: Core logic for managing dependencies
- **`src/utils.ts`**: Shared utilities and helpers
- **`.packdev.json`**: Configuration file (created by users)

## Development Workflow

### 1. Create a Branch

```bash
# Update your fork
git fetch upstream
git checkout main
git merge upstream/main

# Create a feature branch
git checkout -b feature/your-feature-name
```

### 2. Make Changes

- Write clear, concise code
- Follow existing code style
- Add comments for complex logic
- Update documentation as needed

### 3. Test Your Changes

```bash
# Run all tests
npm test

# Run only unit tests
npm run test:unit-only

# Run integration tests
npm run test:integration

# Type checking
npm run typecheck
```

### 4. Commit Your Changes

```bash
# Stage changes
git add .

# Commit with descriptive message
git commit -m "feat: add new feature description"
```

#### Commit Message Format

We follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` - New feature
- `fix:` - Bug fix
- `docs:` - Documentation changes
- `style:` - Code style changes (formatting, etc.)
- `refactor:` - Code refactoring
- `test:` - Adding or updating tests
- `chore:` - Build process or auxiliary tool changes

Examples:
```
feat: add support for pnpm package manager
fix: resolve path validation on Windows
docs: update quick start guide
test: add unit tests for packageManager
```

## Testing

### Test Structure

PackDev has three types of tests:

1. **Unit Tests** (`test/unit/`)
   - Test individual functions and modules
   - Fast and isolated
   - Run in CI/CD

2. **Integration Tests** (`test/integration/`)
   - Test complete workflows
   - Use real package.json manipulation
   - Run locally and in CI/CD (where possible)

3. **Git Hooks Tests** (`test/git-hooks/`)
   - Test Git pre-commit hooks
   - Require TTY access
   - Run only locally (not in CI/CD)

### Running Tests

```bash
# All tests (includes git hooks)
npm test

# Unit tests only (CI-safe)
npm run test:unit-only

# Integration tests
npm run test:integration

# Specific test file
node test/unit/packageManager.test.js
```

### Writing Tests

When adding new features, include tests:

```javascript
// test/unit/myFeature.test.js
const assert = require('assert');
const { myFunction } = require('../../dist/utils');

console.log('🧪 Testing myFunction...');

// Test case 1
assert.strictEqual(myFunction('input'), 'expected output');
console.log('✅ Test case 1 passed');

// Test case 2
assert.throws(() => myFunction(null), Error);
console.log('✅ Test case 2 passed');

console.log('✅ All myFunction tests passed!\n');
```

### Demo Scripts

Test your changes with demo scripts:

```bash
# Complete workflow demo
npm run demo-workflow

# Git hooks demo
npm run demo-hooks

# Package info
npm run package-info
```

## Code Standards

### TypeScript Guidelines

- Use TypeScript features (types, interfaces, enums)
- Avoid `any` type when possible
- Document complex types
- Use meaningful variable names

### Code Style

- **Indentation**: 2 spaces (no tabs)
- **Quotes**: Single quotes for strings
- **Semicolons**: Required
- **Line length**: ~100 characters max
- **Naming**:
  - `camelCase` for variables and functions
  - `PascalCase` for classes and interfaces
  - `UPPER_CASE` for constants

### Example

```typescript
// Good
interface PackageConfig {
  package: string;
  location: string;
  version: string;
  type: 'local' | 'git';
}

function validatePackagePath(path: string): boolean {
  const normalizedPath = normalizePath(path);
  return fs.existsSync(normalizedPath);
}

// Avoid
function validate(p: any) {
  return fs.existsSync(p)
}
```

### Error Handling

- Provide clear, actionable error messages
- Include context in errors
- Validate user input early

```typescript
// Good
if (!fs.existsSync(packageJsonPath)) {
  throw new Error(
    `package.json not found at ${packageJsonPath}\n` +
    `Make sure you're running packdev from your project root.`
  );
}

// Avoid
if (!fs.existsSync(packageJsonPath)) {
  throw new Error('File not found');
}
```

### Documentation

- Update README.md for user-facing changes
- Update relevant docs in `docs/` folder
- Add inline comments for complex logic
- Update examples if behavior changes

## Submitting Changes

### Pull Request Process

1. **Update your branch**:
   ```bash
   git fetch upstream
   git rebase upstream/main
   ```

2. **Push to your fork**:
   ```bash
   git push origin feature/your-feature-name
   ```

3. **Create Pull Request**:
   - Go to GitHub and create a PR
   - Use a clear, descriptive title
   - Fill out the PR template
   - Reference any related issues

### PR Title Format

Follow conventional commits format:

```
feat: add support for pnpm
fix: resolve Windows path issues
docs: improve quick start guide
```

### PR Description

Include:
- **What**: What does this PR do?
- **Why**: Why is this change needed?
- **How**: How does it work?
- **Testing**: How was it tested?
- **Screenshots**: If applicable

Example:
```markdown
## What
Adds support for pnpm package manager

## Why
Users requested pnpm support in issue #123

## How
- Detects pnpm.lock files
- Uses pnpm commands when detected
- Falls back to npm if pnpm not installed

## Testing
- Added unit tests for pnpm detection
- Tested manually with pnpm projects
- All existing tests still pass
```

### Review Process

- Maintainers will review your PR
- Address feedback and update your PR
- Once approved, a maintainer will merge

## Release Process

### Version Numbering

We follow [Semantic Versioning](https://semver.org/):

- **MAJOR**: Breaking changes
- **MINOR**: New features (backward compatible)
- **PATCH**: Bug fixes (backward compatible)

### Creating a Release

Maintainers only:

1. **Update version**:
   ```bash
   npm version patch  # or minor, or major
   ```

2. **Update CHANGELOG**:
   - Document all changes
   - Group by type (features, fixes, breaking)

3. **Create Git tag**:
   ```bash
   git push origin main --tags
   ```

4. **Create GitHub Release**:
   - Go to GitHub Releases
   - Create new release with tag
   - Include changelog
   - Publish release (triggers NPM publish via GitHub Actions)

## Questions?

- **Bug reports**: [Open an issue](https://github.com/OWNER/packdev/issues)
- **Feature requests**: [Open an issue](https://github.com/OWNER/packdev/issues)
- **Questions**: [Start a discussion](https://github.com/OWNER/packdev/discussions)

## Recognition

Contributors will be:
- Listed in CHANGELOG.md
- Mentioned in release notes
- Credited in the repository

Thank you for contributing to PackDev! 🎉
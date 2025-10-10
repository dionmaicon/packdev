# PackDev - Local Package Development Manager

A TypeScript-based CLI tool for managing local package dependencies during development. Simplify your workflow when developing multiple interdependent packages locally.

## 🚀 Features

- **Local Development Mode**: Replace npm versions with local file paths or git URLs
- **Easy Restoration**: Restore original versions when ready for production
- **Privacy by Default**: Keep .packdev.json private in .gitignore (recommended)
- **CI/CD Integration**: Automate package testing with different dependency versions
- **Configuration Management**: Track local dependencies in `.packdev.json`
- **TypeScript Support**: Full TypeScript implementation with type safety
- **Path Validation**: Automatic validation of local package paths and git URLs
- **Backup & Safety**: Safe operations with validation and error handling

## 📦 Installation

```bash
# Install globally (recommended)
npm install -g packdev

# Or install locally in your project
npm install --save-dev packdev
```

> **Note**: After installation, you can use `packdev` commands anywhere (global) or `npx packdev` (local).

## 💡 What is PackDev?

PackDev solves a common problem: **testing your app with local versions of packages before publishing them**.

Instead of publishing beta versions or using complicated `npm link` setups, packdev lets you:
- 🔄 **Temporarily replace** npm packages with local directories or git URLs
- 🏠 **Work locally** on packages and test them immediately in your app
- 🔁 **Switch back and forth** between local and published versions
- 👥 **Privacy-first collaboration** - Keep personal configs private (.gitignore recommended)
- 🤖 **CI/CD automation** - Test with git URLs or pipeline-built local packages

### The Problem PackDev Solves

**Before packdev:**
```bash
# Painful workflow
cd my-library
npm link                    # Creates global symlink
cd ../my-app
npm link my-library         # Links to global symlink
# Problems: global state, easy to forget, conflicts between projects
```

**With PackDev:**
```bash
# Clean workflow
cd my-app
packdev add my-library ../my-library  # Configure once
packdev init                          # Use local version
# Work on both projects...
packdev finish                        # Back to npm version
```

## 🛠️ Usage

### Quick Start

**🚀 5-minute setup:**

1. **Navigate to your project** that uses packages you want to develop locally:
   ```bash
   cd my-react-app  # Your main project
   ```

2. **Create packdev configuration**:
   ```bash
   packdev create-config
   ```

3. **Add the packages you want to develop locally**:
   ```bash
   # Add a local package you want to work on
   packdev add react-components ../my-react-components

   # Add a git repository (specific branch/tag)
   packdev add ui-library https://github.com/myorg/ui-library.git#feature-branch

   # Add multiple dependencies
   packdev add utils-library ../my-utils
   ```

4. **Switch to local development mode**:
   ```bash
   packdev init
   npm install  # Install with local packages and git repositories
   ```

   Now your app uses the local versions AND git repositories! Local changes appear immediately, git repos are installed by npm/yarn.

5. **When ready to go back to published versions**:
   ```bash
   packdev finish
   npm install  # Back to npm versions
   ```

**🔄 Repeat anytime:** Run `packdev init` and `packdev finish` as much as you want!

## 📊 PackDev vs Traditional Alternatives

**What we're comparing:** Different approaches developers use to test local package changes before publishing.

PackDev is a **new tool** that replaces several traditional approaches for testing packages during development:

| Feature | PackDev | npm link | yarn link | Git Dependencies | Beta Publishing* |
|---------|---------|----------|-----------|------------------|------------------|
| **Setup Complexity** | ✅ Simple | ❌ Complex | ❌ Complex | ⚠️ Medium | ⚠️ Medium |
| **Global State** | ✅ None | ❌ Global pollution | ❌ Global pollution | ✅ None | ✅ None |
| **Multi-project Safe** | ✅ Isolated | ❌ Conflicts | ❌ Conflicts | ✅ Isolated | ✅ Isolated |
| **Easy Cleanup** | ✅ One command | ❌ Manual unlink | ❌ Manual unlink | ⚠️ Git reset | ⚠️ Manual |
| **Team Sharing** | ✅ Config file | ❌ Manual setup | ❌ Manual setup | ✅ Git committed | ⚠️ Coordinate versions |
| **Accidental Commits** | ✅ Git hooks prevent | ❌ Easy to forget | ❌ Easy to forget | ⚠️ Intentional | ✅ Safe |
| **Package Manager** | ✅ Works with all | ⚠️ npm only | ⚠️ Yarn only | ✅ Works with all | ✅ Works with all |
| **Version Tracking** | ✅ Automatic | ❌ Manual | ❌ Manual | ⚠️ Git tags | ✅ npm versions |
| **Status Visibility** | ✅ Clear status | ❌ Hidden state | ❌ Hidden state | ✅ Git status | ✅ Clear |
| **Hot Reloading** | ✅ Immediate | ✅ Immediate | ✅ Immediate | ❌ Requires commit/push | ❌ Requires publish |

> **Note:** This compares packdev (our tool) against traditional methods developers use for testing packages.
> Beta Publishing means the old approach of publishing `1.0.0-beta.1` versions to npm for testing.

### 🎯 When to Use Each Solution

**Use PackDev with Local Packages when:**
- ✅ You have local source code you're actively developing
- ✅ You want instant hot reloading and live changes
- ✅ You're working on features across multiple interdependent packages
- ✅ You want a clean, team-friendly workflow 
- ✅ Each team member has different local directory structures (.gitignore recommended)

**Use PackDev with Git Dependencies when:**
- ✅ You need to test specific branches/commits from remote repositories
- ✅ You want to test unreleased features without publishing beta versions
- ✅ You're collaborating on features across multiple repositories
- ✅ You need temporary dependencies that aren't published to npm yet
- ✅ You want the same clean workflow but with remote git repositories

**Use PackDev for CI/CD & Automation when:**
- ✅ Testing dependency matrix across different package versions
- ✅ Validating compatibility with experimental/beta branches
- ✅ Automated integration testing without publishing packages
- ✅ Running tests against multiple git branches in parallel
- ✅ Package compatibility validation in build pipelines
- ✅ Testing different build variants of the same package in one pipeline
- ✅ Multi-step builds where packages are built and tested in sequence
- ✅ Using pipeline-accessible local paths (builds created within CI/CD)
- ✅ Mixed testing (external git URLs + pipeline-built local packages)

**Use Direct Git Dependencies (package.json) when:**
- ⚠️ You permanently want to use a specific git branch/commit in production
- ⚠️ You're okay with manual package.json editing and no workflow management
- ⚠️ You don't need the init/finish development cycle

**Use npm/yarn link when:**
- ⚠️ You only work on one project dependency at a time
- ⚠️ You don't mind global state management and potential conflicts
- ⚠️ You're okay with manual cleanup and no team configuration sharing

**Use Beta publishing when:**
- ⚠️ You want to distribute pre-release versions to external users
- ⚠️ You're ready to publish semi-stable versions to npm registry
- ⚠️ You need others to install via normal `npm install my-package@beta`
- ⚠️ You don't mind registry pollution with beta versions

### 🔄 Workflow Comparison

**Testing different dependency scenarios:**

**With npm link (❌ Complex & Error-prone):**
```bash
# In your library
cd my-awesome-library
npm link                    # Creates global symlink

# In your app
cd ../my-app
npm link my-awesome-library # Links to global symlink
# Work on library...
# Remember to unlink when done
npm unlink my-awesome-library
```

**With Manual Git dependencies (⚠️ Manual & Inflexible):**
```bash
# In your library
cd my-awesome-library
git add . && git commit -m "wip changes"
git push origin feature-branch

# In your app
cd ../my-app
# Edit package.json manually:
# "my-awesome-library": "git+https://github.com/user/my-awesome-library.git#feature-branch"
npm install
# Make more changes? Repeat commit/push cycle...
```

**With PackDev - Local Development (✅ Best for local work):**
```bash
# One-time setup
cd my-app
packdev add my-awesome-library ../my-awesome-library

# Development cycle (instant changes, repeat as needed)
packdev init     # Use local version with hot reloading
# Work on library... changes appear immediately!
packdev finish   # Back to npm version for commits
```

**With PackDev - Git Dependencies (✅ Best for remote work):**
```bash
# One-time setup
cd my-app
packdev add ui-components https://github.com/org/ui-components.git#feature-branch
packdev add beta-lib github:org/beta-lib#v2.0-beta

# Development cycle (clean workflow)
packdev init     # Use git versions
# Test remote features...
packdev finish   # Back to npm versions

# Easy switching between branches/commits
packdev add ui-components https://github.com/org/ui-components.git#different-branch
packdev init     # Now testing different branch
```

### 🎯 Common Development Scenarios

**Scenario 1: Testing a new feature in your UI library**
```bash
# Option A: Local development (you have the source)
packdev add ui-library ../my-ui-library
packdev init
# Make changes to ../my-ui-library, see them instantly in your app
packdev finish  # When ready to commit

# Option B: Testing a colleague's branch
packdev add ui-library https://github.com/team/ui-library.git#colleague-feature
packdev init
# Test the remote feature branch
packdev finish
```

**Scenario 2: Multi-package feature development**
```bash
# Working on a feature that spans multiple packages
packdev add shared-types ../shared-types
packdev add ui-components ../ui-components
packdev add utils-library ../utils-library
packdev init
# All three packages now use local versions
# Changes in any package immediately affect your app
```

**Scenario 3: Beta testing unreleased dependencies**
```bash
# Test specific commits or pre-release versions
packdev add new-framework github:vendor/framework#v3.0-beta
packdev add experimental-tools git@github.com:team/tools.git#experiment
packdev init
# Test cutting-edge features without waiting for npm publish
```

**Scenario 4: Personal development setup (Recommended)**
```bash
# Add .packdev.json to .gitignore (best practice)
echo ".packdev.json" >> .gitignore

# Each developer sets up their own local paths
packdev add shared-components ../my-local-shared-components
packdev add ui-library ~/projects/ui-library
packdev add design-system https://github.com/company/design-system.git#develop
packdev init

# Your local setup stays private, paths don't leak to team
```

### 📋 Command Comparison for Common Tasks

| Task | npm/yarn link | PackDev |
|------|---------------|---------|
| **Initial setup** | `npm link` (in library)<br>`npm link my-lib` (in app) | `packdev add my-lib ../my-lib` |
| **Start development** | Already active | `packdev init` |
| **Check status** | `npm ls --link` (unclear) | `packdev status` (clear) |
| **Stop development** | `npm unlink my-lib`<br>`npm install` | `packdev finish` |
| **Add another package** | `npm link other-lib` | `packdev add other-lib ../other-lib` |
| **List linked packages** | `npm ls --link` | `packdev list` |
| **Multiple projects** | Manual unlink/relink | Just `packdev init` |
| **Team setup** | Everyone runs link commands | Everyone runs `packdev init` |

### Available Commands

#### `packdev init`
Switch to local development mode by replacing package.json versions with local file paths.

```bash
npx packdev init
```

**What it does:**
- Reads `.packdev.json` configuration
- Replaces versions in package.json with `file:` URLs
- Updates the configuration with current versions
- Validates local package paths

#### `packdev finish`
Restore original versions from the configuration.

```bash
npx packdev finish
```

**What it does:**
- Reads `.packdev.json` configuration
- Restores original versions in package.json
- Removes `file:` URLs and puts back npm versions
- **Preserves `.packdev.json` config** for future `init` commands

#### `packdev add <package> <location>`
Add a local dependency or git repository to the configuration.

```bash
# Add local packages
npx packdev add rxjs ../local-rxjs
npx packdev add @myorg/utils ../shared/utils

# Add git repositories
npx packdev add react-ui https://github.com/myorg/react-ui.git
npx packdev add components git@github.com:myorg/components.git#develop
npx packdev add beta-lib github:myorg/beta-lib#v2.0-beta
```

**Note**: The original version is automatically detected from your `package.json`. Git URLs are automatically detected and handled by npm/yarn during install.

Options:
- `-o, --original-version <version>`: Override version (auto-detected from package.json if not provided)

#### `packdev remove <package>`
Remove a local dependency from the configuration.

```bash
npx packdev remove rxjs
```

#### `packdev list`
List all configured local dependencies.

```bash
npx packdev list
```

#### `packdev status`
Show current project status and development mode state.

```bash
npx packdev status
```

#### `packdev create-config`
Create a new `.packdev.json` configuration file.

```bash
npx packdev create-config
```

#### `packdev setup-hooks`
Setup GitHub pre-commit safety hooks to prevent accidental local dependency commits.

```bash
npx packdev setup-hooks
```

**Options:**
- `--force` - Overwrite existing hooks
- `--disable` - Remove/disable the safety hooks
- `--auto-commit` - Enable automatic dependency restoration during commits when local dependencies are detected

**What it does:**
- Creates `.git/hooks/pre-commit` and `.git/hooks/check-local-deps.js`
- Prevents commits containing `file:` dependencies
- Allows commits with "WIP" in the message
- **Auto-commit flow (with `--auto-commit`)**: Automatically restores dependencies and commits changes
- Saves preferences in `.packdev.json` (recommended: keep private in .gitignore)

## 📋 Configuration

The `.packdev.json` file structure:

```json
{
  "version": "<version>",
  "dependencies": [
    {
      "package": "rxjs",
      "location": "../local-rxjs",
      "version": "^7.8.1",
      "type": "local"
    },
    {
      "package": "@myorg/utils",
      "location": "../shared/utils",
      "version": "^2.1.0",
      "type": "local"
    },
    {
      "package": "react-ui",
      "location": "https://github.com/myorg/react-ui.git#feature-branch",
      "version": "^2.0.0",
      "type": "git"
    }
  ],
  "created": "2024-01-15T10:30:00.000Z",
  "lastModified": "2024-01-15T14:45:00.000Z"
}
```

### Configuration Fields

- `package`: npm package name
- `location`: relative path to local package directory OR git URL
- `version`: original version from package.json
- `type`: automatically detected as "local" or "git"

### Configuration Persistence

**Important**: The `.packdev.json` configuration file is **never deleted** by any command. This allows you to:

- ✅ Run `packdev init` and `packdev finish` repeatedly with the same setup
- ✅ Maintain your personal development environment consistently
- ✅ Keep your local dependency configurations private (recommended: use .gitignore)
- ✅ Easily restart development after finishing

### Team Collaboration & CI/CD Usage

**Best Practice: Keep .packdev.json Private (Recommended):**
```bash
# Always add .packdev.json to .gitignore 
echo ".packdev.json" >> .gitignore

# For local file dependencies (most common case)
packdev add ui-library ../my-local-ui-library
packdev add shared-utils ~/projects/shared-utils

# For git/URL dependencies
packdev add design-system https://github.com/company/design-system.git#develop
packdev add beta-package https://github.com/vendor/package.git#v2.0-beta
```

**Why Keep .packdev.json Private:**
- 🔒 **No directory structure leakage** - Local paths vary between developers
- 👥 **Team flexibility** - Each developer organizes projects differently
- 🚀 **Individual workflows** - Everyone can use their preferred setup
- 🛡️ **Clean repository** - No personal configuration pollutes the codebase
- ✅ **Works for all scenarios** - Both local files and git URLs

**When to Share .packdev.json (Rare Cases):**
```bash
# ONLY when using git URLs/references (no local paths)
packdev add design-system https://github.com/company/design-system.git#develop
packdev add experimental https://github.com/vendor/package.git#experimental
git add .packdev.json
git commit -m "add shared git dependency configuration"

# Team members get the same git-based dependencies
git pull
packdev init  # Everyone uses the same git references
```

**CI/CD & Automation Usage:**
```bash
# Option 1: Use git URLs for external packages
packdev add test-package https://github.com/vendor/package.git#experimental
packdev init
npm test  # Test against experimental branch

# Option 2: Use pipeline-built local packages
# Step 1: Build package variants in pipeline
npm run build:variant-a  # Outputs to ./builds/variant-a
npm run build:variant-b  # Outputs to ./builds/variant-b

# Step 2: Test with each variant
packdev add my-package ./builds/variant-a
packdev init && npm test  # Test with variant A
packdev finish

packdev add my-package ./builds/variant-b  
packdev init && npm test  # Test with variant B

# Option 3: Test matrix with mixed dependencies
packdev add framework https://github.com/vendor/framework.git#v2.0-beta
packdev add ui-lib ./pipeline-builds/ui-lib-experimental
packdev init && npm test
```

**⚠️ Important Notes:**
- 📝 **Best practice: Don't commit .packdev.json** - Keep it in .gitignore
- 🔗 **Personal local paths = Private** - Never commit configs with personal file paths (`~/projects/`, `../my-lib/`)
- 🤖 **Pipeline local paths = OK** - CI/CD can use paths created within the pipeline (`./builds/`, `./dist/`)
- 🌐 **Git URLs = Shareable** - External git references are safe to share
- 🏠 **Each developer's setup differs** - Personal directory structures vary between team members

**Real-World CI/CD Example:**
```yaml
# GitHub Actions / GitLab CI example
jobs:
  test-package-variants:
    steps:
      # Step 1: Build package with different configurations
      - name: Build package variants
        run: |
          npm run build -- --flag=experimental ./builds/experimental
          npm run build -- --flag=stable ./builds/stable
          npm run build -- --flag=beta ./builds/beta

      # Step 2: Test app with each variant
      - name: Test with experimental variant
        run: |
          packdev add my-package ./builds/experimental
          packdev init
          npm test
          packdev finish

      - name: Test with stable variant  
        run: |
          packdev add my-package ./builds/stable
          packdev init
          npm test
          packdev finish

      # Step 3: Mixed testing (local + git)
      - name: Test experimental package with beta framework
        run: |
          packdev add my-package ./builds/experimental
          packdev add framework https://github.com/vendor/framework.git#v2.0-beta
          packdev init
          npm test
```

**Use Cases:**
- 🧪 **Testing different package versions** in automated environments
- 🏗️ **CI/CD dependency matrix testing** without publishing
- 🔄 **Automated integration testing** with multiple git branches
- 📦 **Package compatibility validation** across versions
- 🚀 **Pipeline package testing** - Test different build variants in same pipeline
- ⚙️ **Multi-configuration builds** - Build once, test with different dependencies

## 🔄 Workflow Example

Let's say you're working on a project that uses RxJS and you want to test local changes:

### Initial Setup
```bash
# In your project directory (make sure packages are already in package.json)
npx packdev create-config
npx packdev add rxjs ../my-local-rxjs
npx packdev add react-ui https://github.com/myorg/react-ui.git#develop
```

### Development Mode
```bash
# Switch to local development
npx packdev init

# Your package.json now has:
# "rxjs": "file:/absolute/path/to/my-local-rxjs"
# "react-ui": "https://github.com/myorg/react-ui.git#develop"

# Install dependencies (npm/yarn handles both local and git automatically)
npm install

# Now you're using your local RxJS AND git-based react-ui!
```

### Back to Production
```bash
# Restore original versions
npx packdev finish

# Your package.json now has:
# "rxjs": "^7.8.1" (original version)
# "react-ui": "^2.0.0" (original version)

# Configuration is preserved - you can restart anytime
npx packdev init  # Same local + git setup restored
```

## 📁 Project Structure

```
src/
├── index.ts           # Main CLI application
├── packageManager.ts  # Core package management logic
└── utils.ts          # Utility functions
dist/                  # Compiled JavaScript output
.packdev.json          # Configuration file (created by you)
tsconfig.json         # TypeScript configuration
package.json          # Package configuration
```

## 🔧 Development Scripts

```bash
# Build the project
npm run build

# Run in development mode
npm run dev -- <command>

# Watch mode for development
npm run watch

# Type checking
npm run typecheck

# Clean dist directory
npm run clean
```

## ⚡ Examples

### Example 1: Working with RxJS
```bash
# Ensure RxJS is in your package.json first, then add as local dependency
npx packdev add rxjs ../rxjs-fork

# Switch to local development
npx packdev init

# Work with your local RxJS changes...

# Switch back to npm version
npx packdev finish
```

### Example 2: Multiple Dependencies (Local + Git)
```bash
# Add multiple local and git dependencies
npx packdev add @angular/core ../angular/packages/core
npx packdev add @angular/common ../angular/packages/common
npx packdev add rxjs ../rxjs-fork
npx packdev add react-components https://github.com/myorg/react-components.git#beta

# Check status
npx packdev status

# Initialize all at once
npx packdev init
```

### Example 3: Mixed Development (Monorepo + External Git)
```bash
# Working in a monorepo with shared packages + external git repos
npx packdev add @myorg/shared-components ../packages/shared-components
npx packdev add @myorg/shared-utils ../packages/shared-utils
npx packdev add external-lib https://github.com/external/lib.git#feature-branch

# Switch to local development
npx packdev init

# All your monorepo packages are linked locally + git repos installed!
```

## 🛡️ Safety Features

- **Path Validation**: Ensures local package paths exist
- **Package Validation**: Validates local packages have valid package.json
- **Backup Awareness**: Tracks original versions in configuration
- **Error Handling**: Comprehensive error messages and validation
- **Atomic Operations**: Safe switching between modes

## 🐛 Troubleshooting

### Common Issues

**"Local package path does not exist"**
- Ensure the relative path is correct from your project root
- Check that the local package directory exists

**"Could not determine version"**
- The package isn't in your package.json yet
- Add the package to your dependencies first, or use `--original-version` to specify it manually

**"package.json not found"**
- Run packdev from your project root directory
- Ensure package.json exists in current directory

## 🧪 Testing

packdev includes a comprehensive test suite demonstrating the complete workflow with a fake lodash implementation.

### Quick Test

```bash
npm run test-demo
```

This runs a complete end-to-end test that:
- ✅ Tests with real lodash (baseline)
- ✅ Creates packdev configuration
- ✅ Switches to local fake lodash
- ✅ Verifies functionality differences
- ✅ Restores original state
- ✅ Runs 47 unit tests on fake lodash
- ✅ Cleans up test artifacts

### Test Components

The test suite is located in `test/` directory:
- **`test/demo.js`** - Interactive demo comparing real vs fake lodash
- **`test/test-demo.js`** - Comprehensive automated test runner
- **`test/fake-lodash/`** - Complete fake lodash implementation with 6 core functions
- **`test/TEST_RESULTS.md`** - Detailed test analysis and results

### Expected Output

```bash
🎉 PackDev Test Demo Results
✅ All tests completed successfully!
📊 Tests passed: 10/10
⏱️  Total duration: ~4000ms
🏆 Success rate: 100%

🚀 PackDev is ready for production use!
```

## 🛡️ GitHub Safety Hooks

Prevent accidental commits with local file dependencies using built-in Git hooks.

### Quick Setup

```bash
# Create the safety hooks
packdev setup-hooks

# Configure Git to use them
git config core.hooksPath .github/hooks
```

### How It Works

The pre-commit hook automatically:
- ✅ **Scans package.json** for `file:` dependencies and relative paths
- ❌ **Blocks commits** with local dependencies
- ✅ **Allows WIP commits** containing "WIP", "work in progress", "draft", etc.
- 🔍 **Provides clear feedback** on what to do next

### Usage Examples

```bash
# This will be blocked
git commit -m "add new features"

# These will be allowed
git commit -m "WIP: testing local changes"
git commit -m "work in progress - debugging"
git commit -m "draft implementation"

# Or restore dependencies first
packdev finish
git commit -m "add new features"  # Now allowed
```

### Hook Commands

```bash
# Setup hooks
packdev setup-hooks

# Setup hooks with auto-commit flow
packdev setup-hooks --auto-commit

# Overwrite existing hooks
packdev setup-hooks --force

# Enable auto-commit flow on existing hooks
packdev setup-hooks --auto-commit --force

# Remove hooks
packdev setup-hooks --disable

# Test the hooks
npm run demo-hooks
```

### Auto-Commit Flow

When enabled with `--auto-commit`, the pre-commit hook provides an automated workflow:

```bash
# Enable auto-commit flow
packdev setup-hooks --auto-commit

# Now when you try to commit with local dependencies:
git commit -m "feat: add user authentication"

# You'll see:
# ⚠️  Local dependencies detected, auto-restoring...
# 🔄 Auto-commit: Restoring dependencies and including in your commit...
# ✅ Dependencies restored to original versions
# ✅ Updated package.json added to commit
# ✅ Your commit will include both your changes AND restored dependencies
# ✅ Dependencies restored and added to your commit
```

**Benefits:**
- 🚀 **Streamlined workflow** - Automatic dependency restoration during commits
- 🔒 **Safe by default** - No manual intervention required
- 💾 **Preserves commit message** - Uses exactly what you typed
- ⚙️ **Team configurable** - Setting saved in `.packdev.json`
- 🤖 **Fully automated** - No user prompting required

### WIP Patterns Recognized

The hook recognizes these patterns (case-insensitive):
- `WIP`, `wip`
- `work in progress`
- `draft`, `temp`, `temporary`
- `[WIP]`, `(WIP)` with brackets

For detailed information, see **[GitHub Hooks Guide](./docs/GITHUB-HOOKS.md)**.

## 🤝 Contributing

1. Make changes in the `src/` directory
2. Run `npm run typecheck` to verify types
3. Run `npm run build` to compile
4. Test with `npm run test-demo`
5. Test individual commands with `npm run dev -- <command>`

## 📦 Packaging and Local Installation

### Building and Packaging

To create a distributable package (supports both npm and Yarn):

**With npm:**
```bash
# Build and create tarball in one command
npm run pack
```

**With Yarn:**
```bash
# Build and create tarball in one command
yarn pack
```

This will:
1. Build the TypeScript source to JavaScript
2. Create a tarball (`.tgz` file)
3. Display detailed installation instructions for both package managers
4. Automatically detect your preferred package manager

### Local Installation Methods

**Method 1: Install from tarball**
```bash
# npm
npm install ./packdev-<version>.tgz

# yarn
yarn add file:./packdev-<version>.tgz
```

**Method 2: Install directly from directory**
```bash
# npm
npm install /path/to/packdev

# yarn
yarn add file:/path/to/packdev
```

**Method 3: Global installation**
```bash
# npm - install globally to use CLI anywhere
npm install -g ./packdev-<version>.tgz

# yarn - install globally to use CLI anywhere
yarn global add file:./packdev-<version>.tgz

# Test global installation
packdev --help
```

### Package Contents

The generated package includes:
- `dist/` - Compiled JavaScript and TypeScript declarations
- `package.json` - Package metadata
- `README.md` - This documentation
- `LICENSE` - License file

Excluded from package:
- `src/` - TypeScript source files
- `test/` - Test files and demos
- Development configuration files

### Testing Installation

**With npm:**
```bash
# Test local installation
npx packdev --help

# Test import in Node.js
node -e "console.log(require('packdev'))"
```

**With Yarn:**
```bash
# Test local installation
yarn packdev --help

# Test import in Node.js
node -e "console.log(require('packdev'))"
```

## 📚 Complete Documentation

This README provides a quick overview. For detailed guides and advanced topics:

**📖 [Full Documentation Index](./docs/README.md)** - Navigate all guides

**Getting Started:**
- **[Quick Start Guide](./docs/QUICK-START.md)** - Get running in 5 minutes or less

**Key Guides:**
- **[Workflow Guide](./docs/WORKFLOW.md)** - Complete development workflows and best practices
- **[Packaging Guide](./docs/PACKAGING.md)** - Building, packaging, and distribution (npm/Yarn)
- **[GitHub Safety Hooks](./docs/GITHUB-HOOKS.md)** - Prevent accidental commits with local dependencies
- **[Yarn Support](./docs/YARN-SUPPORT.md)** - Comprehensive Yarn package manager guide

**🎮 Interactive Demos:**
```bash
npm run demo-workflow      # Complete workflow demonstration
npm run demo-hooks         # GitHub hooks in action
npm run package-info       # Package information and commands
```

## 📜 License

MIT

# PackDev Packaging and Installation Guide

This guide explains how to package the PackDev library and install it locally for development and testing purposes using either npm or Yarn package managers.

## Prerequisites

- Node.js >= 16.0.0
- npm (comes with Node.js) OR Yarn package manager

## Building and Packaging

### Package Manager Detection

The scripts automatically detect your preferred package manager:
- If `yarn.lock` exists → uses Yarn
- If `package-lock.json` exists → uses npm
- Fallback: checks which command is available

### Quick Start

To build and package the library in one command:

**With npm:**
```bash
npm run pack
```

**With Yarn:**
```bash
yarn pack
```

This will:
1. Build the TypeScript source code to JavaScript
2. Create a tarball (`.tgz` file)
3. Display installation instructions for both package managers

### Manual Steps

If you prefer to run the steps manually:

**With npm:**
```bash
# Build the library
npm run build

# Create the package tarball
npm pack
```

**With Yarn:**
```bash
# Build the library
yarn build

# Create the package tarball
yarn pack
```

### Alternative Pack Scripts

We provide two pack scripts:

- **Node.js script (recommended)**: `npm run pack` / `yarn pack`
- **Bash script (Unix/Linux/macOS)**: `npm run pack:bash` / `yarn pack:bash`

The Node.js script is cross-platform, automatically detects your package manager, and provides colored output with detailed instructions for both npm and Yarn.

## Package Contents

The generated tarball includes:

- `dist/` - Compiled JavaScript and TypeScript declaration files
- `package.json` - Package metadata
- `README.md` - Project documentation
- `LICENSE` - License file (if present)

Files excluded from the package (as defined in `.npmignore` or `package.json` files field):
- `src/` - TypeScript source files
- `node_modules/` - Dependencies
- `test/` - Test files
- Development configuration files

## Local Installation Methods

### Method 1: Install from Tarball

After running `npm run pack` or `yarn pack`, you'll get a file like `packdev-1.0.0.tgz`.

**In another project with npm:**
```bash
# Copy the tarball to your project directory first
npm install ./packdev-1.0.0.tgz

# Using absolute path
npm install /path/to/packdev/packdev-1.0.0.tgz
```

**In another project with Yarn:**
```bash
# Copy the tarball to your project directory first
yarn add file:./packdev-1.0.0.tgz

# Using absolute path
yarn add file:/path/to/packdev/packdev-1.0.0.tgz
```

### Method 2: Install Directly from Directory

You can install directly from the project directory without creating a tarball:

**With npm:**
```bash
npm install /path/to/packdev
```

**With Yarn:**
```bash
yarn add file:/path/to/packdev
```

### Method 3: Global Installation

To install the CLI tool globally:

**With npm:**
```bash
# From tarball
npm install -g ./packdev-1.0.0.tgz

# From directory
npm install -g /path/to/packdev
```

**With Yarn:**
```bash
# From tarball
yarn global add file:./packdev-1.0.0.tgz

# From directory
yarn global add file:/path/to/packdev
```

After global installation, you can use the CLI from anywhere:
```bash
packdev --help
```

## Testing the Installation

### Local Installation Test

In a project where you've installed packdev locally:

**With npm:**
```bash
# Test the CLI
npx packdev --help

# Or if installed globally
packdev --help
```

**With Yarn:**
```bash
# Test the CLI
yarn packdev --help

# Or if installed globally
packdev --help
```

### Import Test

Create a test file to verify the library can be imported:

```javascript
// test-import.js
const packdev = require('packdev');
console.log('Successfully imported packdev');
```

**Run the test:**
```bash
node test-import.js
```

## Uninstalling

### Local Uninstall

**With npm:**
```bash
npm uninstall packdev
```

**With Yarn:**
```bash
yarn remove packdev
```

### Global Uninstall

**With npm:**
```bash
npm uninstall -g packdev
```

**With Yarn:**
```bash
yarn global remove packdev
```

## Troubleshooting

### Common Issues

1. **Permission Errors on Global Install**
   
   **With npm:**
   ```bash
   # Use sudo on Unix/Linux/macOS (not recommended)
   sudo npm install -g ./packdev-1.0.0.tgz
   
   # Better: Configure npm to use a different directory
   npm config set prefix ~/.npm-global
   # Add ~/.npm-global/bin to your PATH
   ```
   
   **With Yarn:**
   ```bash
   # Yarn typically handles global installs better
   yarn global add file:./packdev-1.0.0.tgz
   
   # Check global directory
   yarn global dir
   ```

2. **Build Errors**
   
   **With npm:**
   ```bash
   # Clean and rebuild
   npm run clean
   npm run build
   ```
   
   **With Yarn:**
   ```bash
   # Clean and rebuild
   yarn clean
   yarn build
   ```

3. **Package Not Found After Installation**
   - Verify the tarball was created successfully
   - Check that the `main` field in `package.json` points to the correct file
   - Ensure the `dist/` directory contains the compiled files

### Verifying Package Contents

Before installation, you can inspect the tarball contents:

```bash
# List contents without extracting
tar -tzf packdev-1.0.0.tgz

# Extract to temporary directory for inspection
mkdir temp-extract
tar -xzf packdev-1.0.0.tgz -C temp-extract
ls -la temp-extract/package/
```

## Development Workflow

For active development with frequent testing:

1. **Make changes** to the source code
2. **Test locally** with `npm run dev` or `yarn dev`
3. **Build and pack** with `npm run pack` or `yarn pack`
4. **Install in test project** from tarball
5. **Test the installation**
6. **Repeat** as needed

### Continuous Testing Setup

You can set up a test project that automatically uses the latest build:

**With npm:**
```bash
# In your test project
npm install file:../path/to/packdev

# This will use the built version and update when you rebuild
```

**With Yarn:**
```bash
# In your test project
yarn add file:../path/to/packdev

# This will use the built version and update when you rebuild
```

## Publishing to npm Registry

When ready to publish to the public npm registry:

**With npm:**
```bash
# Login to npm (one time setup)
npm login

# Publish (make sure to update version in package.json first)
npm publish

# Or for scoped packages
npm publish --access public

# Dry run first to see what would be published
npm publish --dry-run
```

**With Yarn:**
```bash
# Login to npm registry (Yarn uses npm registry)
yarn login

# Publish (make sure to update version in package.json first)
yarn publish

# Or for scoped packages
yarn publish --access public
```

Remember to:
- Update the version number in `package.json`
- Update the `CHANGELOG.md` or release notes
- Test thoroughly before publishing
- Consider using dry-run first to see what would be published
# PackDev Yarn Support Guide

This document provides comprehensive information about using Yarn package manager with PackDev, including automatic detection, commands, and best practices.

## 🔍 Automatic Package Manager Detection

The PackDev packaging system automatically detects your preferred package manager using the following logic:

1. **First Priority**: Check for `yarn.lock` → Uses Yarn
2. **Second Priority**: Check for `package-lock.json` → Uses npm
3. **Fallback**: Check if `yarn` command is available → Uses Yarn or npm

This ensures the scripts provide the most relevant commands and examples for your setup.

## 🚀 Yarn Commands Overview

### Package Manager Equivalents

| npm Command | Yarn Command | Description |
|-------------|--------------|-------------|
| `npm install` | `yarn add` | Add dependency |
| `npm install -g` | `yarn global add` | Global install |
| `npm uninstall` | `yarn remove` | Remove dependency |
| `npm uninstall -g` | `yarn global remove` | Global uninstall |
| `npm run script` | `yarn script` | Run script |
| `npm pack` | `yarn pack` | Create tarball |
| `npx command` | `yarn command` | Execute binary |

### Yarn-Specific File Syntax

Yarn requires the `file:` protocol for local packages:

```bash
# ❌ Won't work with Yarn
yarn add ./packdev-1.0.0.tgz

# ✅ Correct Yarn syntax
yarn add file:./packdev-1.0.0.tgz
yarn add file:/absolute/path/to/package
```

## 📦 Packaging with Yarn

### Quick Start

```bash
# Build and create package
yarn pack

# Test the package
yarn test-install

# Get package information
yarn package-info
```

### Available Scripts

When Yarn is detected, all output shows Yarn commands first:

```bash
# Development
yarn build          # Compile TypeScript
yarn dev            # Development mode
yarn watch          # Watch mode
yarn clean          # Clean dist/

# Packaging
yarn pack           # Create tarball with instructions
yarn pack:bash      # Bash script alternative
yarn test-install   # Test installation

# Testing
yarn test-demo      # Run demo tests
yarn typecheck      # Type checking
```

## 🔧 Installation Methods with Yarn

### Method 1: From Tarball

```bash
# In your target project
yarn add file:./packdev-1.0.0.tgz

# Or with absolute path
yarn add file:/path/to/packdev/packdev-1.0.0.tgz
```

### Method 2: Direct from Directory

```bash
# Install directly from project directory
yarn add file:/path/to/packdev

# This uses the built dist/ files
```

### Method 3: Global Installation

```bash
# Install globally
yarn global add file:./packdev-1.0.0.tgz

# Test global installation
packdev --help
```

## 🔍 Testing with Yarn

### CLI Testing

```bash
# Test local installation
yarn packdev --help

# Test global installation (same command)
packdev --help
```

### Module Import Testing

```bash
# Create test file
echo 'console.log("Import test:", require("packdev"))' > test-import.js

# Run test
node test-import.js
```

## 🗑️ Uninstalling with Yarn

### Local Uninstall

```bash
# Remove from current project
yarn remove packdev
```

### Global Uninstall

```bash
# Remove global installation
yarn global remove packdev
```

## 🔄 Development Workflow with Yarn

### Standard Workflow

1. **Make changes** to source code
2. **Test locally**: `yarn dev`
3. **Build and pack**: `yarn pack`
4. **Install in test project**: `yarn add file:./package.tgz`
5. **Test**: `yarn packdev --help`
6. **Repeat** as needed

### Continuous Development Setup

```bash
# In your test project, link directly to source
yarn add file:../path/to/packdev

# This auto-updates when you rebuild the source
```

## 🌐 Yarn Global Directory

### Check Global Installation Location

```bash
# Find where global packages are installed
yarn global dir

# List globally installed packages
yarn global list
```

### Common Global Paths

- **Linux/macOS**: `~/.config/yarn/global`
- **Windows**: `%LOCALAPPDATA%/Yarn/config/global`

## ⚡ Yarn Performance Benefits

### Why Use Yarn?

1. **Faster installs** - Parallel downloads and caching
2. **Better lock files** - More deterministic `yarn.lock`
3. **Workspaces support** - Great for monorepos
4. **Offline mode** - Install from cache when offline
5. **Network resilience** - Better retry logic

### Yarn vs npm for PackDev

| Feature | Yarn | npm | Winner |
|---------|------|-----|--------|
| Local file installs | `file:` protocol required | Direct path works | npm |
| Speed | Faster | Slower | Yarn |
| Lock file | yarn.lock | package-lock.json | Yarn |
| Global installs | Better UX | More complex | Yarn |
| Monorepo support | Workspaces | Limited | Yarn |

## 🛠️ Advanced Yarn Features

### Yarn Workspaces

If you're using `packdev` in a monorepo:

```json
// package.json
{
  "workspaces": [
    "packages/*"
  ]
}
```

```bash
# Install packdev in workspace
yarn workspace my-package add file:../packdev
```

### Yarn Resolutions

Force specific versions across your dependency tree:

```json
// package.json
{
  "resolutions": {
    "packdev": "file:./local-packdev"
  }
}
```

## 🐛 Troubleshooting Yarn Issues

### Common Problems

1. **"file: protocol not found"**
   ```bash
   # ❌ Wrong
   yarn add ./package.tgz
   
   # ✅ Correct
   yarn add file:./package.tgz
   ```

2. **Global install not found**
   ```bash
   # Check if yarn global bin is in PATH
   yarn global bin
   
   # Add to your shell profile
   export PATH="$(yarn global bin):$PATH"
   ```

3. **Permission errors**
   ```bash
   # Yarn handles permissions better than npm
   # Usually no sudo needed
   yarn global add file:./package.tgz
   ```

4. **Cache issues**
   ```bash
   # Clear yarn cache if needed
   yarn cache clean
   ```

### Debug Information

```bash
# Get yarn version and config
yarn --version
yarn config list

# Check global directory
yarn global dir

# Verbose install (for debugging)
yarn add file:./package.tgz --verbose
```

## 📊 Package Manager Comparison

### Installation Size Comparison

```bash
# Check installed size
du -sh node_modules/packdev

# Typical results:
# npm: ~90KB (includes source maps)
# yarn: ~90KB (same content)
```

### Speed Comparison

| Operation | npm | Yarn |
|-----------|-----|------|
| Initial install | 3-5s | 2-3s |
| Cached install | 1-2s | <1s |
| Global install | 2-3s | 1-2s |

## 🔄 Migration Guide

### From npm to Yarn

1. **Install Yarn**: `npm install -g yarn`
2. **Remove package-lock.json**: `rm package-lock.json`
3. **Install dependencies**: `yarn install`
4. **Use yarn commands**: `yarn pack` instead of `npm run pack`

### From Yarn to npm

1. **Remove yarn.lock**: `rm yarn.lock`
2. **Install with npm**: `npm install`
3. **Use npm commands**: `npm run pack` instead of `yarn pack`

## 📝 Best Practices

### For Development

1. **Stick to one package manager** per project
2. **Commit lock files** (`yarn.lock` or `package-lock.json`)
3. **Use exact paths** when installing local packages
4. **Test both installation methods** (tarball and direct)

### For Distribution

1. **Test with both package managers** before releasing
2. **Include both command examples** in documentation
3. **Use semantic versioning** for releases
4. **Validate package contents** before publishing

## 🚀 Future Considerations

### Yarn 3+ (Berry)

The latest Yarn versions have different behaviors:
- Zero-installs with PnP
- Different global directory structure
- Enhanced workspaces

The current scripts are compatible with Yarn 1.x (Classic). For Yarn 3+, some adjustments may be needed.

### pnpm Support

Future versions could add pnpm support:
```bash
# pnpm equivalent commands
pnpm add ./package.tgz
pnpm add -g ./package.tgz
```

---

## Summary

The `packdev` packaging system provides full Yarn support with:

✅ **Automatic detection** of preferred package manager  
✅ **Yarn-specific commands** and syntax  
✅ **Cross-compatible scripts** that work with both npm and Yarn  
✅ **Comprehensive documentation** for both package managers  
✅ **Testing tools** that adapt to your package manager  

Whether you use npm or Yarn, the packaging system adapts to provide the most relevant commands and instructions for your setup.
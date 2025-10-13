# PackDev Workflow Guide

This guide explains the complete workflow for using `packdev` to manage local package dependencies during development.

## 🔄 Core Workflow Cycle

The PackDev workflow is based on a simple **init/finish cycle** that allows you to switch between local development and production-ready states:

```
Production State → init → Development State → finish → Production State
```

### Key Principle: Configuration Persistence

**Important**: The `.packdev.json` configuration file is **never deleted** by the `finish` command. This allows you to easily restart the development cycle with the same local dependencies.

## 📋 Complete Workflow Example

### 1. Initial Setup

```bash
# Create configuration file
packdev create-config

# Add local dependencies to track
packdev add lodash ../my-local-lodash
packdev add @myorg/utils ../shared/utils
```

**Result**: Creates `.packdev.json` with your local dependency mappings.

### 2. Start Local Development

```bash
# Switch to local development mode
packdev init
```

**What happens**:
- ✅ Reads `.packdev.json` configuration
- ✅ Updates `package.json` dependencies from `"lodash": "^4.17.21"` to `"lodash": "file:../my-local-lodash"`
- ✅ Preserves original versions in `.packdev.json`
- ✅ Validates that local paths exist

**package.json changes**:
```diff
{
  "dependencies": {
-   "lodash": "^4.17.21",
+   "lodash": "file:/absolute/path/to/my-local-lodash",
-   "@myorg/utils": "^2.1.0"
+   "@myorg/utils": "file:/absolute/path/to/shared/utils"
  }
}
```

### 3. Development Work

```bash
# Install dependencies with local packages
npm install  # or yarn install

# Your project now uses local versions
# Make changes to both your project and local packages
# Test, debug, iterate...

# Commit work-in-progress (if hooks are set up)
git commit -m "WIP: testing new features with local packages"
```

### 4. Finish Development

```bash
# Restore original versions
packdev finish
```

**What happens**:
- ✅ Reads `.packdev.json` configuration
- ✅ Restores `package.json` dependencies from `"lodash": "file:../my-local-lodash"` back to `"lodash": "^4.17.21"`
- ✅ **Keeps `.packdev.json` intact** for future use
- ✅ Updates `lastModified` timestamp

**package.json changes**:
```diff
{
  "dependencies": {
-   "lodash": "file:/absolute/path/to/my-local-lodash",
+   "lodash": "^4.17.21",
-   "@myorg/utils": "file:/absolute/path/to/shared/utils"
+   "@myorg/utils": "^2.1.0"
  }
}
```

### 5. Repeat Cycle

```bash
# You can immediately start development again
packdev init

# The same local dependencies are restored
# Continue with your development workflow
```

## 🔧 Workflow Commands

| Command | Purpose | Modifies package.json | Modifies .packdev.json |
|---------|---------|---------------------|---------------------|
| `create-config` | Create new configuration | ❌ No | ✅ Creates |
| `add <pkg> <path>` | Add local dependency | ❌ No | ✅ Updates |
| `remove <pkg>` | Remove local dependency | ❌ No | ✅ Updates |
| `list` | Show configured dependencies | ❌ No | ❌ Read-only |
| `init` | Switch to local development | ✅ Local paths | ✅ Timestamps |
| `finish` | Restore original versions | ✅ Restore | ✅ Timestamps |
| `status` | Show current state | ❌ No | ❌ Read-only |

## 🎯 Common Workflow Patterns

### Daily Development Cycle

```bash
# Morning: Start working on feature
packdev init
npm install

# ... development work ...

# Evening: Commit progress
packdev finish
git add .
git commit -m "implement new authentication feature"

# Next morning: Continue work
packdev init
# Continue where you left off
```

### Feature Branch Development

```bash
# Create feature branch
git checkout -b feature/new-ui

# Start local development
packdev init

# Work with local packages
# ... development work ...

# Commit WIP to share with team
git commit -m "WIP: new UI components with local design-system"
git push origin feature/new-ui

# When ready to merge
packdev finish
git add .
git commit -m "finalize new UI components"
git push origin feature/new-ui
```

### Multiple Project Development

```bash
# Project A - working on shared utilities
cd project-a
packdev add @shared/utils ../shared-utils
packdev init

# Project B - using the same shared utilities
cd ../project-b
packdev add @shared/utils ../shared-utils
packdev init

# Both projects now use your local @shared/utils
# Changes in shared-utils affect both projects immediately
```

### Release Preparation

```bash
# Ensure clean state
packdev status
# Should show: "Development mode: 📦 Inactive"

# If in dev mode, finish first
packdev finish

# Verify package.json is clean
cat package.json | grep -E "(file:|\.\.\/)"
# Should return nothing

# Safe to build and release
npm run build
npm publish
```

## 🛡️ Safety Features

### GitHub Hooks Integration

When combined with GitHub hooks (`packdev setup-hooks`):

```bash
# This workflow is protected
packdev init
# ... development work ...
git commit -m "add new features"  # ❌ BLOCKED by hook

# Use WIP for development commits
git commit -m "WIP: add new features"  # ✅ ALLOWED

# Or finish development first
packdev finish
git commit -m "add new features"  # ✅ ALLOWED
```

### State Validation

```bash
# Check current state anytime
packdev status

# Example output:
# 📊 Project Status:
# Config file: ✅ Found
# Package.json: ✅ Found
# Development mode: 🔧 Active
#
# 📦 Configured dependencies:
#   🔧 Active 📁 Local lodash: ^4.17.21 → ../my-local-lodash
#   🔧 Active 🔗 Git ui-components: ^2.0.0 → https://github.com/myorg/ui.git#feature
```

## 📁 File Management

### What Gets Modified

**`.packdev.json`** (Configuration - Persistent):
- ✅ Created by `create-config`, `add`
- ✅ Modified by `add`, `remove`, `init`, `finish`
- ❌ **Never deleted** by any command
- 📋 Contains: dependency mappings, original versions, timestamps

**`package.json`** (Dependencies - Temporary):
- ✅ Modified by `init` (adds local paths)
- ✅ Modified by `finish` (restores original versions)
- ❌ Never modified by `add`, `remove`, `list`, `status`

### Backup Strategy

The workflow is designed to be safe:

1. **Original versions** are stored in `.packdev.json` before any changes
2. **Atomic operations** - either all dependencies switch or none do
3. **Validation** - local paths are verified before switching
4. **Rollback capability** - `finish` always works if `init` succeeded

## 🚫 What NOT to Do

### Don't Delete Configuration

```bash
# ❌ Don't do this
rm .packdev.json
packdev finish  # Will fail - config not found

# ✅ Configuration is meant to be persistent
# Keep .packdev.json in your project
```

### Don't Manually Edit package.json

```bash
# ❌ Don't manually edit dependencies during development
# Let packdev manage the init/finish cycle

# ✅ Use packdev commands to modify the configuration
packdev add new-package ../path/to/package
packdev remove old-package
```

### Don't Commit Local Dependencies

```bash
# ❌ Never commit package.json with file: dependencies
git add package.json  # Contains "lodash": "file:../local"
git commit -m "new feature"  # Bad!

# ✅ Always finish development first
packdev finish
git add package.json  # Contains "lodash": "^4.17.21"
git commit -m "new feature"  # Good!

# ✅ Or use WIP commits during development
git commit -m "WIP: new feature"  # Allowed by hooks
```

## 🔄 Advanced Workflows

### Git Repository Dependencies

Working with git repositories allows you to test unreleased features or specific branches without publishing to npm:

```bash
# Add git repositories with specific branches/tags
packdev add ui-components https://github.com/myorg/ui-components.git#feature-branch
packdev add design-system git@github.com:myorg/design-system.git#develop
packdev add beta-lib github:myorg/beta-lib#v2.0-beta

# Mix local and git dependencies
packdev add local-utils ../utils-lib
packdev add remote-components https://github.com/external/components.git

# Initialize - npm/yarn handles git URLs automatically
packdev init
npm install  # Downloads git repos and links local packages
```

**Git URL Patterns Supported:**
- `https://github.com/user/repo.git` - HTTPS URLs
- `git@github.com:user/repo.git` - SSH URLs  
- `git+https://github.com/user/repo.git` - Git+HTTPS protocol
- `github:user/repo` - GitHub shorthand
- `gitlab:user/repo` - GitLab shorthand
- All patterns support `#branch`, `#tag`, or `#commit` references

### Mixed Local/Remote Development

```bash
# Perfect for working on feature across multiple repos
packdev add shared-types ../shared-types          # Local development
packdev add ui-library https://github.com/myorg/ui.git#experiment
packdev add third-party github:vendor/tools#beta

packdev init
# Now testing: local changes + experimental UI + beta tools
```

### Monorepo Development

```bash
# Root package depends on workspace packages
packdev add @myorg/package-a ./packages/package-a
packdev add @myorg/package-b ./packages/package-b
packdev init

# All workspace packages are now linked locally
```

### Dependency Chain Testing

```bash
# Package A depends on Package B depends on Package C
# Test the entire chain locally

# In Package A
packdev add package-b ../package-b
packdev add package-c ../package-c
packdev init

# Changes in Package C immediately affect Package A through B
```

### Team Collaboration

```bash
# Share configuration across team
git add .packdev.json
git commit -m "add packdev configuration for shared development"

# Team members can use the same setup
git pull
packdev init  # Everyone gets the same local dependencies
```

## 📊 Detailed Comparison with Alternatives

PackDev is one of several tools for local package development. Here's a detailed comparison to help you choose the right tool.

### PackDev vs npm link

| Aspect | PackDev | npm link |
|--------|---------|----------|
| **How it works** | Modifies package.json temporarily | Creates global symlinks |
| **Setup complexity** | Simple (add + init) | Simple (link in both dirs) |
| **Global state** | None | Global link directory |
| **Multi-project** | Isolated per project | Conflicts between projects |
| **Cleanup** | `packdev finish` | Manual unlink required |
| **Safety** | Built-in hooks prevent commits | Easy to forget and commit |
| **Git URLs** | ✅ Supported | ❌ Not supported |

**Use npm link when**: You need quick one-off testing with symlinks

**Use PackDev when**: You want project isolation and built-in safety

### PackDev vs Verdaccio

| Aspect | PackDev | Verdaccio |
|--------|---------|-----------|
| **How it works** | package.json swap | Private npm registry server |
| **Setup** | Zero config | Install + run server |
| **Infrastructure** | None needed | Requires running server |
| **Use case** | Local development | Team private registry |
| **Authentication** | Not needed | Full user/auth system |
| **Publishing** | No publishing needed | Must publish packages |
| **CI/CD** | Git URLs + file paths | Full registry features |

**Use Verdaccio when**: You need a full private npm registry with authentication for your team

**Use PackDev when**: You just want to test local changes without running infrastructure

### PackDev vs Yalc

| Aspect | PackDev | Yalc |
|--------|---------|------|
| **How it works** | package.json swap | Publish to local store + copy |
| **Workflow** | init/finish | publish/push/update |
| **Storage** | No storage needed | Global store (~/.yalc) |
| **File handling** | Direct file: links | Copies files to .yalc/ |
| **Git URLs** | ✅ Supported | ❌ Not supported |
| **Safety hooks** | ✅ Built-in | ⚠️ Manual `yalc check` |
| **State** | Project-isolated | Global store state |

**Use Yalc when**: You prefer publish/push workflow and package copying

**Use PackDev when**: You want simpler init/finish cycle and git URL support

### Key Differentiators

**PackDev's Unique Features:**

1. **Git URL Support**: Test unreleased branches/commits from git repositories
   ```bash
   packdev add ui https://github.com/org/ui.git#experimental
   ```

2. **Built-in Safety Hooks**: Automatic git hooks prevent accidental commits
   ```bash
   packdev setup-hooks --auto-commit
   ```

3. **Mixed Dependencies**: Combine local paths and git URLs
   ```bash
   packdev add local-lib ../lib
   packdev add remote-ui https://github.com/org/ui.git#dev
   ```

4. **No Global State**: Each project is completely isolated
   - No global link directory (unlike npm link)
   - No global store (unlike Yalc)
   - No running server (unlike Verdaccio)

5. **Simple Approach**: Direct package.json manipulation
   - Easy to understand what's happening
   - No intermediate storage or copying
   - Transparent to package managers

### When to Use What

**Choose PackDev if:**
- ✅ You want simple init/finish workflow
- ✅ You need to test git repository branches
- ✅ You want automatic safety against accidental commits
- ✅ You prefer project-isolated configuration
- ✅ You need CI/CD testing with git URLs

**Choose npm link if:**
- ✅ You need quick one-off symlink testing
- ✅ You're comfortable with global state
- ✅ You don't need safety features

**Choose Verdaccio if:**
- ✅ You need a full private npm registry
- ✅ You want team authentication/authorization
- ✅ You need to cache/proxy npmjs.org
- ✅ You're okay running server infrastructure

**Choose Yalc if:**
- ✅ You prefer publish/push workflow
- ✅ You want package copying instead of file: links
- ✅ You don't need git URL support
- ✅ You're okay with global store state

## 💡 Best Practices

### 1. Commit Configuration

```bash
# ✅ Commit the configuration to share with team
git add .packdev.json
git commit -m "add packdev config for local development"
```

### 2. Document Dependencies

```bash
# ✅ Document in README.md
echo "## Local Development" >> README.md
echo "Use \`packdev init\` to switch to local/git dependencies" >> README.md
echo "Use \`packdev finish\` to restore for production" >> README.md
echo "See .packdev.json for configured local paths and git repositories" >> README.md
```

### 3. Use Status Checks

```bash
# ✅ Check status before important operations
packdev status
npm run build  # Only if development mode is inactive
```

### 4. Automate with Scripts

```bash
# ✅ Add npm scripts for common workflows
# In package.json:
{
  "scripts": {
    "dev:start": "packdev init && npm install",
    "dev:end": "packdev finish",
    "dev:status": "packdev status"
  }
}
```

## 🎉 Summary

The PackDev workflow is designed around **configuration persistence** and **safe state transitions**:

- 🔧 **init** = Switch to local development (temporary state)
- 📦 **finish** = Restore production versions (permanent state)
- 📋 **Configuration** = Always preserved for easy restart
- 🛡️ **Safety** = Hooks prevent accidental commits
- 🔄 **Repeatable** = Use the same setup over and over

This allows you to seamlessly switch between local development and production-ready code while maintaining a clean, repeatable workflow.

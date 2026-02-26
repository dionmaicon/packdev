# PackDev Quick Start Guide

Get up and running with `packdev` in 5 minutes or less.

## 💡 What is PackDev?

PackDev lets you **test your app with local package versions** before publishing them. No more `npm link` headaches or publishing beta versions for every small change!

**The Problem:**
- You're working on `my-awesome-library` 
- You want to test it in `my-app` before publishing
- Traditional solutions are messy: `npm link`, git dependencies, or constant beta publishing

**The PackDev Solution:**
```bash
cd my-app
packdev add my-awesome-library ../my-awesome-library
packdev init        # Now using local version
# Make changes to ../my-awesome-library, test immediately!
packdev finish      # Back to npm version when ready
```

## 🚀 Installation

```bash
# Install globally (recommended)
npm install -g packdev

# Or install locally in your project
npm install --save-dev packdev
```

**Verify installation:**
```bash
packdev --version
packdev --help
```

## ⚡ 5-Minute Getting Started

### Step 1: Navigate to Your Main Project
```bash
cd my-react-app  # The app that uses packages you want to develop
```

### Step 2: Add Dependencies
PackDev supports three override types — no need to create a config first, `add` handles that automatically:

```bash
# Local path — use a package from your filesystem
packdev add react-components ../my-react-components
packdev add utils ../my-utils-library

# Git URL — use a specific branch or tag
packdev add ui-library https://github.com/myorg/ui-library.git#feature-branch
packdev add beta-tools github:vendor/beta-tools#v2.0-beta

# Release version — override with a different published npm version
packdev add lodash ^3.10.1
packdev add typescript 4.9.5

# Check what you've added
packdev list
```

If packdev can't detect the original version automatically (e.g. the package is already overridden), use `--original-version`:
```bash
packdev add lodash ^3.10.1 --original-version ^4.17.21
```

### Step 3: Start Development
```bash
packdev init  # Automatically installs dependencies
```

### Step 4: Finish Development
```bash
packdev finish  # Automatically restores and reinstalls dependencies
git commit -m "implement new features"
```

## 🛡️ Safety Setup (Recommended)

```bash
# Prevent accidental commits with local deps
packdev setup-hooks
# Hooks are automatically installed and active in .git/hooks/
```

## 📋 Essential Commands

| Command | Purpose | Example |
|---------|---------|---------|
| `create-config` | Initialize config (optional) | `packdev create-config` |
| `add <pkg> <path>` | Track local package | `packdev add axios ../my-axios` |
| `add <pkg> <git-url>` | Track git repo | `packdev add ui git@github.com:org/ui.git#dev` |
| `add <pkg> <semver>` | Override with release version | `packdev add lodash ^3.10.1` |
| `add <pkg> <location> --original-version <ver>` | Specify original version manually | `packdev add lodash ^3.10.1 --original-version ^4.17.21` |
| `init` | Start development (auto-installs) | `packdev init` |
| `finish` | End development (auto-installs) | `packdev finish` |
| `status` | Check current state | `packdev status` |
| `list` | Show all tracked dependencies | `packdev list` |

**Note**: `init` and `finish` automatically run `npm install` (or `yarn`/`pnpm`). Use `--no-install` flag to skip this.

## 💡 Common Scenarios

### Branch Switching Without Conflicts
```bash
# Working with local dependencies
packdev init  # Development mode active

# Need to switch branches?
packdev finish  # Clean package.json instantly

# Switch freely without conflicts
git checkout main  # ✅ No "uncommitted changes" warnings
git checkout feature/other  # ✅ Clean switching

# Resume work
git checkout your-branch
packdev init  # Back to local development
```

**Why this helps**: No package.json merge conflicts, clean git status, fast context switching between branches

### Testing Local and Git Changes
```bash
# Test local changes
packdev add @myorg/utils ../shared-utils
packdev init  # Automatically installs dependencies
# Test your changes locally

# Test git repository features
packdev add ui-components https://github.com/myorg/ui.git#experiment
packdev init  # Automatically installs with git dependency
# Test experimental branch
packdev finish  # Automatically restores and reinstalls
```

### Team Collaboration
`.packdev.json` is per-developer (add it to `.gitignore`) since paths are local to each machine. Each team member sets up their own overrides:

```bash
# Developer A
packdev add my-lib ../my-lib
packdev init

# Developer B (different local path, same package)
packdev add my-lib /home/devb/projects/my-lib
packdev init
```

### Multiple Projects
```bash
# Same local package in multiple projects
cd project-a && packdev add shared ../shared && packdev init  # Auto-installs
cd project-b && packdev add shared ../shared && packdev init  # Auto-installs
# Both projects now use local ../shared
```

## 🚨 Common Issues & Solutions

### "Config not found"
```bash
# Just use add — it creates the config automatically
packdev add your-package ../path/to/package

# Or explicitly initialize first
packdev create-config
```

### "Local path does not exist" 
```bash
# Check the path exists
ls ../path/to/package/package.json
# Fix path or create package
```

### Accidental commit blocked
```bash
# Option 1: Restore dependencies
packdev finish
git commit -m "your message"

# Option 2: Use WIP commit
git commit -m "WIP: your message"
```

### Package manager detection
```bash
# Force npm/yarn usage
npm run pack    # Uses detected package manager
yarn pack      # Forces yarn if available
```

## 🎯 Next Steps

### For Daily Development
- Read: [Workflow Guide](./WORKFLOW.md)
- Try: `npm run demo-workflow`

### For Package Distribution  
- Read: [Packaging Guide](./PACKAGING.md)
- Try: `npm run pack && npm run test-install`

### For Team Safety
- Read: [GitHub Hooks Guide](./GITHUB-HOOKS.md)  
- Try: `npm run demo-hooks`

### For Yarn Users
- Read: [Yarn Support Guide](./YARN-SUPPORT.md)
- Note: Auto-detected based on lock files

## 🔍 Quick Troubleshooting

### Check Your Setup
```bash
packdev status
# Should show config and current mode
```

### View Configuration
```bash
packdev list  
# Shows all tracked packages
```

### Test Package
```bash
npm run package-info
# Shows package details and commands
```

### Interactive Demo
```bash
npm run demo-workflow --interactive
# Step-by-step walkthrough
```

## 📚 Full Documentation

- **[Documentation Index](./README.md)** - All guides and references
- **[Main README](../README.md)** - Complete project overview
- **[Workflow Guide](./WORKFLOW.md)** - Detailed workflow patterns
- **[Packaging Guide](./PACKAGING.md)** - Distribution and building
- **[GitHub Hooks](./GITHUB-HOOKS.md)** - Safety and team features
- **[Yarn Support](./YARN-SUPPORT.md)** - Yarn-specific documentation

---

**🎉 That's it!** You're ready to use PackDev for package development with local paths, git repositories, and release version overrides. For more advanced workflows and team features, explore the complete documentation above.
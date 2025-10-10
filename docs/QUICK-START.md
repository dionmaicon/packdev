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

### Step 2: Create PackDev Configuration
```bash
packdev create-config
```

### Step 3: Add Dependencies (Local or Git)
```bash
# Add local packages you want to work on
packdev add react-components ../my-react-components
packdev add utils ../my-utils-library

# Add git repositories (specific branches/tags)
packdev add ui-library https://github.com/myorg/ui-library.git#feature-branch
packdev add beta-tools github:vendor/beta-tools#v2.0-beta

# Check what you've added
packdev list
```

### 2. Start Development
```bash
packdev init
npm install  # Now uses local packages and git repositories
```

### 3. Finish Development
```bash
packdev finish
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
| `create-config` | Setup project | `packdev create-config` |
| `add <pkg> <path>` | Track package | `packdev add axios ../my-axios` |
| `add <pkg> <git-url>` | Track git repo | `packdev add ui git@github.com:org/ui.git#dev` |
| `init` | Start development | `packdev init` |
| `finish` | End development | `packdev finish` |
| `status` | Check current state | `packdev status` |

## 💡 Common Scenarios

### Testing Local and Git Changes
```bash
# Test local changes
packdev add @myorg/utils ../shared-utils
packdev init
# Test your changes locally

# Test git repository features
packdev add ui-components https://github.com/myorg/ui.git#experiment
packdev init
# Test experimental branch
packdev finish
```

### Team Collaboration  
```bash
# Share config with team
git add .packdev.json
git commit -m "add local dev config"

# Team members use same setup
git pull
packdev init
```

### Multiple Projects
```bash
# Same local package in multiple projects
cd project-a && packdev add shared ../shared && packdev init
cd project-b && packdev add shared ../shared && packdev init
# Both projects now use local ../shared
```

## 🚨 Common Issues & Solutions

### "Config not found"
```bash
# Create configuration first
packdev create-config
packdev add your-package ../path/to/package
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

**🎉 That's it!** You're ready to use PackDev for local package development. For more advanced workflows and team features, explore the complete documentation above.
# PackDev - Package Development Manager

[![npm version](https://img.shields.io/npm/v/packdev.svg)](https://www.npmjs.com/package/packdev)
[![npm downloads](https://img.shields.io/npm/dm/packdev.svg)](https://www.npmjs.com/package/packdev)
[![CI](https://github.com/dionmaicon/packdev/actions/workflows/ci.yml/badge.svg)](https://github.com/dionmaicon/packdev/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE.md)
[![node](https://img.shields.io/node/v/packdev.svg)](package.json)

A TypeScript-based CLI tool for managing package dependencies during development. Test your packages before publishing using local paths or git repositories, without the complexity of `npm link`.

![PackDev demo](assets/demo.gif)

## 🎯 Why PackDev?

**The Problem**: You're developing a library and need to test it in your app before publishing. Traditional solutions are painful:
- `npm link` creates global state and conflicts between projects
- Publishing beta versions clutters your registry
- Manual `file:` paths or git URLs in package.json are easy to accidentally commit

**The Solution**: PackDev manages development dependencies seamlessly:
```bash
packdev add my-library ../my-library    # Configure once
packdev init                             # Switch to local
# ... develop and test ...
packdev finish                           # Back to npm version
```

## 📦 Installation

```bash
npm install -g packdev
```

## 🚀 Quick Start

1. **Add development dependencies** (local paths, git URLs, or release versions):
   ```bash
   packdev add my-library ../path/to/my-library
   packdev add ui-components https://github.com/org/ui-components.git#dev-branch
   packdev add lodash ^3.10.1
   ```

2. **Switch to development mode**:
   ```bash
   packdev init  # Automatically runs npm/yarn/pnpm install
   ```

3. **Restore production versions**:
   ```bash
   packdev finish  # Automatically runs npm/yarn/pnpm install
   ```

📖 **[Full Quick Start Guide →](docs/QUICK-START.md)**

## 📊 PackDev vs Alternatives

| Feature | PackDev | npm link | Verdaccio | Yalc |
|---------|---------|----------|-----------|------|
| **How it works** | Swaps package.json | Symlinks | Private npm server | Publish to local store |
| **No global state** | ✅ | ❌ | ✅ | ❌ Global store |
| **Git dependencies** | ✅ | ❌ | ❌ | ❌ |
| **Accidental commit protection** | ✅ Built-in hooks | ❌ | N/A | ⚠️ Manual check |
| **CI/CD ready** | ✅ | ❌ | ✅ | ⚠️ |
| **Multi-project safe** | ✅ | ❌ Conflicts | ✅ | ⚠️ Shared store |

**When to use PackDev**: Direct package.json manipulation, git URLs, built-in safety
**When to use npm link**: Quick one-off symlink testing
**When to use Verdaccio**: Team needs full private npm registry with authentication
**When to use Yalc**: Prefer publish/push workflow, need package copying over file: links

📖 **[Detailed Comparison →](docs/WORKFLOW.md#-detailed-comparison-with-alternatives)**

## 💡 Examples

### Example 1: Simple Local Development

Develop a library alongside your app:

```bash
# In your app directory
packdev add my-utils ../my-utils
packdev init  # Automatically installs dependencies

# Make changes to ../my-utils
# Test immediately in your app
# Changes reflect instantly (no rebuild needed for JS)

packdev finish  # Automatically restores and reinstalls
```

### Example 2: Testing a Specific Release Version

Test your app against a different published version without touching your package.json permanently:

```bash
# Override lodash to an older version for compatibility testing
packdev add lodash ^3.10.1
packdev init  # Installs lodash@^3.10.1

# Run your tests
npm test

packdev finish  # Restores original lodash version
```

Use `--original-version` if the package is already overridden or not yet in your package.json:

```bash
packdev add lodash ^3.10.1 --original-version ^4.17.21
```

### Example 3: Clean Git Branch Switching

Avoid merge conflicts and "uncommitted changes" when switching branches:

```bash
# Working with local dependencies
packdev init  # Development mode active

# Need to switch branches?
packdev finish  # Clean package.json instantly

# Switch freely without conflicts
git checkout main  # ✅ No blocking warnings
git checkout feature/other-work  # ✅ Clean switching

# Back to your branch
git checkout feature/your-work
packdev init  # Resume local development
```

**Benefits**: No package.json conflicts, clean git status, fast context switching

📖 **[Git Workflows →](docs/WORKFLOW.md#git-branch-switching)**

### Example 4: Git Auto-Commit Safety Hook

Prevent accidentally committing local development configurations:

```bash
# Setup safety hooks
packdev setup-hooks --auto-commit

# Now packdev automatically manages package.json during commits
git add .
git commit -m "feat: new feature"
# ✅ Packdev auto-restores package.json before commit
# ✅ Packdev auto-reinstates local deps after commit

# For quick WIP commits, use bypass
git commit -m "WIP: testing something"
# ✅ Skips packdev checks for WIP commits
```

📖 **[Git Hooks Documentation →](docs/GITHUB-HOOKS.md)**

### Example 5: CI/CD Testing with Multiple Variants

Test your app against different package versions in CI:

```yaml
# .github/workflows/test-variants.yml
name: Test Package Variants

on: [push, pull_request]

jobs:
  test-variants:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        ui-variant: [stable, experimental]
        utils-variant: [v1, v2]

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '18'

      - name: Configure test matrix
        run: |
          npx packdev@latest create-config

          # Configure UI library variant (git branches)
          if [ "${{ matrix.ui-variant }}" = "experimental" ]; then
            npx packdev@latest add ui-library https://github.com/org/ui-library.git#experimental
          else
            npx packdev@latest add ui-library https://github.com/org/ui-library.git#stable
          fi

          # Configure utils library variant (published release versions)
          if [ "${{ matrix.utils-variant }}" = "v2" ]; then
            npx packdev@latest add utils-library ^2.0.0
          else
            npx packdev@latest add utils-library ^1.0.0
          fi

          # Applies the config and installs dependencies
          npx packdev@latest init

      - name: Run tests
        run: npm test

      - name: Report test results
        if: always()
        run: |
          echo "✅ Tests completed for:"
          echo "   UI: ${{ matrix.ui-variant }}"
          echo "   Utils: ${{ matrix.utils-variant }}"
```

This creates a **4-variant test matrix** (stable+v1, stable+v2, experimental+v1, experimental+v2) to ensure compatibility across all combinations.

📖 **[CI/CD Integration Guide →](docs/WORKFLOW.md#-advanced-workflows)**

### Example 6: Monorepo — Auto-Link and Live Rebuild

Working in a monorepo (npm/pnpm/yarn workspaces)? Let PackDev find the package for you and rebuild it as you edit:

```bash
# In your app package, no path needed — packdev locates the workspace member
packdev link ui-library
packdev init

# Rebuild ui-library automatically on every source change
packdev watch  # 👀 detects the build script, rebuilds on save
```

`packdev link` searches workspace members and sibling directories, so you don't hand-write `../../packages/ui-library`. `packdev watch` picks up each linked package's `build` script (override per package via the `watch` block in `.packdev.json`).

### Example 7: Agent-Friendly Scripting (JSON + Exit Codes)

Every command speaks JSON and returns stable exit codes, so scripts and coding agents can act on results without scraping prose:

```bash
# Machine-readable output on stdout, human logs on stderr
packdev status --json
# {"command":"status","isInDevMode":true,"dependencies":[...],"isValid":true}

packdev add my-lib ../my-lib --json --dry-run  # preview, write nothing

# Branch on exit codes
packdev init --json
case $? in
  0) echo "dev mode active" ;;
  2) echo "no .packdev.json — run packdev create-config" ;;
  3) echo "no package.json in cwd" ;;
esac
```

Exit codes: `0` success, `1` generic error, `2` config not found, `3` package.json not found. Add `--dry-run` to any of `init`/`finish`/`add`/`link` to preview changes safely.

## 🛡️ Safety Features

- **Auto-backup**: Original package.json preserved before changes
- **Path validation**: Ensures local paths and git URLs exist
- **Git hooks**: Prevent accidental commits of development configs
- **Status checks**: Always know if you're in dev or production mode
- **Per-developer config**: `.packdev.json` lives on your machine — add it to `.gitignore` since paths are local to each developer

📖 **[Safety Best Practices →](docs/WORKFLOW.md#-safety-features)**

## 📖 Documentation

- **[Quick Start Guide](docs/QUICK-START.md)** - Get up and running in 5 minutes
- **[Workflow & Best Practices](docs/WORKFLOW.md)** - Team collaboration, CI/CD, safety
- **[Git Hooks](docs/GITHUB-HOOKS.md)** - Auto-commit protection and safety checks
- **[Packaging Guide](docs/PACKAGING.md)** - Building, testing, and distributing
- **[Yarn Support](docs/YARN-SUPPORT.md)** - Using PackDev with Yarn

## 🔧 Commands Reference

```bash
packdev create-config                        # Initialize .packdev.json (optional — add does this automatically)
packdev add <pkg> <location>                 # Add local path dependency
packdev add <pkg> <git-url>                  # Add git URL dependency
packdev add <pkg> <semver>                   # Add release version override (e.g. ^3.10.1)
packdev add <pkg> <location> --original-version <ver>  # Specify original version manually
packdev link <pkg>                           # Auto-detect a workspace/sibling package's path and add it
packdev remove <pkg>                         # Remove tracked dependency
packdev init                                 # Switch to development mode
packdev finish                               # Restore production versions
packdev watch                                # Rebuild linked local deps on change (--once to build and exit)
packdev status                               # Check current mode
packdev list                                 # Show all tracked dependencies
packdev restore                              # Recover package.json from backup after a crash
packdev setup-hooks                          # Install git safety hooks
```

**Flags**: `--json` (global — machine-readable output + stable exit codes); `--dry-run` and `--no-install` on `init`/`finish`/`add`/`link` (preview without writing / skip the package-manager install).

📖 **[Complete Command Reference →](docs/QUICK-START.md#-essential-commands)**

## 🤝 Contributing

We welcome contributions! Please see our **[Contributing Guide](docs/CONTRIBUTING.md)** for details on:
- Code of conduct
- Development setup
- Running tests
- Code standards
- Submitting pull requests
- Release process

## 📜 License

MIT License - see [LICENSE.md](LICENSE.md) for details

---

**Made with ❤️ for developers who value simplicity and safety**

📦 [npm](https://www.npmjs.com/package/packdev) | 🐙 [GitHub](https://github.com/dionmaicon/packdev) | 📖 [Documentation](docs/README.md)

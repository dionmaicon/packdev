# PackDev - Package Development Manager

A TypeScript-based CLI tool for managing package dependencies during development. Test your packages before publishing using local paths or git repositories, without the complexity of `npm link`.

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

1. **Create configuration** in your app directory:
   ```bash
   packdev create-config
   ```

2. **Add development dependencies** (local paths or git URLs):
   ```bash
   packdev add my-library ../path/to/my-library
   packdev add ui-components https://github.com/org/ui-components.git#dev-branch
   ```

3. **Switch to development mode**:
   ```bash
   packdev init
   npm install
   ```

4. **Restore production versions**:
   ```bash
   packdev finish
   npm install
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
packdev init
npm install

# Make changes to ../my-utils
# Test immediately in your app
# Changes reflect instantly (no rebuild needed for JS)

packdev finish  # When ready for production
```

### Example 2: Git Auto-Commit Safety Hook

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

### Example 3: CI/CD Testing with Multiple Variants

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

      - name: Install PackDev
        run: npm install -g packdev

      - name: Configure test matrix
        run: |
          packdev create-config

          # Configure UI library variant
          if [ "${{ matrix.ui-variant }}" = "experimental" ]; then
            packdev add ui-library https://github.com/org/ui-library.git#experimental
          else
            packdev add ui-library https://github.com/org/ui-library.git#stable
          fi

          # Configure utils library variant
          if [ "${{ matrix.utils-variant }}" = "v2" ]; then
            packdev add utils-library https://github.com/org/utils-library.git#v2-beta
          else
            packdev add utils-library https://github.com/org/utils-library.git#v1.0
          fi

          # Apply configuration
          packdev init

      - name: Install dependencies
        run: npm install

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

## 🛡️ Safety Features

- **Auto-backup**: Original package.json preserved before changes
- **Path validation**: Ensures local paths and git URLs exist
- **Git hooks**: Prevent accidental commits of development configs
- **Status checks**: Always know if you're in dev or production mode
- **.gitignore recommended**: Keep `.packdev.json` private by default

📖 **[Safety Best Practices →](docs/WORKFLOW.md#-safety-features)**

## 📖 Documentation

- **[Quick Start Guide](docs/QUICK-START.md)** - Get up and running in 5 minutes
- **[Workflow & Best Practices](docs/WORKFLOW.md)** - Team collaboration, CI/CD, safety
- **[Git Hooks](docs/GITHUB-HOOKS.md)** - Auto-commit protection and safety checks
- **[Packaging Guide](docs/PACKAGING.md)** - Building, testing, and distributing
- **[Yarn Support](docs/YARN-SUPPORT.md)** - Using PackDev with Yarn

## 🔧 Commands Reference

```bash
packdev create-config          # Initialize .packdev.json
packdev add <pkg> <location>   # Add local or git dependency
packdev remove <pkg>           # Remove tracked dependency
packdev init                   # Switch to development mode
packdev finish                 # Restore production versions
packdev status                 # Check current mode
packdev list                   # Show all tracked dependencies
packdev setup-hooks            # Install git safety hooks
```

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

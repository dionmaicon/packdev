# PackDev Documentation

Welcome to the comprehensive documentation for `packdev` - the TypeScript-based CLI tool for managing package dependencies during development using local paths or git repositories.

## 📚 Documentation Index

### 🚀 Getting Started

- **[Main README](../README.md)** - Project overview, installation, and quick start guide
- **[Workflow Guide](./WORKFLOW.md)** - Complete workflow patterns and best practices

### 📦 Package Management

- **[Packaging Guide](./PACKAGING.md)** - Building, packaging, and distribution
- **[Yarn Support](./YARN-SUPPORT.md)** - Comprehensive Yarn package manager guide

### 🛡️ Safety & Security

- **[GitHub Hooks](./GITHUB-HOOKS.md)** - Pre-commit safety hooks to prevent accidental commits

## 📖 Quick Navigation

### By Use Case

| I want to... | Read this guide |
|--------------|----------------|
| **Get started quickly** | [Main README](../README.md) |
| **Understand the workflow** | [Workflow Guide](./WORKFLOW.md) |
| **Package for distribution** | [Packaging Guide](./PACKAGING.md) |
| **Use with Yarn** | [Yarn Support](./YARN-SUPPORT.md) |
| **Prevent commit mistakes** | [GitHub Hooks](./GITHUB-HOOKS.md) |
| **Learn best practices** | [Workflow Guide](./WORKFLOW.md) |
| **Troubleshoot issues** | [Packaging Guide](./PACKAGING.md) + [Yarn Support](./YARN-SUPPORT.md) |

### By Experience Level

**🆕 New Users**
1. Start with [Main README](../README.md)
2. Follow [Workflow Guide](./WORKFLOW.md) examples
3. Set up [GitHub Hooks](./GITHUB-HOOKS.md) for safety

**🔧 Experienced Users**
- [Packaging Guide](./PACKAGING.md) - Distribution and advanced packaging
- [Yarn Support](./YARN-SUPPORT.md) - Yarn-specific workflows and optimizations

**👥 Team Leads**
- [GitHub Hooks](./GITHUB-HOOKS.md) - Team safety and collaboration
- [Workflow Guide](./WORKFLOW.md) - Team workflow patterns

## 📋 Document Details

### [Main README](../README.md) (500+ lines)
- **Purpose**: Project overview and quick start
- **Contains**: Installation, basic usage, examples
- **Audience**: All users
- **Updated**: Latest

### [Workflow Guide](./WORKFLOW.md) (388 lines)
- **Purpose**: Complete workflow patterns and best practices
- **Contains**: Init/finish cycles, configuration persistence, team collaboration
- **Audience**: All users, especially teams
- **Key Topics**: Configuration persistence, safety features, advanced workflows

### [Packaging Guide](./PACKAGING.md) (316+ lines)
- **Purpose**: Building and distributing packages
- **Contains**: npm/Yarn packaging, local installation, troubleshooting
- **Audience**: Package maintainers, CI/CD setup
- **Key Topics**: Cross-platform packaging, testing, distribution methods

### [Yarn Support](./YARN-SUPPORT.md) (370 lines)
- **Purpose**: Comprehensive Yarn package manager support
- **Contains**: Yarn-specific commands, migration guides, performance tips
- **Audience**: Yarn users, teams migrating from npm
- **Key Topics**: Auto-detection, command equivalents, workspaces

### [GitHub Hooks](./GITHUB-HOOKS.md) (373 lines)
- **Purpose**: Pre-commit safety hooks to prevent accidental commits
- **Contains**: Hook setup, usage patterns, team integration
- **Audience**: All users, especially teams
- **Key Topics**: Safety checks, WIP commits, troubleshooting

## 🎯 Common Workflows

### Daily Development
```bash
# Morning
packdev init  # Automatically installs dependencies

# Evening  
packdev finish  # Automatically restores and reinstalls
git commit -m "implement feature X"
```
📖 **Read**: [Workflow Guide](./WORKFLOW.md) - Daily Development Cycle

### Team Collaboration
```bash
# Setup hooks for team safety
packdev setup-hooks
# Hooks are automatically installed in .git/hooks/

# Share configuration
git add .packdev.json
git commit -m "add local development config"
```
📖 **Read**: [GitHub Hooks](./GITHUB-HOOKS.md) - Team Setup

### Package Distribution
```bash
# Build and test package
npm run pack
npm run test-install

# Distribute
npm publish  # or share .tgz file
```
📖 **Read**: [Packaging Guide](./PACKAGING.md) - Distribution Methods

### Yarn Migration
```bash
# Migrate from npm to Yarn
rm package-lock.json
yarn install

# Use Yarn-specific commands
yarn pack
yarn add file:./package.tgz
```
📖 **Read**: [Yarn Support](./YARN-SUPPORT.md) - Migration Guide

## 🔍 Finding Information

### Search by Topic

**Configuration Management**
- [Workflow Guide](./WORKFLOW.md) - Configuration persistence
- [Main README](../README.md) - Basic configuration

**Package Managers** 
- [Yarn Support](./YARN-SUPPORT.md) - Yarn-specific features
- [Packaging Guide](./PACKAGING.md) - Cross-platform packaging

**Safety & Security**
- [GitHub Hooks](./GITHUB-HOOKS.md) - Pre-commit safety
- [Workflow Guide](./WORKFLOW.md) - Safety features

**Troubleshooting**
- [Packaging Guide](./PACKAGING.md) - Common issues section
- [Yarn Support](./YARN-SUPPORT.md) - Yarn troubleshooting
- [GitHub Hooks](./GITHUB-HOOKS.md) - Hook troubleshooting

### Command Reference

| Command | Primary Guide | Additional Info |
|---------|---------------|-----------------|
| `packdev init` | [Main README](../README.md) | [Workflow Guide](./WORKFLOW.md) |
| `packdev finish` | [Main README](../README.md) | [Workflow Guide](./WORKFLOW.md) |
| `packdev add` | [Main README](../README.md) | [Workflow Guide](./WORKFLOW.md) |
| `packdev remove` | [Main README](../README.md) | [Workflow Guide](./WORKFLOW.md) |
| `packdev setup-hooks` | [GitHub Hooks](./GITHUB-HOOKS.md) | [Main README](../README.md) |
| `packdev status` | [Main README](../README.md) | [Workflow Guide](./WORKFLOW.md) |

### Quick References

| Need | Guide | Alternative |
|------|-------|-------------|
| **5-minute start** | [Quick Start](./QUICK-START.md) | [Main README](../README.md) |
| **Common commands** | [Quick Start](./QUICK-START.md) | [Workflow Guide](./WORKFLOW.md) |

## 🚀 Demo Scripts

Interactive demonstrations are available:

```bash
# Complete workflow demonstration
npm run demo-workflow

# Interactive workflow walkthrough
npm run demo-workflow --interactive

# GitHub hooks demonstration  
npm run demo-hooks

# Interactive hook testing
npm run demo-hooks --interactive

# Package installation testing
npm run test-install

# Comprehensive package information
npm run package-info
```

## 📝 Contributing to Documentation

When updating documentation:

1. **Keep guides focused** - Each document has a specific purpose
2. **Cross-reference liberally** - Link to related information
3. **Update this index** - When adding new documents
4. **Test examples** - Ensure all code examples work
5. **Consider audience** - Write for the intended user level

### Documentation Standards

- **Headers**: Use emoji + descriptive titles
- **Code blocks**: Include language specification
- **Examples**: Provide working, testable examples  
- **Links**: Use relative paths for internal links
- **Structure**: Follow established patterns

## 📊 Documentation Stats

- **Total Documents**: 5 comprehensive guides
- **Total Lines**: 1,900+ lines of documentation
- **Coverage**: Complete workflow, packaging, safety, and package manager support
- **Maintenance**: Actively maintained and tested

## 🎉 Quick Links

- 🏠 **[Project Home](../README.md)** - Start here
- 🔄 **[Workflow](./WORKFLOW.md)** - Learn the development cycle  
- 📦 **[Packaging](./PACKAGING.md)** - Distribute your package
- 🧶 **[Yarn](./YARN-SUPPORT.md)** - Yarn-specific guide
- 🛡️ **[Safety](./GITHUB-HOOKS.md)** - Prevent mistakes

---

*This documentation index is maintained as part of PackDev. For the most up-to-date information, always refer to the latest version of each guide.*
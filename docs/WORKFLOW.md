# PackDev Workflow Guide

The complete `init`/`finish` cycle for local and git-repository dependency development.

## Core Cycle

```
Production State → init → Development State → finish → Production State
```

**Key principle**: `.packdev.json` is never deleted by `finish` — it's your persistent config, safe to restart the cycle from any time.

## Walkthrough

```bash
# 1. Track dependencies (creates .packdev.json automatically)
packdev add lodash ../my-local-lodash
packdev add @myorg/utils ../shared/utils

# 2. Switch to local development (auto-installs)
packdev init
```
`init` rewrites `package.json`, preserving the original version in `.packdev.json`:
```diff
  "dependencies": {
-   "lodash": "^4.17.21",
+   "lodash": "file:/absolute/path/to/my-local-lodash",
  }
```
```bash
# 3. Develop, test, iterate against both projects

# 4. Restore production versions (auto-installs)
packdev finish
```
`finish` reverses the diff exactly, keeps `.packdev.json` intact, and updates its `lastModified` timestamp. Repeat the cycle as needed — nothing about step 1 needs to happen again.

## Commands

| Command | Purpose | Modifies package.json | Modifies .packdev.json |
|---|---|---|---|
| `create-config` | Create config (rarely needed — `add` does this) | ❌ | ✅ creates |
| `add <pkg> <path\|url\|semver>` | Track a local/git/version override | ❌ | ✅ updates |
| `remove <pkg>` | Untrack a dependency | ❌ | ✅ updates |
| `list` | Show tracked dependencies | ❌ | read-only |
| `init` | Switch to local development | ✅ local/git paths | ✅ timestamp |
| `finish` | Restore production versions | ✅ restore | ✅ timestamp |
| `status` | Show current state | ❌ | read-only |

## Branch Switching Without Conflicts

The workflow's most practical daily benefit: `packdev finish` before switching branches means no `file:`-dependency merge conflicts and no "uncommitted changes" warnings blocking `git checkout`.

```bash
packdev init                        # local dev active
packdev finish                      # clean package.json instantly
git checkout hotfix/urgent-fix      # ✅ no conflicts, anywhere
# ... fix, review a PR, whatever ...
git checkout your-feature-branch
packdev init                        # resume exactly where you left off
```

This composes with anything that needs a clean tree: stashing, reviewing a colleague's PR, testing a different feature branch — `finish` first, `init` again when you're back.

## Safety Hooks

`packdev setup-hooks` blocks a commit that would ship `file:`/relative-path dependencies unless the message contains `WIP` (or the commit is preceded by `packdev finish`). Full setup and the auto-commit flow: **[GitHub Hooks Guide](./GITHUB-HOOKS.md)**.

```bash
packdev status
# 📊 Development mode: 🔧 Active
#   🔧 Active 📁 Local lodash: ^4.17.21 → ../my-local-lodash
```

## File Management

| File | Role | Committed? |
|---|---|---|
| `.packdev.json` | Dependency mappings, original versions, timestamps | ✅ yes (or per-developer, see below) |
| `package.json` | Rewritten by `init`, restored by `finish` | Only ever commit it in its **restored** (`finish`'d) state |

**Backup strategy**: original versions are stored in `.packdev.json` *before* any `package.json` change, local paths are validated before switching, and `finish` always succeeds if the matching `init` succeeded — `packdev restore` recovers from a crash mid-operation.

## What NOT to Do

- **Don't delete `.packdev.json`** — it's meant to persist; `finish` needs it to know what to restore.
- **Don't hand-edit `package.json` dependencies during development** — use `packdev add`/`remove`, then `init`/`finish`.
- **Don't commit `package.json` with `file:`/git-path dependencies still active** — always `packdev finish` first, or use a `WIP:` commit message if hooks are set up.

## Advanced

### Git Repository Dependencies

Test unreleased branches/commits without publishing:

```bash
packdev add ui-components https://github.com/myorg/ui-components.git#feature-branch
packdev add design-system git@github.com:myorg/design-system.git#develop
packdev add beta-lib github:myorg/beta-lib#v2.0-beta
packdev init   # downloads git deps, links local ones, in one pass
```

Supported URL forms — all take `#branch`, `#tag`, or `#commit`: `https://github.com/user/repo.git`, `git@github.com:user/repo.git`, `git+https://...`, `github:user/repo`, `gitlab:user/repo`.

### Monorepo / Dependency Chains

```bash
packdev add @myorg/package-a ./packages/package-a
packdev add @myorg/package-b ./packages/package-b
packdev init
```
Works transitively too — if A depends on B depends on C, adding both B and C as local overrides in A means a change in C is immediately visible through B, in A.

### Team Collaboration

`.packdev.json` is safe to commit if paths are relative and consistent across machines (a monorepo). If developers use different absolute local paths, add it to `.gitignore` instead — see the per-developer note in the [Quick Start Guide](./QUICK-START.md#team-collaboration).

## Comparison with Alternatives (npm link / Verdaccio / Yalc)

Covered once, in the main README to avoid drift: **[README → vs alternatives](../README.md#vs-alternatives)**.

## Release Preparation

```bash
packdev status                       # confirm: Development mode: 📦 Inactive
# if active:
packdev finish
grep -E "(file:|\.\.\/)" package.json  # should return nothing
npm run build && npm publish           # or, for this repo: gh release create (see CONTRIBUTING.md)
```

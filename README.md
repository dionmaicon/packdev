# PackDev

[![npm version](https://img.shields.io/npm/v/packdev.svg)](https://www.npmjs.com/package/packdev)
[![npm downloads](https://img.shields.io/npm/dm/packdev.svg)](https://www.npmjs.com/package/packdev)
[![CI](https://github.com/dionmaicon/packdev/actions/workflows/ci.yml/badge.svg)](https://github.com/dionmaicon/packdev/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE.md)
[![node](https://img.shields.io/node/v/packdev.svg)](package.json)

**Which version of this dependency actually works with my code?**

`npm outdated` tells you what's behind. Renovate opens the PR. Neither tells you whether the
upgrade breaks — you find out from CI, after the merge, or from production.

PackDev installs each candidate version in an isolated sandbox, runs *your* build and *your*
tests against it, and reports a verdict per version.

```bash
$ packdev compat sqs-consumer --versions 12.0.0,15.0.3 \
    --app libs/queue --test "yarn build && yarn test"

✅ 12.0.0  PASSED  (control — currently installed)
❌ 15.0.3  FAILED  src/consumer.service.ts:48
           TS2322: handleMessage must return Promise<Message | undefined>

recommended: 12.0.0    minimum: 12.0.0
```

Seventeen seconds. No install into your repo, no branch, no PR.

> PackDev doesn't decide whether to upgrade. It gives you the evidence to decide — and the
> evidence is only as good as the command you hand `--test`. Point it at your full CI, not `tsc`.

## 📦 Installation

```bash
npm install -g packdev
```

## The three checks

```bash
# 1. Static, no install: which published versions have every symbol my app imports?
packdev api-diff is-odd --range ">=0.1.0 <4.0.0" --json
# {"minimumCompatibleVersion":"0.1.0","recommendedVersion":"3.0.1", ...}

# 2. Real install + real test run, only on the range that survived step 1. The
#    installed version is auto-included as the control — if it doesn't pass,
#    the harness is broken, not the candidate, and no recommendation is emitted.
packdev compat is-odd --versions 2.0.0,3.0.1 --test "node check.js" --json
# {"minimumCompatibleVersion":"2.0.0","recommendedVersion":"3.0.1","controlFailed":false, ...}
# apiCompatible (step 1) and PASSED (step 2) are different claims — shape match ≠ behavior match

# 3. Suspect instanceof/DI weirdness from a hoisting mismatch? Workspace-aware by
#    default, exits 5 on a real duplicate — usable as a CI guard. --check-dupes
#    wires this into `compat` automatically, flagging a copy-count regression
#    even when your test command itself passes.
packdev dupes commander --json
# {"duplicate":false,"copies":[{"path":"node_modules/commander","realpath":"…/node_modules/commander","version":"14.0.1","workspace":"."}], "workspacesDetected":[],"scannedWorkspaces":[]}
```

Sometimes `api-diff` can't fully verify a package's types — a barrel `.d.ts` that re-exports from
another file, types re-exported from a sibling package, or types that come from a separate
`@types/*` package instead of the package itself. In those cases it never guesses ❌. It reports
`null` (unresolved) instead, so a gap in static analysis is never mistaken for evidence that an
upgrade breaks.

![API compatibility demo](assets/api-compat-demo.gif)

📖 **[Full API Compatibility Guide →](docs/API-COMPATIBILITY.md)** — decision table, every flag, real captured output, exit codes, and agent/scripting notes.

## For coding agents

An agent asked to "upgrade our dependencies" has two options: guess from changelogs, or open a
PR and wait for CI. PackDev gives it a third — a bounded, falsifiable check it can run itself,
before touching the repo.

```bash
packdev --json compat <pkg> --versions <list> --app <dir> --test "<your CI command>"
```

- **Every command has `--json`** with a stable schema and meaningful exit codes.
- **Nothing is mutated.** Sandboxed installs; your `node_modules` and lockfile are untouched.
- **Verdicts are earned, not inferred.** A ✅ means your test command exited 0 against that
  exact version — not that a model read a changelog and felt good about it.
- **`dupes` catches what tests can't see:** two copies of the same package silently break
  `instanceof`, DI singletons, and Symbol registries. One tree walk, no install.

### Install as an MCP server

`packdev mcp` runs the same three checks as MCP tools (`api_diff`, `compat`, `dupes`) over stdio, so
an agent can call them directly instead of shelling out to the CLI. It runs entirely on your
machine — your dependency tree is never uploaded anywhere.

```jsonc
// Claude Code:  claude mcp add packdev -- npx -y packdev mcp
// or in .mcp.json / claude_desktop_config.json:
{
  "mcpServers": {
    "packdev": { "command": "npx", "args": ["-y", "packdev", "mcp"] }
  }
}
```

### Add this to your agent instructions

Drop this into `AGENTS.md` / `CLAUDE.md` / `.cursorrules` so the discipline travels with the tool
instead of depending on someone remembering to invoke it correctly — it works whether the agent
has the MCP server configured or is just shelling out to the CLI:

```markdown
### Dependency upgrades
Before proposing any dependency upgrade, verify it — use the `api_diff`/`compat`/`dupes` MCP
tools if configured, otherwise the equivalent CLI commands:
1. Static screen, no install: `api_diff` tool, or
   `packdev --json api-diff <pkg> --range ">=<next-major>"`.
2. Real install + real test, control included: `compat` tool, or
   `packdev --json compat <pkg> --versions <installed>,<candidate> --app <workspace>
   --test "<the exact CI command>"` — the installed version is the control.
3. If the control fails, the harness is broken, not the package. Report that, don't upgrade.
4. `dupes` tool, or `packdev dupes <pkg>`, before and after. A copy count that goes up is a
   regression.
Never claim an upgrade is safe without a passing control.
```

## Use it in CI

Point it at a Renovate or Dependabot PR and get the answer before a human looks:

```bash
packdev --json compat $PKG --versions $CURRENT,$PROPOSED --app $WORKSPACE \
  --test "yarn build && yarn lint:test && yarn test" \
  --snapshot-dir ./packdev-snapshots
```

Exit non-zero on a failed candidate, attach the JSON as a PR comment, keep the lockfile
snapshots as build artifacts so "why was this green last week and red today" is answerable.
`compat` also reports which sandbox mode ran (`hermetic` vs a full workspace install) and which
package manager resolved it — see `--mode` and `--package-manager` in the
[API Compatibility Guide](docs/API-COMPATIBILITY.md) if a monorepo needs one pinned explicitly.

---

## Develop against local packages

PackDev's other half: a `npm link`/yalc-style workflow for testing an unpublished package (local
path or git branch) in a consumer app, without global state or a private registry.

**The problem**: you're developing a library and need to test it in your app before publishing.
`npm link` creates global state and conflicts between projects; publishing beta versions clutters
your registry; manual `file:` paths or git URLs in `package.json` are easy to accidentally commit.

```bash
packdev add my-library ../my-library    # Configure once
packdev init                             # Switch to local
# ... develop and test ...
packdev finish                           # Back to npm version
```

![PackDev demo](assets/demo.gif)

### Quick Start

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

### vs alternatives

| Feature | PackDev | npm link | Verdaccio | Yalc |
|---------|---------|----------|-----------|------|
| **How it works** | Swaps package.json | Symlinks | Private npm server | Publish to local store |
| **No global state** | ✅ | ❌ | ✅ | ❌ Global store |
| **Git dependencies** | ✅ | ❌ | ❌ | ❌ |
| **Accidental commit protection** | ✅ Built-in hooks | ❌ | N/A | ⚠️ Manual check |
| **CI/CD ready** | ✅ | ❌ | ✅ | ⚠️ |
| **Multi-project safe** | ✅ | ❌ Conflicts | ✅ | ⚠️ Shared store |

- **When to use PackDev**: direct package.json manipulation, git URLs, built-in safety
- **When to use npm link**: quick one-off symlink testing
- **When to use Verdaccio**: team needs a full private npm registry with authentication
- **When to use Yalc**: prefer a publish/push workflow, need package copying over `file:` links

📖 **[Detailed Comparison →](docs/WORKFLOW.md#-detailed-comparison-with-alternatives)**

### Examples

<details>
<summary><strong>Simple local development</strong></summary>

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

</details>

<details>
<summary><strong>Testing a specific release version</strong></summary>

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

</details>

<details>
<summary><strong>Clean git branch switching</strong></summary>

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

</details>

<details>
<summary><strong>Git auto-commit safety hook</strong></summary>

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

</details>

<details>
<summary><strong>CI/CD testing with multiple variants</strong></summary>

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

</details>

<details>
<summary><strong>Monorepo — auto-link and live rebuild</strong></summary>

Working in a monorepo (npm/pnpm/yarn workspaces)? Let PackDev find the package for you and rebuild it as you edit:

```bash
# In your app package, no path needed — packdev locates the workspace member
packdev link ui-library
packdev init

# Rebuild ui-library automatically on every source change
packdev watch  # 👀 detects the build script, rebuilds on save
```

`packdev link` searches workspace members and sibling directories, so you don't hand-write `../../packages/ui-library`. `packdev watch` picks up each linked package's `build` script (override per package via the `watch` block in `.packdev.json`).

</details>

<details>
<summary><strong>Agent-friendly scripting (JSON + exit codes)</strong></summary>

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

</details>

### Safety features

- **Auto-backup**: Original package.json preserved before changes
- **Path validation**: Ensures local paths and git URLs exist
- **Git hooks**: Prevent accidental commits of development configs
- **Status checks**: Always know if you're in dev or production mode
- **Per-developer config**: `.packdev.json` lives on your machine — add it to `.gitignore` since paths are local to each developer

📖 **[Safety Best Practices →](docs/WORKFLOW.md#-safety-features)**

---

## 📖 Documentation

- **[Quick Start Guide](docs/QUICK-START.md)** - Get up and running in 5 minutes
- **[Workflow & Best Practices](docs/WORKFLOW.md)** - Team collaboration, CI/CD, safety
- **[API Compatibility Guide](docs/API-COMPATIBILITY.md)** - `api`/`api-diff`/`compat`/`dupes` — decision table, flags, real output, agent notes
- **[Git Hooks](docs/GITHUB-HOOKS.md)** - Auto-commit protection and safety checks
- **[Packaging Guide](docs/PACKAGING.md)** - Building, testing, and distributing
- **[Yarn Support](docs/YARN-SUPPORT.md)** - Using PackDev with Yarn

## 🔧 Commands Reference

```bash
# Verify a dependency upgrade before installing it
packdev api <pkg>                            # Show the export map of the installed version (--introspect for pure-JS fallback)
packdev api-diff <pkg> --range <semver>      # Which published versions satisfy what your app imports (static, no install)
packdev compat <pkg> --test <cmd>            # Does your real test suite pass against a candidate version (sandboxed install)
packdev dupes <pkg>                          # Find every distinct copy of a package resolved in the tree
packdev mcp                                  # Run as a local MCP server (stdio) exposing api_diff/compat/dupes as tools

# Develop against local packages
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

📖 **[Complete Command Reference →](docs/QUICK-START.md#-essential-commands)** · 📖 **[API Compatibility Guide →](docs/API-COMPATIBILITY.md)**

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

📦 [npm](https://www.npmjs.com/package/packdev) | 🐙 [GitHub](https://github.com/dionmaicon/packdev) | 📖 [Documentation](docs/README.md)

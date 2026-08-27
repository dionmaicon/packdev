# Contributing to PackDev

Thank you for your interest in contributing to PackDev!

## Getting Started

**Prerequisites**: Node.js >= 18.0.0, npm/Yarn/pnpm, Git.

```bash
git clone https://github.com/YOUR_USERNAME/packdev.git
cd packdev
git remote add upstream https://github.com/dionmaicon/packdev.git
npm install
npm run build
```

**Development mode** (run the CLI from TypeScript source, no build step):
```bash
npm run dev -- init
npm run dev -- status
npm run dev -- --help
```

## Project Structure

```
packdev/
├── src/
│   ├── index.ts            # CLI entry point (Commander.js)
│   ├── mcp.ts               # `packdev mcp` — MCP server exposing api_diff/compat/dupes/behavior_diff
│   ├── packageManager.ts    # init/finish/add/link/watch — local & git dependency swapping
│   ├── api.ts, apiDiff.ts   # `api`/`api-diff` — static export-surface checks
│   ├── compat.ts            # `compat` — sandboxed real-install/real-test runtime checks
│   ├── dupes.ts             # `dupes` — duplicate resolved-copy detection
│   ├── behaviorDiff.ts       # `behavior-diff` (experimental) — reachability-filtered shipped-code diff
│   ├── registry.ts          # npm registry fetch/auth/tarball download+extract
│   ├── appScan.ts           # scans the app's own source for real package usage
│   ├── runtimeIntrospect.ts # sandboxed runtime introspection fallback for `api --introspect`
│   ├── watch.ts             # `watch` — rebuild linked local deps on change
│   └── utils.ts             # shared helpers
├── dist/                    # compiled output (generated, not committed)
├── test/
│   ├── unit/                # unit + feature tests (CI-safe)
│   ├── integration/         # real package.json manipulation workflows
│   ├── git-hooks/           # pre-commit hook tests (need a TTY, local-only)
│   └── docker/              # yarn-workspaces integration, real package manager behavior
├── scripts/                 # build/pack/demo scripts
├── docs/                    # this documentation
└── .github/workflows/       # CI (ci.yml) + npm publish on release (deploy.yml)
```

## Development Workflow

```bash
git fetch upstream && git checkout main && git merge upstream/main
git checkout -b feature/your-feature-name

# ... make changes ...

npm run build && npm run lint && npm run typecheck
npm run test:unit-only        # fast, CI-safe
npm test                      # everything, including git-hooks tests (local only)

git commit -m "feat: add support for pnpm package manager"
```

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`.

## Testing

| Suite | Location | Run with | CI |
|---|---|---|---|
| Unit/feature | `test/unit/` | `npm run test:unit-only` | ✅ |
| Integration | `test/integration/` | `npm run test:integration` | ✅ |
| Git hooks | `test/git-hooks/` | `npm test` (included) | ❌ needs a TTY |
| Docker (real package managers) | `test/docker/` | `npm run test:docker` | manual |

Feature tests (`test/unit/features.test.js`) run the built CLI as a subprocess against a local fake npm registry — no network calls, no real installs beyond what the test itself sandboxes. When adding a `compat`/`api-diff`/`dupes`/`behavior-diff` feature, add a test there following the existing pattern (`this.run('description', async () => { ... })`), and register it in the `runAll()` call list at the bottom of the file.

## Code Standards

- TypeScript strict types — avoid `any`. 2-space indent, single quotes, semicolons required.
- Errors should be actionable: name the exact path/value, not just "not found."
  ```typescript
  // Good
  throw new Error(`package.json not found at ${packageJsonPath} — run packdev from your project root.`);
  // Avoid
  throw new Error('File not found');
  ```
- Comments explain *why* (a non-obvious constraint or workaround), not *what* — the code and types should already say what.
- Update `README.md`/`docs/` for user-facing changes in the same PR.

## Submitting Changes

1. `git fetch upstream && git rebase upstream/main`
2. Push your branch and open a PR with a Conventional Commits-style title (`feat: add pnpm support`)
3. Describe what/why/how it was tested
4. A maintainer reviews and merges

## Release Process

Maintainers only — see [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) for the exact automation:

1. Bump `version` in `package.json` (semver — patch/minor/major)
2. `npm install --package-lock-only` to sync the lockfile, commit both
3. `gh release create v<version> --title v<version> --notes "..."` — creating the **GitHub Release** (not just a git tag) triggers `deploy.yml`, which runs the full test suite and publishes to npm automatically
4. A bare `git tag && git push --tags` does **not** trigger publish — it must go through a GitHub Release

## Questions?

- Bug reports / feature requests: [open an issue](https://github.com/dionmaicon/packdev/issues)
- Questions: [start a discussion](https://github.com/dionmaicon/packdev/discussions)

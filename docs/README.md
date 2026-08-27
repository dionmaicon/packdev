# PackDev Documentation

`packdev` is two things in one CLI: a local/git dependency development workflow (`init`/`finish`/`add`/`link`), and a dependency-upgrade verification toolkit (`api`/`api-diff`/`compat`/`dupes`/`behavior-diff`).

## Start Here

| I want to... | Read |
|---|---|
| Get running in 5 minutes | [Quick Start](./QUICK-START.md) |
| Understand the full `init`/`finish` workflow | [Workflow Guide](./WORKFLOW.md) |
| Verify a dependency upgrade before merging it | [API Compatibility Guide](./API-COMPATIBILITY.md) |
| Prevent committing local/git dependency overrides | [GitHub Hooks](./GITHUB-HOOKS.md) |
| Build/pack/install the CLI locally | [Packaging Guide](./PACKAGING.md) |
| Use `packdev` with Yarn specifically | [Yarn Support](./YARN-SUPPORT.md) |
| Contribute code | [Contributing Guide](./CONTRIBUTING.md) |

## Pages

| Page | Lines | Covers |
|---|---|---|
| [Main README](../README.md) | ~480 | Project pitch, installation, both feature sets, MCP server, full commands reference |
| [Quick Start](./QUICK-START.md) | ~250 | 5-minute walkthrough, essential commands, common scenarios, troubleshooting |
| [Workflow Guide](./WORKFLOW.md) | ~130 | init/finish cycle in depth, branch switching, git-URL dependencies, monorepos |
| [API Compatibility Guide](./API-COMPATIBILITY.md) | ~300 | `api`/`api-diff`/`compat`/`dupes`/`behavior-diff` — full flag reference, JSON schemas, exit codes, agent/scripting notes |
| [GitHub Hooks](./GITHUB-HOOKS.md) | ~100 | Pre-commit safety hook setup, auto-commit flow, CI guard snippet |
| [Packaging Guide](./PACKAGING.md) | ~65 | Build, pack, local install, troubleshooting |
| [Yarn Support](./YARN-SUPPORT.md) | ~55 | Package-manager auto-detection, Yarn-specific gotchas |
| [Contributing Guide](./CONTRIBUTING.md) | ~110 | Dev setup, project structure, testing, release process |

## Conventions

- Every command example that produces JSON uses `--json`; every JSON schema shown was captured from a real run, not hand-written.
- Internal links are relative paths (`./FILE.md`, `../README.md`) — this is deliberate so the `docs/` folder can be dropped into a GitHub wiki repo as-is, with `docs/README.md` becoming `Home.md`.
- Each guide states its own scope in its first paragraph; if you're looking for something and it's not where you expected, check the table above rather than assuming it doesn't exist.

## Demo Scripts

```bash
npm run demo-workflow              # interactive init/finish walkthrough
npm run demo-hooks                 # interactive git-hooks walkthrough
npm run test-install                # verify a packed tarball actually installs
npm run package-info                # dump resolved package metadata
```

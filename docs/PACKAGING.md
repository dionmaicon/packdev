# Packaging & Local Installation

How to build a tarball and install it in another project for testing — before publishing.

## Build & Pack

```bash
npm run pack        # or: yarn pack
```
This builds TypeScript → `dist/`, creates `packdev-<version>.tgz`, and prints install instructions for both npm and Yarn. A cross-platform bash equivalent exists too: `npm run pack:bash`.

Manual steps, if you want them separately:
```bash
npm run build   # tsc: src/ -> dist/
npm pack        # dist/ + package.json + README.md + LICENSE.md -> .tgz
```

The tarball's contents are controlled by `package.json`'s `"files"` field — currently `dist/**/*.js`, `dist/**/*.d.ts`, `README.md`, `LICENSE.md`. `src/`, `test/`, and dev config never ship.

## Installing It Somewhere Else

```bash
# From a tarball
npm install ./packdev-0.4.0.tgz              # or: yarn add file:./packdev-0.4.0.tgz

# Directly from the built directory (auto-updates when you rebuild)
npm install /path/to/packdev                  # or: yarn add file:/path/to/packdev

# Globally, to get the `packdev` binary on PATH
npm install -g /path/to/packdev                # or: yarn global add file:/path/to/packdev
packdev --help
```

Yarn requires the `file:` protocol for local paths; npm accepts either form. See [Yarn Support](./YARN-SUPPORT.md) if anything here behaves differently under Yarn.

## Verifying an Install

```bash
packdev --help                                       # CLI works
node -e "console.log(require('packdev'))"             # module resolves

# Inspect a tarball's contents before installing it, if you're suspicious
tar -tzf packdev-0.4.0.tgz
```

## Continuous Local Testing

Point a real test project at the built directory instead of re-packing every time:
```bash
# In the test project
npm install file:../path/to/packdev
# Rebuilding packdev's dist/ is picked up automatically on next install/require
```

## Troubleshooting

| Problem | Fix |
|---|---|
| `EACCES` on global install | `npm config set prefix ~/.npm-global` and add it to `PATH`, instead of `sudo` |
| Build errors | `npm run clean && npm run build` |
| "package not found" after install | Confirm the tarball built (`npm run pack` output), and that `dist/` actually contains compiled `.js`/`.d.ts` — a failed `tsc` run silently leaves a stale/partial `dist/` |

## Publishing (maintainers)

This repo publishes via CI, not manual `npm publish` — see **[Contributing Guide → Release Process](./CONTRIBUTING.md#release-process)**: a GitHub Release (not a bare git tag) triggers `.github/workflows/deploy.yml`, which runs the full test suite and publishes to npm.

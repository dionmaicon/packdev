# PackDev with Yarn

`packdev` auto-detects your package manager — nothing Yarn-specific to configure, but a few things are worth knowing.

## Detection Order

1. `package.json`'s `"packageManager"` field (Corepack pin), if present — always wins
2. `pnpm-lock.yaml` → pnpm
3. `yarn.lock` → Yarn
4. `package-lock.json` → npm
5. Falls back to npm if none found, walking up parent directories (so it still resolves correctly from inside a monorepo workspace child)

Every `packdev` command that shells out to a package manager (`init`, `finish`, `compat`'s sandboxed installs, etc.) uses whichever one this resolves to.

## The `file:` Protocol Gotcha

Yarn requires the `file:` protocol for local packages; npm accepts a bare path. `packdev add`/`init` already handle this correctly regardless of which manager is detected — this only matters if you're installing a packed `.tgz` by hand:

```bash
# ❌ Yarn rejects this
yarn add ./packdev-1.0.0.tgz
# ✅ Yarn needs the protocol
yarn add file:./packdev-1.0.0.tgz
# npm accepts either form
npm install ./packdev-1.0.0.tgz
```

## Building/Packing with Yarn

Every `npm run <script>` in this repo has a Yarn equivalent (`yarn <script>`) — `yarn pack`, `yarn build`, `yarn test-install`, etc. See [Packaging Guide](./PACKAGING.md) for the full script list; nothing about them differs by package manager beyond the invocation prefix.

## Yarn Workspaces (monorepos)

`compat --app <workspace-dir>` and `dupes` are workspace-aware for Yarn (Classic and Berry) automatically — see [API Compatibility Guide](./API-COMPATIBILITY.md) for how duplicate/hoisting detection works across workspaces. For `packdev`'s own local-dependency development workflow in a workspace root:

```json
// package.json
{ "workspaces": ["packages/*"] }
```
```bash
yarn workspace my-package add file:../packdev
```

## Troubleshooting

| Problem | Fix |
|---|---|
| `"file: protocol not found"` | Use `yarn add file:./package.tgz`, not a bare path |
| Global install not on `PATH` | `export PATH="$(yarn global bin):$PATH"` |
| Stale/corrupt cache | `yarn cache clean` |
| Need to see what's actually happening | `yarn add file:./package.tgz --verbose`, or `yarn config list` |

## Yarn 3+ (Berry)

`packdev`'s own package manager detection and the sandboxed installs in `compat` both work against Yarn Berry (tested against 4.14.1) — `workspace:`-protocol dependencies resolve correctly once `compat` sandboxes the whole monorepo root (automatic, see [API Compatibility Guide](./API-COMPATIBILITY.md#-packdev-compat-pkg---test-cmd)). Zero-installs/PnP mode is untested; expect to fall back to `nodeLinker: node-modules` if you hit resolution issues.

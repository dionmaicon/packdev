# API Compatibility Guide

Four commands that answer "what's actually there" at increasing levels of confidence and cost — `api`, `api-diff`, `compat`, and `dupes`. They exist because LLMs and humans alike hallucinate methods that don't exist in the version actually resolved in a project (classic multi-package monorepo situation, e.g. NestJS's `@nestjs/*` family pinned to different versions across apps), and that isn't caught until CI or runtime.

## 🧭 Which command do I need?

| Question | Command |
|---|---|
| What can I call on the version I have installed right now? | `packdev api <pkg>` |
| Which published versions have every symbol my app actually imports? (fast, no install) | `packdev api-diff <pkg> --range <semver>` |
| Does my real test suite actually pass against a candidate version? (slower, real install) | `packdev compat <pkg> --test <cmd>` |
| Is a weird `instanceof`/DI bug caused by two copies of the same package in the tree? | `packdev dupes <pkg>` |

**Start with `api-diff` before reaching for `compat`.** `api-diff` never installs anything — it downloads a tarball, reads its `.d.ts`, and diffs it against what your app actually imports — so checking a 10-version range costs about the same as checking one. `compat` does a real install + real test run per version, which is correct but slow. Use `api-diff` to narrow a range down first, then `compat` to actually confirm the survivors.

### `apiCompatible` and `PASSED`/`FAILED` are never the same claim

`api-diff`'s `apiCompatible` means "the exported shape matches" — pure static analysis. `compat`'s `PASSED`/`FAILED` means "the real test suite actually ran and passed" — real behavior. **A version can be `apiCompatible: true` and still `FAILED`** — same function signature, different runtime behavior (a classic breaking change that doesn't show up in types). Neither command claims what the other checks; don't conflate them. Minimal illustration (same target version, both commands run against it):

```json
// api-diff — same export shape as before, looks fine statically
{ "version": "1.0.0", "apiCompatible": true, "missingSymbols": [] }

// compat — the real test suite actually caught a behavior change
{ "version": "1.0.0", "status": "FAILED" }
```

`apiCompatible` is actually a **tri-state**: `true` / `false` / `null` — `null` means "couldn't be statically verified" (a barrel `.d.ts`, see `api-diff`'s reference section below), and is never a synonym for `false`. Treat `null` as "run `compat` for a real answer," not as a failure.

## 📦 `packdev api <pkg>`

Shows the export map of whatever version of `<pkg>` is currently resolved in `node_modules` — functions, classes, interfaces, types, with signatures.

```bash
packdev api commander --json
```
```json
{
  "command": "api", "package": "commander", "version": "14.0.1",
  "resolvedPath": "/…/node_modules/commander", "hasTypes": true,
  "exports": [
    { "name": "createCommand", "kind": "function", "signature": "(name?: string): Command", "subpath": "." },
    { "name": "CommanderError", "kind": "class", "signature": "CommanderError", "subpath": "." },
    { "name": "Command", "kind": "class", "signature": "Command", "subpath": "." }
  ]
}
```

| Flag | Purpose |
|---|---|
| `--introspect` | Fall back to executing the package and reflecting its **runtime** shape, but only when no static types were found anywhere. See below. |
| `--introspect-timeout-ms <n>` | Timeout for `--introspect` (default `5000`). |

**Resolution order**: conditional `"exports"` map → `"types"`/`"typings"` fields → `main` with `.js`→`.d.ts` swapped → a sibling `@types/<pkg>` package. If `"exports"` declares subpaths beyond the root (`./testing`, `./utils`, ...), those are resolved too and each entry is tagged `"subpath"` (`"."` for the root). A package published for both CJS and ESM (dual entry points) will legitimately show near-duplicate entries with different `subpath` values — that's real, not a bug.

`export = X` (TypeScript's CommonJS export-assignment syntax, common in older `@types/*` packages) is resolved and reported as `"default"`, matching how `import X from "pkg"` is recorded elsewhere in this tool family.

**`hasTypes: false`** means no static declarations were found anywhere (a valid, honest outcome for a pure-JS package, not an error). Optionally recover partial information with `--introspect`:

```bash
packdev api pure-js-lib --introspect --json
```
```json
{
  "hasTypes": false, "exports": [],
  "runtimeIntrospection": {
    "exports": [
      { "name": "Widget", "kind": "class", "signature": "(0 args)", "members": ["render", "destroy"] },
      { "name": "createWidget", "kind": "function", "signature": "(1 args)" }
    ]
  }
}
```

`--introspect` **executes the installed package's real code** in an isolated, timeout-bounded child process to walk its prototype chain (a plain `Object.keys()` on a class instance misses methods — they live on `.prototype`). It's opt-in only, never automatic, and clearly separated from static output (`runtimeIntrospection` is `null` unless the flag is passed and static resolution found nothing) — don't reach for it by default against untrusted packages.

**`hasTypes: true` but `exports: []`** (types exist but the checker couldn't statically resolve anything to a real symbol — the common case is a barrel `.d.ts` built from `export * from "./generated"` re-exports the isolated single-file program can't follow, or a generic factory-wrapper pattern) surfaces a `rawExportHints` fallback: a syntax-only scan (no type checker) that can still name what's there, even without a signature. It is never conflated with a resolved export — treat it as "there's *something* here, but not verified":

```bash
packdev api barrel-lib --json
```
```json
{
  "hasTypes": true, "exports": [],
  "rawExportHints": [
    { "name": "*", "note": "re-exported from \"./generated\"" }
  ]
}
```

`--introspect` also applies in this case (types resolved to nothing usable, same as no types at all) for a runtime-reflected shape instead.

**Exit codes**: `0` success (including `hasTypes: false` and the `rawExportHints` fallback), `4` package not installed anywhere up the `node_modules` tree.

## 🔍 `packdev api-diff <pkg> --range <semver>`

Scans your app's real imports of `<pkg>`, then checks every published version in `--range` against that usage — entirely statically, no install, no `node_modules` mutation.

```bash
packdev api-diff is-odd --range ">=0.1.0 <4.0.0" --app . --json
```
```json
{
  "command": "api-diff", "package": "is-odd", "range": ">=0.1.0 <4.0.0",
  "usedSymbols": ["default"], "hasDynamicUsage": false,
  "minimumCompatibleVersion": "0.1.0", "recommendedVersion": "3.0.1",
  "versions": [
    { "version": "0.1.0", "apiCompatible": true, "missingSymbols": [], "exportCount": 1, "typesSource": "types-package" },
    { "version": "3.0.1", "apiCompatible": true, "missingSymbols": [], "exportCount": 1, "typesSource": "types-package" }
  ]
}
```

| Flag | Purpose |
|---|---|
| `--range <semver>` | **Required.** Version range to check, e.g. `">=1.0.0 <3.0.0"`. |
| `--app <dir>` | App directory to scan for imports (default `.`). |
| `--registry <url>` | npm registry URL. Defaults to `.npmrc`'s `@scope:registry` mapping for a scoped package, then `.npmrc`'s own `registry` line, then `https://registry.npmjs.org` — usually doesn't need to be passed by hand. |
| `--token <token>` | Bearer token for a private registry. Defaults to `NPM_TOKEN`/`NODE_AUTH_TOKEN` env vars, then `.npmrc`'s `//<host>/:_authToken`. |
| `--include-prerelease` | Include prerelease versions (excluded by default). |
| `--include-deprecated` | Include deprecated versions (excluded by default). |

- `hasDynamicUsage: true` means the app uses a namespace import (`import * as x`) or a bare `require(pkg)` somewhere — those can't be statically resolved to specific symbols, so the usage check is only a partial guarantee for that app. It's surfaced, not silently ignored.
- `typesSource` tells you where the types came from for that version: `"bundled"` (shipped with the package), `"types-package"` (fetched `@types/<pkg>` separately), or `"none"` (no types found anywhere — `missingSymbols` will include everything the app imports, since nothing could be verified).
- `usedSymbols: []` (app never imports the package) makes every version trivially `apiCompatible: true` — nothing to miss.
- **Everything is sorted, so two versions' results are diffable at a glance.** `versions[]` is ascending by semver; `usedSymbols`, and each version's `missingSymbols`/`unresolvedSymbols`, are alphabetical — not scan/insertion order. The same symbol name always lands in the same relative position across every version's list, so scanning down a v1.0 → v2.0 pair reads like a git diff instead of requiring a symbol-by-symbol re-read each time.
- **`apiCompatible: null`** is a third, distinct state from `true`/`false` — "couldn't be verified," not "incompatible." It fires when types exist but resolve to zero exports (a barrel `.d.ts` — `export * from "./generated"` re-exports the isolated single-file resolver can't follow — same limitation `api`'s `rawExportHints` fallback exists for). The affected symbols land in `unresolvedSymbols`, **never** in `missingSymbols` — reporting an unverifiable symbol as missing would be a confident false negative, not an honest "unknown." When every version in range is `null` (nothing confirmed either way), the human output explicitly says so isn't a confirmed incompatibility and points at `compat` for a real answer:
  ```json
  { "version": "1.0.199-abc123", "apiCompatible": null, "missingSymbols": [], "unresolvedSymbols": ["EventPublisher"], "exportCount": 0, "typesSource": "bundled" }
  ```
- **Private registries** (GitHub Packages, Artifactory, Verdaccio, ...): if `--app`'s `.npmrc` already has `@scope:registry` and `//<host>/:_authToken` lines (the same ones your real installs use), `api-diff` picks them up automatically — no `--registry`/`--token` needed. A `401` error names the exact host and explains which of `--token`/env/`.npmrc` it looked for and found nothing.

**Exit codes**: `0` success, `1` generic error (invalid range, registry unreachable or unauthorized, etc.).

## 🧪 `packdev compat <pkg> --test <cmd>`

For each candidate version: copies your app into an isolated sandbox, pins the version, runs a real install, runs your real test command, records the result, discards the sandbox. Never touches the real project.

```bash
packdev compat is-odd --versions 2.0.0,3.0.1 --test "node check.js" --json
```
```json
{
  "command": "compat", "package": "is-odd",
  "minimumCompatibleVersion": "2.0.0", "recommendedVersion": "3.0.1", "nonMonotonic": false,
  "versions": [
    { "version": "2.0.0", "status": "PASSED", "exitCode": 0, "durationMs": 920,
      "lockfileHash": "9dc1ee7f…", "lockfileSnapshotPath": "/tmp/packdev-compat-snapshots-.../is-odd-2.0.0-npm-package-lock.json" },
    { "version": "3.0.1", "status": "PASSED", "exitCode": 0, "durationMs": 630,
      "lockfileHash": "394e9906…", "lockfileSnapshotPath": "/tmp/packdev-compat-snapshots-.../is-odd-3.0.1-npm-package-lock.json" }
  ],
  "snapshotDir": "/tmp/packdev-compat-snapshots-...", "concurrency": 1, "testCommandCaveat": null, "testCommandCaveats": [],
  "seededLockfile": false, "lockfileSeedNote": null, "fanOutConsumers": []
}
```

| Flag | Purpose |
|---|---|
| `--test <cmd>` | Command to run in each sandbox, e.g. `"npm test"`. Required unless `--test-script` is given. |
| `--test-script <name>` | Run `"<detected package manager> run <name>"` in each target's own directory instead of `--test` for all of them — consumers rarely share one test command, so with `--fan-out`/multi-target `--app` this is usually what you want. |
| `--range <semver>` / `--versions <list>` | Mutually exclusive — a registry range, or an explicit comma-separated list. |
| `--app <dir>`, `--registry <url>`, `--token <token>`, `--include-prerelease`, `--include-deprecated` | Same meaning and `.npmrc` auto-detection as `api-diff`. `--registry`/`--token` here only resolve `--range` — the sandbox's own real install always uses its package manager's normal `.npmrc` auth, unaffected by `--token`. `--app` also accepts a comma-separated list (`libs/a,libs/b`) or a glob (`apps/*`, expanded from the current directory) — the first match is the primary app, the rest become fan-out consumers (see below). |
| `--fan-out` | Auto-discover fan-out consumers instead of listing them in `--app`: every workspace under the monorepo root (other than `--app`) that directly declares `<pkg>`, ranked by how many distinct symbols it imports from it, capped at `--top`. |
| `--top <n>` | Cap on auto-discovered fan-out consumers (`--fan-out` only, default 5) — fan-out multiplies wall clock per version. |
| `--bisect` | Binary-search the pass/fail boundary instead of testing every version (fewer runs). Re-confirms the boundary once to catch flakiness/non-monotonicity, falling back to a full linear scan if the confirmation disagrees — never trusts a fast-but-wrong answer. |
| `--group <pkgs>` | Comma-separated peer packages to pin to the **same** version as `<pkg>` in every run (NestJS's `@nestjs/*` family, or any set that must move in lockstep). Without this, only `<pkg>` moves — its declared peers stay wherever your `package.json` already has them, which usually isn't a combination anyone actually ships. |
| `--snapshot-dir <dir>` | Save a hashed copy of each version's resolved lockfile — the target version pins exactly, but its *own* dependencies still resolve by range, so the same target version can mean a different dependency tree across two runs. Point repeated runs at the same directory to build a diffable history. |
| `--concurrency <n>` | Test up to `n` versions in parallel (linear scan only — `--bisect`'s binary search is inherently sequential, this is a documented no-op there). |
| `--prefer-offline` | Pass `--prefer-offline` through to the sandbox's package manager install. |
| `--check-dupes` | After each sandboxed install, check for duplicate resolved copies of `<pkg>` and its direct dependencies; fail a version whose copy count increased relative to the control (`dupesRegression` on that version). |
| `--seed-lockfile` | Copy the app's own lockfile into every sandbox before install, so the pin forces a minimal update against real resolution stickiness instead of a fresh solve. Recommended with `--check-dupes` — off by default because it's less hermetic: a stale lockfile can mask a resolution a clean install would surface. |

- `status`: `"PASSED"` / `"FAILED"` (install succeeded, test command didn't) / `"INSTALL_FAILED"` (the install itself failed — native build breakage, missing peer, etc. — distinct from a real test failure, so it doesn't masquerade as an API problem) / `"SKIPPED"` (couldn't even be sandboxed — see below).
- **`workspace:`-protocol dependencies are handled, not just diagnosed**: if the app's `package.json` declares a `workspace:`-protocol dependency (`"workspace:*"`, `"workspace:^"`, the yarn/pnpm workspaces convention), `compat` finds the monorepo root (walking up for a `package.json` with `workspaces` or a `pnpm-workspace.yaml`) and sandboxes the **whole monorepo**, not just the app — so sibling workspace packages physically exist in the sandbox and those specifiers resolve normally. The install runs at the sandboxed monorepo root; the test command runs at the sandboxed app's own directory within it. This needs a package manager that actually understands `workspace:` (Yarn Berry / pnpm — npm and Yarn Classic don't); if the app's own detected manager doesn't, expect `INSTALL_FAILED` with that manager's real error, not a silent skip.
- **`"SKIPPED"`** now only happens when no workspaces root is discoverable anywhere above the app at all (an unusual layout) — `compat` genuinely has nothing to sandbox against. `output` names the blocking dependencies either way.
- **All versions `SKIPPED` is a distinct, honest outcome from "tested and failed"**: the human summary says `⚠️ Every version was skipped — nothing was actually tested` (not the generic "no version passed the test command," which would misleadingly imply a real test ran) and the command exits **`6`** — not `0` — so a CI pipeline can't mistake "verified nothing" for a pass.
- **`INSTALL_FAILED`/`SKIPPED` diagnostics**: human output prints the real reason under each such line (the package manager's actual stderr for `INSTALL_FAILED`, the blocking dependency names for `SKIPPED`) — `--json`'s `output` field has the same text if you're scripting against it instead.
- `nonMonotonic: true` (linear scan only) means a fail sits between two passes in version order — the assumption `--bisect` relies on doesn't hold for this package; test individually or accept the slower full scan.
- Exact reproduction: `snapshotDir` + `lockfileSnapshotPath` per version are always present (auto-generated if `--snapshot-dir` wasn't passed) — diff two runs' snapshot files for the same version to see exactly what changed.
- **A `PASSED` is only as trustworthy as `--test`.** `compat` warns on the ways this can be true without meaning anything, all best-effort heuristics over your test command/config — false negatives are expected, they only need to catch the common cases:
  - **`TRANSPILE_ONLY`**: `--test` contains `jest` and the app's config looks transpile-only (`ts-jest` with `isolatedModules: true`, `babel-jest`, `@swc/jest`) — these transpile TypeScript *without* type-checking it, so a version with a genuinely broken type surface can still report `PASSED`.
  - **`TYPE_CHECK_ONLY`**: `--test` is bare `tsc`/`tsc --noEmit` and nothing else — the mirror case. A type check can't see anything runtime-only: an ESM-only bump, a duplicate-copy regression, an actual behavior change. Prefer a `--test` that includes your real test suite, not just one or the other.
  - **`PASS_WITH_NO_TESTS`**: `--test` or the jest config sets `--passWithNoTests` — a run that matches zero test files still exits `0`, so `PASSED` may mean the suite never actually ran.
  - **Per-version `esmMismatch`** (on each `CompatVersionResult`, not a report-level caveat — a package can go ESM-only in exactly one candidate, not the whole range): fires only when the app's own `--test` is a jest run that's CJS-blind to that candidate specifically (no evidence jest's default `transformIgnorePatterns` was customized) **and** the candidate looks ESM-only relative to the control (adds `"type":"module"`, or drops the CJS `require`/`default` export condition from its `exports` map). This is the one class of break a type-check-only `--test` structurally cannot see even with a real test suite configured, because Node's module loader and jest's CJS transform behave differently from `tsc` here.

  `testCommandCaveat` (the first caveat's message, `null` if none) is kept for back-compat; `testCommandCaveats` is the full list of `{ code, severity, message }`. Both print in human output.
- **`seededLockfile`/`lockfileSeedNote`**: `seededLockfile` is `true` when `--seed-lockfile` was on. `lockfileSeedNote` is non-null exactly when there's something worth saying about that choice — a reduced-hermeticity warning when seeding is on, or a recommendation to turn it on when `--check-dupes` is set without it (a fresh solve re-flattens the tree, which can hide exactly the nested-fork duplicate class `--check-dupes` was built to catch).
- **Fan-out: test the dependents, not just the owner.** Testing only the package that declares `<pkg>` is a weak claim in a monorepo — its own tests can pass while a sibling workspace that actually exercises the changed behavior breaks. With `--fan-out` or a multi-target `--app`, every target is pinned and tested in **one shared sandbox** (this forces workspace sandbox mode — consumers are sibling packages, so a discoverable monorepo root is required above the primary `--app`). Each `CompatVersionResult.consumers[]` entry — `{ dir, name, status, exitCode, output }`, `dir: "."` for the primary app — is one target's own test run against that already-installed version; `status` at the top level becomes the **rollup**, `"PASSED"` only if every consumer passed. Report-level `fanOutConsumers` lists which dirs were actually tested (auto-discovered ones too), so you don't have to dig into a version to see who was covered. A workspace only reachable via hoisting (imports `<pkg>` but doesn't declare it) isn't eligible for auto-discovery — there's no section of its own `package.json` to pin the candidate version into.
- **Non-zero exit on a real failure** (linear scan only): if any version comes back `FAILED` or `INSTALL_FAILED`, `compat` exits **`7`**, so it can gate a CI job the same way `dupes` gates on `5`. This does **not** apply to `--bisect` — its per-step `FAILED` results while narrowing the boundary are expected search mechanics, not a verdict, so they never flip the exit code; check `minimumCompatibleVersion`/`recommendedVersion` instead for a bisected run.

**Exit codes**: `0` success, `1` generic error (package not declared, `--range`/`--versions` both/neither given, a `--group` member not declared, etc.), `6` every version was `SKIPPED` (nothing was actually tested), `7` at least one version genuinely `FAILED`/`INSTALL_FAILED` (linear scan only, not `--bisect`).

## 🧬 `packdev dupes <pkg>`

> **Breaking change:** the `--json` array of resolved copies was renamed from `resolutions` to `copies` — the old name collided with `package.json`'s own `resolutions` field when read alongside it. Update any script/agent parsing this output to read `copies` instead.

Walks the real `node_modules` tree (not the declared dependency graph) for every distinct place `<pkg>` actually resolves — the thing that breaks `instanceof` checks and DI singletons when hoisting goes wrong. **Two copies of the *same* version still count** — Node caches modules by realpath, so a different physical directory is always a different object, even at an identical version string.

```bash
packdev dupes commander --json
# {"command":"dupes","package":"commander","duplicate":false,"copies":[{"path":"node_modules/commander","realpath":"/abs/…/node_modules/commander","version":"14.0.1","workspace":"."}], "workspacesDetected":[],"scannedWorkspaces":[],"resolvedViaParent":null}
```

**Workspace-aware by default.** In an npm/yarn/pnpm workspaces monorepo, hoisting is partial: a workspace whose range can't be satisfied by the hoisted version gets its own private nested copy — the single most common source of duplicate-copy bugs, and invisible if only the root's own `node_modules` is scanned. `dupes` detects `package.json` `workspaces` (array or `{packages: [...]}` form) and `pnpm-workspace.yaml`, and scans every matched workspace's `node_modules` too, not just the root's:

```console
$ packdev dupes @acme/shared-lib --json
{"duplicate":true,"copies":[
  {"path":"node_modules/@acme/shared-lib","version":"1.0.0","workspace":"."},
  {"path":"apps/checkout/node_modules/@acme/shared-lib","version":"1.0.199-abc123","workspace":"apps/checkout"}
], "workspacesDetected":["apps/checkout","apps/api"], "scannedWorkspaces":["apps/checkout","apps/api"]}
```

A common real cause: a **prerelease** pinned in some workspaces (`1.0.199-abc123`) can never satisfy the caret ranges (`^1.0.0`) the rest of the monorepo uses, so it can never hoist — every workspace pinned to it gets a private, non-interchangeable copy even though nothing about it looks wrong in a build or test run. When `dupes` can confirm this mechanism (a prerelease copy coexists with a non-prerelease copy, and it can find another workspace whose own declared range genuinely can't match the prerelease), it says so directly instead of only reporting the generic "copies may break identity checks" warning:

```console
⚠️  3 distinct copies found (2 distinct versions) — instanceof/DI singletons may break across copies
⚠️  1 workspace(s) pin a PRERELEASE (1.0.199-abc123).
    Prerelease versions are not matched by the caret/tilde ranges used by other workspaces (^1.0.195), so they cannot hoist and each pinned workspace gets a private copy.
    If this package exports classes used as identity tokens (NestJS providers, instanceof checks), those copies are NOT interchangeable.
```

This is the `prereleaseHoistingNote` field in `--json` output (`null` when no prerelease is involved, or when the specific blocking range couldn't be confirmed — an unconfirmed guess isn't printed). Every workspace reachable from the scan is checked for its own declared range, not just the ones with a physical duplicate copy — most affected workspaces are simply *hoisted* to the non-prerelease version and have no copy of their own, so they'd otherwise be invisible to this check entirely. `blockedRange` cites whichever range blocks the **most** workspaces (not just the first one found); `allBlockedRanges` lists every distinct blocking range with its own workspace list, and `totalBlockedWorkspaces` sums across all of them, for repos where the declared ranges aren't uniform.

| Flag | Purpose |
|---|---|
| `--root <dir>` | Search root (default `.`). |
| `--no-workspaces` | Skip the workspace scan even if a workspaces config is found — root-only, for speed on very large monorepos. When set, `scannedWorkspaces` stays `[]` while `workspacesDetected` still lists what was skipped, so the verdict is visibly hedged rather than silently claiming a clean bill of health. |

Four honest outcomes:

| `copies` | `duplicate` | Exit | Meaning |
|---|---|---|---|
| One entry | `false` | `0` | Single resolution — nothing to worry about. |
| 2+ entries (any versions, even identical) | `true` | `5` | Real duplication — `instanceof`/DI singletons may break across the copies. |
| `[]`, `resolvedViaParent` set | `false` | `0` | Not nested here, but resolves fine via Node's normal upward `node_modules` walk from a parent directory — distinct from not being a dependency at all. |
| `[]`, `resolvedViaParent: null` | `false` | `0` | Genuinely not installed anywhere reachable from `--root` (or a typo'd package name) — not an error. |

Exit code **`5`** on `duplicate: true` makes `dupes` usable directly as a CI guard (`packdev dupes <pkg> || fail-the-build`); every other outcome above is `0`.

Each resolution includes `realpath` (fully resolved, symlinks followed) alongside `path`, since realpath is what actually determines Node's module-identity — two `path`s that look different can still be the same realpath (a symlink), and vice versa.

## Exit codes (all four commands)

| Code | Meaning |
|---|---|
| `0` | Success — including honest "nothing found" outcomes (`hasTypes: false`, empty `dupes` copies). |
| `1` | Generic error — see the `error` field in `--json` output for the actual message. |
| `4` | Package not installed anywhere up the `node_modules` tree (`api` only — `api-diff`/`compat` resolve from the registry, not local `node_modules`). |
| `5` | `dupes` found `duplicate: true` — usable directly as a CI guard. |
| `6` | `compat` — every version was `SKIPPED`; nothing was actually tested. |
| `7` | `compat` — at least one version `FAILED`/`INSTALL_FAILED` (linear scan only; `--bisect` never sets this). |

## 🤖 Agent/scripting notes

- Always pass `--json` — every report includes a `command` field, so combined/piped output from multiple invocations stays disambiguable without re-parsing prose.
- Budget-conscious ordering: run `api-diff` first (cheap, no install) to narrow a version range down to plausible candidates, then `compat` (expensive, real installs) only on the survivors — don't run `compat --range` across a wide range as a first move.
- `success: false` + a human-readable `error` string appears in every command's JSON on failure, in addition to the exit code — branch on either, but the exit code is the stable contract across versions.
- `--introspect` executes third-party code. Treat it the same as running the package's own code directly — don't enable it by default in an automated pipeline against untrusted packages.
- First-party, mid-migration packages living behind a private registry are exactly the ones most worth checking with `api-diff`/`compat` — and the ones your `.npmrc` already knows how to authenticate to for real installs. Point `--app` at the project whose `.npmrc` has the right `@scope:registry`/`_authToken` lines and skip `--registry`/`--token` entirely; only reach for `--token` (or `NPM_TOKEN`/`NODE_AUTH_TOKEN`) when running somewhere without that `.npmrc` on disk, e.g. a bare CI job.
- `dupes` exits `5` on `duplicate: true` — wire it into CI as a guard (`packdev dupes <pkg> || exit 1`) rather than only reading `--json`'s `duplicate` field by hand.
- Never treat `api-diff`'s `apiCompatible: null` or `compat`'s `status: "SKIPPED"` as a failure signal — both mean "couldn't be determined," a different claim than `false`/`FAILED`. An agent auto-upgrading or auto-blocking on these commands' output should branch on them separately (e.g. surface for human review) rather than folding them into the same bucket as a confirmed incompatibility.

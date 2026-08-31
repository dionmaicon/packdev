/**
 * `packdev mcp` — exposes api-diff/compat/dupes as MCP tools over stdio, so a
 * coding agent can verify a dependency upgrade itself instead of guessing
 * from a changelog. Deliberately a subcommand of the existing binary, not a
 * separate package: one version number, the tool schemas can't drift from
 * the CLI behaviour, and `npx -y packdev mcp` needs no separate install.
 *
 * This is local-only by construction: it reads node_modules/lockfiles and
 * runs sandboxed installs on the caller's disk, so it is a stdio server, not
 * a hosted one. Nothing here ever makes an outbound call except the npm
 * registry lookups the CLI itself already makes.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { version } from "../package.json";
import { runApiDiff } from "./apiDiff";
import { runCompat, runCompatBisect, type CompatOptions } from "./compat";
import { findDuplicateResolutions } from "./dupes";
import { runBehaviorDiff } from "./behaviorDiff";
import { loadNpmrcConfig, resolveRegistryForPackage, resolveAuthToken } from "./registry";

// The discipline from the README's "add this to your agent instructions"
// block, carried by the server itself (as a resource and in every tool's
// description) so it travels with the tool instead of depending on a human
// having pasted it into AGENTS.md.
const GUIDE = `# Verifying a dependency upgrade with PackDev

Before proposing any dependency upgrade, verify it:

1. \`api_diff\` — cheap static screen, no install. Checks which published
   versions have every symbol your app actually imports.
2. \`compat\` — real install in a sandbox, real test command. Always include
   the currently-installed version alongside the candidate: it becomes the
   "control", tested identically. Nothing is mutated — your node_modules and
   lockfile are untouched.
3. If the control fails (\`controlFailed: true\`), the test harness is
   broken, not the package. Report that, don't upgrade. A failed control
   also means no recommendation is emitted (\`recommendedVersion: null\`).
4. \`dupes\` — run before and after. A copy count that goes up (nested
   duplicate) can silently break instanceof/DI singletons even when tests
   pass; \`compat\`'s \`checkDupes\` option wires this in automatically.

Never claim an upgrade is safe without a passing control. A ✅/PASSED
verdict means the exact test command you supplied exited 0 against that
exact version — nothing more, and nothing less.`;

function jsonResult(data: unknown): { content: [{ type: "text"; text: string }] } {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

function errorResult(error: unknown): {
  content: [{ type: "text"; text: string }];
  isError: true;
} {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: JSON.stringify({ success: false, error: message }) }],
    isError: true,
  };
}

async function resolveRegistryAndToken(
  pkgName: string,
  appDir: string,
  registryOverride: string | undefined,
  tokenOverride: string | undefined,
): Promise<{ registryUrl: string; token: string | undefined }> {
  const npmrc = await loadNpmrcConfig(appDir);
  const registryUrl = resolveRegistryForPackage(pkgName, npmrc, registryOverride);
  const token = resolveAuthToken(registryUrl, npmrc, tokenOverride);
  return { registryUrl, token };
}

export function createPackdevMcpServer(): McpServer {
  const server = new McpServer({ name: "packdev", version });

  server.registerResource(
    "packdev-guide",
    "packdev://guide",
    {
      title: "How to verify a dependency upgrade with PackDev",
      description: "The control-version discipline every PackDev tool call should follow.",
      mimeType: "text/markdown",
    },
    () => ({
      contents: [{ uri: "packdev://guide", mimeType: "text/markdown", text: GUIDE }],
    }),
  );

  server.registerTool(
    "api_diff",
    {
      title: "PackDev api-diff",
      description:
        "Static, no-install check: which published versions of a package satisfy every " +
        "symbol your app actually imports from it. Cheap first screen before compat. " +
        "A version can come back apiCompatible: null (not false) when its export surface " +
        "can't be statically verified (a barrel re-export, a cross-package re-export, or " +
        "types from a separate @types/* package) — that is not the same claim as false, " +
        "and must not be reported to the user as an incompatibility.",
      inputSchema: {
        package: z.string().describe("Package name to check"),
        range: z.string().describe('Version range to check, e.g. ">=1.0.0 <3.0.0"'),
        app: z.string().default(".").describe("App directory to scan for usage"),
        registry: z
          .string()
          .optional()
          .describe("npm registry URL (defaults to .npmrc resolution, then the public registry)"),
        token: z
          .string()
          .optional()
          .describe("Bearer token for a private registry (defaults to env/.npmrc)"),
        includePrerelease: z.boolean().optional().describe("Include prerelease versions"),
        includeDeprecated: z.boolean().optional().describe("Include deprecated versions"),
      },
    },
    async (args) => {
      try {
        const appDir = args.app ?? ".";
        const { registryUrl, token } = await resolveRegistryAndToken(
          args.package,
          appDir,
          args.registry,
          args.token,
        );
        const report = await runApiDiff(args.package, {
          range: args.range,
          appDir,
          registryUrl,
          token,
          includePrerelease: args.includePrerelease ?? false,
          includeDeprecated: args.includeDeprecated ?? false,
        });
        return jsonResult({ command: "api-diff", ...report });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "compat",
    {
      title: "PackDev compat",
      description:
        "Installs each candidate version of a package in an isolated sandbox and runs your " +
        "real test command against it — the ground-truth check, more expensive than " +
        "api_diff but the only one that can see runtime/build failures a type check can't " +
        "(ESM-only bumps, duplicate-copy regressions, behavior changes). Always include the " +
        "currently-installed version in `versions` alongside the candidate(s): it is tested " +
        "identically as the control, and if it fails (controlFailed: true in the response), " +
        "the test harness itself is broken — do not attribute that failure to the candidate, " +
        "and do not report a recommendation (recommendedVersion will be null).",
      inputSchema: {
        package: z.string().describe("Package name to check"),
        versions: z
          .array(z.string())
          .optional()
          .describe(
            "Explicit versions to test, e.g. the installed version plus one candidate — " +
              "mutually exclusive with `range`, and one of the two is required",
          ),
        range: z
          .string()
          .optional()
          .describe(
            'Version range to resolve candidates from instead of listing them explicitly, e.g. ">=1.0.0 <3.0.0" — mutually exclusive with `versions`',
          ),
        app: z.string().default(".").describe("Primary app directory to test — used for `range`/control resolution"),
        consumerApps: z
          .array(z.string())
          .optional()
          .describe(
            "Extra workspace directories to test as fan-out consumers alongside `app`, in the " +
              "same sandbox. Testing only the owning package's own tests is a much weaker claim " +
              "than testing what actually depends on it. Requires a discoverable monorepo root " +
              "above `app` (consumers are sibling packages). Mutually exclusive with `fanOut`.",
          ),
        fanOut: z
          .boolean()
          .optional()
          .describe(
            "Auto-discover fan-out consumers instead of listing them: every workspace under the " +
              "monorepo root (other than `app`) that directly declares `package`, ranked by how " +
              "many distinct symbols it imports from it and capped at `fanOutTop`.",
          ),
        fanOutTop: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Cap on auto-discovered fan-out consumers (`fanOut` only). Default 5."),
        testScript: z
          .string()
          .optional()
          .describe(
            'Run "<detected package manager> run <testScript>" in each target\'s own directory ' +
              "instead of `test` for all of them — consumers rarely share one test command.",
          ),
        test: z
          .string()
          .optional()
          .describe(
            'Command to run in each sandboxed version/target, e.g. "npm run build && npm test" — ' +
              "should include your real test suite, not just a type check: a bare `tsc --noEmit` " +
              "can see a broken type surface but nothing runtime-only (an ESM-only bump, a " +
              "duplicate-copy regression, an actual behavior change), while a transpile-only " +
              "jest setup (ts-jest isolatedModules, babel-jest, @swc/jest) never reads the " +
              "dependency's types at all. The response's testCommandCaveats[] reports which of " +
              "these it detected for this exact command. Required unless testScript is given.",
          ),
        registry: z.string().optional().describe("npm registry URL, used for the sandboxed install"),
        token: z
          .string()
          .optional()
          .describe(
            "Bearer token for a private registry, used only to resolve `range` into concrete " +
              "versions — the sandboxed install itself authenticates via its own package " +
              "manager's .npmrc, not this token. Has no effect when `versions` is given directly.",
          ),
        group: z
          .array(z.string())
          .optional()
          .describe("Package names to pin to the same version as `package` in every sandbox run"),
        snapshotDir: z
          .string()
          .optional()
          .describe("Directory to save a resolved-lockfile snapshot per tested version"),
        includePrerelease: z
          .boolean()
          .optional()
          .describe("Include prerelease versions when resolving `range`"),
        includeDeprecated: z
          .boolean()
          .optional()
          .describe("Include deprecated versions when resolving `range`"),
        concurrency: z.number().int().min(1).optional().describe("Versions to test in parallel"),
        preferOffline: z.boolean().optional().describe("Prefer the local package manager cache"),
        checkDupes: z
          .boolean()
          .optional()
          .describe(
            "After each install, fail a version whose duplicate-copy count for the package " +
              "or its direct dependencies increased relative to the control — pair with " +
              "seedLockfile, otherwise a fresh solve can re-flatten away exactly the nested-" +
              "fork duplicate this is meant to catch",
          ),
        seedLockfile: z
          .boolean()
          .optional()
          .describe(
            "Copy the app's own lockfile into every sandbox before install, reproducing real " +
              "resolution stickiness instead of a fresh solve. Less hermetic (a stale lockfile " +
              "can mask a resolution a clean install would surface), but the condition " +
              "checkDupes needs to see a nested-fork regression.",
          ),
        ignoreInstallScripts: z
          .boolean()
          .optional()
          .describe(
            "Block lifecycle scripts (preinstall/install/postinstall) during compat's own " +
              "sandbox install of the candidate version — scoped to that install step only, " +
              "so the app's own pretest/prebuild hooks still run normally and the verdict stays " +
              "meaningful. Off by default: install scripts are load-bearing for native packages " +
              "(esbuild, sharp, better-sqlite3), so blocking them can turn a healthy version " +
              "into a false FAILED. Uses --ignore-scripts under npm/pnpm/Yarn Classic and " +
              "--mode=skip-build under Yarn Berry (Berry's closest equivalent — skips build/" +
              "lifecycle scripts); has no effect only when the yarn generation actually in use " +
              "couldn't be determined — see testCommandCaveats for an IGNORE_SCRIPTS_UNSUPPORTED " +
              "warning when that happens.",
          ),
        mode: z
          .enum(["hermetic", "workspace"])
          .optional()
          .describe("Force sandbox mode instead of auto-detecting from workspace:-protocol deps"),
        packageManager: z
          .string()
          .optional()
          .describe('Override the detected package manager, e.g. "yarn@1.22.22"'),
        bisect: z
          .boolean()
          .optional()
          .describe("Binary-search the pass/fail boundary instead of testing every version"),
      },
    },
    async (args) => {
      try {
        if (!args.range && (!args.versions || args.versions.length === 0)) {
          throw new Error("Either `range` or `versions` must be provided");
        }
        if (args.range && args.versions && args.versions.length > 0) {
          throw new Error("`range` and `versions` are mutually exclusive");
        }
        if (!args.test && !args.testScript) {
          throw new Error("Either `test` or `testScript` must be provided");
        }
        const appDir = args.app ?? ".";
        const { registryUrl, token } = await resolveRegistryAndToken(
          args.package,
          appDir,
          args.registry,
          args.token,
        );
        const compatOptions: CompatOptions = {
          ...(args.range !== undefined ? { range: args.range } : {}),
          ...(args.versions !== undefined ? { versions: args.versions } : {}),
          appDir,
          testCommand: args.test,
          registryUrl,
          token,
          ...(args.includePrerelease !== undefined
            ? { includePrerelease: args.includePrerelease }
            : {}),
          ...(args.includeDeprecated !== undefined
            ? { includeDeprecated: args.includeDeprecated }
            : {}),
          ...(args.group !== undefined ? { group: args.group } : {}),
          ...(args.snapshotDir !== undefined ? { snapshotDir: args.snapshotDir } : {}),
          ...(args.concurrency !== undefined ? { concurrency: args.concurrency } : {}),
          ...(args.preferOffline !== undefined ? { preferOffline: args.preferOffline } : {}),
          ...(args.checkDupes !== undefined ? { checkDupes: args.checkDupes } : {}),
          ...(args.seedLockfile !== undefined ? { seedLockfile: args.seedLockfile } : {}),
          ...(args.ignoreInstallScripts !== undefined
            ? { ignoreInstallScripts: args.ignoreInstallScripts }
            : {}),
          ...(args.consumerApps !== undefined ? { consumerApps: args.consumerApps } : {}),
          ...(args.fanOut !== undefined ? { fanOut: args.fanOut } : {}),
          ...(args.fanOutTop !== undefined ? { fanOutTop: args.fanOutTop } : {}),
          ...(args.testScript !== undefined ? { testScript: args.testScript } : {}),
          ...(args.mode !== undefined ? { mode: args.mode } : {}),
          ...(args.packageManager !== undefined ? { packageManager: args.packageManager } : {}),
        };
        const report = args.bisect
          ? await runCompatBisect(args.package, compatOptions)
          : await runCompat(args.package, compatOptions);
        return jsonResult({ command: "compat", ...report });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "dupes",
    {
      title: "PackDev dupes",
      description:
        "Finds every distinct physical copy of a package resolved in the dependency tree. " +
        "Two copies of the SAME version still break instanceof checks and DI singletons " +
        "(NestJS tokens, Symbol registries) — Node caches modules by realpath, so a copy at " +
        "a different path is a different object even at an identical version. Cheap: a single " +
        "tree walk, no install. Run before and after a `compat` check — a copy count that " +
        "goes up is a regression `compat`'s own test command may not catch.",
      inputSchema: {
        package: z.string().describe("Package name to check"),
        root: z.string().default(".").describe("Directory to search from"),
        scanWorkspaces: z
          .boolean()
          .optional()
          .describe("Scan workspace-nested node_modules too (default true)"),
      },
    },
    async (args) => {
      try {
        const root = args.root ?? ".";
        const report = await findDuplicateResolutions(args.package, root, {
          ...(args.scanWorkspaces !== undefined ? { scanWorkspaces: args.scanWorkspaces } : {}),
        });
        const { resolutions, ...rest } = report;
        return jsonResult({
          command: "dupes",
          package: args.package,
          duplicate: resolutions.length > 1,
          copies: resolutions,
          ...rest,
        });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "behavior_diff",
    {
      title: "PackDev behavior-diff (EXPERIMENTAL)",
      description:
        "EXPERIMENTAL. Diffs a package's shipped code between the installed version and `to`, " +
        "filtered to functions reachable from what `app` actually imports/passes as option-bag " +
        "keys — the one class of break neither api_diff (types only) nor compat (pass/fail, no " +
        "attribution) can point at directly: a semantic change with a near-identical type surface " +
        "(e.g. a callback's return value changing from 'acknowledge' to 'requeue' semantics). " +
        "Reports evidence only — which lines changed and which import/option-key pulled them in " +
        "— never a verdict; do not report a change here as a confirmed behavior break without " +
        "reading the diff yourself. Function-matching (by name) and reachability (textual " +
        "mention, not a real call graph) are both best-effort heuristics: expect false negatives. " +
        "`degraded` (non-null) means no diff could be produced (native/wasm, minified/bundled " +
        "output, or no compiled JS found) — `changes` is always [] in that case.",
      inputSchema: {
        package: z.string().describe("Package name to check"),
        to: z.string().describe("Version to diff against the installed (control) version"),
        app: z
          .string()
          .default(".")
          .describe("App directory to scan for usage, and to resolve the installed (from) version from"),
        registry: z
          .string()
          .optional()
          .describe("npm registry URL (defaults to .npmrc resolution, then the public registry)"),
        token: z.string().optional().describe("Bearer token for a private registry"),
        maxDepth: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Local-require hops to walk out from the entry file, per version. Default 3."),
        maxResults: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Cap on distinct changed/added/removed functions returned. Default 20."),
      },
    },
    async (args) => {
      try {
        const appDir = args.app ?? ".";
        const { registryUrl, token } = await resolveRegistryAndToken(
          args.package,
          appDir,
          args.registry,
          args.token,
        );
        const report = await runBehaviorDiff(args.package, args.to, {
          appDir,
          registryUrl,
          token,
          ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
          ...(args.maxResults !== undefined ? { maxResults: args.maxResults } : {}),
        });
        return jsonResult({ command: "behavior-diff", ...report });
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = createPackdevMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

#!/usr/bin/env node

import { Command } from "commander";
import { version } from "../package.json";
import {
  initializeProject,
  finishProject,
  addLocalDependency,
  linkPackage,
  removeLocalDependency,
  listLocalDependencies,
  validateProject,
  setupGitHooks,
  restoreProject,
} from "./packageManager";

const program = new Command();

program
  .name("packdev")
  .description(
    "CLI tool for managing local and git package development dependencies",
  )
  .version(version)
  .option("--json", "Output machine-readable JSON instead of human text", false);

// Emits `data` as JSON to stdout when --json is set, otherwise runs `human()`
// to print the normal prose output. Keeps stdout pure JSON in --json mode by
// routing progress/log lines to stderr instead.
function output(data: Record<string, unknown>, human: () => void): void {
  if (program.opts()["json"]) {
    console.log(JSON.stringify(data));
  } else {
    human();
  }
}

function log(message: string): void {
  if (program.opts()["json"]) {
    console.error(message);
  } else {
    console.log(message);
  }
}

// Stable exit codes so scripts/agents can branch on failure kind instead of
// parsing prose. 0 always means success or a safe no-op.
const EXIT_CODE = {
  SUCCESS: 0,
  GENERIC_ERROR: 1,
  CONFIG_NOT_FOUND: 2,
  PACKAGE_JSON_NOT_FOUND: 3,
} as const;

function exitCodeFor(error?: string): number {
  if (!error) return EXIT_CODE.GENERIC_ERROR;
  if (/configuration file .* not found/i.test(error)) {
    return EXIT_CODE.CONFIG_NOT_FOUND;
  }
  if (/package\.json not found/i.test(error)) {
    return EXIT_CODE.PACKAGE_JSON_NOT_FOUND;
  }
  return EXIT_CODE.GENERIC_ERROR;
}

program
  .command("init")
  .description(
    "Initialize development mode - replace package.json versions with local paths or git URLs",
  )
  .option(
    "-c, --config <path>",
    "Path to .packdev.json config file",
    ".packdev.json",
  )
  .option(
    "--no-install",
    "Skip running package manager install after updating package.json",
  )
  .option(
    "--dry-run",
    "Preview changes without writing package.json or running install",
    false,
  )
  .action(async (options) => {
    try {
      log("🚀 Initializing development mode...");
      const result = await initializeProject(
        options.config,
        options.install,
        options.dryRun,
      );

      output({ command: "init", dryRun: !!options.dryRun, ...result }, () => {
        if (result.success) {
          console.log(
            options.dryRun
              ? "✅ Dry run — no files were written."
              : "✅ Development mode initialized successfully!",
          );
          console.log(
            `📝 ${options.dryRun ? "Would replace" : "Replaced"} ${result.replacedCount} dependencies with local paths or git URLs`,
          );
          if (result.replacedPackages.length > 0) {
            console.log("📦 Development packages:");
            result.replacedPackages.forEach((pkg) => {
              console.log(
                `  - ${pkg.name}: ${pkg.originalVersion} → ${pkg.localPath}`,
              );
            });
          }
        } else {
          console.error("❌ Failed to initialize:", result.error);
        }
      });

      if (!result.success) process.exit(exitCodeFor(result.error));
    } catch (error) {
      output(
        { command: "init", success: false, error: String(error) },
        () => console.error("❌ Error during initialization:", error),
      );
      process.exit(EXIT_CODE.GENERIC_ERROR);
    }
  });

program
  .command("finish")
  .description(
    "Finish development mode - restore original package.json versions",
  )
  .option(
    "-c, --config <path>",
    "Path to .packdev.json config file",
    ".packdev.json",
  )
  .option(
    "--no-install",
    "Skip running package manager install after updating package.json",
  )
  .option(
    "--dry-run",
    "Preview changes without writing package.json or running install",
    false,
  )
  .action(async (options) => {
    try {
      log("🔄 Finishing development mode...");
      const result = await finishProject(
        options.config,
        options.install,
        options.dryRun,
      );

      output({ command: "finish", dryRun: !!options.dryRun, ...result }, () => {
        if (result.success) {
          console.log(
            options.dryRun
              ? "✅ Dry run — no files were written."
              : "✅ Development mode finished successfully!",
          );
          console.log(
            `📝 ${options.dryRun ? "Would restore" : "Restored"} ${result.restoredCount} dependencies to original versions`,
          );
          if (result.restoredPackages.length > 0) {
            console.log("📦 Restored packages:");
            result.restoredPackages.forEach((pkg) => {
              console.log(
                `  - ${pkg.name}: ${pkg.localPath} → ${pkg.originalVersion}`,
              );
            });
          }
        } else {
          console.error("❌ Failed to finish:", result.error);
        }
      });

      if (!result.success) process.exit(exitCodeFor(result.error));
    } catch (error) {
      output(
        { command: "finish", success: false, error: String(error) },
        () => console.error("❌ Error during finish:", error),
      );
      process.exit(EXIT_CODE.GENERIC_ERROR);
    }
  });

program
  .command("add")
  .description("Add a local package or git repository to .packdev.json")
  .argument("<package>", "Package name")
  .argument("<location>", "Relative path to local package or git URL")
  .option(
    "-c, --config <path>",
    "Path to .packdev.json config file",
    ".packdev.json",
  )
  .option(
    "-o, --original-version <version>",
    "Override version (auto-detected from package.json if not provided)",
  )
  .option(
    "--no-install",
    "Skip running package manager install after updating package.json",
  )
  .option(
    "--dry-run",
    "Preview changes without writing .packdev.json, package.json, or running install",
    false,
  )
  .action(async (packageName, location, options) => {
    try {
      log(`📦 Adding dependency: ${packageName} → ${location}`);
      const result = await addLocalDependency(
        packageName,
        location,
        options.config,
        options.originalVersion,
        options.install,
        options.dryRun,
      );

      output(
        {
          command: "add",
          package: packageName,
          location,
          dryRun: !!options.dryRun,
          ...result,
        },
        () => {
          if (result.success) {
            console.log(
              options.dryRun
                ? "✅ Dry run — no files were written."
                : "✅ Dependency added successfully!",
            );
            console.log(
              `📝 ${options.dryRun ? "Would add" : "Added"} ${packageName}: ${result.version} → ${location}`,
            );
          } else {
            console.error("❌ Failed to add dependency:", result.error);
          }
        },
      );

      if (!result.success) process.exit(exitCodeFor(result.error));
    } catch (error) {
      output(
        { command: "add", success: false, error: String(error) },
        () => console.error("❌ Error adding dependency:", error),
      );
      process.exit(EXIT_CODE.GENERIC_ERROR);
    }
  });

program
  .command("link")
  .description(
    "Auto-detect a local package's path (workspace member or sibling directory) and add it",
  )
  .argument("<package>", "Package name")
  .option(
    "-c, --config <path>",
    "Path to .packdev.json config file",
    ".packdev.json",
  )
  .option(
    "-o, --original-version <version>",
    "Override version (auto-detected from package.json if not provided)",
  )
  .option(
    "--no-install",
    "Skip running package manager install after updating package.json",
  )
  .option(
    "--dry-run",
    "Preview changes without writing .packdev.json, package.json, or running install",
    false,
  )
  .action(async (packageName, options) => {
    try {
      log(`🔎 Locating local package: ${packageName}`);
      const result = await linkPackage(
        packageName,
        options.config,
        options.originalVersion,
        options.install,
        options.dryRun,
      );

      output(
        {
          command: "link",
          package: packageName,
          dryRun: !!options.dryRun,
          ...result,
        },
        () => {
          if (result.success) {
            console.log(
              options.dryRun
                ? "✅ Dry run — no files were written."
                : "✅ Dependency linked successfully!",
            );
            console.log(
              `📝 ${options.dryRun ? "Would link" : "Linked"} ${packageName}: ${result.version} → ${result.location}`,
            );
          } else {
            console.error("❌ Failed to link dependency:", result.error);
            if (result.candidates && result.candidates.length > 0) {
              console.log("📁 Candidates found:");
              result.candidates.forEach((dir) => console.log(`  - ${dir}`));
            }
          }
        },
      );

      if (!result.success) process.exit(exitCodeFor(result.error));
    } catch (error) {
      output(
        { command: "link", success: false, error: String(error) },
        () => console.error("❌ Error linking dependency:", error),
      );
      process.exit(EXIT_CODE.GENERIC_ERROR);
    }
  });

program
  .command("remove")
  .description("Remove a local or git dependency from .packdev.json")
  .argument("<package>", "Package name")
  .option(
    "-c, --config <path>",
    "Path to .packdev.json config file",
    ".packdev.json",
  )
  .action(async (packageName, options) => {
    try {
      log(`📦 Removing dependency: ${packageName}`);
      const result = await removeLocalDependency(packageName, options.config);

      output({ command: "remove", package: packageName, ...result }, () => {
        if (result.success) {
          console.log("✅ Dependency removed successfully!");
        } else {
          console.error("❌ Failed to remove dependency:", result.error);
        }
      });

      if (!result.success) process.exit(exitCodeFor(result.error));
    } catch (error) {
      output(
        { command: "remove", success: false, error: String(error) },
        () => console.error("❌ Error removing dependency:", error),
      );
      process.exit(EXIT_CODE.GENERIC_ERROR);
    }
  });

program
  .command("list")
  .description("List all configured local and git dependencies")
  .option(
    "-c, --config <path>",
    "Path to .packdev.json config file",
    ".packdev.json",
  )
  .action(async (options) => {
    try {
      const result = await listLocalDependencies(options.config);

      output({ command: "list", ...result }, () => {
        if (result.success) {
          if (result.dependencies.length === 0) {
            console.log("📝 No dependencies configured");
          } else {
            console.log("📦 Configured dependencies:");
            result.dependencies.forEach((dep) => {
              console.log(
                `  - ${dep.package}: ${dep.version} → ${dep.location}`,
              );
            });
          }
        } else {
          console.error("❌ Failed to list dependencies:", result.error);
        }
      });

      if (!result.success) process.exit(exitCodeFor(result.error));
    } catch (error) {
      output(
        { command: "list", success: false, error: String(error) },
        () => console.error("❌ Error listing dependencies:", error),
      );
      process.exit(EXIT_CODE.GENERIC_ERROR);
    }
  });

program
  .command("watch")
  .description(
    "Rebuild linked local dependencies on change (--once to build and exit)",
  )
  .option(
    "-c, --config <path>",
    "Path to .packdev.json config file",
    ".packdev.json",
  )
  .option("--once", "Build all linked dependencies once, then exit", false)
  .action(async (options) => {
    const jsonMode = !!program.opts()["json"];
    try {
      const { runWatch } = await import("./watch");

      await runWatch({
        configPath: options.config,
        once: options.once,
        onEvent: (event) => {
          if (jsonMode) {
            console.log(JSON.stringify({ command: "watch", ...event }));
            return;
          }
          switch (event.event) {
            case "no-targets":
              console.log(`ℹ️  ${event.message}`);
              break;
            case "watching":
              console.log(`👀 Watching ${event.package} (${event.message})`);
              break;
            case "build-start":
              console.log(`🔨 Building ${event.package}...`);
              break;
            case "build-success":
              console.log(`✅ ${event.package} built`);
              break;
            case "build-failed":
              console.error(`❌ ${event.package} build failed`);
              break;
          }
        },
      });
    } catch (error) {
      output(
        { command: "watch", success: false, error: String(error) },
        () => console.error("❌ Error running watch:", error),
      );
      process.exit(EXIT_CODE.GENERIC_ERROR);
    }
  });

program
  .command("status")
  .description("Show development mode status and configured dependencies")
  .option(
    "-c, --config <path>",
    "Path to .packdev.json config file",
    ".packdev.json",
  )
  .action(async (options) => {
    try {
      const result = await validateProject(options.config);

      output({ command: "status", ...result }, () => {
        console.log("📊 Project Status:");
        console.log(
          `Config file: ${result.configExists ? "✅ Found" : "❌ Not found"}`,
        );
        console.log(
          `Package.json: ${result.packageJsonExists ? "✅ Found" : "❌ Not found"}`,
        );
        console.log(
          `Development mode: ${result.isInDevMode ? "🔧 Active" : "📦 Inactive"}`,
        );

        if (result.configExists && result.dependencies.length > 0) {
          console.log("\n📦 Configured dependencies:");
          result.dependencies.forEach((dep) => {
            const typeIcon = dep.type === "git" ? "🔗" : "📁";
            const status = result.isInDevMode ? "🔧 Active" : "📦 Remote";
            const typeLabel = dep.type === "git" ? "Git" : "Local";
            console.log(
              `  ${status} ${typeIcon} ${typeLabel} ${dep.package}: ${dep.version} → ${dep.location}`,
            );
          });
        }

        if (result.hasStaleBackup) {
          console.log("\n⚠️  Stale backup detected — run 'packdev restore' to recover.");
        }

        if (!result.isValid) {
          console.log("\n⚠️  Issues found:");
          result.issues.forEach((issue) => console.log(`  - ${issue}`));
        }
      });
    } catch (error) {
      output(
        { command: "status", success: false, error: String(error) },
        () => console.error("❌ Error checking status:", error),
      );
      process.exit(EXIT_CODE.GENERIC_ERROR);
    }
  });

program
  .command("restore")
  .description(
    "Recover package.json from the crash-safety backup left by an interrupted init/finish",
  )
  .action(async () => {
    try {
      log("🩹 Checking for crash-safety backup...");
      const result = await restoreProject();

      output({ command: "restore", ...result }, () => {
        if (result.success && result.restored) {
          console.log("✅ package.json restored from backup!");
        } else if (result.success && !result.restored) {
          console.log(`ℹ️  ${result.error}`);
        } else {
          console.error("❌ Failed to restore:", result.error);
        }
      });

      if (!result.success) process.exit(exitCodeFor(result.error));
    } catch (error) {
      output(
        { command: "restore", success: false, error: String(error) },
        () => console.error("❌ Error during restore:", error),
      );
      process.exit(EXIT_CODE.GENERIC_ERROR);
    }
  });

program
  .command("create-config")
  .description("Create a new .packdev.json configuration file")
  .option(
    "-c, --config <path>",
    "Path to .packdev.json config file",
    ".packdev.json",
  )
  .action(async (options) => {
    try {
      log("📝 Creating new configuration file...");
      const fs = await import("fs/promises");

      const defaultConfig = {
        version: "1.0.0",
        dependencies: [],
        created: new Date().toISOString(),
      };

      await fs.writeFile(
        options.config,
        JSON.stringify(defaultConfig, null, 2),
      );

      output(
        { command: "create-config", success: true, config: options.config },
        () => {
          console.log(`✅ Created ${options.config}`);
          console.log(
            "💡 Use 'packdev add <package> <path|git-url>' to add dependencies",
          );
        },
      );
    } catch (error) {
      output(
        { command: "create-config", success: false, error: String(error) },
        () => console.error("❌ Error creating config:", error),
      );
      process.exit(EXIT_CODE.GENERIC_ERROR);
    }
  });

program
  .command("setup-hooks")
  .description(
    "Setup Git pre-commit hooks to prevent accidental development dependency commits",
  )
  .option("--force", "Overwrite existing hooks", false)
  .option("--disable", "Disable/remove the safety hooks", false)
  .option(
    "--auto-commit",
    "Enable automatic dependency restoration during commits",
    false,
  )
  .action(async (options) => {
    try {
      if (options.disable) {
        log("🗑️  Disabling GitHub safety hooks...");
      } else {
        log("🔧 Setting up GitHub safety hooks...");
      }

      const result = await setupGitHooks(
        options.force,
        options.disable,
        options.autoCommit,
      );

      output({ command: "setup-hooks", ...result }, () => {
        if (result.success) {
          if (options.disable) {
            console.log("✅ Git safety hooks disabled successfully!");
          } else {
            console.log("✅ Git safety hooks setup successfully!");
            console.log(
              "🛡️  The hooks will now prevent commits with development dependencies",
            );
            if (options.autoCommit) {
              console.log(
                "🤖 Auto-commit flow enabled: Dependencies will be automatically restored during commits",
              );
            } else {
              console.log(
                "💡 Use 'WIP' in commit messages to bypass the check",
              );
              console.log(
                "💡 Enable auto-commit flow with: packdev setup-hooks --auto-commit --force",
              );
            }
          }

          if (result.message) {
            console.log(`📝 ${result.message}`);
          }
        } else {
          console.error("❌ Failed to setup hooks:", result.error);
        }
      });

      if (!result.success) process.exit(exitCodeFor(result.error));
    } catch (error) {
      output(
        { command: "setup-hooks", success: false, error: String(error) },
        () => console.error("❌ Error setting up hooks:", error),
      );
      process.exit(EXIT_CODE.GENERIC_ERROR);
    }
  });

// Parse command line arguments
program.parse();

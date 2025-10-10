#!/usr/bin/env node

import { Command } from "commander";
import { version } from "../package.json";
import {
  initializeProject,
  finishProject,
  addLocalDependency,
  removeLocalDependency,
  listLocalDependencies,
  validateProject,
  setupGitHooks,
} from "./packageManager";

const program = new Command();

program
  .name("packdev")
  .description(
    "CLI tool for managing local and git package development dependencies",
  )
  .version(version);

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
    false,
  )
  .action(async (options) => {
    try {
      console.log("🚀 Initializing development mode...");
      const result = await initializeProject(
        options.config,
        !options.noInstall,
      );

      if (result.success) {
        console.log("✅ Development mode initialized successfully!");
        console.log(
          `📝 Replaced ${result.replacedCount} dependencies with local paths or git URLs`,
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
        process.exit(1);
      }
    } catch (error) {
      console.error("❌ Error during initialization:", error);
      process.exit(1);
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
    false,
  )
  .action(async (options) => {
    try {
      console.log("🔄 Finishing development mode...");
      const result = await finishProject(options.config, !options.noInstall);

      if (result.success) {
        console.log("✅ Development mode finished successfully!");
        console.log(
          `📝 Restored ${result.restoredCount} dependencies to original versions`,
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
        process.exit(1);
      }
    } catch (error) {
      console.error("❌ Error during finish:", error);
      process.exit(1);
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
    false,
  )
  .action(async (packageName, location, options) => {
    try {
      console.log(`📦 Adding dependency: ${packageName} → ${location}`);
      const result = await addLocalDependency(
        packageName,
        location,
        options.config,
        options.originalVersion,
        !options.noInstall,
      );

      if (result.success) {
        console.log("✅ Dependency added successfully!");
        console.log(`📝 Added ${packageName}: ${result.version} → ${location}`);
      } else {
        console.error("❌ Failed to add dependency:", result.error);
        process.exit(1);
      }
    } catch (error) {
      console.error("❌ Error adding dependency:", error);
      process.exit(1);
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
      console.log(`📦 Removing dependency: ${packageName}`);
      const result = await removeLocalDependency(packageName, options.config);

      if (result.success) {
        console.log("✅ Dependency removed successfully!");
      } else {
        console.error("❌ Failed to remove dependency:", result.error);
        process.exit(1);
      }
    } catch (error) {
      console.error("❌ Error removing dependency:", error);
      process.exit(1);
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

      if (result.success) {
        if (result.dependencies.length === 0) {
          console.log("📝 No dependencies configured");
        } else {
          console.log("📦 Configured dependencies:");
          result.dependencies.forEach((dep) => {
            console.log(`  - ${dep.package}: ${dep.version} → ${dep.location}`);
          });
        }
      } else {
        console.error("❌ Failed to list dependencies:", result.error);
        process.exit(1);
      }
    } catch (error) {
      console.error("❌ Error listing dependencies:", error);
      process.exit(1);
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

      if (!result.isValid) {
        console.log("\n⚠️  Issues found:");
        result.issues.forEach((issue) => console.log(`  - ${issue}`));
      }
    } catch (error) {
      console.error("❌ Error checking status:", error);
      process.exit(1);
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
      console.log("📝 Creating new configuration file...");
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
      console.log(`✅ Created ${options.config}`);
      console.log(
        "💡 Use 'packdev add <package> <path|git-url>' to add dependencies",
      );
    } catch (error) {
      console.error("❌ Error creating config:", error);
      process.exit(1);
    }
  });

program
  .command("setup-hooks")
  .description(
    "Setup Git pre-commit hooks to prevent accidental development dependency commits",
  )
  .option("--force", "Overwrite existing hooks", false)
  .option("--disable", "Disable/remove the safety hooks", false)
  .action(async (options) => {
    try {
      if (options.disable) {
        console.log("🗑️  Disabling GitHub safety hooks...");
      } else {
        console.log("🔧 Setting up GitHub safety hooks...");
      }

      const result = await setupGitHooks(options.force, options.disable);

      if (result.success) {
        if (options.disable) {
          console.log("✅ Git safety hooks disabled successfully!");
        } else {
          console.log("✅ Git safety hooks setup successfully!");
          console.log(
            "🛡️  The hooks will now prevent commits with development dependencies",
          );
          console.log("💡 Use 'WIP' in commit messages to bypass the check");
        }

        if (result.message) {
          console.log(`📝 ${result.message}`);
        }
      } else {
        console.error("❌ Failed to setup hooks:", result.error);
        process.exit(1);
      }
    } catch (error) {
      console.error("❌ Error setting up hooks:", error);
      process.exit(1);
    }
  });

// Parse command line arguments
program.parse();

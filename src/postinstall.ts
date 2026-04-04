#!/usr/bin/env node
/**
 * Postinstall hook — detects fresh install vs upgrade and tells the user
 * exactly what to do next. Runs `gnosys upgrade` automatically on upgrades.
 * Only runs in interactive terminals (TTY). Silently exits in CI/Docker/scripts.
 */

import { existsSync } from "fs";
import { join } from "path";
import { createInterface } from "readline/promises";
import { stdin, stdout } from "process";
import { execSync } from "child_process";

async function main() {
  // Skip in non-interactive environments (CI, Docker, piped installs)
  if (!stdout.isTTY || !stdin.isTTY) {
    process.exit(0);
  }

  // Skip if GNOSYS_SKIP_POSTINSTALL is set (for testing or automation)
  if (process.env.GNOSYS_SKIP_POSTINSTALL) {
    process.exit(0);
  }

  // Detect if this is an upgrade (central DB exists) or fresh install
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  const centralDbPath = join(home, ".gnosys", "gnosys.db");
  const isUpgrade = existsSync(centralDbPath);

  // Read package version
  let version = "unknown";
  try {
    const pkgPath = join(__dirname, "..", "package.json");
    const pkg = JSON.parse(require("fs").readFileSync(pkgPath, "utf-8"));
    version = pkg.version;
  } catch {
    // non-critical
  }

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    if (isUpgrade) {
      // ── Upgrade flow ──
      console.log(`\n  Gnosys v${version} installed (upgrade detected)`);
      console.log("");

      const answer = await rl.question(
        "  Run gnosys upgrade now? This syncs all projects and regenerates the dashboard. [Y/n] "
      );
      rl.close();

      const shouldUpgrade = !answer || answer.trim().toLowerCase() !== "n";

      if (shouldUpgrade) {
        console.log("");
        execSync("gnosys upgrade", { stdio: "inherit" });
        console.log(`\n  Next steps:`);
        console.log(`    1. Restart your IDE's MCP server (Cursor: Cmd+Shift+P > MCP: Restart All Servers)`);
        console.log(`    2. Run 'gnosys status --web' to open the portfolio dashboard`);
        console.log(`    3. In any project, tell your AI agent 'update status' to refresh its status\n`);
      } else {
        console.log(`\n  Run these when you're ready:`);
        console.log(`    1. gnosys upgrade              — sync all projects + regenerate dashboard`);
        console.log(`    2. Restart IDE MCP server       — so agents see the new tools`);
        console.log(`    3. gnosys status --web          — open the portfolio dashboard\n`);
      }
    } else {
      // ── Fresh install flow ──
      console.log(`\n  Gnosys v${version} installed (fresh install)`);
      console.log("");

      const answer = await rl.question(
        "  Run setup wizard? [Y/n] "
      );
      rl.close();

      const shouldSetup = !answer || answer.trim().toLowerCase() !== "n";

      if (shouldSetup) {
        console.log("");
        execSync("gnosys setup", { stdio: "inherit" });
      } else {
        console.log(`\n  Run these when you're ready:`);
        console.log(`    1. gnosys setup                 — configure LLM providers and preferences`);
        console.log(`    2. gnosys init                  — initialize gnosys in a project directory`);
        console.log(`    3. gnosys status                — check project status\n`);
      }
    }
  } catch {
    // Ctrl+C or readline error — still print the manual steps
    rl.close();
    console.log("");
    if (isUpgrade) {
      console.log(`  Run 'gnosys upgrade' to complete the update.\n`);
    } else {
      console.log(`  Run 'gnosys setup' to get started.\n`);
    }
    process.exit(0);
  }
}

main();

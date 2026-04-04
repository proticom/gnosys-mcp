#!/usr/bin/env node
/**
 * Postinstall hook — detects fresh install vs upgrade and always prints
 * the next steps. If the terminal is interactive, offers to run
 * gnosys upgrade (or setup) automatically.
 */

import { existsSync } from "fs";
import { join } from "path";
import { createInterface } from "readline/promises";
import { stdin, stdout } from "process";
import { execSync } from "child_process";

async function main() {
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

  const isInteractive = stdout.isTTY && stdin.isTTY;

  if (isUpgrade) {
    // ── Upgrade flow ──
    console.log("");
    const title = `Gnosys v${version} installed`;
    console.log(`\n  ${title}\n`);
    console.log("  Next steps:");
    console.log("    1. gnosys upgrade              sync all projects + regenerate dashboard");
    console.log("    2. Restart MCP servers:");
    console.log("         Cursor:      Cmd+Shift+P > MCP: Restart All Servers");
    console.log("         Claude Code:  /mcp > restart gnosys (or start new session)");
    console.log("         Codex:       start new session");
    console.log("    3. gnosys status --web          open the portfolio dashboard");
    console.log("");

    // If interactive, offer to run upgrade automatically
    if (isInteractive) {
      const rl = createInterface({ input: stdin, output: stdout });
      try {
        const answer = await rl.question("  Run gnosys upgrade now? [Y/n] ");
        rl.close();

        if (!answer || answer.trim().toLowerCase() !== "n") {
          console.log("");
          execSync("gnosys upgrade", { stdio: "inherit" });
        }
      } catch {
        rl.close();
      }
    }
  } else {
    // ── Fresh install flow ──
    console.log("");
    const title = `Gnosys v${version} installed`;
    console.log(`\n  ${title}\n`);
    console.log("  Get started:");
    console.log("    1. gnosys setup                 configure LLM providers and preferences");
    console.log("    2. gnosys init                  initialize gnosys in a project directory");
    console.log("    3. gnosys status                check project status");
    console.log("");

    // If interactive, offer to run setup automatically
    if (isInteractive) {
      const rl = createInterface({ input: stdin, output: stdout });
      try {
        const answer = await rl.question("  Run setup wizard? [Y/n] ");
        rl.close();

        if (!answer || answer.trim().toLowerCase() !== "n") {
          console.log("");
          execSync("gnosys setup", { stdio: "inherit" });
        }
      } catch {
        rl.close();
      }
    }
  }
}

main();

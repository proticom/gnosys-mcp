#!/usr/bin/env node
/**
 * Postinstall hook — detects fresh install vs upgrade and always prints
 * the next steps. If the terminal is interactive, offers to run
 * gnosys upgrade (or setup) automatically.
 *
 * v5.4.3: All output goes to stderr (not stdout). npm hides postinstall
 * stdout for global installs but shows stderr — so writing to stderr is
 * the only way users actually see the message during `npm install -g`.
 */

import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createInterface } from "readline/promises";
import { stdin, stdout } from "process";
import { execSync } from "child_process";
import { GnosysDB } from "./lib/db.js";

/** Write a line to stderr — npm shows this even when stdout is suppressed. */
function out(line: string = ""): void {
  process.stderr.write(`${line}\n`);
}

async function main() {
  // Skip if GNOSYS_SKIP_POSTINSTALL is set (for testing or automation)
  if (process.env.GNOSYS_SKIP_POSTINSTALL) {
    process.exit(0);
  }

  // Detect if this is an upgrade (central DB exists) or fresh install
  const centralDbPath = GnosysDB.getCentralDbPath();
  const isUpgrade = existsSync(centralDbPath);

  // Read package version. v5.4.3: use proper ESM path resolution and
  // a top-level `readFileSync` import — the previous `require("fs")`
  // call doesn't work in ESM and silently caused "vunknown" output.
  let version = "unknown";
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkgPath = join(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    version = pkg.version;
  } catch {
    // non-critical
  }

  const isInteractive = stdout.isTTY && stdin.isTTY;

  if (isUpgrade) {
    // ── Upgrade flow ──
    out();
    out(`  Gnosys v${version} installed`);
    out();
    out("  Next steps:");
    out("    1. gnosys upgrade              sync all projects + regenerate dashboard");
    out("    2. Restart MCP servers:");
    out("         Cursor:      Cmd+Shift+P > MCP: Restart All Servers");
    out("         Claude Code: /mcp > restart gnosys (or start new session)");
    out("         Codex:       start new session");
    out("    3. gnosys status --web         open the portfolio dashboard");
    out();

    // If interactive, offer to run upgrade automatically
    if (isInteractive) {
      const rl = createInterface({ input: stdin, output: stdout });
      try {
        const answer = await rl.question("  Run gnosys upgrade now? [Y/n] ");
        rl.close();

        if (!answer || answer.trim().toLowerCase() !== "n") {
          out();
          execSync("gnosys upgrade", { stdio: "inherit" });
        }
      } catch {
        rl.close();
      }
    }
  } else {
    // ── Fresh install flow ──
    out();
    out(`  Gnosys v${version} installed`);
    out();
    out("  Get started:");
    out("    1. gnosys setup                configure LLM providers and preferences");
    out("    2. gnosys init                 initialize gnosys in a project directory");
    out("    3. gnosys status               check project status");
    out();

    // If interactive, offer to run setup automatically
    if (isInteractive) {
      const rl = createInterface({ input: stdin, output: stdout });
      try {
        const answer = await rl.question("  Run setup wizard? [Y/n] ");
        rl.close();

        if (!answer || answer.trim().toLowerCase() !== "n") {
          out();
          execSync("gnosys setup", { stdio: "inherit" });
        }
      } catch {
        rl.close();
      }
    }
  }
}

main();

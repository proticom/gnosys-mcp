#!/usr/bin/env node
/**
 * Postinstall hook — prompts the user to run `gnosys setup` after installation.
 * Only runs in interactive terminals (TTY). Silently exits in CI/Docker/scripts.
 */

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

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    const answer = await rl.question(
      "\n  Gnosys installed. Run setup wizard? [Y/n] "
    );

    rl.close();

    const shouldSetup = !answer || answer.trim().toLowerCase() !== "n";

    if (shouldSetup) {
      console.log("");
      // Spawn gnosys setup with inherited stdio so the wizard is fully interactive
      execSync("gnosys setup", { stdio: "inherit" });
    } else {
      console.log("  Run 'gnosys setup' anytime to configure.\n");
    }
  } catch {
    // Ctrl+C or readline error — exit silently
    rl.close();
    console.log("");
    process.exit(0);
  }
}

main();

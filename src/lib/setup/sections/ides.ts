/**
 * Setup: IDE integration.
 *
 * Standalone wizard for configuring MCP integration with the supported IDEs
 * (Claude Code, Claude Desktop, Cursor, Codex, Gemini CLI, Antigravity).
 * Extracted from the linear `runSetup` so it can be invoked directly via
 * `gnosys setup ides` or from the summary-first menu.
 */

import { Interface as ReadlineInterface } from "readline/promises";
import fs from "fs/promises";
import path from "path";
import { detectIDEs, setupIDE } from "../../setup.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const CHECK = `${GREEN}✓${RESET}`;
const CROSS = `${RED}✗${RESET}`;

const IDE_LABELS: Record<string, string> = {
  claude: "Claude Code",
  "claude-desktop": "Claude Desktop",
  cursor: "Cursor",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
  antigravity: "Antigravity",
};

const ALL_IDE_KEYS = ["claude", "claude-desktop", "cursor", "codex", "gemini-cli", "antigravity"];

// IDEs whose MCP config lives at the user level (~/...) rather than per-project.
const USER_LEVEL_IDES = new Set(["claude", "claude-desktop", "gemini-cli", "antigravity"]);

export interface IdesSetupOptions {
  rl: ReadlineInterface;
  directory: string;
}

async function ask(rl: ReadlineInterface, prompt: string): Promise<string> {
  return (await rl.question(prompt)).trim();
}

async function askChoice(
  rl: ReadlineInterface,
  prompt: string,
  choices: string[],
  defaultIdx = 0,
): Promise<number> {
  if (prompt) console.log(prompt);
  choices.forEach((c, i) => {
    const marker = i === defaultIdx ? `  ${DIM}(default)${RESET}` : "";
    console.log(`  ${i + 1}. ${c}${marker}`);
  });
  for (let attempts = 0; attempts < 5; attempts++) {
    const answer = await ask(rl, "> ");
    if (!answer) return defaultIdx;
    const n = parseInt(answer, 10);
    if (!Number.isNaN(n) && n >= 1 && n <= choices.length) return n - 1;
    console.log(`${DIM}Pick a number 1-${choices.length}${RESET}`);
  }
  return defaultIdx;
}

/**
 * Run the IDE-integration wizard. Detects which IDEs are present in the
 * project directory and lets the user pick which to wire up.
 * Returns true if at least one IDE config was written.
 */
export async function runIdesSetup(opts: IdesSetupOptions): Promise<boolean> {
  console.log("");
  console.log(`${BOLD}IDE Integration${RESET}`);
  console.log("");

  const detected = await detectIDEs(opts.directory);

  if (detected.length > 0) {
    const names = detected.map((id) => IDE_LABELS[id] ?? id).join(", ");
    console.log(`Detected: ${GREEN}${names}${RESET}`);
  } else {
    console.log(`${DIM}No IDE integrations detected in this directory.${RESET}`);
  }
  console.log("");

  const ideOptions: string[] = [];
  const ideKeyForOption: string[] = [];

  for (const ide of ALL_IDE_KEYS) {
    const isDetected = detected.includes(ide);
    const label = IDE_LABELS[ide] ?? ide;
    if (isDetected) {
      ideOptions.push(`${label} ${DIM}(detected)${RESET}`);
    } else if (USER_LEVEL_IDES.has(ide)) {
      ideOptions.push(`${label} ${DIM}(not detected — will configure user-level)${RESET}`);
    } else {
      ideOptions.push(`${label} ${DIM}(create .${ide}/)${RESET}`);
    }
    ideKeyForOption.push(ide);
  }
  ideOptions.push("All");
  ideOptions.push("Skip");

  const idx = await askChoice(opts.rl, "Pick an IDE to configure:", ideOptions);

  let idesToSetup: string[] = [];
  if (idx < ALL_IDE_KEYS.length) {
    idesToSetup = [ideKeyForOption[idx]];
  } else if (idx === ALL_IDE_KEYS.length) {
    idesToSetup = [...ALL_IDE_KEYS];
  }
  // Last option is Skip

  if (idesToSetup.length === 0) {
    console.log(`${DIM}Skipped.${RESET}`);
    return false;
  }

  let configured = 0;
  for (const ide of idesToSetup) {
    if (!detected.includes(ide) && !USER_LEVEL_IDES.has(ide)) {
      const dirPath = path.join(opts.directory, `.${ide}`);
      try {
        await fs.mkdir(dirPath, { recursive: true });
        console.log(`  ${CHECK} Created .${ide}/ directory`);
      } catch (err) {
        console.log(`  ${CROSS} Could not create .${ide}/: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
    }

    const result = await setupIDE(ide, opts.directory);
    if (result.success) {
      console.log(`  ${CHECK} ${result.message}`);
      configured++;
    } else {
      console.log(`  ${CROSS} ${IDE_LABELS[ide] ?? ide}: ${result.message}`);
    }
  }

  return configured > 0;
}

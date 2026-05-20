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
import { safeQuestion } from "../ui/safePrompt.js";

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
  return (await safeQuestion(rl, prompt)).trim();
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
 *
 * v5.9.3 redesign:
 *   - Uses Header() + Title() + footer hint for "all / skip" instead of
 *     burying those as menu items.
 *   - Status column with ● (filled, accent) for "detected" and ○ (hollow,
 *     text-dim) for "will create" or "will use user-level".
 *   - Final line: `2 ides configured · 0 errors`.
 *
 * Returns true if at least one IDE config was written.
 */
export async function runIdesSetup(opts: IdesSetupOptions): Promise<boolean> {
  const { Header } = await import("../ui/header.js");
  const { Title } = await import("../ui/title.js");
  const { Footer } = await import("../ui/footer.js");
  const { c, color, glyph } = await import("../ui/tokens.js");

  console.log("");
  console.log(Header(["gnosys", "setup", "ides"]));
  console.log("");
  console.log(Title("IDE integrations", "we'll write the MCP server config so gnosys is available from each"));
  console.log("");

  const detected = await detectIDEs(opts.directory);

  // Header row for the columns.
  console.log(`   ${color(c.textDim, "ide".padEnd(18))}${color(c.textDim, "status".padEnd(22))}${color(c.textDim, "target")}`);
  console.log(`   ${color(c.textGhost, "─".repeat(60))}`);

  const ideOptions: string[] = [];
  const ideKeyForOption: string[] = [];

  ALL_IDE_KEYS.forEach((ide, idx) => {
    const isDetected = detected.includes(ide);
    const label = IDE_LABELS[ide] ?? ide;
    const dot = isDetected ? color(c.accent, glyph.dotFilled) : color(c.textDim, glyph.dotHollow);
    const status = isDetected
      ? color(c.text, "detected")
      : USER_LEVEL_IDES.has(ide)
        ? color(c.textDim, "user-level")
        : color(c.textDim, "will create");
    const target = USER_LEVEL_IDES.has(ide)
      ? color(c.textDim, `~/${ide}-mcp config`)
      : color(c.textDim, `.${ide}/mcp.json`);
    const num = color(c.textDim, String(idx + 1).padStart(2, " "));
    console.log(`   ${num}  ${color(c.text, label.padEnd(16))} ${dot} ${status.padEnd(20)}   ${target}`);
    ideOptions.push(label);
    ideKeyForOption.push(ide);
  });

  console.log("");
  console.log(Footer(`1–${ALL_IDE_KEYS.length} · pick    a · all detected    enter · skip`));

  const idx = await askChoice(opts.rl, "", [...ideOptions, "All detected", "Skip"]);

  let idesToSetup: string[] = [];
  if (idx < ALL_IDE_KEYS.length) {
    idesToSetup = [ideKeyForOption[idx]];
  } else if (idx === ALL_IDE_KEYS.length) {
    // v5.9.3: "all detected" only configures IDEs that are actually
    // detected — was "all IDEs" which created stub dirs for unused
    // editors. User-level IDEs (Claude Code, Gemini CLI, etc.) are
    // always included since they don't need a project marker.
    idesToSetup = ALL_IDE_KEYS.filter((k) => detected.includes(k) || USER_LEVEL_IDES.has(k));
  }
  // Last option is Skip — leaves idesToSetup empty

  if (idesToSetup.length === 0) {
    console.log(`${DIM}Skipped.${RESET}`);
    return false;
  }

  let configured = 0;
  let errors = 0;
  for (const ide of idesToSetup) {
    if (!detected.includes(ide) && !USER_LEVEL_IDES.has(ide)) {
      const dirPath = path.join(opts.directory, `.${ide}`);
      try {
        await fs.mkdir(dirPath, { recursive: true });
        console.log(`  ${CHECK} Created .${ide}/ directory`);
      } catch (err) {
        console.log(`  ${CROSS} Could not create .${ide}/: ${err instanceof Error ? err.message : String(err)}`);
        errors++;
        continue;
      }
    }

    const result = await setupIDE(ide, opts.directory);
    if (result.success) {
      console.log(`  ${CHECK} ${result.message}`);
      configured++;
    } else {
      console.log(`  ${CROSS} ${IDE_LABELS[ide] ?? ide}: ${result.message}`);
      errors++;
    }
  }

  // v5.9.3 — summary line per design §5.
  const { c: cTok, color: colorize } = await import("../ui/tokens.js");
  console.log("");
  console.log(`   ${colorize(cTok.textDim, `${configured} ides configured · ${errors} errors`)}`);

  return configured > 0;
}

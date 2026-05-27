/**
 * Setup: IDE integration.
 *
 * Standalone wizard for configuring MCP integration with the supported IDEs
 * (Claude Code, Claude Desktop, Cursor, Codex, Gemini CLI, Antigravity).
 * Extracted from the linear `runSetup` so it can be invoked directly via
 * `gnosys setup ides` or from the summary-first menu.
 */

import type { Interface as ReadlineInterface } from "readline/promises";
import fs from "fs/promises";
import path from "path";
import { detectIDEs, setupIDE } from "../../setup.js";
import { safeQuestion } from "../ui/safePrompt.js";
import { renderTable } from "../ui/table.js";

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
  // v5.9.4 Bug 12 — Grok Build is xAI's coding agent.
  "grok-build": "Grok Build",
};

const ALL_IDE_KEYS = ["claude", "claude-desktop", "cursor", "codex", "gemini-cli", "antigravity", "grok-build"];

// IDEs whose MCP config lives at the user level (~/...) rather than per-project.
const USER_LEVEL_IDES = new Set(["claude", "claude-desktop", "gemini-cli", "antigravity", "grok-build"]);

/** Per-IDE display target for the v5.9.3+ IDE table. */
const IDE_TARGET_DISPLAY: Record<string, string> = {
  claude: "claude mcp add (CLI)",
  "claude-desktop": "~/Library/.../claude_desktop_config.json",
  cursor: ".cursor/mcp.json",
  codex: ".codex/mcp.json",
  "gemini-cli": "~/.gemini/settings.json",
  antigravity: "~/.gemini/antigravity/mcp_config.json",
  "grok-build": "~/.grok/config.toml ([mcp_servers.gnosys])",
};

function ideTarget(ide: string): string {
  return IDE_TARGET_DISPLAY[ide] ?? `.${ide}/mcp.json`;
}

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

  // v5.9.4 — laid out via the `Table` atom. Each row prefixed with a
  // numbered selection digit (the `rowFormatter` injects that).
  type IdeRow = { ide: string; idx: number; isDetected: boolean };
  const tableRows: IdeRow[] = ALL_IDE_KEYS.map((ide, idx) => ({
    ide,
    idx,
    isDetected: detected.includes(ide),
  }));
  const tableLines = renderTable<IdeRow>(tableRows, [
    {
      header: "ide",
      render: (r) => IDE_LABELS[r.ide] ?? r.ide,
      color: c.text,
    },
    {
      header: "status",
      render: (r) => {
        if (r.isDetected) return "detected";
        return USER_LEVEL_IDES.has(r.ide) ? "user-level" : "will create";
      },
      color: c.textDim,
    },
    {
      header: "target",
      render: (r) => ideTarget(r.ide),
      color: c.textDim,
    },
  ], {
    indent: 3,
    gap: 2,
    rowFormatter: (r, line) => {
      const num = color(c.textDim, String(r.idx + 1).padStart(2, " "));
      const dot = r.isDetected ? color(c.accent, glyph.dotFilled) : color(c.textDim, glyph.dotHollow);
      // The Table indent is 3 chars; we replace it with `   <n>  <dot> ` so
      // the existing visual rhythm (number + status-dot) is preserved.
      return `   ${num}  ${dot} ${line.slice(3)}`;
    },
  });
  tableLines.forEach((line) => {
    console.log(line);
  });

  const ideOptions: string[] = ALL_IDE_KEYS.map((ide) => IDE_LABELS[ide] ?? ide);
  const ideKeyForOption: string[] = [...ALL_IDE_KEYS];

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
  console.log("");
  console.log(`   ${color(c.textDim, `${configured} ides configured · ${errors} errors`)}`);

  return configured > 0;
}

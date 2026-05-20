/**
 * Setup summary-first wizard (v5.9.3 redesign).
 *
 * When the user runs `gnosys setup` and a config already exists, the
 * first screen is the current settings summary. The user picks a
 * numbered option to edit just that piece, returns to the panel with
 * `✓` next to the changed line for the rest of this sitting, and exits
 * with `done` (Enter or `done`).
 *
 * v5.9.3 changes:
 *   - Uses Phase A atoms: Header, Panel, Status, Footer, Prompt
 *   - Re-reads config from the ACTIVE store path (.gnosys/ if project
 *     scope, else ~/.gnosys/) before re-render — fixes the stale-display
 *     bug where switching provider via section 3 left the panel showing
 *     the old value because loadConfig was reading from project root
 *     rather than .gnosys/.
 *   - `[D]one` / `[E]xit` collapsed to single "done" action.
 *   - `maybeOfferProviderRepair` reworked to column-aligned detection
 *     block with no "pre-v5.8.4" history leak.
 */

import { createInterface, Interface as ReadlineInterface } from "readline/promises";
import { stdin, stdout } from "process";
import fsSync from "fs";
import path from "path";
import {
  loadConfig,
  resolveTaskModel,
  updateConfig,
  type GnosysConfig,
  type LLMProviderName,
} from "../config.js";
import { GnosysDB } from "../db.js";
import { getGnosysHome } from "../paths.js";
import { safeQuestion } from "./ui/safePrompt.js";
import { Header } from "./ui/header.js";
import { Panel } from "./ui/panel.js";
import { Status } from "./ui/status.js";
import { Footer } from "./ui/footer.js";
import { c, color, glyph } from "./ui/tokens.js";

// Read once at module init — used by Header().
const PKG_VERSION = (() => {
  try {
    const url = new URL("../../../package.json", import.meta.url);
    const raw = fsSync.readFileSync(url, "utf-8");
    return `v${(JSON.parse(raw) as { version?: string }).version ?? "0.0.0"}`;
  } catch {
    return undefined;
  }
})();

// ─── Active store path ─────────────────────────────────────────────────────
//
// loadConfig() reads `<storePath>/gnosys.json`. The active store is either
// `<projectDir>/.gnosys/` (if that gnosys.json exists) or `~/.gnosys/`
// (global). Always prefer the project-level one when present so writes by
// the section editors are visible to the summary re-render.

function resolveActiveStorePath(projectDir: string): string {
  const projectStore = path.join(projectDir, ".gnosys");
  if (fsSync.existsSync(path.join(projectStore, "gnosys.json"))) return projectStore;
  return getGnosysHome();
}

// ─── Provider-revert repair ────────────────────────────────────────────────
//
// Detect the "gnosys.json says anthropic but no Anthropic key exists AND
// another provider has a key" pattern. Offer one-keystroke repair.

const PROVIDERS_WITH_KEYS: LLMProviderName[] = ["anthropic", "openai", "xai", "groq", "mistral"];

async function maybeOfferProviderRepair(
  cfg: GnosysConfig,
  projectDir: string,
  rl: ReadlineInterface,
): Promise<void> {
  if (cfg.llm.defaultProvider !== "anthropic") return;
  const { getApiKeyForProvider } = await import("../setup.js");
  const anthropicKey = await getApiKeyForProvider("anthropic");
  if (anthropicKey) return;

  const candidates: LLMProviderName[] = [];
  for (const p of PROVIDERS_WITH_KEYS) {
    if (p === "anthropic") continue;
    const key = await getApiKeyForProvider(p);
    if (key) candidates.push(p);
  }
  if (candidates.length === 0) return;

  const suggestion = candidates[0];
  const others = candidates.slice(1);

  // Header for the provider-check sub-screen.
  process.stdout.write(`${Header(["gnosys", "setup", "provider-check"], { version: PKG_VERSION })}\n\n`);
  process.stdout.write(`${Status("warn", "default provider mismatch")}\n\n`);

  // Column-aligned detection block.
  const indent = "   ";
  const label = (s: string) => color(c.textDim, s.padEnd(20));
  process.stdout.write(`${indent}${label("gnosys.json says")}${color(c.text, "anthropic")}\n`);
  process.stdout.write(`${indent}${label("anthropic key")}${color(c.textMid, "not found in env or keychain")}\n`);
  process.stdout.write(`${indent}${label("key found for")}${color(c.accentHi, suggestion)}\n`);
  if (others.length > 0) {
    process.stdout.write(`${indent}${label("")}${color(c.textDim, `(also available: ${others.join(", ")})`)}\n`);
  }
  process.stdout.write("\n");

  const answer = (await safeQuestion(rl, ` ${color(c.accent, glyph.prompt)} switch the default to ${color(c.accentHi, suggestion)}? [Y/n] `))
    .trim()
    .toLowerCase();
  if (answer === "n" || answer === "no") {
    process.stdout.write(`${Status("warn", "keeping anthropic as the default", "edit via section 1 to change")}\n`);
    return;
  }

  try {
    const storePath = resolveActiveStorePath(projectDir);
    await updateConfig(storePath, { llm: { defaultProvider: suggestion } });
    process.stdout.write(`${Status("ok", `default switched · ${suggestion} is now the active provider`)}\n`);
  } catch (err) {
    process.stdout.write(`${Status("warn", `failed to repair: ${err instanceof Error ? err.message : String(err)}`)}\n`);
    process.stdout.write(`${Status("warn", "run 'gnosys setup models' to change manually", "fallback")}\n`);
  }
}

// ─── Section handlers ──────────────────────────────────────────────────────

/** Each summary line is a section the user can navigate into. */
export interface SummarySection {
  key: string;
  label: string;
  describe: (cfg: GnosysConfig) => string | Promise<string>;
  edit: (rl: ReadlineInterface, cfg: GnosysConfig, projectDir: string) => Promise<boolean>;
}

export function buildSections(): SummarySection[] {
  return [
    {
      key: "1",
      label: "provider",
      describe: (cfg) => cfg.llm.defaultProvider,
      edit: async (rl, _cfg, projectDir) => {
        const { runModelsSetup } = await import("../setup.js");
        await runModelsSetup({ directory: projectDir, rl });
        return true;
      },
    },
    {
      key: "2",
      label: "models",
      describe: async (cfg) => {
        const synth = resolveTaskModel(cfg, "synthesis");
        return `${synth.provider} / ${synth.model}`;
      },
      edit: async (rl, _cfg, projectDir) => {
        const { runModelsSetup } = await import("../setup.js");
        await runModelsSetup({ directory: projectDir, rl });
        return true;
      },
    },
    {
      key: "3",
      label: "task routing",
      describe: async (cfg) => {
        const provs = new Set([
          resolveTaskModel(cfg, "structuring").provider,
          resolveTaskModel(cfg, "synthesis").provider,
        ]);
        return provs.size === 1 ? `all ${[...provs][0]}` : `mixed (${[...provs].join(", ")})`;
      },
      edit: async (rl, _cfg, projectDir) => editRouting(rl, projectDir),
    },
    {
      key: "4",
      label: "ide integrations",
      describe: async () => {
        const { detectIDEs } = await import("../setup.js");
        const ides = await detectIDEs(process.cwd());
        return ides.length === 0 ? "none" : `${ides.length} configured`;
      },
      edit: async (rl, _cfg, projectDir) => editIDEs(rl, projectDir),
    },
    {
      key: "5",
      label: "multi-machine sync",
      describe: () => {
        try {
          const db = GnosysDB.openLocal();
          const remotePath = db.getMeta("remote_path");
          db.close();
          return remotePath ?? "not configured";
        } catch {
          return "not configured";
        }
      },
      edit: async (rl) => {
        const { runConfigureWizard } = await import("../remoteWizard.js");
        const centralDb = GnosysDB.openLocal();
        try {
          return await runConfigureWizard(centralDb, rl);
        } finally {
          centralDb.close();
        }
      },
    },
    {
      key: "6",
      label: "dream mode",
      describe: (cfg) => {
        if (!cfg.dream?.enabled) return "disabled";
        const provider = cfg.dream.provider ?? "ollama";
        const model = cfg.dream.model ?? "default";
        return `${provider} / ${model}`;
      },
      edit: async (rl, _cfg, projectDir) => {
        const { runDreamSetup } = await import("../setup.js");
        await runDreamSetup({ directory: projectDir, rl });
        return true;
      },
    },
    {
      key: "7",
      label: "user preferences",
      describe: async () => {
        const { listUserPreferences } = await import("./sections/preferences.js");
        const prefs = await listUserPreferences();
        return `${prefs.length} stored`;
      },
      edit: async (rl) => {
        const { runPreferencesReview } = await import("./sections/preferences.js");
        return runPreferencesReview(rl);
      },
    },
  ];
}

async function editRouting(rl: ReadlineInterface, projectDir: string): Promise<boolean> {
  const { runRoutingSetup } = await import("./sections/routing.js");
  return runRoutingSetup({ rl, directory: projectDir });
}

async function editIDEs(rl: ReadlineInterface, projectDir: string): Promise<boolean> {
  const { runIdesSetup } = await import("./sections/ides.js");
  return runIdesSetup({ rl, directory: projectDir });
}

// ─── Rendering ─────────────────────────────────────────────────────────────

/**
 * Render the panel body — one menu-shaped row per section. Returns the
 * row strings (already colored) ready to hand to Panel().
 */
async function renderPanelRows(cfg: GnosysConfig, sections: SummarySection[]): Promise<string[]> {
  const labelW = Math.max(...sections.map((s) => s.label.length));
  const rows: string[] = [];
  for (const s of sections) {
    const value = await s.describe(cfg);
    const numTxt = color(c.textDim, s.key);
    const labelTxt = color(c.text, s.label.padEnd(labelW));
    const valueTxt = color(c.textMid, value);
    rows.push(` ${numTxt}   ${labelTxt}   ${valueTxt}`);
  }
  return rows;
}

/**
 * Build the `trailing` map of `✓` marks for sections edited this sitting.
 */
function buildTrailingMap(updated: Set<string>, sections: SummarySection[]): Record<number, string> {
  const trailing: Record<number, string> = {};
  sections.forEach((s, idx) => {
    if (updated.has(s.key)) {
      trailing[idx] = color(c.ok, glyph.ok);
    }
  });
  return trailing;
}

// ─── Main loop ─────────────────────────────────────────────────────────────

export interface SummaryOptions {
  directory?: string;
  rl?: ReadlineInterface;
}

/**
 * Run the summary-first wizard. Loops until the user picks "done"
 * (Enter or `done`). Returns true if any section was edited.
 */
export async function runSummaryWizard(opts: SummaryOptions = {}): Promise<boolean> {
  const projectDir = opts.directory ?? process.cwd();
  const ownsRl = !opts.rl;
  const rl = opts.rl ?? createInterface({ input: stdin, output: stdout });

  const sections = buildSections();
  const updated = new Set<string>();
  let anyChange = false;
  let revertCheckDone = false;

  try {
    while (true) {
      // Always re-read from the ACTIVE store path so any section edit is
      // reflected immediately. The previous bug used the projectDir root,
      // which didn't contain gnosys.json — only the .gnosys/ subdir did.
      const storePath = resolveActiveStorePath(projectDir);
      const cfg = await loadConfig(storePath);

      if (!revertCheckDone) {
        revertCheckDone = true;
        await maybeOfferProviderRepair(cfg, projectDir, rl);
      }

      // Render header + panel.
      process.stdout.write("\n");
      process.stdout.write(`${Header(["gnosys", "setup"], { version: PKG_VERSION })}\n\n`);
      const rows = await renderPanelRows(cfg, sections);
      const trailing = buildTrailingMap(updated, sections);
      process.stdout.write(`${Panel("gnosys settings", rows, { trailing })}\n\n`);
      process.stdout.write(`${Footer(`1–${sections.length} · edit    enter · done`)}\n`);

      const answer = (await safeQuestion(rl, ` ${color(c.accent, glyph.prompt)} `))
        .trim()
        .toLowerCase();
      if (!answer || answer === "done") {
        return anyChange;
      }

      const section = sections.find((s) => s.key === answer);
      if (!section) {
        process.stdout.write(`${Status("warn", `unknown choice: ${answer}`)}\n`);
        continue;
      }

      // Pass a fresh config snapshot to the editor.
      const cfgForEdit = await loadConfig(storePath);
      try {
        const changed = await section.edit(rl, cfgForEdit, projectDir);
        if (changed) {
          updated.add(section.key);
          anyChange = true;
        }
      } catch (err) {
        process.stdout.write(`${Status("fail", `section editor failed: ${err instanceof Error ? err.message : String(err)}`)}\n`);
      }
    }
  } finally {
    if (ownsRl) rl.close();
  }
}

// Internal helpers exported for tests.
export const __test = { resolveActiveStorePath, renderPanelRows, buildTrailingMap };

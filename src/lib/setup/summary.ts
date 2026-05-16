/**
 * Setup summary-first wizard (v5.7.0).
 *
 * When the user runs `gnosys setup` and a config already exists, the first
 * screen is the current settings summary. The user picks a numbered option
 * to edit just that piece, returns to the summary with `✓ updated` next to
 * the changed line, and exits with `[D]one` (apply) or `[E]xit` (revert).
 *
 * Each section is a thin wrapper around the existing per-section function
 * in `setup.ts` (or a new section module). This file is the orchestrator
 * + summary screen — it does not duplicate section logic.
 */

import { createInterface, Interface as ReadlineInterface } from "readline/promises";
import { stdin, stdout } from "process";
import {
  loadConfig,
  resolveTaskModel,
  updateConfig,
  type GnosysConfig,
  type LLMProviderName,
} from "../config.js";
import { GnosysDB } from "../db.js";

// ─── ANSI ───────────────────────────────────────────────────────────────────
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const CHECK = `${GREEN}✓${RESET}`;

// ─── Provider-revert repair (v5.8.5) ────────────────────────────────────────
//
// Detect the "gnosys.json says anthropic but no Anthropic key exists AND
// another provider has a key" pattern. This is the fingerprint of the
// pre-v5.8.4 updateConfig bug that silently seeded `defaultProvider:
// anthropic` into ~/.gnosys/gnosys.json whenever any setup section was
// written to a fresh store. Offer one-keystroke repair.

const PROVIDERS_WITH_KEYS: LLMProviderName[] = ["anthropic", "openai", "xai", "groq", "mistral"];

async function maybeOfferProviderRepair(
  cfg: GnosysConfig,
  projectDir: string,
  rl: ReadlineInterface,
): Promise<void> {
  if (cfg.llm.defaultProvider !== "anthropic") return;
  const { getApiKeyForProvider } = await import("../setup.js");
  const anthropicKey = await getApiKeyForProvider("anthropic");
  if (anthropicKey) return; // user might really want Anthropic and just hasn't fully set up yet

  const candidates: LLMProviderName[] = [];
  for (const p of PROVIDERS_WITH_KEYS) {
    if (p === "anthropic") continue;
    const key = await getApiKeyForProvider(p);
    if (key) candidates.push(p);
  }
  if (candidates.length === 0) return; // no other provider has a key either

  // Pick the strongest candidate. Order in PROVIDERS_WITH_KEYS is the priority.
  const suggestion = candidates[0];

  console.log("");
  console.log(`${YELLOW}⚠${RESET} Your gnosys.json says ${BOLD}defaultProvider: anthropic${RESET},`);
  console.log(`  but no Anthropic API key is configured (env or keychain).`);
  console.log(`  Found a key for ${BOLD}${suggestion}${RESET}${candidates.length > 1 ? ` (also: ${candidates.slice(1).join(", ")})` : ""}.`);
  console.log("");
  console.log(`  This usually means a pre-v5.8.4 setup wizard seeded anthropic by mistake.`);
  console.log("");
  const answer = (await rl.question(`Switch the default to ${BOLD}${suggestion}${RESET}? [Y/n] `)).trim().toLowerCase();
  if (answer === "n" || answer === "no") {
    console.log(`${DIM}Left as anthropic. Run option 1 below to change explicitly.${RESET}`);
    return;
  }

  try {
    // Write to the store that actually holds the current config so the
    // override lands at the right scope.
    const { getGnosysHome } = await import("../paths.js");
    const fs = await import("fs/promises");
    const path = await import("path");
    // Prefer project-level if it has a gnosys.json, else global.
    const projectStore = path.join(projectDir, ".gnosys");
    let storePath = getGnosysHome();
    try {
      const stat = await fs.stat(path.join(projectStore, "gnosys.json"));
      if (stat.isFile()) storePath = projectStore;
    } catch {
      // fall back to global
    }
    await updateConfig(storePath, { llm: { defaultProvider: suggestion } });
    console.log(`${CHECK} Switched default to ${BOLD}${suggestion}${RESET}.`);
  } catch (err) {
    console.log(`${YELLOW}⚠${RESET} Failed to repair: ${err instanceof Error ? err.message : String(err)}`);
    console.log(`${DIM}Run 'gnosys setup models' to change manually.${RESET}`);
  }
}

// ─── Section handlers ───────────────────────────────────────────────────────

/** Each summary line is a section the user can navigate into. */
export interface SummarySection {
  /** Number key shown in the menu. */
  key: string;
  /** Label shown on the summary line (left side). */
  label: string;
  /** Current value — printed on the right side, dim. */
  describe: (cfg: GnosysConfig) => string | Promise<string>;
  /** Run when user picks this line. Returns true if a change was committed. */
  edit: (rl: ReadlineInterface, cfg: GnosysConfig, projectDir: string) => Promise<boolean>;
}

/**
 * Build the section list. Each `edit` calls into existing wizards via
 * dynamic import — keeps this file decoupled from the legacy setup.ts.
 */
export function buildSections(): SummarySection[] {
  return [
    {
      key: "1",
      label: "Provider",
      describe: (cfg) => cfg.llm.defaultProvider,
      edit: async (rl, _cfg, projectDir) => {
        const { runModelsSetup } = await import("../setup.js");
        // v5.8.4: pass the summary's readline through so we don't open a
        // second one and double every keystroke.
        await runModelsSetup({ directory: projectDir, rl });
        return true;
      },
    },
    {
      key: "2",
      label: "Models",
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
      label: "Task Routing",
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
      label: "IDE Integrations",
      describe: async (_cfg) => {
        const { detectIDEs } = await import("../setup.js");
        const ides = await detectIDEs(process.cwd());
        return ides.length === 0 ? "none" : `${ides.length} configured`;
      },
      edit: async (rl, _cfg, projectDir) => editIDEs(rl, projectDir),
    },
    {
      key: "5",
      label: "Multi-machine Sync",
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
      label: "Dream Mode",
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
      label: "User Preferences",
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

// ─── Section editors that don't yet have standalone wizards ────────────────

/**
 * Per-task routing editor. The legacy `runSetup` walks all 5 tasks in step 4
 * — this lets the user revisit the choice without redoing provider/models.
 */
async function editRouting(rl: ReadlineInterface, projectDir: string): Promise<boolean> {
  const { runRoutingSetup } = await import("./sections/routing.js");
  return runRoutingSetup({ rl, directory: projectDir });
}

/** IDE selection editor — same prompt as step 5 in the linear wizard. */
async function editIDEs(rl: ReadlineInterface, projectDir: string): Promise<boolean> {
  const { runIdesSetup } = await import("./sections/ides.js");
  return runIdesSetup({ rl, directory: projectDir });
}

// ─── Main loop ──────────────────────────────────────────────────────────────

export interface SummaryOptions {
  /** Project directory the wizard operates on (default: cwd). */
  directory?: string;
  /** Optional pre-existing readline; useful when caller is already prompting. */
  rl?: ReadlineInterface;
}

/**
 * Run the summary-first wizard. Loops until the user picks Done or Exit.
 * Returns `true` if any section was edited and committed.
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
      // Reload config each iteration so the displayed values reflect any
      // section edit that just happened.
      const cfg = await loadConfig(projectDir);

      // v5.8.5: detect the "config says anthropic but no Anthropic key is
      // configured anywhere AND another provider has a key" pattern. This
      // is the fingerprint of the pre-v5.8.4 updateConfig bug that silently
      // seeded `defaultProvider: anthropic` into ~/.gnosys/gnosys.json when
      // any section was written to a fresh store. Offer one-keystroke repair.
      if (!revertCheckDone) {
        revertCheckDone = true;
        await maybeOfferProviderRepair(cfg, projectDir, rl);
      }

      console.log("");
      console.log(`${BOLD}┌─────────────────────────────────────────────┐${RESET}`);
      console.log(`${BOLD}│  Gnosys Settings                            │${RESET}`);
      console.log(`${BOLD}├─────────────────────────────────────────────┤${RESET}`);
      for (const s of sections) {
        const value = await s.describe(cfg);
        const marker = updated.has(s.key) ? `  ${CHECK}` : "    ";
        const line = `  ${s.key}. ${s.label.padEnd(18)} ${DIM}${value}${RESET}${marker}`;
        console.log(line);
      }
      console.log(`${BOLD}└─────────────────────────────────────────────┘${RESET}`);
      console.log("");
      console.log(`  Pick a number to edit · ${BOLD}D${RESET}one · ${BOLD}E${RESET}xit`);

      const answer = (await rl.question("> ")).trim().toLowerCase();
      if (!answer || answer === "d" || answer === "done") {
        return anyChange;
      }
      if (answer === "e" || answer === "exit") {
        if (anyChange) {
          console.log(`${DIM}(any changes already committed during section edits stay applied)${RESET}`);
        }
        return anyChange;
      }

      const section = sections.find((s) => s.key === answer);
      if (!section) {
        console.log(`${DIM}Unknown choice: ${answer}${RESET}`);
        continue;
      }

      const cfgForEdit = await loadConfig(projectDir);
      try {
        const changed = await section.edit(rl, cfgForEdit, projectDir);
        if (changed) {
          updated.add(section.key);
          anyChange = true;
        }
      } catch (err) {
        console.log(`${DIM}Section editor failed: ${err instanceof Error ? err.message : String(err)}${RESET}`);
      }
    }
  } finally {
    if (ownsRl) rl.close();
  }
}

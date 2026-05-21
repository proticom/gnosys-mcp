/**
 * Setup: Task Routing.
 *
 * Standalone wizard for configuring per-task LLM routing
 * (structuring / synthesis / vision / transcription / dream).
 * Extracted from the linear `runSetup` flow so it can be invoked
 * directly via `gnosys setup routing` or from the summary-first menu.
 */

import { Interface as ReadlineInterface } from "readline/promises";
import {
  loadConfig,
  updateConfig,
  resolveTaskModel,
  getProviderModel,
  type GnosysConfig,
  type LLMProviderName,
} from "../../config.js";
import { safeQuestion } from "../ui/safePrompt.js";
import { Header } from "../ui/header.js";
import { Title } from "../ui/title.js";
import { Footer } from "../ui/footer.js";
import { printStatus } from "../ui/status.js";
import {
  classifyCost,
  renderRoutingTable,
  renderRoutingDiff,
  type TaskRow,
  type DiffEntry,
} from "../routingRender.js";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

type TaskName = "structuring" | "synthesis" | "chat" | "vision" | "transcription";
const TASKS: TaskName[] = ["structuring", "synthesis", "chat", "vision", "transcription"];

export interface RoutingOptions {
  rl: ReadlineInterface;
  directory: string;
}

async function ask(rl: ReadlineInterface, prompt: string): Promise<string> {
  return (await safeQuestion(rl, prompt)).trim();
}

async function askYesNo(rl: ReadlineInterface, prompt: string, defaultYes: boolean): Promise<boolean> {
  const hint = defaultYes ? " [Y/n] " : " [y/N] ";
  const answer = (await ask(rl, prompt + hint)).toLowerCase();
  if (!answer) return defaultYes;
  return answer === "y" || answer === "yes";
}

async function askChoice(
  rl: ReadlineInterface,
  prompt: string,
  choices: string[],
  defaultIdx = 0,
): Promise<number> {
  console.log("");
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

function buildEffectiveRouting(cfg: GnosysConfig): Record<string, { provider: string; model: string }> {
  const out: Record<string, { provider: string; model: string }> = {};
  for (const t of TASKS) {
    const r = resolveTaskModel(cfg, t);
    out[t] = { provider: r.provider, model: r.model };
  }
  out.dream = {
    provider: cfg.dream?.provider ?? "ollama",
    model: cfg.dream?.model ?? getProviderModel(cfg, (cfg.dream?.provider ?? "ollama") as LLMProviderName),
  };
  return out;
}

/**
 * Build the table-row payload from current routing data. Marks any
 * task whose effective provider/model differs from the snapshot as
 * `changed` so the renderer can highlight it (▶ in accent-hi).
 */
function buildTaskRows(
  routing: Record<string, { provider: string; model: string }>,
  baseline: Record<string, { provider: string; model: string }>,
  dreamEnabled: boolean,
): TaskRow[] {
  const rows: TaskRow[] = [];
  for (const t of [...TASKS, "dream" as const]) {
    const r = routing[t];
    const uses = `${r.provider} / ${r.model}`;
    const cost = t === "dream" && !dreamEnabled ? "free" : classifyCost(r.provider, r.model);
    const base = baseline[t];
    const changed = !base || base.provider !== r.provider || base.model !== r.model;
    rows.push({ task: t, uses, cost, changed });
  }
  return rows;
}

/**
 * Run the task-routing wizard. Reads current config, walks the 3-way choice
 * (keep defaults / customize individual / use same for all), writes any
 * overrides via updateConfig(). Returns true if config was changed.
 */
export async function runRoutingSetup(opts: RoutingOptions): Promise<boolean> {
  const cfg = await loadConfig(opts.directory);
  const provider = cfg.llm.defaultProvider;
  const model = getProviderModel(cfg, provider);

  console.log("");
  console.log(Header(["gnosys", "setup", "routing"]));
  console.log("");
  console.log(Title("Task routing", "each task can use a different model — overrides the default"));
  console.log("");

  const dreamEnabled = !!cfg.dream?.enabled;
  const baseline = buildEffectiveRouting(cfg);
  // Initial table: nothing has changed yet, so every row is `changed: false`.
  const initialRows = buildTaskRows(baseline, baseline, dreamEnabled);
  console.log(renderRoutingTable(initialRows));
  console.log("");

  // v5.9.4 Bug 5 — clearer option copy. Option 1 keeps current routing
  // (skip, no changes). Option 2 customises individual tasks. Option 3
  // CLEARS all task overrides so every task falls back to the default
  // provider; we show a Diff() of what's being removed before committing.
  const choice = await askChoice(
    opts.rl,
    "What would you like to do?",
    [
      "Keep current routing (no changes)",
      "Customize individual tasks",
      "Reset all task overrides to use default",
    ],
    0,
  );

  if (choice === 0) {
    console.log(`${DIM}No changes.${RESET}`);
    return false;
  }

  const newTaskModels: Record<string, { provider: string; model: string }> = {
    ...(cfg.taskModels ?? {}),
  };
  let dreamProvider: LLMProviderName = (cfg.dream?.provider ?? "ollama") as LLMProviderName;
  let dreamModel = cfg.dream?.model ?? "llama3.2";
  let dreamEnabledNew = dreamEnabled;

  if (choice === 1) {
    // Customize each task
    for (const t of TASKS) {
      const current = baseline[t];
      const keep = await askYesNo(
        opts.rl,
        `Keep ${t} → ${current.provider} / ${current.model}?`,
        true,
      );
      if (!keep) {
        const p = await ask(opts.rl, `  Provider for ${t} (e.g. anthropic, openai, xai, ollama): `);
        const m = await ask(opts.rl, `  Model for ${t}: `);
        if (p && m) newTaskModels[t] = { provider: p, model: m };
      }
    }
    // Dream
    dreamEnabledNew = await askYesNo(opts.rl, "Enable dream mode?", dreamEnabled);
    if (dreamEnabledNew) {
      const keepDream = await askYesNo(
        opts.rl,
        `Keep dream → ${dreamProvider} / ${dreamModel}?`,
        true,
      );
      if (!keepDream) {
        const p = (await ask(opts.rl, "  Provider for dream: ")) as LLMProviderName | "";
        if (p) dreamProvider = p as LLMProviderName;
        dreamModel = (await ask(opts.rl, "  Model for dream: ")) || dreamModel;
      }
    }
  } else {
    // v5.9.4 Bug 5 — choice === 2 now means "reset all task overrides to use
    // default". Show the user what's about to be cleared (the rows currently
    // pinned to non-default providers) before committing.
    const { Diff } = await import("../ui/diff.js");
    const overridesBeingCleared = Object.entries(cfg.taskModels ?? {})
      .filter(([, v]) => v.provider !== provider || v.model !== model)
      .map(([task, v]) => ({
        label: task,
        from: `${v.provider} / ${v.model}`,
        to: `${provider} / ${model} (default)`,
      }));
    if (overridesBeingCleared.length > 0) {
      console.log("");
      console.log(Diff(overridesBeingCleared));
      console.log("");
    } else {
      console.log(`${DIM}No overrides to clear — already using default everywhere.${RESET}`);
    }
    const confirmReset = await askYesNo(opts.rl, "Reset all task overrides?", true);
    if (!confirmReset) {
      console.log(`${DIM}Cancelled.${RESET}`);
      return false;
    }
    // Clear every overridden task back to default by deleting the keys.
    for (const t of TASKS) delete newTaskModels[t];
  }

  // Persist
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await updateConfig(opts.directory, {
    taskModels: newTaskModels as GnosysConfig["taskModels"],
    dream: {
      ...(cfg.dream ?? {}),
      enabled: dreamEnabledNew,
      provider: dreamProvider as LLMProviderName,
      model: dreamModel,
    } as any,
  });

  // v5.9.3 Screen 4 — re-render the table with `▶` markers on changed rows
  // followed by a Diff() block summarizing what shipped. Then a final
  // status line that names the saved file.
  const updatedCfg = await loadConfig(opts.directory);
  const updatedRouting = buildEffectiveRouting(updatedCfg);
  const finalRows = buildTaskRows(updatedRouting, baseline, dreamEnabledNew);
  console.log("");
  console.log(renderRoutingTable(finalRows));
  console.log("");

  const diffEntries: DiffEntry[] = [];
  for (const t of [...TASKS, "dream" as const]) {
    const before = baseline[t];
    const after = updatedRouting[t];
    const fromStr = `${before.provider} / ${before.model}`;
    const toStr = `${after.provider} / ${after.model}`;
    diffEntries.push({ task: t, from: fromStr, to: toStr === fromStr ? null : toStr });
  }
  console.log(renderRoutingDiff(diffEntries));
  console.log("");
  printStatus("ok", "routing saved", `${opts.directory}/.gnosys/gnosys.json`);
  // Footer hint (right-aligned) for any follow-up navigation in the menu flow.
  console.log(Footer("press enter to return"));
  return true;
}

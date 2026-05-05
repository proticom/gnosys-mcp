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

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RESET = "\x1b[0m";
const CHECK = `${GREEN}✓${RESET}`;

export const TASK_DESCRIPTIONS: Record<string, string> = {
  structuring: "adding memories, tagging",
  synthesis: "Q&A answers, chat",
  vision: "images, PDFs",
  transcription: "audio files",
  dream: "idle consolidation",
};

type TaskName = "structuring" | "synthesis" | "vision" | "transcription";
const TASKS: TaskName[] = ["structuring", "synthesis", "vision", "transcription"];

export interface RoutingOptions {
  rl: ReadlineInterface;
  directory: string;
}

async function ask(rl: ReadlineInterface, prompt: string): Promise<string> {
  return (await rl.question(prompt)).trim();
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

function printTable(routing: Record<string, { provider: string; model: string }>, dreamEnabled: boolean): void {
  const taskNameWidth = 16;
  const routingWidth = 38;
  console.log(`  ${BOLD}${"Task".padEnd(taskNameWidth)}${"Current Routing".padEnd(routingWidth)}${RESET}`);
  console.log(`  ${"─".repeat(taskNameWidth + routingWidth)}`);
  for (const t of [...TASKS, "dream" as const]) {
    const r = routing[t];
    const desc = TASK_DESCRIPTIONS[t] ?? "";
    const status = t === "dream" && !dreamEnabled ? `${DIM}(disabled)${RESET}` : `${DIM}(${desc})${RESET}`;
    console.log(`  ${t.padEnd(taskNameWidth)}${`${r.provider} / ${r.model}`.padEnd(routingWidth)}${status}`);
  }
  console.log("");
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
  console.log(`${BOLD}Task Routing${RESET}`);
  console.log("");
  console.log(`Each task can use a different LLM. Defaults flow from your provider`);
  console.log(`(${BOLD}${provider} / ${model}${RESET}). Override per-task or keep defaults.`);
  console.log("");

  const dreamEnabled = !!cfg.dream?.enabled;
  const routing = buildEffectiveRouting(cfg);
  printTable(routing, dreamEnabled);

  const choice = await askChoice(
    opts.rl,
    "What would you like to do?",
    [
      `Keep defaults (all tasks use ${provider})`,
      "Customize individual tasks",
      "Use same provider for ALL tasks (including dream)",
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
      const current = routing[t];
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
    // choice === 2: use same provider for everything
    for (const t of TASKS) {
      newTaskModels[t] = { provider, model };
    }
    dreamEnabledNew = await askYesNo(opts.rl, `Enable dream with ${provider}?`, true);
    if (dreamEnabledNew) {
      dreamProvider = provider as LLMProviderName;
      dreamModel = model;
    }
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

  console.log("");
  console.log(`${CHECK} Task routing updated.`);
  return true;
}

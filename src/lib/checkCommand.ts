import path from "path";
import {
  loadConfig,
  DEFAULT_CONFIG,
  resolveTaskModel,
  type GnosysConfig,
  type LLMProviderName,
} from "./config.js";
import { getGnosysHome } from "./paths.js";
import { getLLMProvider, isProviderAvailable } from "./llm.js";

export type CheckCommandOptions = {
  task?: string;
};

export async function runCheckCommand(opts: CheckCommandOptions): Promise<void> {
  const projectDir = process.cwd();
  const storePath = path.join(projectDir, ".gnosys");
  const globalStorePath = getGnosysHome();

  // Load config: try project-level first, fall back to global ~/.gnosys/
  let cfg: GnosysConfig;
  let configSource: string;
  try {
    const projectCfg = await loadConfig(storePath);
    // Check if it's just defaults (no actual config file) by seeing if dream has been configured
    const hasProjectConfig = projectCfg.dream?.provider !== DEFAULT_CONFIG.dream?.provider ||
      projectCfg.llm?.defaultProvider !== DEFAULT_CONFIG.llm?.defaultProvider;
    if (hasProjectConfig) {
      cfg = projectCfg;
      configSource = storePath;
    } else {
      cfg = await loadConfig(globalStorePath);
      configSource = globalStorePath;
    }
  } catch {
    cfg = await loadConfig(globalStorePath);
    configSource = globalStorePath;
  }

  const GREEN = "\x1b[32m";
  const RED = "\x1b[31m";
  const YELLOW = "\x1b[33m";
  const DIM = "\x1b[2m";
  const BOLD = "\x1b[1m";
  const RESET = "\x1b[0m";
  const CHECK = `${GREEN}✓${RESET}`;
  const CROSS = `${RED}✗${RESET}`;
  const WARN = `${YELLOW}⚠${RESET}`;

  console.log(`\n${BOLD}Gnosys LLM Check${RESET} ${DIM}(config: ${configSource})${RESET}\n`);

  // Define the 5 tasks and how to resolve each
  interface TaskCheck {
    name: string;
    description: string;
    resolve: () => { provider: string; model: string };
    needsKey?: boolean;
  }

  const tasks: TaskCheck[] = [
    {
      name: "structuring",
      description: "adding memories, tagging",
      resolve: () => resolveTaskModel(cfg, "structuring"),
    },
    {
      name: "synthesis",
      description: "Q&A answers (gnosys ask)",
      resolve: () => resolveTaskModel(cfg, "synthesis"),
    },
    {
      name: "chat",
      description: "interactive chat (gnosys chat)",
      // Chat reuses the synthesis task's model — surface it under its own name
      // so users can see exactly what their TUI will use.
      resolve: () => resolveTaskModel(cfg, "synthesis"),
    },
    {
      name: "vision",
      description: "images, PDFs",
      resolve: () => resolveTaskModel(cfg, "vision"),
    },
    {
      name: "transcription",
      description: "audio files",
      resolve: () => resolveTaskModel(cfg, "transcription"),
    },
    {
      name: "dream",
      description: "overnight consolidation",
      resolve: () => ({
        provider: cfg.dream?.provider || "ollama",
        model: cfg.dream?.model || "llama3.2",
      }),
    },
  ];

  let passed = 0;
  let failed = 0;
  let skipped = 0;

  // Filter to a single task if --task was given.
  const filteredTasks = opts.task
    ? tasks.filter((t) => t.name === opts.task)
    : tasks;
  if (opts.task && filteredTasks.length === 0) {
    console.error(`Unknown task: ${opts.task}. Pick one of: ${tasks.map((t) => t.name).join(", ")}`);
    process.exit(1);
  }

  for (const task of filteredTasks) {
    const { provider, model } = task.resolve();
    const label = `${task.name.padEnd(16)} ${DIM}${provider} / ${model}${RESET}`;
    const desc = `${DIM}(${task.description})${RESET}`;

    // Special handling for dream — check if enabled
    if (task.name === "dream" && !cfg.dream?.enabled) {
      console.log(`  ${WARN} ${label}  disabled  ${desc}`);
      skipped++;
      continue;
    }

    // Check provider availability (API key, etc.)
    const availability = isProviderAvailable(cfg, provider as LLMProviderName);
    if (!availability.available) {
      console.log(`  ${CROSS} ${label}  ${RED}${availability.error}${RESET}  ${desc}`);
      failed++;
      continue;
    }

    // Test actual connection with timing
    const start = Date.now();
    try {
      const llmProvider = getLLMProvider({ ...cfg, llm: { ...cfg.llm, defaultProvider: provider as LLMProviderName } });
      await llmProvider.testConnection();
      const ms = Date.now() - start;
      console.log(`  ${CHECK} ${label}  ${GREEN}${ms}ms${RESET}  ${desc}`);
      passed++;
    } catch (err) {
      const ms = Date.now() - start;
      const errMsg = err instanceof Error ? err.message : String(err);
      // Truncate long error messages
      const shortErr = errMsg.length > 60 ? errMsg.slice(0, 57) + "..." : errMsg;
      console.log(`  ${CROSS} ${label}  ${RED}${shortErr}${RESET} (${ms}ms)  ${desc}`);
      failed++;
    }
  }

  console.log();
  const total = passed + failed + skipped;
  if (failed === 0) {
    console.log(`${CHECK} All ${passed}/${total} tasks connected.`);
  } else {
    console.log(`${passed}/${total} connected, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ""}.`);
    console.log(`\n${DIM}Fix: Run 'gnosys setup' to configure providers and API keys.${RESET}`);
  }
  console.log();
}

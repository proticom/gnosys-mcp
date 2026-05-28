import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import type { GnosysResolver } from "./resolver.js";
import {
  loadConfig,
  writeConfig,
  resolveTaskModel,
  generateConfigTemplate,
  ALL_PROVIDERS,
  type LLMProviderName,
  type GnosysConfig,
} from "./config.js";

type GetResolver = () => Promise<GnosysResolver>;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function packageVersion(): Promise<string> {
  const pkgPath = path.resolve(__dirname, "..", "..", "package.json");
  const pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8"));
  return pkg.version as string;
}

function providerModel(cfg: GnosysConfig, p: LLMProviderName): string | undefined {
  switch (p) {
    case "anthropic": return cfg.llm.anthropic.model;
    case "ollama": return cfg.llm.ollama.model;
    case "groq": return cfg.llm.groq.model;
    case "openai": return cfg.llm.openai.model;
    case "lmstudio": return cfg.llm.lmstudio.model;
    case "xai": return cfg.llm.xai.model;
    case "mistral": return cfg.llm.mistral.model;
    case "custom": return cfg.llm.custom?.model;
  }
}

export async function runConfigShowCommand(
  getResolver: GetResolver,
  opts: { json?: boolean },
): Promise<void> {
        const resolver = await getResolver();
        const stores = resolver.getStores();
        if (stores.length === 0) {
          console.error("No stores found. Run gnosys init first.");
          process.exit(1);
        }
    
        const cfg = await loadConfig(stores[0].path);
    
        if (opts.json) {
          // v5.9.3 (design §12): --json keeps the old machine-readable
          // dump for scripts. Default output is the human-friendly view.
          process.stdout.write(`${JSON.stringify(cfg, null, 2)}\n`);
          return;
        }
    
        console.log("System of Cognition (SOC) — LLM Configuration:");
        console.log(`  Default provider: ${cfg.llm.defaultProvider}`);
        console.log("");
        console.log("  Providers:");
        console.log(`    Anthropic:  model=${cfg.llm.anthropic.model}, apiKey=${cfg.llm.anthropic.apiKey ? "config" : (process.env.ANTHROPIC_API_KEY ? "env" : "—")}`);
        console.log(`    Ollama:     model=${cfg.llm.ollama.model}, url=${cfg.llm.ollama.baseUrl}`);
        console.log(`    Groq:       model=${cfg.llm.groq.model}, apiKey=${cfg.llm.groq.apiKey ? "config" : (process.env.GROQ_API_KEY ? "env" : "—")}`);
        console.log(`    OpenAI:     model=${cfg.llm.openai.model}, apiKey=${cfg.llm.openai.apiKey ? "config" : (process.env.OPENAI_API_KEY ? "env" : "—")}, url=${cfg.llm.openai.baseUrl}`);
        console.log(`    LM Studio:  model=${cfg.llm.lmstudio.model}, url=${cfg.llm.lmstudio.baseUrl}`);
        console.log(`    xAI:        model=${cfg.llm.xai.model}, apiKey=${cfg.llm.xai.apiKey ? "config" : (process.env.XAI_API_KEY ? "env" : "—")}`);
        console.log(`    Mistral:    model=${cfg.llm.mistral.model}, apiKey=${cfg.llm.mistral.apiKey ? "config" : (process.env.MISTRAL_API_KEY ? "env" : "—")}`);
        if (cfg.llm.custom) {
          console.log(`    Custom:     model=${cfg.llm.custom.model}, url=${cfg.llm.custom.baseUrl}, apiKey=${cfg.llm.custom.apiKey ? "config" : (process.env.GNOSYS_LLM_API_KEY ? "env" : "—")}`);
        }
        console.log("");
    
        const structuring = resolveTaskModel(cfg, "structuring");
        const synthesis = resolveTaskModel(cfg, "synthesis");
        console.log("  Task Routing:");
        console.log(`    Structuring: ${structuring.provider}/${structuring.model}${cfg.taskModels?.structuring ? " (override)" : " (default)"}`);
        console.log(`    Synthesis:   ${synthesis.provider}/${synthesis.model}${cfg.taskModels?.synthesis ? " (override)" : " (default)"}`);
}

export async function runConfigSetCommand(
  getResolver: GetResolver,
  key: string,
  value: string,
  extra: string[],
): Promise<void> {
        // v5.9.3 Screen 13 — schema-validate the top-level key against the
        // known set BEFORE any work, render a `did you mean X?` hint on
        // typo. The diff + store-source label fire after the switch.
        const { suggestConfigKey, classifyStore, KNOWN_CONFIG_KEYS } = await import(
          "./setup/configSetRender.js"
        );
        const { Header } = await import("./setup/ui/header.js");
        const { printStatus } = await import("./setup/ui/status.js");
        const { printDiff } = await import("./setup/ui/diff.js");
    
        if (!KNOWN_CONFIG_KEYS.includes(key)) {
          const suggestion = suggestConfigKey(key);
          const meta = suggestion ? `did you mean \`${suggestion}\` ?` : undefined;
          printStatus("fail", `unknown config key   ${key}`, meta);
          process.exit(1);
        }
    
        const resolver = await getResolver();
        const writeTarget = resolver.getWriteTarget();
        if (!writeTarget) {
          printStatus("fail", "no writable store found");
          process.exit(1);
        }
    
        const storePath = writeTarget.store.getStorePath();
        const cfg = await loadConfig(storePath);
        const validProviders = ALL_PROVIDERS.join(", ");
        const homeDir = process.env.HOME || process.env.USERPROFILE || "/";
        const storeLabel = classifyStore(storePath, homeDir);
    
        // Each branch populates this row so the trailing Diff print picks up
        // a single before/after summary. Recall has three sub-fields and
        // sets the row inside its own switch.
        let diffRow: { label: string; from: string; to: string } | null = null;
    
        switch (key) {
          case "provider":
            if (!ALL_PROVIDERS.includes(value as LLMProviderName)) {
              printStatus("fail", `invalid provider \`${value}\``, `supported: ${validProviders}`);
              process.exit(1);
            }
            diffRow = { label: "provider", from: cfg.llm.defaultProvider, to: value };
            cfg.llm.defaultProvider = value as LLMProviderName;
            break;
    
          case "model": {
            // Set model for current default provider
            const p = cfg.llm.defaultProvider;
            const fromModel = providerModel(cfg, p) ?? "(unset)";
            if (p === "anthropic") cfg.llm.anthropic.model = value;
            else if (p === "ollama") cfg.llm.ollama.model = value;
            else if (p === "groq") cfg.llm.groq.model = value;
            else if (p === "openai") cfg.llm.openai.model = value;
            else if (p === "lmstudio") cfg.llm.lmstudio.model = value;
            else if (p === "xai") cfg.llm.xai.model = value;
            else if (p === "mistral") cfg.llm.mistral.model = value;
            else if (p === "custom") {
              if (!cfg.llm.custom) cfg.llm.custom = { model: value, baseUrl: "" };
              else cfg.llm.custom.model = value;
            }
            diffRow = { label: `${p}.model`, from: fromModel, to: value };
            break;
          }
    
          case "task": {
            // gnosys config set task <taskName> <provider> <model>
            const taskName = value as "structuring" | "synthesis";
            const taskProvider = extra[0] as LLMProviderName;
            const taskModel = extra[1];
            if (!taskName || !taskProvider || !taskModel) {
              printStatus("fail", "usage", "gnosys config set task <structuring|synthesis> <provider> <model>");
              process.exit(1);
            }
            if (taskName !== "structuring" && taskName !== "synthesis") {
              printStatus("fail", `invalid task \`${taskName}\``, "valid: structuring, synthesis");
              process.exit(1);
            }
            if (!ALL_PROVIDERS.includes(taskProvider)) {
              printStatus("fail", `invalid provider \`${taskProvider}\``, `supported: ${validProviders}`);
              process.exit(1);
            }
            if (!cfg.taskModels) cfg.taskModels = {};
            const taskMap = cfg.taskModels as Record<string, { provider: LLMProviderName; model: string }>;
            const prev = taskMap[taskName];
            const fromStr = prev ? `${prev.provider}/${prev.model}` : "(unset)";
            taskMap[taskName] = { provider: taskProvider, model: taskModel };
            diffRow = { label: `task.${taskName}`, from: fromStr, to: `${taskProvider}/${taskModel}` };
            break;
          }
    
          case "ollama-url":
            diffRow = { label: "ollama.baseUrl", from: cfg.llm.ollama.baseUrl ?? "(unset)", to: value };
            cfg.llm.ollama.baseUrl = value;
            break;
    
          case "ollama-model":
            diffRow = { label: "ollama.model", from: cfg.llm.ollama.model ?? "(unset)", to: value };
            cfg.llm.ollama.model = value;
            break;
    
          case "anthropic-model":
            diffRow = { label: "anthropic.model", from: cfg.llm.anthropic.model ?? "(unset)", to: value };
            cfg.llm.anthropic.model = value;
            break;
    
          case "groq-model":
            diffRow = { label: "groq.model", from: cfg.llm.groq.model ?? "(unset)", to: value };
            cfg.llm.groq.model = value;
            break;
    
          case "openai-model":
            diffRow = { label: "openai.model", from: cfg.llm.openai.model ?? "(unset)", to: value };
            cfg.llm.openai.model = value;
            break;
    
          case "openai-url":
            diffRow = { label: "openai.baseUrl", from: cfg.llm.openai.baseUrl ?? "(unset)", to: value };
            cfg.llm.openai.baseUrl = value;
            break;
    
          case "lmstudio-url":
            diffRow = { label: "lmstudio.baseUrl", from: cfg.llm.lmstudio.baseUrl ?? "(unset)", to: value };
            cfg.llm.lmstudio.baseUrl = value;
            break;
    
          case "lmstudio-model":
            diffRow = { label: "lmstudio.model", from: cfg.llm.lmstudio.model ?? "(unset)", to: value };
            cfg.llm.lmstudio.model = value;
            break;
    
          case "xai-model":
            diffRow = { label: "xai.model", from: cfg.llm.xai.model ?? "(unset)", to: value };
            cfg.llm.xai.model = value;
            break;
    
          case "mistral-model":
            diffRow = { label: "mistral.model", from: cfg.llm.mistral.model ?? "(unset)", to: value };
            cfg.llm.mistral.model = value;
            break;
    
          case "custom-url":
            diffRow = { label: "custom.baseUrl", from: cfg.llm.custom?.baseUrl ?? "(unset)", to: value };
            if (!cfg.llm.custom) cfg.llm.custom = { model: "", baseUrl: value };
            else cfg.llm.custom.baseUrl = value;
            break;
    
          case "custom-model":
            diffRow = { label: "custom.model", from: cfg.llm.custom?.model ?? "(unset)", to: value };
            if (!cfg.llm.custom) cfg.llm.custom = { model: value, baseUrl: "" };
            else cfg.llm.custom.model = value;
            break;
    
          case "custom-key":
            // Sensitive — don't echo the key in the diff, just mark as redacted.
            diffRow = { label: "custom.apiKey", from: cfg.llm.custom?.apiKey ? "(set)" : "(unset)", to: "(set)" };
            if (!cfg.llm.custom) cfg.llm.custom = { model: "", baseUrl: "", apiKey: value };
            else cfg.llm.custom.apiKey = value;
            break;
    
          case "recall": {
            // gnosys config set recall <field> <value>
            // Supported: recall aggressive true/false, recall maxMemories <n>, recall minRelevance <n>
            const recallField = value;
            const recallValue = extra[0];
            if (!recallField || !recallValue) {
              printStatus("fail", "usage", "gnosys config set recall <aggressive|maxMemories|minRelevance> <value>");
              process.exit(1);
            }
            if (!cfg.recall) cfg.recall = { aggressive: true, maxMemories: 8, minRelevance: 0.4 };
            switch (recallField) {
              case "aggressive":
                if (recallValue !== "true" && recallValue !== "false") {
                  printStatus("fail", `invalid value \`${recallValue}\``, "use `true` or `false`");
                  process.exit(1);
                }
                diffRow = { label: "recall.aggressive", from: String(cfg.recall.aggressive), to: recallValue };
                cfg.recall.aggressive = recallValue === "true";
                break;
              case "maxMemories": {
                const n = parseInt(recallValue, 10);
                if (isNaN(n) || n < 1 || n > 20) {
                  printStatus("fail", "maxMemories must be between 1 and 20");
                  process.exit(1);
                }
                diffRow = { label: "recall.maxMemories", from: String(cfg.recall.maxMemories), to: String(n) };
                cfg.recall.maxMemories = n;
                break;
              }
              case "minRelevance": {
                const f = parseFloat(recallValue);
                if (isNaN(f) || f < 0 || f > 1) {
                  printStatus("fail", "minRelevance must be between 0 and 1");
                  process.exit(1);
                }
                diffRow = { label: "recall.minRelevance", from: String(cfg.recall.minRelevance), to: String(f) };
                cfg.recall.minRelevance = f;
                break;
              }
              default:
                printStatus("fail", `unknown recall field \`${recallField}\``, "valid: aggressive, maxMemories, minRelevance");
                process.exit(1);
            }
            break;
          }
        }
    
        await writeConfig(storePath, cfg);
    
        // v5.9.3 Screen 13 — print Header + Diff + ✓ saved with store label.
        console.log("");
        console.log(Header(["gnosys", "config", "set"]));
        console.log("");
        if (diffRow) {
          // Append store source to the `to` column so the diff line says
          // both the new value and where it landed (project vs global).
          printDiff([{ ...diffRow, to: `${diffRow.to}    (${storeLabel})` }]);
        }
        printStatus("ok", `saved · ${path.join(storePath, "gnosys.json")}`, `(${storeLabel})`);
}

export async function runConfigInitCommand(
  getResolver: GetResolver,
  opts: { force?: boolean },
): Promise<void> {
        // v5.9.3 (design handoff §14, deci-050): `config init` is being
        // folded into `gnosys setup`. Without --force we print a warning
        // pointing to `gnosys setup` and exit. With --force we write the
        // (now-blank-provider) template anyway for muscle-memory use.
        if (!opts.force) {
          const { Header } = await import("./setup/ui/header.js");
          const { Status } = await import("./setup/ui/status.js");
          const { Footer } = await import("./setup/ui/footer.js");
          console.log("");
          console.log(Header(["gnosys", "config", "init"], { version: `v${(await packageVersion())}` }));
          console.log("");
          console.log(Status("warn", "writing a blank template means the next run of `gnosys setup`"));
          console.log(Status("warn", "will walk you through the same choices anyway"));
          console.log("");
          console.log("   try   gnosys setup        interactive walkthrough (recommended)");
          console.log("");
          console.log(Footer("re-run with --force to write the template anyway"));
          process.exit(0);
        }
    
        const resolver = await getResolver();
        const writeTarget = resolver.getWriteTarget();
        if (!writeTarget) {
          console.error("No writable store found.");
          process.exit(1);
        }
    
        const storePath = writeTarget.store.getStorePath();
        const configPath = path.join(storePath, "gnosys.json");
    
        try {
          await fs.access(configPath);
          console.error("gnosys.json already exists. Use 'gnosys config set' to modify.");
          process.exit(1);
        } catch {
          // File doesn't exist — good
        }
    
        await fs.writeFile(configPath, generateConfigTemplate() + "\n", "utf-8");
        console.log(`Created ${configPath}`);
}

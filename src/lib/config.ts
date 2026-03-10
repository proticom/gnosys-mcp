/**
 * Gnosys Configuration — Loads and validates gnosys.json config files.
 * Uses Zod for schema validation with sensible defaults.
 */

import { z } from "zod";
import fs from "fs/promises";
import path from "path";

// ─── LLM Provider Schemas ───────────────────────────────────────────────

const LLMProviderEnum = z.enum(["anthropic", "ollama", "groq", "openai", "lmstudio"]);
export type LLMProviderName = z.infer<typeof LLMProviderEnum>;

const AnthropicConfigSchema = z.object({
  model: z.string().default("claude-sonnet-4-20250514"),
  apiKey: z.string().optional(), // Falls back to ANTHROPIC_API_KEY env var
});

const OllamaConfigSchema = z.object({
  model: z.string().default("llama3.2"),
  baseUrl: z.string().default("http://localhost:11434"),
});

const GroqConfigSchema = z.object({
  model: z.string().default("llama-3.3-70b-versatile"),
  apiKey: z.string().optional(), // Falls back to GROQ_API_KEY env var
});

const OpenAIConfigSchema = z.object({
  model: z.string().default("gpt-4o-mini"),
  apiKey: z.string().optional(), // Falls back to OPENAI_API_KEY env var
  baseUrl: z.string().default("https://api.openai.com/v1"),
});

const LMStudioConfigSchema = z.object({
  model: z.string().default("default"),
  baseUrl: z.string().default("http://localhost:1234/v1"),
});

const TaskModelSchema = z.object({
  provider: LLMProviderEnum,
  model: z.string(),
});

const LLMConfigSchema = z.object({
  defaultProvider: LLMProviderEnum.default("anthropic"),
  anthropic: AnthropicConfigSchema.default({ model: "claude-sonnet-4-20250514" }),
  ollama: OllamaConfigSchema.default({ model: "llama3.2", baseUrl: "http://localhost:11434" }),
  groq: GroqConfigSchema.default({ model: "llama-3.3-70b-versatile" }),
  openai: OpenAIConfigSchema.default({ model: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1" }),
  lmstudio: LMStudioConfigSchema.default({ model: "default", baseUrl: "http://localhost:1234/v1" }),
});

const TaskModelsSchema = z.object({
  structuring: TaskModelSchema.optional(),
  synthesis: TaskModelSchema.optional(),
});

// ─── Main Config Schema ─────────────────────────────────────────────────

export const GnosysConfigSchema = z.object({
  /** LLM configuration */
  llm: LLMConfigSchema.default({
    defaultProvider: "anthropic",
    anthropic: { model: "claude-sonnet-4-20250514" },
    ollama: { model: "llama3.2", baseUrl: "http://localhost:11434" },
    groq: { model: "llama-3.3-70b-versatile" },
    openai: { model: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1" },
    lmstudio: { model: "default", baseUrl: "http://localhost:1234/v1" },
  }),

  /** Task-specific model overrides */
  taskModels: TaskModelsSchema.default({}),

  // Legacy fields — kept for backward compat, mapped to llm.defaultProvider/anthropic.model
  /** @deprecated Use llm.defaultProvider instead */
  defaultLLMProvider: z
    .enum(["anthropic", "ollama", "openai", "groq"])
    .optional(),

  /** @deprecated Use llm.anthropic.model or llm.ollama.model instead */
  defaultModel: z.string().optional(),

  /** Max records per batch commit during bulk import */
  bulkIngestionBatchSize: z.number().int().min(1).max(10000).default(500),

  /** Parallel LLM calls during import */
  importConcurrency: z.number().int().min(1).max(20).default(5),

  /** Enable auto-commit on every write (disable for manual git) */
  autoCommit: z.boolean().default(true),

  /** LLM retry attempts on transient failures */
  llmRetryAttempts: z.number().int().min(0).max(10).default(3),

  /** Base delay in ms for exponential backoff between retries */
  llmRetryBaseDelayMs: z.number().int().min(100).max(30000).default(1000),

  /** Default author for imported memories */
  defaultAuthor: z
    .enum(["human", "ai", "human+ai"])
    .default("ai"),

  /** Default authority for imported memories */
  defaultAuthority: z
    .enum(["declared", "observed", "imported", "inferred"])
    .default("imported"),

  /** Default confidence for structured (non-LLM) imports */
  defaultConfidence: z.number().min(0).max(1).default(0.8),

  /** Store path override (relative to project root, or absolute) */
  storePath: z.string().optional(),
});

export type GnosysConfig = z.infer<typeof GnosysConfigSchema>;

// ─── Defaults ────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG: GnosysConfig = GnosysConfigSchema.parse({});

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Resolve the effective LLM provider and model for a given task.
 * Priority: taskModels override > llm config > legacy fields > defaults.
 */
export function resolveTaskModel(
  config: GnosysConfig,
  task: "structuring" | "synthesis"
): { provider: LLMProviderName; model: string } {
  // 1. Task-specific override
  const taskOverride = config.taskModels?.[task];
  if (taskOverride) {
    return { provider: taskOverride.provider, model: taskOverride.model };
  }

  // 2. Default provider from llm config
  const provider = config.llm.defaultProvider;

  // 3. Model from provider-specific config
  const model = getProviderModel(config, provider);

  return { provider, model };
}

/**
 * Get the configured model for a specific provider.
 */
export function getProviderModel(config: GnosysConfig, provider: LLMProviderName): string {
  switch (provider) {
    case "anthropic": return config.llm.anthropic.model;
    case "ollama": return config.llm.ollama.model;
    case "groq": return config.llm.groq.model;
    case "openai": return config.llm.openai.model;
    case "lmstudio": return config.llm.lmstudio.model;
    default: return config.llm.anthropic.model;
  }
}

/**
 * Get the Groq API key, checking config first then env var.
 */
export function getGroqApiKey(config: GnosysConfig): string | undefined {
  return config.llm.groq.apiKey || process.env.GROQ_API_KEY;
}

/**
 * Get the OpenAI API key, checking config first then env var.
 */
export function getOpenAIApiKey(config: GnosysConfig): string | undefined {
  return config.llm.openai.apiKey || process.env.OPENAI_API_KEY;
}

/**
 * Get the OpenAI base URL from config.
 */
export function getOpenAIBaseUrl(config: GnosysConfig): string {
  return config.llm.openai.baseUrl;
}

/**
 * Get the LM Studio base URL from config.
 */
export function getLMStudioBaseUrl(config: GnosysConfig): string {
  return config.llm.lmstudio.baseUrl;
}

/**
 * Get the Anthropic API key, checking config first then env var.
 */
export function getAnthropicApiKey(config: GnosysConfig): string | undefined {
  return config.llm.anthropic.apiKey || process.env.ANTHROPIC_API_KEY;
}

/**
 * Get the Ollama base URL from config.
 */
export function getOllamaBaseUrl(config: GnosysConfig): string {
  return config.llm.ollama.baseUrl;
}

// ─── Migration ───────────────────────────────────────────────────────────

/**
 * Migrate legacy config fields to the new llm structure.
 * Called during loading to ensure backward compatibility.
 */
function migrateConfig(raw: Record<string, unknown>): Record<string, unknown> {
  const migrated = { ...raw };

  // Migrate legacy defaultLLMProvider → llm.defaultProvider
  if (migrated.defaultLLMProvider && !migrated.llm) {
    const provider = migrated.defaultLLMProvider as string;
    if (provider === "anthropic" || provider === "ollama") {
      migrated.llm = {
        defaultProvider: provider,
        ...(typeof migrated.llm === "object" && migrated.llm !== null ? migrated.llm : {}),
      };
    }
  }

  // Migrate legacy defaultModel → provider-specific model
  if (migrated.defaultModel && !migrated.llm) {
    migrated.llm = { anthropic: { model: migrated.defaultModel } };
  } else if (migrated.defaultModel && typeof migrated.llm === "object" && migrated.llm !== null) {
    const llm = migrated.llm as Record<string, unknown>;
    if (!llm.anthropic) {
      llm.anthropic = { model: migrated.defaultModel };
    }
  }

  return migrated;
}

// ─── Loader ──────────────────────────────────────────────────────────────

/**
 * Load gnosys.json from a .gnosys directory.
 * Returns defaults if no config file exists.
 * Throws on invalid config with descriptive error messages.
 */
export async function loadConfig(storePath: string): Promise<GnosysConfig> {
  const configPath = path.join(storePath, "gnosys.json");

  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw);
    const migrated = migrateConfig(parsed);
    return GnosysConfigSchema.parse(migrated);
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      // No config file — use defaults
      return DEFAULT_CONFIG;
    }

    if (err instanceof SyntaxError) {
      throw new Error(
        `Invalid JSON in ${configPath}: ${err.message}`
      );
    }

    if (err instanceof z.ZodError) {
      const issues = err.issues
        .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
        .join("\n");
      throw new Error(
        `Invalid gnosys.json at ${configPath}:\n${issues}`
      );
    }

    throw err;
  }
}

/**
 * Write a gnosys.json config file to a .gnosys directory.
 */
export async function writeConfig(
  storePath: string,
  config: Partial<GnosysConfig>
): Promise<void> {
  const configPath = path.join(storePath, "gnosys.json");
  const merged = GnosysConfigSchema.parse(config);
  await fs.writeFile(configPath, JSON.stringify(merged, null, 2) + "\n", "utf-8");
}

/**
 * Update specific fields in gnosys.json without overwriting the whole file.
 */
export async function updateConfig(
  storePath: string,
  updates: Record<string, unknown>
): Promise<GnosysConfig> {
  const existing = await loadConfig(storePath);
  const merged = { ...existing, ...updates };
  const validated = GnosysConfigSchema.parse(merged);
  const configPath = path.join(storePath, "gnosys.json");
  await fs.writeFile(configPath, JSON.stringify(validated, null, 2) + "\n", "utf-8");
  return validated;
}

/**
 * Generate a default gnosys.json with the new llm config structure.
 */
export function generateConfigTemplate(): string {
  return JSON.stringify(
    {
      llm: {
        defaultProvider: "anthropic",
        anthropic: { model: "claude-sonnet-4-20250514" },
        ollama: { model: "llama3.2", baseUrl: "http://localhost:11434" },
        groq: { model: "llama-3.3-70b-versatile" },
        openai: { model: "gpt-4o-mini", baseUrl: "https://api.openai.com/v1" },
        lmstudio: { model: "default", baseUrl: "http://localhost:1234/v1" },
      },
      taskModels: {},
      bulkIngestionBatchSize: 500,
      importConcurrency: 5,
      autoCommit: true,
      llmRetryAttempts: 3,
      llmRetryBaseDelayMs: 1000,
      defaultAuthor: "ai",
      defaultAuthority: "imported",
      defaultConfidence: 0.8,
    },
    null,
    2
  );
}

/**
 * All supported provider names.
 */
export const ALL_PROVIDERS: LLMProviderName[] = ["anthropic", "ollama", "groq", "openai", "lmstudio"];

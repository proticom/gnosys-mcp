/**
 * Gnosys Configuration — Loads and validates gnosys.json config files.
 * Uses Zod for schema validation with sensible defaults.
 */

import { z } from "zod";
import fs from "fs/promises";
import path from "path";

// ─── LLM Provider Schemas ───────────────────────────────────────────────

const LLMProviderEnum = z.enum(["anthropic", "ollama", "groq", "openai", "lmstudio", "xai", "mistral", "custom"]);
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

const XAIConfigSchema = z.object({
  model: z.string().default("grok-2"),
  apiKey: z.string().optional(),
});

const MistralConfigSchema = z.object({
  model: z.string().default("mistral-large-latest"),
  apiKey: z.string().optional(),
});

const CustomConfigSchema = z.object({
  model: z.string(),
  baseUrl: z.string(),
  apiKey: z.string().optional(),
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
  xai: XAIConfigSchema.default({ model: "grok-2" }),
  mistral: MistralConfigSchema.default({ model: "mistral-large-latest" }),
  custom: CustomConfigSchema.optional(),
});

const TaskModelsSchema = z.object({
  structuring: TaskModelSchema.optional(),
  synthesis: TaskModelSchema.optional(),
});

// ─── Archive Schema ─────────────────────────────────────────────────────

const ArchiveConfigSchema = z.object({
  /** Days since last reinforcement before a memory becomes archive-eligible */
  maxActiveDays: z.number().int().min(1).default(90),
  /** Minimum confidence threshold — below this, eligible for archive */
  minConfidence: z.number().min(0).max(1).default(0.3),
});

// ─── Dream Schema ──────────────────────────────────────────────────────

const DreamConfigSchema = z.object({
  /** Enable dream mode (default: false — must be explicitly enabled) */
  enabled: z.boolean().default(false),
  /** Idle time in minutes before triggering dream cycle */
  idleMinutes: z.number().int().min(1).default(10),
  /** Max runtime in minutes for a single dream cycle */
  maxRuntimeMinutes: z.number().int().min(1).max(120).default(30),
  /** LLM provider to use for dream operations */
  provider: LLMProviderEnum.default("ollama"),
  /** LLM model override for dream (leave empty to use provider default) */
  model: z.string().optional(),
  /** Enable self-critique scoring (never deletes, only suggests) */
  selfCritique: z.boolean().default(true),
  /** Enable category summary generation */
  generateSummaries: z.boolean().default(true),
  /** Enable relationship discovery between memories */
  discoverRelationships: z.boolean().default(true),
  /** Min memory count before dream mode activates */
  minMemories: z.number().int().min(1).default(10),
});

export type DreamConfig = z.infer<typeof DreamConfigSchema>;

// ─── Recall Schema ─────────────────────────────────────────────────────

const RecallConfigSchema = z.object({
  /** When true, inject memories even at medium relevance (boosts recall for long sessions) */
  aggressive: z.boolean().default(true),
  /** Max memories to inject per turn */
  maxMemories: z.number().int().min(1).max(20).default(8),
  /** Minimum relevance score (0-1). Lower = more memories returned. Aggressive mode uses this as a soft floor. */
  minRelevance: z.number().min(0).max(1).default(0.4),
});

export type RecallConfig = z.infer<typeof RecallConfigSchema>;

// ─── Web Knowledge Base Schema ──────────────────────────────────────────

const WebConfigSchema = z.object({
  /** Source type for web knowledge base ingestion */
  source: z.enum(["sitemap", "directory", "urls"]).default("sitemap"),
  /** Sitemap URL for sitemap source */
  sitemapUrl: z.string().optional(),
  /** Content directory for directory source */
  contentDir: z.string().optional(),
  /** URL list for urls source */
  urls: z.array(z.string()).optional(),
  /** Output directory for knowledge files */
  outputDir: z.string().default("./knowledge"),
  /** URL path patterns to exclude from ingestion */
  exclude: z.array(z.string()).default(["/api", "/admin", "/_next"]),
  /** URL glob → category name mapping */
  categories: z.record(z.string(), z.string()).default({
    "/blog/*": "blog",
    "/services/*": "services",
    "/products/*": "products",
  }),
  /** Use LLM for enriched frontmatter generation */
  llmEnrich: z.boolean().default(true),
  /** Remove knowledge files for pages no longer in source */
  prune: z.boolean().default(false),
  /** Max parallel ingestion requests */
  concurrency: z.number().min(1).max(10).default(3),
  /** Delay in ms between crawl requests (skip for localhost) */
  crawlDelayMs: z.number().min(0).default(200),
});

export type WebConfig = z.infer<typeof WebConfigSchema>;

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
    xai: { model: "grok-2" },
    mistral: { model: "mistral-large-latest" },
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

  /** Two-tier memory archive settings */
  archive: ArchiveConfigSchema.default({ maxActiveDays: 90, minConfidence: 0.3 }),

  /** Recall — automatic memory injection on every turn */
  recall: RecallConfigSchema.default({
    aggressive: true,
    maxMemories: 8,
    minRelevance: 0.4,
  }),

  /** Dream Mode — sleep-time consolidation (off by default) */
  dream: DreamConfigSchema.default({
    enabled: false,
    idleMinutes: 10,
    maxRuntimeMinutes: 30,
    provider: "ollama",
    selfCritique: true,
    generateSummaries: true,
    discoverRelationships: true,
    minMemories: 10,
  }),

  /** Web Knowledge Base — read-only, file-based mode for serverless chatbots */
  web: WebConfigSchema.optional(),
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

  // 3. For structuring tasks, prefer a cheaper model when using Anthropic
  //    (Sonnet is expensive for bulk structuring — Haiku is 10x cheaper)
  if (task === "structuring" && provider === "anthropic") {
    return { provider, model: "claude-haiku-3.5" };
  }

  // 4. Model from provider-specific config
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
    case "xai": return config.llm.xai.model;
    case "mistral": return config.llm.mistral.model;
    case "custom": return config.llm.custom?.model || "";
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

/**
 * Get the xAI API key, checking config first then env var.
 */
export function getXAIApiKey(config: GnosysConfig): string | undefined {
  return config.llm.xai.apiKey || process.env.XAI_API_KEY;
}

/**
 * Get the Mistral API key, checking config first then env var.
 */
export function getMistralApiKey(config: GnosysConfig): string | undefined {
  return config.llm.mistral.apiKey || process.env.MISTRAL_API_KEY;
}

/**
 * Get the Custom provider API key, checking config first then env var.
 */
export function getCustomApiKey(config: GnosysConfig): string | undefined {
  return config.llm.custom?.apiKey || process.env.GNOSYS_LLM_API_KEY;
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
        xai: { model: "grok-2" },
        mistral: { model: "mistral-large-latest" },
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
      archive: {
        maxActiveDays: 90,
        minConfidence: 0.3,
      },
      recall: {
        aggressive: true,
        maxMemories: 8,
        minRelevance: 0.4,
      },
      dream: {
        enabled: false,
        idleMinutes: 10,
        maxRuntimeMinutes: 30,
        provider: "ollama",
        selfCritique: true,
        generateSummaries: true,
        discoverRelationships: true,
        minMemories: 10,
      },
    },
    null,
    2
  );
}

/**
 * All supported provider names.
 */
export const ALL_PROVIDERS: LLMProviderName[] = ["anthropic", "ollama", "groq", "openai", "lmstudio", "xai", "mistral", "custom"];

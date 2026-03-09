/**
 * Gnosys Configuration — Loads and validates gnosys.json config files.
 * Uses Zod for schema validation with sensible defaults.
 */

import { z } from "zod";
import fs from "fs/promises";
import path from "path";

// ─── Schema ──────────────────────────────────────────────────────────────

export const GnosysConfigSchema = z.object({
  /** LLM provider for smart ingestion: anthropic, ollama, openai, groq */
  defaultLLMProvider: z
    .enum(["anthropic", "ollama", "openai", "groq"])
    .default("anthropic"),

  /** Model name to use for ingestion */
  defaultModel: z.string().default("claude-haiku-4-5-20251001"),

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
    return GnosysConfigSchema.parse(parsed);
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
 * Generate a default gnosys.json with comments (as a documented template).
 */
export function generateConfigTemplate(): string {
  return JSON.stringify(
    {
      defaultLLMProvider: "anthropic",
      defaultModel: "claude-haiku-4-5-20251001",
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

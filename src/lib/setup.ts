/**
 * Gnosys Interactive Setup Wizard.
 *
 * Guides users through provider selection, model tier, API key storage,
 * task model configuration, and IDE integration.
 * Web knowledge base is set up separately via: gnosys web init
 *
 * Uses Node.js built-in readline/promises — no external dependencies.
 */

import { createInterface, Interface as ReadlineInterface } from "readline/promises";
import { stdin, stdout } from "process";
import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import {
  loadConfig,
  updateConfig,
  resolveTaskModel,
  getProviderModel,
  ALL_PROVIDERS,
  type GnosysConfig,
  type LLMProviderName,
} from "./config.js";

// ─── ANSI Colors ────────────────────────────────────────────────────────────

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";
const CHECK = `${GREEN}\u2713${RESET}`;
const WARN = `${YELLOW}\u26A0${RESET}`;
const CROSS = `${RED}\u2717${RESET}`;

// ─── Version (read from package.json at runtime) ───────────────────────────

function getVersion(): string {
  try {
    const pkgPath = path.resolve(
      new URL(".", import.meta.url).pathname,
      "../../package.json"
    );
    const pkg = JSON.parse(fsSync.readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ModelTier {
  name: string;
  model: string;
  input: number;   // cost per million input tokens
  output: number;  // cost per million output tokens
  recommended: boolean;
}

/** Per-task routing override chosen during setup. */
export interface TaskRouting {
  provider: string;
  model: string;
}

export interface SetupResult {
  provider: string;
  model: string;
  structuringModel: string;
  apiKeyWritten: boolean;
  ides: string[];
  mode: "agent";
  upgraded: boolean;
  /** Task-specific overrides chosen during setup (undefined = use defaults). */
  taskOverrides?: {
    structuring?: TaskRouting;
    synthesis?: TaskRouting;
    vision?: TaskRouting;
    transcription?: TaskRouting;
    dream?: TaskRouting;
  };
  dreamEnabled?: boolean;
}

// ─── Provider Tiers ─────────────────────────────────────────────────────────

export const PROVIDER_TIERS: Record<string, ModelTier[]> = {
  anthropic: [
    { name: "Budget", model: "claude-haiku-4-5", input: 0.80, output: 4.00, recommended: false },
    { name: "Balanced", model: "claude-sonnet-4-6", input: 3.00, output: 15.00, recommended: true },
    { name: "Premium", model: "claude-opus-4-6", input: 5.00, output: 25.00, recommended: false },
  ],
  openai: [
    { name: "Nano", model: "gpt-5.4-nano", input: 0.20, output: 1.25, recommended: false },
    { name: "Mini", model: "gpt-5.4-mini", input: 0.75, output: 4.50, recommended: true },
    { name: "Standard", model: "gpt-5.4", input: 2.50, output: 15.00, recommended: false },
  ],
  groq: [
    { name: "Small (8B)", model: "llama-3.1-8b-instant", input: 0.05, output: 0.08, recommended: false },
    { name: "Large (70B)", model: "llama-3.3-70b-versatile", input: 0.59, output: 0.79, recommended: true },
  ],
  xai: [
    { name: "Mini", model: "grok-3-mini", input: 0.10, output: 0.40, recommended: false },
    { name: "Standard", model: "grok-4.0", input: 0.40, output: 1.60, recommended: false },
    { name: "Flagship", model: "grok-4.20", input: 0.80, output: 3.20, recommended: true },
  ],
  mistral: [
    { name: "Tiny", model: "mistral-tiny", input: 0.05, output: 0.05, recommended: false },
    { name: "Small", model: "mistral-small-4", input: 0.20, output: 0.80, recommended: true },
    { name: "Large", model: "mistral-large-latest", input: 2.00, output: 8.00, recommended: false },
  ],
  ollama: [
    { name: "Llama 3.2 (default)", model: "llama3.2", input: 0, output: 0, recommended: true },
    { name: "Mistral", model: "mistral", input: 0, output: 0, recommended: false },
    { name: "Gemma 2", model: "gemma2", input: 0, output: 0, recommended: false },
  ],
  lmstudio: [
    { name: "Default", model: "default", input: 0, output: 0, recommended: true },
  ],
  custom: [],
};

// ─── Dynamic Model Fetching (OpenRouter) ─────────────────────────────────────

const OPENROUTER_API = "https://openrouter.ai/api/v1/models";
const CACHE_FILE = path.join(os.homedir(), ".config", "gnosys", "models-cache.json");
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Map OpenRouter provider prefixes to our provider names
const OPENROUTER_PREFIX_MAP: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  "x-ai": "xai",
  mistralai: "mistral",
  google: "google",
  // groq/ollama/lmstudio skipped — local or have their own APIs
};

interface OpenRouterModel {
  id: string;
  name?: string;
  pricing?: { prompt?: string; completion?: string };
  context_length?: number;
  created?: number;
}

/**
 * Fetch models from OpenRouter, cache for 24 hours, fall back to hardcoded.
 * Returns updated PROVIDER_TIERS for cloud providers only.
 */
export async function fetchDynamicModels(): Promise<Record<string, ModelTier[]>> {
  // Check cache first
  try {
    const stat = await fs.stat(CACHE_FILE);
    if (Date.now() - stat.mtimeMs < CACHE_TTL_MS) {
      const cached = JSON.parse(await fs.readFile(CACHE_FILE, "utf-8"));
      if (cached && typeof cached === "object") return cached;
    }
  } catch {
    // No cache or expired
  }

  // Fetch from OpenRouter
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const resp = await fetch(OPENROUTER_API, { signal: controller.signal });
    clearTimeout(timeout);

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = (await resp.json()) as { data: OpenRouterModel[] };

    const result: Record<string, ModelTier[]> = {};

    for (const [prefix, ourProvider] of Object.entries(OPENROUTER_PREFIX_MAP)) {
      const models = data.data
        .filter((m) => m.id.startsWith(prefix + "/"))
        .map((m) => {
          const modelId = m.id.slice(prefix.length + 1);
          const input = parseFloat(m.pricing?.prompt ?? "0") * 1e6;
          const output = parseFloat(m.pricing?.completion ?? "0") * 1e6;
          const isPreview = /preview|beta/i.test(modelId);
          const isVariant = modelId.includes(":") && !modelId.includes(":thinking");
          const isFree = modelId.includes(":free");
          const isGuard = /guard|embed/i.test(modelId);
          return {
            modelId, name: m.name ?? modelId, input, output,
            ctx: m.context_length ?? 0, created: m.created ?? 0,
            isPreview, isVariant, isFree, isGuard,
          };
        })
        .filter((m) => m.input > 0 && !m.isFree && !m.isVariant && !m.isGuard)
        .filter((m) => !/audio|search|embed|tts|vision|image|code-/i.test(m.modelId)) // skip specialized models
        .sort((a, b) => b.created - a.created); // newest first

      if (models.length === 0) continue;

      // Group into 3 price tiers by input cost
      const BUDGET_MAX = 1.5;    // <= $1.50/M input
      const BALANCED_MAX = 6.0;  // $1.50-$6/M input
      // > $6 = premium

      // Only consider models from the last 18 months to avoid ancient models
      const cutoff = Date.now() / 1000 - 18 * 30 * 24 * 60 * 60;
      const recent = models.filter((m) => m.created > cutoff);
      const pool = recent.length >= 3 ? recent : models; // fallback if too few recent

      // Known model family overrides — some providers have model families
      // where the "premium" model isn't the most expensive (e.g. opus-4.6 is $5
      // while opus-4.1 is $15, but 4.6 is the better model)
      const FAMILY_TIER: Record<string, Record<string, "budget" | "balanced" | "premium">> = {
        anthropic: { haiku: "budget", sonnet: "balanced", opus: "premium" },
      };
      const familyMap = FAMILY_TIER[ourProvider];

      let budget: typeof pool;
      let balanced: typeof pool;
      let premium: typeof pool;

      if (familyMap) {
        // Use family-based tiering: pick newest from each family
        budget = []; balanced = []; premium = [];
        const seen = new Set<string>();
        for (const m of pool) {
          for (const [family, tier] of Object.entries(familyMap)) {
            if (m.modelId.includes(family) && !seen.has(family)) {
              seen.add(family);
              if (tier === "budget") budget.push(m);
              else if (tier === "balanced") balanced.push(m);
              else premium.push(m);
              break;
            }
          }
        }
      } else {
        // Price-based tiering for other providers
        budget = pool.filter((m) => m.input <= BUDGET_MAX);
        balanced = pool.filter((m) => m.input > BUDGET_MAX && m.input <= BALANCED_MAX);
        premium = pool.filter((m) => m.input > BALANCED_MAX);
      }

      // For each tier: pick newest stable + newest preview (if different)
      function pickFromTier(
        tierModels: typeof models,
        label: string,
        isRec: boolean,
      ): ModelTier[] {
        if (tierModels.length === 0) return [];
        const stable = tierModels.find((m) => !m.isPreview);
        const preview = tierModels.find((m) => m.isPreview);
        const picks: ModelTier[] = [];

        if (stable) {
          picks.push({
            name: label,
            model: stable.modelId,
            input: Math.round(stable.input * 100) / 100,
            output: Math.round(stable.output * 100) / 100,
            recommended: isRec && !preview, // recommend stable if no preview
          });
        }
        if (preview && (!stable || preview.modelId !== stable.modelId)) {
          picks.push({
            name: `${label} (preview)`,
            model: preview.modelId,
            input: Math.round(preview.input * 100) / 100,
            output: Math.round(preview.output * 100) / 100,
            recommended: isRec && !!stable, // recommend preview when both exist
          });
        }
        // If only preview exists in tier, mark it recommended if this is the rec tier
        if (!stable && preview && isRec) {
          picks[0].recommended = true;
        }
        return picks;
      }

      const tiers: ModelTier[] = [
        ...pickFromTier(budget, "Budget", false),
        ...pickFromTier(balanced, "Balanced", true),
        ...pickFromTier(premium, "Premium", false),
      ];

      // If no balanced tier, recommend the cheapest available
      if (!tiers.some((t) => t.recommended) && tiers.length > 0) {
        tiers[0].recommended = true;
      }

      result[ourProvider] = tiers;
    }

    // Cache the result
    try {
      await fs.mkdir(path.dirname(CACHE_FILE), { recursive: true });
      await fs.writeFile(CACHE_FILE, JSON.stringify(result, null, 2), "utf-8");
    } catch {
      // Non-critical
    }

    return result;
  } catch {
    // Offline or error — return empty (caller falls back to hardcoded)
    return {};
  }
}

/**
 * Get model tiers for a provider — tries dynamic first, falls back to hardcoded.
 */
export async function getModelTiers(provider: string): Promise<ModelTier[]> {
  const dynamic = await fetchDynamicModels();
  if (dynamic[provider] && dynamic[provider].length > 0) {
    return dynamic[provider];
  }
  return PROVIDER_TIERS[provider] ?? [];
}

// ─── Provider display names and env var mapping ─────────────────────────────

const PROVIDER_DISPLAY: Record<string, string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI (GPT-5.4)",
  ollama: "Ollama (local, free)",
  groq: "Groq (fast, cheap)",
  xai: "xAI (Grok)",
  mistral: "Mistral",
  lmstudio: "LM Studio (local, free)",
  custom: "Custom (any OpenAI-compatible API)",
};

const PROVIDER_ENV_VAR: Record<string, string> = {
  anthropic: "GNOSYS_ANTHROPIC_KEY",
  openai: "GNOSYS_OPENAI_KEY",
  groq: "GNOSYS_GROQ_KEY",
  xai: "GNOSYS_XAI_KEY",
  mistral: "GNOSYS_MISTRAL_KEY",
  custom: "GNOSYS_CUSTOM_KEY",
};

// Ordered list for the menu
const PROVIDER_ORDER = [
  "anthropic",
  "openai",
  "ollama",
  "groq",
  "xai",
  "mistral",
  "lmstudio",
  "custom",
];

// Task descriptions for display
const TASK_DESCRIPTIONS: Record<string, string> = {
  structuring: "adding memories, tagging",
  synthesis: "Q&A answers",
  vision: "images, PDFs",
  transcription: "audio files",
  dream: "overnight consolidation",
};

// ─── Exported Helpers ───────────────────────────────────────────────────────

/**
 * Returns the cheapest capable model for structuring tasks.
 * Structuring (keyword extraction, tagging) doesn't need a flagship model.
 */
export function getStructuringModel(provider: string, chosenModel: string): string {
  switch (provider) {
    case "anthropic":
      return "claude-haiku-4-5";
    case "openai":
      return "gpt-5.4-nano";
    default:
      // groq, xai, mistral, ollama, lmstudio, custom — already cheap enough
      return chosenModel;
  }
}

/**
 * Write an API key to ~/.config/gnosys/.env.
 * Creates the directory and file if they don't exist.
 * Replaces an existing key line if found, otherwise appends.
 */
export async function writeApiKey(provider: string, key: string): Promise<void> {
  const envVar = PROVIDER_ENV_VAR[provider];
  if (!envVar) return;

  const configDir = path.join(os.homedir(), ".config", "gnosys");
  await fs.mkdir(configDir, { recursive: true });

  const envPath = path.join(configDir, ".env");

  let lines: string[] = [];
  try {
    const existing = await fs.readFile(envPath, "utf-8");
    lines = existing.split("\n");
  } catch {
    // File doesn't exist yet — start fresh
  }

  // Check if this env var already exists and replace it
  let found = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith(`${envVar}=`)) {
      lines[i] = `${envVar}=${key}`;
      found = true;
      break;
    }
  }

  if (!found) {
    // Remove trailing empty lines before appending
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
      lines.pop();
    }
    lines.push(`${envVar}=${key}`);
  }

  await fs.writeFile(envPath, lines.join("\n") + "\n", "utf-8");
}

/**
 * Write an API key to the macOS Keychain.
 * Uses the -U flag to update if the entry already exists.
 * Returns true on success, false on failure.
 */
export function writeApiKeyToKeychain(envVar: string, key: string): boolean {
  if (process.platform !== "darwin") return false;
  try {
    // The -U flag updates if the password already exists
    execSync(
      `security add-generic-password -a "$USER" -s "${envVar}" -w "${key.replace(/"/g, '\\"')}" -U`,
      { stdio: "pipe" }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Write an API key using Linux secret-tool (GNOME Keyring).
 * Returns true on success, false on failure.
 */
function writeApiKeyToSecretTool(envVar: string, key: string, provider: string): boolean {
  if (process.platform === "darwin") return false;
  try {
    // Check if secret-tool is available
    execSync("which secret-tool", { stdio: "pipe" });
    // Write the key — printf avoids trailing newline issues
    execSync(
      `printf "%s" "${key.replace(/"/g, '\\"')}" | secret-tool store --label="Gnosys ${provider}" service gnosys account ${envVar}`,
      { stdio: "pipe", shell: "/bin/sh" }
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if secret-tool is available on Linux.
 */
function hasSecretTool(): boolean {
  if (process.platform === "darwin") return false;
  try {
    execSync("which secret-tool", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect where an existing API key is stored.
 * Returns description like "macOS Keychain", "env var", ".env file", or empty string.
 */
function detectKeySource(envVarName: string, legacyEnvVar: string): string {
  // Check macOS Keychain
  if (process.platform === "darwin") {
    try {
      const result = execSync(
        `security find-generic-password -a "$USER" -s "${envVarName}" -w`,
        { stdio: "pipe", encoding: "utf-8" }
      ).trim();
      if (result) return "macOS Keychain";
    } catch {
      // Not in keychain
    }
  }

  // Check environment variable (new-style)
  if (process.env[envVarName]) return `$${envVarName}`;

  // Check legacy env var
  if (legacyEnvVar && process.env[legacyEnvVar]) return `$${legacyEnvVar}`;

  // Check .env file
  try {
    const envPath = path.join(os.homedir(), ".config", "gnosys", ".env");
    const content = fsSync.readFileSync(envPath, "utf-8");
    if (content.includes(`${envVarName}=`)) return "~/.config/gnosys/.env";
  } catch {
    // No .env
  }

  return "";
}

/**
 * Detect which IDEs are available in the given project directory.
 * Returns an array like ["claude", "cursor", "codex"].
 */
export async function detectIDEs(projectDir: string): Promise<string[]> {
  const detected: string[] = [];

  // Check for Claude CLI
  try {
    execSync("which claude", { stdio: "ignore" });
    detected.push("claude");
  } catch {
    // Not installed
  }

  // Check for .cursor/ directory
  try {
    const stat = await fs.stat(path.join(projectDir, ".cursor"));
    if (stat.isDirectory()) detected.push("cursor");
  } catch {
    // Not present
  }

  // Check for .codex/ directory
  try {
    const stat = await fs.stat(path.join(projectDir, ".codex"));
    if (stat.isDirectory()) detected.push("codex");
  } catch {
    // Not present
  }

  return detected;
}

/**
 * Set up Gnosys MCP integration for a specific IDE.
 */
export async function setupIDE(
  ide: string,
  projectDir: string
): Promise<{ success: boolean; message: string }> {
  try {
    switch (ide) {
      case "claude": {
        try {
          execSync("claude mcp add -s user gnosys -- gnosys serve", {
            stdio: "pipe",
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("already exists")) {
            return { success: true, message: "Claude Code MCP server already configured" };
          }
          throw e;
        }
        return { success: true, message: "Claude Code MCP server registered" };
      }

      case "cursor": {
        const cursorDir = path.join(projectDir, ".cursor");
        const mcpPath = path.join(cursorDir, "mcp.json");
        await fs.mkdir(cursorDir, { recursive: true });

        let config: Record<string, unknown> = {};
        try {
          const existing = await fs.readFile(mcpPath, "utf-8");
          config = JSON.parse(existing);
        } catch {
          // File doesn't exist or is invalid — start fresh
        }

        // Merge gnosys entry
        const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
        servers.gnosys = { command: "gnosys", args: ["serve"] };
        config.mcpServers = servers;

        await fs.writeFile(mcpPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
        return { success: true, message: "Cursor MCP config updated (.cursor/mcp.json)" };
      }

      case "codex": {
        const codexDir = path.join(projectDir, ".codex");
        const configPath = path.join(codexDir, "config.toml");
        await fs.mkdir(codexDir, { recursive: true });

        let content = "";
        try {
          content = await fs.readFile(configPath, "utf-8");
        } catch {
          // File doesn't exist — start fresh
        }

        // Add gnosys section if not already present
        if (!content.includes("[gnosys]")) {
          if (content.length > 0 && !content.endsWith("\n")) {
            content += "\n";
          }
          content += `\n[gnosys]\ncommand = "gnosys"\nargs = ["serve"]\n`;
          await fs.writeFile(configPath, content, "utf-8");
        }
        return { success: true, message: "Codex config updated (.codex/config.toml)" };
      }

      default:
        return { success: false, message: `Unknown IDE: ${ide}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: msg };
  }
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Print a numbered list, read a choice, validate it, re-prompt on invalid input.
 * Returns the 0-based index of the chosen option.
 */
async function askChoice(
  rl: ReadlineInterface,
  question: string,
  options: string[]
): Promise<number> {
  console.log();
  if (question) console.log(question);
  console.log();
  for (let i = 0; i < options.length; i++) {
    console.log(`  ${BOLD}${i + 1}.${RESET} ${options[i]}`);
  }
  console.log();

  while (true) {
    const answer = await rl.question(`${DIM}>${RESET} `);
    const num = parseInt(answer.trim(), 10);
    if (num >= 1 && num <= options.length) {
      return num - 1;
    }
    console.log(`${RED}Please enter a number between 1 and ${options.length}.${RESET}`);
  }
}

/**
 * Read a single line of input with an optional default value.
 */
async function askInput(
  rl: ReadlineInterface,
  prompt: string,
  opts?: { default?: string }
): Promise<string> {
  const suffix = opts?.default ? ` ${DIM}(${opts.default})${RESET}` : "";
  const answer = await rl.question(`${prompt}${suffix}: `);
  const trimmed = answer.trim();
  return trimmed || opts?.default || "";
}

/**
 * Y/n prompt. Returns true for yes.
 */
async function askYesNo(
  rl: ReadlineInterface,
  question: string,
  defaultYes = true
): Promise<boolean> {
  const hint = defaultYes ? "Y/n" : "y/N";
  const answer = await rl.question(`${question} [${hint}] `);
  const trimmed = answer.trim().toLowerCase();
  if (trimmed === "") return defaultYes;
  return trimmed === "y" || trimmed === "yes";
}

/**
 * Format a price for display: "$0.80" or "free".
 */
function formatPrice(input: number, output: number): string {
  if (input === 0 && output === 0) return "free";
  return `$${input.toFixed(2)}\u2013$${output.toFixed(2)}/M tokens`;
}

/**
 * Print a bordered box with a title and key-value rows.
 * Supports rows with empty keys (spacer rows) and section headers.
 */
function printBox(title: string, rows: [string, string][]): void {
  const maxKeyLen = Math.max(...rows.map(([k]) => k.length));
  const maxValLen = Math.max(...rows.map(([, v]) => v.length));
  const contentWidth = Math.max(title.length, maxKeyLen + maxValLen + 2);
  const innerWidth = contentWidth + 4; // 2 padding each side
  const border = "\u2500".repeat(innerWidth);

  console.log();
  console.log(`\u250C${border}\u2510`);
  console.log(`\u2502  ${BOLD}${title}${RESET}${" ".repeat(innerWidth - title.length - 2)}\u2502`);
  console.log(`\u251C${border}\u2524`);
  for (const [key, val] of rows) {
    if (key === "" && val === "") {
      // Spacer row
      console.log(`\u2502${" ".repeat(innerWidth)}\u2502`);
    } else {
      const line = `${key.padEnd(maxKeyLen)}  ${val}`;
      console.log(`\u2502  ${line}${" ".repeat(innerWidth - line.length - 2)}\u2502`);
    }
  }
  console.log(`\u2514${border}\u2518`);
  console.log();
}

/**
 * Mask a key: show first 7 chars, replace the rest with dots.
 */
function maskKey(key: string): string {
  if (key.length <= 7) return key;
  return key.slice(0, 7) + "\u2026" + "*".repeat(Math.min(key.length - 7, 12));
}

/**
 * Read the central projects.json or DB to find registered projects.
 */
async function getRegisteredProjects(): Promise<Array<{ name: string; directory: string; id: string }>> {
  const projects: Array<{ name: string; directory: string; id: string }> = [];

  // Try central DB via dynamic import
  try {
    const { GnosysDB } = await import("./db.js");
    const db = GnosysDB.openCentral();
    const all = db.getAllProjects();
    for (const p of all) {
      projects.push({
        name: p.name,
        directory: p.working_directory,
        id: p.id,
      });
    }
    db.close();
  } catch {
    // Central DB not available or module not built yet — that's okay
  }

  return projects;
}

/**
 * Try to load existing gnosys.json config for displaying current values.
 * Checks the project .gnosys dir first, then the global ~/.gnosys dir.
 * Returns null if no config found.
 */
async function loadExistingConfig(projectDir: string): Promise<GnosysConfig | null> {
  // Try project-level config first
  try {
    const projectStore = path.join(projectDir, ".gnosys");
    const stat = await fs.stat(path.join(projectStore, "gnosys.json"));
    if (stat.isFile()) {
      return await loadConfig(projectStore);
    }
  } catch {
    // No project config
  }

  // Try global config at ~/.gnosys
  try {
    const globalStore = path.join(os.homedir(), ".gnosys");
    const stat = await fs.stat(path.join(globalStore, "gnosys.json"));
    if (stat.isFile()) {
      return await loadConfig(globalStore);
    }
  } catch {
    // No global config
  }

  return null;
}

/**
 * Let the user pick a provider from the list.
 * Returns the provider name or "skip".
 * If currentProvider is given, shows it as the current value.
 */
async function pickProvider(
  rl: ReadlineInterface,
  dynamicModels: Record<string, ModelTier[]>,
  stepLabel: string,
  currentProvider?: string,
): Promise<string> {
  const currentHint = currentProvider ? ` ${DIM}(current: ${currentProvider})${RESET}` : "";
  const providerOptions = PROVIDER_ORDER.map((key) => {
    const tiers = dynamicModels[key] ?? PROVIDER_TIERS[key];
    const display = PROVIDER_DISPLAY[key];
    if (!tiers || tiers.length === 0) return display;
    const minIn = Math.min(...tiers.map((t) => t.input));
    const maxOut = Math.max(...tiers.map((t) => t.output));
    if (minIn === 0 && maxOut === 0) return display;
    return `${display}      ${DIM}$${minIn.toFixed(2)}\u2013$${maxOut.toFixed(2)}/M tokens${RESET}`;
  });

  const choiceIdx = await askChoice(
    rl,
    `${stepLabel}${currentHint}`,
    providerOptions
  );

  return PROVIDER_ORDER[choiceIdx];
}

/**
 * Let the user pick a model from a provider's tiers.
 * Returns the model string.
 */
async function pickModel(
  rl: ReadlineInterface,
  provider: string,
  dynamicModels: Record<string, ModelTier[]>,
  stepLabel: string,
  currentModel?: string,
): Promise<string> {
  const tiers = dynamicModels[provider] ?? PROVIDER_TIERS[provider];
  if (!tiers || tiers.length === 0) return "";

  const isLocal = provider === "ollama" || provider === "lmstudio";
  const currentHint = currentModel ? ` ${DIM}(current: ${currentModel})${RESET}` : "";

  const tierOptions = tiers.map((t) => {
    const rec = t.recommended ? `  ${CYAN}<- recommended${RESET}` : "";
    if (isLocal) {
      return `${t.name}${rec}`;
    }
    return `${t.name} (${t.model})  ${DIM}${formatPrice(t.input, t.output)}${RESET}${rec}`;
  });

  const tierIndex = await askChoice(
    rl,
    `${stepLabel}${currentHint}`,
    tierOptions
  );

  return tiers[tierIndex].model;
}

// ─── Main Setup Wizard ──────────────────────────────────────────────────────

export async function runSetup(opts: {
  directory?: string;
  nonInteractive?: boolean;
}): Promise<SetupResult> {
  const version = getVersion();
  const projectDir = opts.directory ? path.resolve(opts.directory) : process.cwd();

  // ─── Non-interactive mode ─────────────────────────────────────────────
  if (opts.nonInteractive) {
    const provider = "anthropic";
    const model = "claude-sonnet-4-6";
    const structuringModel = getStructuringModel(provider, model);

    console.log(`${BOLD}Gnosys v${version}${RESET} — non-interactive setup`);
    console.log(`  Provider:     ${provider}`);
    console.log(`  Model:        ${model}`);
    console.log(`  Structuring:  ${structuringModel}`);
    console.log(`  API key:      skipped`);
    console.log(`  IDE setup:    skipped`);
    console.log(`  Mode:         agent`);

    return {
      provider,
      model,
      structuringModel,
      apiKeyWritten: false,
      ides: [],
      mode: "agent",
      upgraded: false,
    };
  }

  // ─── Interactive mode ─────────────────────────────────────────────────

  const rl = createInterface({ input: stdin, output: stdout });

  let setupCompleted = false;

  // Handle Ctrl+C gracefully — only show "cancelled" if setup didn't finish
  rl.on("close", () => {
    if (!setupCompleted) {
      console.log("\n\nSetup cancelled.");
      process.exit(0);
    }
  });

  let upgraded = false;

  try {
    // ─── Banner ───────────────────────────────────────────────────────
    const tagline = "Persistent Memory for AI Agents";
    const versionStr = `Gnosys v${version}`;
    const bannerContentWidth = Math.max(versionStr.length, tagline.length);
    const bannerInner = bannerContentWidth + 4;
    const bannerBorder = "\u2500".repeat(bannerInner);
    console.log();
    console.log(`\u250C${bannerBorder}\u2510`);
    console.log(`\u2502  ${BOLD}${CYAN}Gnosys${RESET} v${version}${" ".repeat(bannerInner - versionStr.length - 2)}\u2502`);
    console.log(`\u2502  ${DIM}${tagline}${RESET}${" ".repeat(bannerInner - tagline.length - 2)}\u2502`);
    console.log(`\u2514${bannerBorder}\u2518`);
    console.log();

    // ─── Load existing config for defaults ───────────────────────────
    const existingConfig = await loadExistingConfig(projectDir);
    const currentProvider = existingConfig?.llm.defaultProvider;
    const currentModel = existingConfig
      ? getProviderModel(existingConfig, existingConfig.llm.defaultProvider)
      : undefined;

    // ─── Pre-check: Upgrade detection ─────────────────────────────────
    const centralDbPath = path.join(os.homedir(), ".gnosys", "gnosys.db");
    const centralDbExists = fsSync.existsSync(centralDbPath);

    if (centralDbExists) {
      const projects = await getRegisteredProjects();

      if (projects.length > 0) {
        const shouldUpgrade = await askYesNo(
          rl,
          `Found ${projects.length} project${projects.length === 1 ? "" : "s"}. Upgrade to v${version}?`,
          true
        );

        if (!shouldUpgrade) {
          console.log(`${DIM}  Skipped upgrade.${RESET}`);
          console.log();
        }

        if (shouldUpgrade) {
          const { createProjectIdentity } = await import("./projectIdentity.js");

          for (const project of projects) {
            // Check directory still exists on disk
            try {
              const stat = await fs.stat(project.directory);
              if (stat.isDirectory()) {
                await createProjectIdentity(project.directory, {
                  projectName: project.name,
                });
                console.log(`  ${CHECK} ${project.name} (${project.directory})`);
              } else {
                console.log(`  ${CROSS} ${project.name} — directory missing`);
              }
            } catch {
              console.log(`  ${CROSS} ${project.name} — ${project.directory} not found`);
            }
          }

          // Sync global rules
          try {
            const { syncToTarget } = await import("./rulesGen.js");
            const { GnosysDB } = await import("./db.js");
            const db = GnosysDB.openCentral();
            await syncToTarget(db, projectDir, "global", null);
            db.close();
            console.log(`  ${CHECK} Global rules synced (~/.claude/CLAUDE.md)`);
          } catch {
            console.log(`  ${WARN} Could not sync global rules`);
          }

          upgraded = true;
          console.log();
        }
      }
    }

    // ─── Pre-fetch dynamic models ─────────────────────────────────────
    console.log(`${DIM}Fetching latest model pricing...${RESET}`);
    const dynamicModels = await fetchDynamicModels();
    if (Object.keys(dynamicModels).length > 0) {
      console.log(`${DIM}${CHECK} Live pricing loaded from OpenRouter${RESET}`);
    } else {
      console.log(`${DIM}Using bundled model data (offline or fetch failed)${RESET}`);
    }
    console.log();

    // ─── Step 1/5 — Provider ──────────────────────────────────────────
    const providerOptions = PROVIDER_ORDER.map((key) => {
      const tiers = dynamicModels[key] ?? PROVIDER_TIERS[key];
      const display = PROVIDER_DISPLAY[key];
      if (!tiers || tiers.length === 0) return display;
      const minIn = Math.min(...tiers.map((t) => t.input));
      const maxOut = Math.max(...tiers.map((t) => t.output));
      if (minIn === 0 && maxOut === 0) return display;
      return `${display}      ${DIM}$${minIn.toFixed(2)}\u2013$${maxOut.toFixed(2)}/M tokens${RESET}`;
    });
    // Add "Skip" option
    providerOptions.push("Skip (core memory works without LLM)");

    const currentProviderHint = currentProvider
      ? ` ${DIM}(current: ${currentProvider})${RESET}`
      : "";

    const providerIndex = await askChoice(
      rl,
      `${BOLD}Step 1/5${RESET} ${DIM}\u2014${RESET} Choose your LLM provider${currentProviderHint}`,
      providerOptions
    );

    const isSkip = providerIndex === PROVIDER_ORDER.length; // last option
    const provider = isSkip ? "skip" : PROVIDER_ORDER[providerIndex];

    // ─── Step 2/5 — Model tier ────────────────────────────────────────
    let model = "";

    if (!isSkip && provider !== "custom") {
      const tiers = dynamicModels[provider] ?? PROVIDER_TIERS[provider];
      if (tiers.length > 0) {
        const isLocal = provider === "ollama" || provider === "lmstudio";
        const currentModelHint = (currentProvider === provider && currentModel)
          ? ` ${DIM}(current: ${currentModel})${RESET}`
          : "";

        const tierOptions = tiers.map((t) => {
          const rec = t.recommended ? `  ${CYAN}<- recommended${RESET}` : "";
          if (isLocal) {
            return `${t.name}${rec}`;
          }
          return `${t.name} (${t.model})  ${DIM}${formatPrice(t.input, t.output)}${RESET}${rec}`;
        });

        const tierIndex = await askChoice(
          rl,
          `${BOLD}Step 2/5${RESET} ${DIM}\u2014${RESET} Choose model tier${currentModelHint}`,
          tierOptions
        );
        model = tiers[tierIndex].model;
      }
    } else if (provider === "custom") {
      // Custom: ask for base URL and model name
      console.log();
      console.log(`${BOLD}Step 2/5${RESET} ${DIM}\u2014${RESET} Custom provider details`);
      console.log();
      const baseUrl = await askInput(rl, "Base URL (OpenAI-compatible)");
      model = await askInput(rl, "Model name");

      if (baseUrl) {
        // Write GNOSYS_LLM_BASE_URL to env file
        const configDir = path.join(os.homedir(), ".config", "gnosys");
        await fs.mkdir(configDir, { recursive: true });
        const envPath = path.join(configDir, ".env");

        let lines: string[] = [];
        try {
          const existing = await fs.readFile(envPath, "utf-8");
          lines = existing.split("\n");
        } catch {
          // File doesn't exist
        }

        let found = false;
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].startsWith("GNOSYS_LLM_BASE_URL=")) {
            lines[i] = `GNOSYS_LLM_BASE_URL=${baseUrl}`;
            found = true;
            break;
          }
        }
        if (!found) {
          while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
            lines.pop();
          }
          lines.push(`GNOSYS_LLM_BASE_URL=${baseUrl}`);
        }
        await fs.writeFile(envPath, lines.join("\n") + "\n", "utf-8");
      }
    } else if (isSkip) {
      // Skip step 2 entirely
      console.log();
      console.log(`${DIM}Step 2/5 \u2014 Model tier: skipped${RESET}`);
    }

    // ─── Step 3/5 — API key ───────────────────────────────────────────
    let apiKeyWritten = false;
    let apiKeySource = "";
    const needsKey =
      !isSkip &&
      provider !== "ollama" &&
      provider !== "lmstudio";

    // Determine the env var name for this provider
    const envVarName = provider === "custom" ? "GNOSYS_CUSTOM_KEY" :
      `GNOSYS_${provider.toUpperCase()}_KEY`;

    // Also check legacy env var names
    const legacyEnvVars: Record<string, string> = {
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      groq: "GROQ_API_KEY",
      xai: "XAI_API_KEY",
      mistral: "MISTRAL_API_KEY",
    };
    const legacyEnvVar = legacyEnvVars[provider] ?? "";

    if (needsKey) {
      console.log();
      console.log(`${BOLD}Step 3/5${RESET} ${DIM}\u2014${RESET} API Key`);
      console.log();

      // Check where the key currently lives
      const existingKeySource = detectKeySource(envVarName, legacyEnvVar);

      // Check if key already exists in environment
      const existingKey = process.env[envVarName] || (legacyEnvVar ? process.env[legacyEnvVar] : "");
      if (existingKey || existingKeySource) {
        const source = existingKeySource || "env";
        console.log(`  ${CHECK} Found existing key (${source})`);
        if (existingKey) {
          console.log(`  ${DIM}  ${maskKey(existingKey)}${RESET}`);
        }
        apiKeyWritten = true;
        apiKeySource = existingKeySource || "env";

        // Offer to change it
        const changeKey = await askYesNo(rl, "  Change key storage?", false);
        if (!changeKey) {
          // Keep existing — skip the rest of step 3
        } else {
          // Fall through to key storage options below
          apiKeyWritten = false;
          apiKeySource = "";
        }
      }

      if (!apiKeyWritten) {
        console.log(`  Provider: ${GREEN}${provider}${RESET}`);
        console.log(`  Env var:  ${GREEN}${envVarName}${RESET}`);
        console.log();

        const isMac = process.platform === "darwin";
        const isLinux = process.platform === "linux";
        const hasSecret = isLinux && hasSecretTool();
        const shell = path.basename(process.env.SHELL ?? "zsh");
        const profileFile = shell === "bash" ? "~/.bash_profile" : "~/.zshrc";

        const options: string[] = [];
        if (isMac) {
          options.push(
            `Store in macOS Keychain (recommended \u2014 most secure, no plaintext on disk)`,
          );
        }
        if (hasSecret) {
          options.push(
            `Store in GNOME Keyring (recommended \u2014 encrypted, no plaintext on disk)`,
          );
        }
        options.push(
          `Set via environment variable (${profileFile})`,
          `Save to ~/.config/gnosys/.env (\u26a0 plaintext on disk \u2014 least secure)`,
          `Skip (configure later)`,
        );

        const keyChoice = await askChoice(rl, "", options);

        // Build the index map based on which options are present
        let idx = 0;
        const keychainIdx = isMac ? idx++ : -1;
        const gnomeIdx = hasSecret ? idx++ : -1;
        const envIdx = idx++;
        const dotenvIdx = idx++;
        const skipIdx = idx++;
        // skipIdx is unused as a variable but documents the last index

        if (keyChoice === keychainIdx) {
          // macOS Keychain — reuse existing key if available, otherwise ask
          console.log();
          const key = existingKey || await askInput(rl, `Enter your ${provider} API key`);
          if (key) {
            const success = writeApiKeyToKeychain(envVarName, key);
            if (success) {
              console.log(`  ${CHECK} Key ${existingKey ? "moved" : "saved"} to macOS Keychain (${maskKey(key)})`);
              apiKeyWritten = true;
              apiKeySource = "macOS Keychain";
            } else {
              console.log(`  ${CROSS} Failed to write to Keychain. Falling back to .env file.`);
              await writeApiKey(provider, key);
              console.log(`  ${CHECK} Key saved to ~/.config/gnosys/.env (${maskKey(key)})`);
              apiKeyWritten = true;
              apiKeySource = "~/.config/gnosys/.env";
            }
          }
        } else if (keyChoice === gnomeIdx) {
          // Linux GNOME Keyring — reuse existing key if available, otherwise ask
          console.log();
          const key = existingKey || await askInput(rl, `Enter your ${provider} API key`);
          if (key) {
            const success = writeApiKeyToSecretTool(envVarName, key, provider);
            if (success) {
              console.log(`  ${CHECK} Key ${existingKey ? "moved" : "saved"} to GNOME Keyring (${maskKey(key)})`);
              apiKeyWritten = true;
              apiKeySource = "GNOME Keyring";
            } else {
              console.log(`  ${CROSS} Failed to write to GNOME Keyring. Falling back to .env file.`);
              await writeApiKey(provider, key);
              console.log(`  ${CHECK} Key saved to ~/.config/gnosys/.env (${maskKey(key)})`);
              apiKeyWritten = true;
              apiKeySource = "~/.config/gnosys/.env";
            }
          }
        } else if (keyChoice === envIdx) {
          // Environment variable
          console.log();
          console.log(`  Run this in a ${BOLD}separate terminal${RESET}:`);
          console.log();
          console.log(`  ${GREEN}echo 'export ${envVarName}=your-key-here' >> ${profileFile} && source ${profileFile}${RESET}`);
          console.log();
          console.log(`  ${DIM}Replace "your-key-here" with your actual API key.${RESET}`);
          console.log(`  ${DIM}The key is stored in your shell profile (${profileFile}).${RESET}`);
          console.log();
          await askInput(rl, "Press Enter after setting the key...", { default: "" });

          // Verify
          console.log(`  ${DIM}Key will be available in new terminal sessions.${RESET}`);
          apiKeyWritten = true;
          apiKeySource = "shell profile";
        } else if (keyChoice === dotenvIdx) {
          // .env file (least secure)
          console.log();
          console.log(`  ${WARN} ${BOLD}Security warning:${RESET} This stores your key as plaintext in`);
          console.log(`  ~/.config/gnosys/.env. Anyone with access to your user account`);
          console.log(`  can read it. If this directory syncs to a cloud service (iCloud,`);
          console.log(`  Dropbox), the key will be uploaded in plaintext.`);
          console.log();

          const confirm = await askYesNo(rl, "Continue with plaintext storage?", false);
          if (confirm) {
            const key = await askInput(rl, `Enter your API key`);
            if (key) {
              await writeApiKey(provider, key);
              console.log(`  ${CHECK} Key saved to ~/.config/gnosys/.env (${maskKey(key)})`);
              apiKeyWritten = true;
              apiKeySource = "~/.config/gnosys/.env";
            }
          } else {
            console.log(`  ${DIM}Skipped. Choose a different method next time.${RESET}`);
          }
        } else {
          // Skip
          console.log(`  ${DIM}Skipped. Set your key later using one of these methods:`);
          if (isMac) {
            console.log(`  \u2022 macOS Keychain: security add-generic-password -a "$USER" -s "${envVarName}" -w "key" -U`);
          }
          if (hasSecret) {
            console.log(`  \u2022 GNOME Keyring: printf '%s' 'key' | secret-tool store --label="Gnosys ${provider}" service gnosys account ${envVarName}`);
          }
          console.log(`  \u2022 Shell profile:  echo 'export ${envVarName}=key' >> ${profileFile}`);
          console.log(`  \u2022 Dotenv file:    echo '${envVarName}=key' >> ~/.config/gnosys/.env${RESET}`);
        }
      }
    } else {
      console.log();
      console.log(`${DIM}Step 3/5 \u2014 API key: not needed (local provider)${RESET}`);
    }

    // ─── Step 4/5 — Task Model Configuration ─────────────────────────
    const taskOverrides: SetupResult["taskOverrides"] = {};
    let dreamEnabled = existingConfig?.dream?.enabled ?? false;
    let dreamProvider: string = existingConfig?.dream?.provider ?? "ollama";
    let dreamModel = existingConfig?.dream?.model ?? "";

    if (!isSkip) {
      console.log();
      console.log(`${BOLD}Step 4/5${RESET} ${DIM}\u2014${RESET} Task Routing`);
      console.log();
      console.log(`Gnosys uses different LLM models for different tasks. Each defaults to your`);
      console.log(`chosen provider, but you can override them individually.`);
      console.log();

      // Show current routing table
      // Build effective routing for each task based on new provider + existing overrides
      type TaskName = "structuring" | "synthesis" | "vision" | "transcription";
      const tasks: TaskName[] = ["structuring", "synthesis", "vision", "transcription"];

      // Build a temporary config to see what defaults look like with the new provider
      const effectiveRouting: Record<string, { provider: string; model: string }> = {};
      for (const task of tasks) {
        if (existingConfig?.taskModels?.[task]) {
          // Use the existing override
          effectiveRouting[task] = {
            provider: existingConfig.taskModels[task]!.provider,
            model: existingConfig.taskModels[task]!.model,
          };
        } else {
          // Derive from the newly chosen default provider
          const p = provider;
          let m = model;
          if (task === "structuring") {
            m = getStructuringModel(p, model);
          }
          effectiveRouting[task] = { provider: p, model: m };
        }
      }
      // Dream routing
      effectiveRouting.dream = {
        provider: dreamProvider,
        model: dreamModel || getProviderModel(
          existingConfig ?? { llm: { defaultProvider: "ollama", ollama: { model: "llama3.2", baseUrl: "http://localhost:11434" } } } as GnosysConfig,
          dreamProvider as LLMProviderName,
        ),
      };

      // Display the table
      const taskNameWidth = 16;
      const routingWidth = 38;
      console.log(`  ${BOLD}${"Task".padEnd(taskNameWidth)}${"Current Routing".padEnd(routingWidth)}${RESET}`);
      console.log(`  ${"\u2500".repeat(taskNameWidth + routingWidth)}`);
      for (const task of [...tasks, "dream" as const]) {
        const r = effectiveRouting[task];
        const desc = TASK_DESCRIPTIONS[task] ?? "";
        const routingStr = `${r.provider} / ${r.model}`;
        const status = task === "dream" && !dreamEnabled ? `${DIM}(disabled)${RESET}` : `${DIM}(${desc})${RESET}`;
        console.log(`  ${task.padEnd(taskNameWidth)}${routingStr.padEnd(routingWidth)}${status}`);
      }
      console.log();

      const taskChoice = await askChoice(
        rl,
        "",
        [
          `Keep defaults (use ${provider} for everything available)`,
          "Customize individual tasks",
          "Use same provider for ALL tasks (including dream)",
        ]
      );

      if (taskChoice === 1) {
        // Customize individual tasks
        console.log();
        console.log(`${DIM}For each task, pick a provider and model. Press Enter to keep the default.${RESET}`);

        for (const task of tasks) {
          console.log();
          console.log(`  ${BOLD}${task}${RESET} ${DIM}(${TASK_DESCRIPTIONS[task]})${RESET}`);
          const currentTaskRouting = effectiveRouting[task];

          const useDefault = await askYesNo(
            rl,
            `  Keep ${currentTaskRouting.provider} / ${currentTaskRouting.model}?`,
            true
          );

          if (!useDefault) {
            // Pick a provider for this task
            const taskProvider = await pickProvider(
              rl,
              dynamicModels,
              `  Provider for ${task}`,
              currentTaskRouting.provider,
            );

            // Pick a model
            let taskModel: string;
            if (taskProvider === "ollama" || taskProvider === "lmstudio") {
              taskModel = await pickModel(rl, taskProvider, dynamicModels, `  Model for ${task}`);
            } else if (taskProvider === "custom") {
              taskModel = await askInput(rl, "  Model name");
            } else {
              taskModel = await pickModel(rl, taskProvider, dynamicModels, `  Model for ${task}`);
            }

            taskOverrides[task] = { provider: taskProvider, model: taskModel };
          }
        }

        // Dream configuration
        console.log();
        console.log(`  ${BOLD}dream${RESET} ${DIM}(${TASK_DESCRIPTIONS.dream})${RESET}`);
        console.log(`  ${DIM}Dream mode runs offline consolidation — discovering relationships,`);
        console.log(`  generating summaries, and scoring memories. Defaults to Ollama (free/local).${RESET}`);

        dreamEnabled = await askYesNo(
          rl,
          `  Enable dream mode?`,
          dreamEnabled
        );

        if (dreamEnabled) {
          const keepDreamDefault = await askYesNo(
            rl,
            `  Keep ${dreamProvider} / ${dreamModel || "default"}?`,
            true
          );

          if (!keepDreamDefault) {
            dreamProvider = await pickProvider(
              rl,
              dynamicModels,
              `  Provider for dream`,
              dreamProvider,
            );
            dreamModel = await pickModel(
              rl,
              dreamProvider,
              dynamicModels,
              `  Model for dream`,
            );
          }

          taskOverrides.dream = { provider: dreamProvider, model: dreamModel };
        }
      } else if (taskChoice === 2) {
        // Use same provider for ALL tasks including dream
        console.log();
        console.log(`  ${DIM}All tasks will use ${provider} / ${model}.${RESET}`);

        for (const task of tasks) {
          let taskModel = model;
          if (task === "structuring") {
            taskModel = getStructuringModel(provider, model);
          }
          taskOverrides[task] = { provider, model: taskModel };
        }

        dreamEnabled = await askYesNo(
          rl,
          `  Enable dream mode with ${provider}?`,
          true
        );
        if (dreamEnabled) {
          dreamProvider = provider;
          dreamModel = model;
          taskOverrides.dream = { provider, model };
        }
      }
      // taskChoice === 0: keep defaults, do nothing

    } else {
      console.log();
      console.log(`${DIM}Step 4/5 \u2014 Task routing: skipped (no provider)${RESET}`);
    }

    // ─── Step 5/5 — IDE integration (enhanced) ───────────────────────
    const detectedIdes = await detectIDEs(projectDir);
    const configuredIdes: string[] = [];

    console.log();
    console.log(`${BOLD}Step 5/5${RESET} ${DIM}\u2014${RESET} IDE Integration`);
    console.log();

    const ideLabels: Record<string, string> = {
      claude: "Claude Code",
      cursor: "Cursor",
      codex: "Codex",
    };

    // Build IDE options: show detected ones and offer to create missing ones
    const allIdeKeys = ["claude", "cursor", "codex"];
    const ideOptions: string[] = [];
    const ideKeyForOption: string[] = []; // parallel array mapping option index to IDE key

    for (const ide of allIdeKeys) {
      const isDetected = detectedIdes.includes(ide);
      const label = ideLabels[ide] ?? ide;
      if (isDetected) {
        ideOptions.push(`${label} (detected)`);
      } else if (ide === "claude") {
        // Claude CLI needs to be installed, can't just create a directory
        ideOptions.push(`${label} ${DIM}(not detected \u2014 install Claude CLI first)${RESET}`);
      } else {
        // Offer to create the directory
        ideOptions.push(`${label} ${DIM}(create .${ide}/ \u2014 not detected)${RESET}`);
      }
      ideKeyForOption.push(ide);
    }

    ideOptions.push("All");
    ideOptions.push("Skip");

    if (detectedIdes.length > 0) {
      const detectedNames = detectedIdes.map((id) => ideLabels[id] ?? id).join(", ");
      console.log(`Detected: ${GREEN}${detectedNames}${RESET}`);
    } else {
      console.log(`${DIM}No IDE integrations detected in this directory.${RESET}`);
    }

    const ideIndex = await askChoice(rl, "", ideOptions);

    let idesToSetup: string[] = [];
    if (ideIndex < allIdeKeys.length) {
      // Individual IDE selected
      idesToSetup = [ideKeyForOption[ideIndex]];
    } else if (ideIndex === allIdeKeys.length) {
      // "All"
      idesToSetup = [...allIdeKeys];
    }
    // Last option is "Skip"

    for (const ide of idesToSetup) {
      // For non-detected IDEs (except claude), create the directory first
      if (!detectedIdes.includes(ide) && ide !== "claude") {
        const dirPath = path.join(projectDir, `.${ide}`);
        try {
          await fs.mkdir(dirPath, { recursive: true });
          console.log(`  ${CHECK} Created .${ide}/ directory`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`  ${CROSS} Could not create .${ide}/: ${msg}`);
          continue;
        }
      }

      const result = await setupIDE(ide, projectDir);
      if (result.success) {
        console.log(`  ${CHECK} ${result.message}`);
        configuredIdes.push(ide);
      } else {
        console.log(`  ${CROSS} ${ideLabels[ide] ?? ide}: ${result.message}`);
      }
    }

    // Sync global rules
    if (idesToSetup.length > 0) {
      try {
        const { syncToTarget } = await import("./rulesGen.js");
        const { GnosysDB } = await import("./db.js");
        const db = GnosysDB.openCentral();
        await syncToTarget(db, projectDir, "global", null);
        db.close();
      } catch {
        // Non-critical — rules sync is best-effort during setup
      }
    }

    // ─── Compute structuring model ────────────────────────────────────
    const structuringModel = isSkip ? "" : (
      taskOverrides.structuring?.model ?? getStructuringModel(provider, model)
    );

    // ─── Write config to gnosys.json ─────────────────────────────────
    if (!isSkip) {
      // Determine which store path to write to — prefer project, fall back to global
      let storePath: string;
      const projectStore = path.join(projectDir, ".gnosys");
      const globalStore = path.join(os.homedir(), ".gnosys");

      if (fsSync.existsSync(path.join(projectStore, "gnosys.json"))) {
        storePath = projectStore;
      } else if (fsSync.existsSync(path.join(globalStore, "gnosys.json"))) {
        storePath = globalStore;
      } else {
        // Default to global store — create directory if needed
        await fs.mkdir(globalStore, { recursive: true });
        storePath = globalStore;
      }

      // Build the config updates
      // Build LLM config update, preserving existing provider-specific settings
      const existingLlm = existingConfig?.llm;
      const existingProviderConfig = existingLlm
        ? (existingLlm as Record<string, unknown>)[provider]
        : undefined;
      const providerConfigBase = (typeof existingProviderConfig === "object" && existingProviderConfig !== null)
        ? existingProviderConfig as Record<string, unknown>
        : {};

      const configUpdates: Record<string, unknown> = {
        llm: {
          ...(existingLlm ?? {}),
          defaultProvider: provider as LLMProviderName,
          [provider]: {
            ...providerConfigBase,
            model,
          },
        },
      };

      // Task model overrides — only write if the user actually changed them
      const taskModelsUpdate: Record<string, { provider: string; model: string }> = {};
      if (taskOverrides.structuring) {
        taskModelsUpdate.structuring = taskOverrides.structuring;
      }
      if (taskOverrides.synthesis) {
        taskModelsUpdate.synthesis = taskOverrides.synthesis;
      }
      if (taskOverrides.vision) {
        taskModelsUpdate.vision = taskOverrides.vision;
      }
      if (taskOverrides.transcription) {
        taskModelsUpdate.transcription = taskOverrides.transcription;
      }
      if (Object.keys(taskModelsUpdate).length > 0) {
        configUpdates.taskModels = taskModelsUpdate;
      }

      // Dream configuration
      configUpdates.dream = {
        ...(existingConfig?.dream ?? {}),
        enabled: dreamEnabled,
        provider: dreamProvider as LLMProviderName,
        ...(dreamModel ? { model: dreamModel } : {}),
      };

      try {
        await updateConfig(storePath, configUpdates);
        console.log();
        console.log(`  ${CHECK} Config written to ${storePath}/gnosys.json`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log();
        console.log(`  ${WARN} Could not write config: ${msg}`);
      }
    }

    // ─── Summary ──────────────────────────────────────────────────────
    // Compute final effective routing for summary display
    const summaryRouting: Record<string, string> = {};
    const taskNames = ["structuring", "synthesis", "vision", "transcription", "dream"] as const;
    for (const task of taskNames) {
      if (isSkip) {
        summaryRouting[task] = "not configured";
        continue;
      }
      if (task === "dream") {
        if (!dreamEnabled) {
          summaryRouting[task] = "disabled";
        } else {
          const p = taskOverrides.dream?.provider ?? dreamProvider;
          const m = taskOverrides.dream?.model ?? (dreamModel || "default");
          summaryRouting[task] = `${p} / ${m}`;
        }
        continue;
      }
      if (taskOverrides[task]) {
        summaryRouting[task] = `${taskOverrides[task]!.provider} / ${taskOverrides[task]!.model}`;
      } else {
        // Default routing
        const p = provider;
        let m = model;
        if (task === "structuring") m = getStructuringModel(p, m);
        summaryRouting[task] = `${p} / ${m}`;
      }
    }

    const summaryRows: [string, string][] = [
      ["Provider:", isSkip ? "none" : provider],
      ["Model:", model || "none"],
      ["API key:", apiKeyWritten ? `${apiKeySource} ${CHECK}` : "not set"],
      ["", ""],
      ["Task Routing:", ""],
      ["  structuring:", summaryRouting.structuring],
      ["  synthesis:", summaryRouting.synthesis],
      ["  vision:", summaryRouting.vision],
      ["  transcription:", summaryRouting.transcription],
      ["  dream:", summaryRouting.dream],
    ];

    if (configuredIdes.length > 0) {
      summaryRows.push(["", ""]);
      const ideNames = configuredIdes.map((id) => ideLabels[id] ?? id).join(", ");
      summaryRows.push(["IDEs:", ideNames]);
    }

    printBox("Setup Complete", summaryRows);

    console.log(`Next: Run ${CYAN}gnosys init${RESET} in any project to start using memory.`);
    console.log();

    setupCompleted = true;
    rl.close();

    return {
      provider: isSkip ? "skip" : provider,
      model,
      structuringModel,
      apiKeyWritten,
      ides: configuredIdes,
      mode: "agent",
      upgraded,
      taskOverrides: Object.keys(taskOverrides).length > 0 ? taskOverrides : undefined,
      dreamEnabled,
    };
  } catch (err) {
    rl.close();
    throw err;
  }
}

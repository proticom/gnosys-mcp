/**
 * Gnosys Interactive Setup Wizard.
 *
 * Guides users through provider selection, model tier, API key storage,
 * task model configuration, and IDE integration.
 * Web knowledge base is set up separately via: gnosys web init
 *
 * Uses Node.js built-in readline/promises — no external dependencies.
 */

import { createInterface, type Interface as ReadlineInterface } from "readline/promises";
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
import { validateModel } from "./modelValidation.js";
import { resolveActiveStorePath, ensureActiveStorePath } from "./setup/storePath.js";
import { safeQuestion } from "./setup/ui/safePrompt.js";
import { getClaudeDesktopConfigPath, getApiKeySkipHints } from "./platform.js";

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
interface TaskRouting {
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
async function fetchDynamicModels(): Promise<Record<string, ModelTier[]>> {
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
          let modelId = m.id.slice(prefix.length + 1);
          // Anthropic API uses hyphens (claude-haiku-4-5) but OpenRouter uses dots (claude-haiku-4.5)
          if (ourProvider === "anthropic") {
            modelId = modelId.replace(/(\d+)\.(\d+)/g, "$1-$2");
          }
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
        // v5.9.4 Bug 3 — xAI: OpenRouter returns weird names like
        // `grok-build-0.1` and `grok-4.20-multi-agent`. Keep only canonical
        // numbered Grok flagship/preview models (e.g. `grok-3`, `grok-4.0`,
        // `grok-4.3`). When nothing matches we fall through to the static
        // tiers a few lines down.
        .filter((m) => ourProvider !== "xai" || /^grok-[0-9]/.test(m.modelId))
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

      // v5.9.4 Bug 3 — UNION OpenRouter tiers with static PROVIDER_TIERS.xai
      // so the static catalog (e.g. grok-4.3) always shows up even when
      // OpenRouter omits it. Dedup by model id; static entries win the tie
      // (their pricing matches the launch price more reliably).
      if (ourProvider === "xai") {
        const seen = new Set(tiers.map((t) => t.model));
        for (const staticTier of PROVIDER_TIERS.xai ?? []) {
          if (!seen.has(staticTier.model)) {
            tiers.push(staticTier);
            seen.add(staticTier.model);
          }
        }
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
async function getModelTiers(provider: string): Promise<ModelTier[]> {
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
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  await fs.chmod(configDir, 0o700);

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
  await fs.chmod(envPath, 0o600);
}

/**
 * Write an API key to the macOS Keychain.
 * Uses the -U flag to update if the entry already exists.
 * Returns true on success, false on failure.
 */
function writeApiKeyToKeychain(envVar: string, key: string): boolean {
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
  const home = os.homedir();

  // Check for Claude Code — CLI in PATH or global ~/.claude/ directory
  try {
    execSync("which claude", { stdio: "ignore" });
    detected.push("claude");
  } catch {
    try {
      const stat = await fs.stat(path.join(home, ".claude"));
      if (stat.isDirectory()) detected.push("claude");
    } catch {
      // Not installed
    }
  }

  // Check for Cursor — global ~/.cursor/ directory or app installed
  try {
    const stat = await fs.stat(path.join(home, ".cursor"));
    if (stat.isDirectory()) detected.push("cursor");
  } catch {
    // Also check macOS Applications
    try {
      await fs.stat("/Applications/Cursor.app");
      detected.push("cursor");
    } catch {
      // Not installed
    }
  }

  // Check for Codex — CLI in PATH or global ~/.codex/ directory
  try {
    execSync("which codex", { stdio: "ignore" });
    detected.push("codex");
  } catch {
    try {
      const stat = await fs.stat(path.join(home, ".codex"));
      if (stat.isDirectory()) detected.push("codex");
    } catch {
      // Not installed
    }
  }

  // Check for Gemini CLI — CLI in PATH or global ~/.gemini/ directory
  try {
    execSync("which gemini", { stdio: "ignore" });
    detected.push("gemini-cli");
  } catch {
    try {
      const stat = await fs.stat(path.join(home, ".gemini"));
      if (stat.isDirectory()) detected.push("gemini-cli");
    } catch {
      // Not installed
    }
  }

  // Check for Antigravity — ~/.gemini/antigravity/ directory or app installed
  // (Antigravity stores its MCP config at ~/.gemini/antigravity/mcp_config.json)
  try {
    const stat = await fs.stat(path.join(home, ".gemini", "antigravity"));
    if (stat.isDirectory()) detected.push("antigravity");
  } catch {
    // Also check macOS Applications
    try {
      await fs.stat("/Applications/Antigravity.app");
      detected.push("antigravity");
    } catch {
      // Not installed
    }
  }

  // Check for Claude Desktop — distinct from Claude Code CLI. Detected via the
  // app bundle on macOS or the platform-specific config dir.
  try {
    const cfg = getClaudeDesktopConfigPath();
    const cfgDir = path.dirname(cfg);
    const stat = await fs.stat(cfgDir);
    if (stat.isDirectory()) detected.push("claude-desktop");
  } catch {
    // Also check macOS Applications
    try {
      await fs.stat("/Applications/Claude.app");
      detected.push("claude-desktop");
    } catch {
      // Not installed
    }
  }

  // v5.9.4 Bug 12 — Grok Build (xAI's coding agent) stores MCP config at
  // ~/.grok/config.toml. The directory's presence is the detection signal.
  try {
    const stat = await fs.stat(path.join(home, ".grok"));
    if (stat.isDirectory()) detected.push("grok-build");
  } catch {
    // Not installed
  }

  return detected;
}

/**
 * Replace (or append) a `[mcp.<name>]` block inside the TOML text for
 * Grok Build's config file. Preserves every line outside that block —
 * deci-046 read-then-merge rule. We can't pull in a TOML dependency
 * without adding to package.json, so we ship a minimal hand-rolled
 * updater scoped exactly to the `[mcp.gnosys]` use case.
 *
 * Spec assumption: TOML headers we touch are simple `[a.b]` lines with
 * no inline tables or nested arrays. Any other content is left alone.
 *
 * Exported for tests.
 */
export function upsertGrokMcpBlock(
  existing: string,
  name: string,
  entry: { command: string; args: string[]; startup_timeout_sec?: number },
): string {
  const sectionHeader = `[mcp.${name}]`;
  const lines = existing.split("\n");
  const headerIdx = lines.findIndex((line) => line.trim() === sectionHeader);
  const blockBody = renderGrokMcpBlock(entry);

  if (headerIdx === -1) {
    // Append a fresh block, separated by a blank line if the file has content.
    const prefix = existing.length === 0 || existing.endsWith("\n\n")
      ? existing
      : existing.endsWith("\n") ? `${existing}\n` : `${existing}\n\n`;
    return `${prefix}${sectionHeader}\n${blockBody}`;
  }

  // Replace the existing block — everything from sectionHeader up to the
  // next `[` header (or EOF). Count blank lines immediately after the block
  // so we can preserve the original spacing before the next section.
  let endIdx = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (/^\s*\[/.test(lines[i])) { endIdx = i; break; }
  }
  let trailingBlankBeforeNext = 0;
  while (endIdx > headerIdx + 1 && lines[endIdx - 1].trim() === "") {
    trailingBlankBeforeNext++;
    endIdx--;
  }
  const afterLines = lines.slice(endIdx);
  const hasFollowingSection = afterLines.some((l) => /^\s*\[/.test(l));

  const beforeBlock = lines.slice(0, headerIdx).join("\n");
  const head = beforeBlock.length > 0 ? `${beforeBlock}\n` : "";

  if (!hasFollowingSection) {
    // No following section — drop trailing blank lines and end with a single \n.
    return `${head}${sectionHeader}\n${blockBody}`;
  }
  const gap = "\n".repeat(Math.max(1, trailingBlankBeforeNext));
  const afterBlock = afterLines.join("\n");
  return `${head}${sectionHeader}\n${blockBody}${gap}${afterBlock}`;
}

/**
 * Absolute path to the `gnosys-mcp` stdio entry (dist/index.js).
 * Prefer this over `gnosys serve` — v5.11.0 `gnosys serve` imported index.js but
 * did not call startMcpServer(), so MCP hosts saw "connection closed" on init.
 */
function resolveGnosysMcpCommand(): string {
  try {
    const p = execSync("command -v gnosys-mcp", { encoding: "utf-8" }).trim();
    if (p) return p;
  } catch {
    // Fall back to bare name on PATH.
  }
  return "gnosys-mcp";
}

function gnosysMcpServerEntry(): { command: string; args: string[] } {
  return { command: resolveGnosysMcpCommand(), args: [] };
}

function renderGrokMcpBlock(entry: { command: string; args: string[]; startup_timeout_sec?: number }): string {
  const argsStr = `[${entry.args.map((a) => JSON.stringify(a)).join(", ")}]`;
  const lines: string[] = [
    `command = ${JSON.stringify(entry.command)}`,
    `args = ${argsStr}`,
  ];
  if (typeof entry.startup_timeout_sec === "number") {
    lines.push(`startup_timeout_sec = ${entry.startup_timeout_sec}`);
  }
  return `${lines.join("\n")}\n`;
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
        const mcpCmd = resolveGnosysMcpCommand();
        try {
          try {
            execSync("claude mcp remove gnosys", { stdio: "pipe" });
          } catch {
            // Not registered yet — fine.
          }
          execSync(`claude mcp add -s user gnosys -- ${mcpCmd}`, {
            stdio: "pipe",
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("already exists")) {
            return { success: true, message: "Claude Code MCP server already configured" };
          }
          throw e;
        }
        return { success: true, message: `Claude Code MCP server registered (${mcpCmd})` };
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
        servers.gnosys = gnosysMcpServerEntry();
        config.mcpServers = servers;

        await fs.writeFile(mcpPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
        return { success: true, message: "Cursor MCP config updated (.cursor/mcp.json)" };
      }

      case "codex": {
        // v5.8.5: register via `codex mcp add` (the real Codex CLI registration
        // path), the same pattern Claude Code uses. Two earlier attempts at a
        // hand-written TOML block — `[gnosys] command/args` (pre-v5.8.4) and
        // `[mcp.gnosys] type/command` (v5.8.4) — both turned out not to be
        // recognized by current Codex CLI: `codex mcp list` wouldn't show
        // gnosys, so agents couldn't call the tools.
        //
        // We also migrate away from those legacy blocks in
        // `~/.codex/config.toml` so users on stale configs get cleaned up.
        const os = await import("os");

        // 1. Migrate (strip) legacy hand-written blocks in ~/.codex/config.toml.
        const userCodexConfig = path.join(os.homedir(), ".codex", "config.toml");
        try {
          let existing = await fs.readFile(userCodexConfig, "utf-8");
          const before = existing;
          // Old shape (pre-v5.8.4): [gnosys] command/args
          existing = existing.replace(
            /\n?\[gnosys\][^[]*?command\s*=\s*"gnosys"[^[]*?args\s*=\s*\[[^\]]*\]\s*\n?/,
            "\n",
          );
          // v5.8.4 shape: [mcp.gnosys] type/command
          existing = existing.replace(
            /\n?\[mcp\.gnosys\][^[]*?type\s*=\s*"local"[^[]*?command\s*=\s*\[[^\]]*\]\s*\n?/,
            "\n",
          );
          if (existing !== before) {
            existing = existing.replace(/\n{3,}/g, "\n\n");
            await fs.writeFile(userCodexConfig, existing, "utf-8");
          }
        } catch {
          // No user-level config.toml to clean — fine.
        }

        // 2. Absolute path to `gnosys-mcp` (stdio entry) for Codex spawn.
        const gnosysCmd = resolveGnosysMcpCommand();

        // 3. Check whether gnosys is already registered. If yes and the
        //    command matches, leave it alone (idempotent). If it differs,
        //    remove and re-add.
        let alreadyCorrect = false;
        try {
          const existing = execSync("codex mcp get gnosys 2>/dev/null", {
            encoding: "utf-8",
          });
          if (existing && existing.includes(gnosysCmd) && !existing.includes(" serve")) {
            alreadyCorrect = true;
          } else if (existing) {
            // Different command — remove so we can re-add with the right one.
            try {
              execSync("codex mcp remove gnosys", { stdio: "pipe" });
            } catch {
              // Non-fatal — `mcp add` below will overwrite or fail loudly.
            }
          }
        } catch {
          // `codex mcp get` returns non-zero when the server isn't registered —
          // that's the common case on first install; proceed to add.
        }

        if (alreadyCorrect) {
          return {
            success: true,
            message:
              "Codex MCP server already registered. Start a new Codex session for tool changes to take effect.",
          };
        }

        // 4. Register via the canonical Codex CLI command.
        try {
          execSync(`codex mcp add gnosys -- ${gnosysCmd}`, { stdio: "pipe" });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          // Common failure: codex CLI not installed. Don't fail the whole
          // setup flow; just report so the user can install codex first.
          return {
            success: false,
            message:
              `Could not run \`codex mcp add\` — is the Codex CLI installed and on PATH? ${msg}`,
          };
        }

        return {
          success: true,
          message:
            "Codex MCP server registered. Start a new Codex session for the Gnosys tools to appear.",
        };
      }

      case "gemini-cli": {
        // Gemini CLI reads MCP servers from ~/.gemini/settings.json (user-level)
        const geminiDir = path.join(os.homedir(), ".gemini");
        const settingsPath = path.join(geminiDir, "settings.json");
        await fs.mkdir(geminiDir, { recursive: true });

        let config: Record<string, unknown> = {};
        try {
          const existing = await fs.readFile(settingsPath, "utf-8");
          config = JSON.parse(existing);
        } catch {
          // File doesn't exist or is invalid — start fresh
        }

        const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
        servers.gnosys = gnosysMcpServerEntry();
        config.mcpServers = servers;

        await fs.writeFile(settingsPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
        return { success: true, message: "Gemini CLI MCP config updated (~/.gemini/settings.json)" };
      }

      case "antigravity": {
        // Antigravity reads MCP servers from ~/.gemini/antigravity/mcp_config.json
        // (separate file from Gemini CLI's settings.json, even though they share the parent dir)
        const antigravityDir = path.join(os.homedir(), ".gemini", "antigravity");
        const configPath = path.join(antigravityDir, "mcp_config.json");
        await fs.mkdir(antigravityDir, { recursive: true });

        let config: Record<string, unknown> = {};
        try {
          const existing = await fs.readFile(configPath, "utf-8");
          config = JSON.parse(existing);
        } catch {
          // File doesn't exist or is invalid — start fresh
        }

        const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
        servers.gnosys = gnosysMcpServerEntry();
        config.mcpServers = servers;

        await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
        return { success: true, message: "Antigravity MCP config updated (~/.gemini/antigravity/mcp_config.json)" };
      }

      case "grok-build": {
        // v5.9.4 Bug 12 — Grok Build reads its MCP servers from a
        // `[mcp.<name>]` block in ~/.grok/config.toml. We never clobber
        // unrelated TOML content (per deci-046 read-then-merge rule); the
        // helper preserves every line outside the `[mcp.gnosys]` block.
        const grokDir = path.join(os.homedir(), ".grok");
        const configPath = path.join(grokDir, "config.toml");
        await fs.mkdir(grokDir, { recursive: true });
        let existing = "";
        try {
          existing = await fs.readFile(configPath, "utf-8");
        } catch {
          // File doesn't exist yet — start fresh
        }
        const updated = upsertGrokMcpBlock(existing, "gnosys", {
          ...gnosysMcpServerEntry(),
          startup_timeout_sec: 90,
        });
        await fs.writeFile(configPath, updated, "utf-8");
        return { success: true, message: "Grok Build MCP config updated (~/.grok/config.toml)" };
      }

      case "claude-desktop": {
        // Claude Desktop reads MCP servers from claude_desktop_config.json
        // in a platform-specific app data directory. Distinct from Claude
        // Code CLI which uses `claude mcp add`.
        const configPath = getClaudeDesktopConfigPath();
        const configDir = path.dirname(configPath);
        await fs.mkdir(configDir, { recursive: true });

        let config: Record<string, unknown> = {};
        try {
          const existing = await fs.readFile(configPath, "utf-8");
          config = JSON.parse(existing);
        } catch {
          // File doesn't exist or is invalid — start fresh
        }

        const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
        servers.gnosys = gnosysMcpServerEntry();
        config.mcpServers = servers;

        await fs.writeFile(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");

        // Display path with ~ prefix when inside HOME for clarity
        const home = os.homedir();
        const displayPath = configPath.startsWith(home)
          ? configPath.replace(home, "~")
          : configPath;
        return {
          success: true,
          message: `Claude Desktop MCP config updated (${displayPath}). Restart Claude Desktop for the change to take effect.`,
        };
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
    const answer = await safeQuestion(rl, `${DIM}>${RESET} `);
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
  const answer = await safeQuestion(rl, `${prompt}${suffix}: `);
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
  const answer = await safeQuestion(rl, `${question} [${hint}] `);
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
 * Resolves the active store via the shared `resolveActiveStorePath` helper
 * (v5.9.4 Bug 10 — was reading from a different store than the summary
 * panel, producing stale-display bugs in `gnosys setup models`).
 * Returns null if no config exists in either project or global stores.
 */
async function loadExistingConfig(projectDir: string): Promise<GnosysConfig | null> {
  const storePath = resolveActiveStorePath(projectDir);
  try {
    const stat = await fs.stat(path.join(storePath, "gnosys.json"));
    if (stat.isFile()) {
      return await loadConfig(storePath);
    }
  } catch {
    // No config in the resolved store
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
 * Returns the model string. Includes a "Custom (enter model name)"
 * option so users can type any model ID not in the curated list.
 */
async function pickModel(
  rl: ReadlineInterface,
  provider: string,
  dynamicModels: Record<string, ModelTier[]>,
  stepLabel: string,
  currentModel?: string,
): Promise<string> {
  const tiers = dynamicModels[provider] ?? PROVIDER_TIERS[provider];
  if (!tiers || tiers.length === 0) {
    // No tiers available — fall back to direct entry
    return await askInput(rl, "Model name");
  }

  const isLocal = provider === "ollama" || provider === "lmstudio";
  const currentHint = currentModel ? ` ${DIM}(current: ${currentModel})${RESET}` : "";

  const tierOptions = tiers.map((t) => {
    const rec = t.recommended ? `  ${CYAN}<- recommended${RESET}` : "";
    if (isLocal) {
      return `${t.name}${rec}`;
    }
    return `${t.name} (${t.model})  ${DIM}${formatPrice(t.input, t.output)}${RESET}${rec}`;
  });
  tierOptions.push(`Custom ${DIM}(enter model name)${RESET}`);

  const tierIndex = await askChoice(
    rl,
    `${stepLabel}${currentHint}`,
    tierOptions
  );

  // Custom option is the last entry
  if (tierIndex === tiers.length) {
    const custom = await askInput(rl, "Enter model name");
    return custom;
  }

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
    // v5.9.3 redesign: atom-based splash replaces the old ASCII box banner.
    const { renderColdStartSplash } = await import("./setup/coldStart.js");
    console.log();
    console.log(renderColdStartSplash(version));
    console.log();

    // ─── Load existing config for defaults ───────────────────────────
    const existingConfig = await loadExistingConfig(projectDir);
    const currentProvider = existingConfig?.llm.defaultProvider;
    const currentModel = existingConfig
      ? getProviderModel(existingConfig, existingConfig.llm.defaultProvider)
      : undefined;

    // ─── Pre-check: Upgrade detection ─────────────────────────────────
    const { GnosysDB: GnosysDBForUpgrade } = await import("./db.js");
    const centralDbPath = GnosysDBForUpgrade.getCentralDbPath();
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
          // Intentional dynamic import — lazy-load projectIdentity to avoid a static cycle.
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

    // v5.9.3 Screen 1.1 chrome \u2014 Header + Title + step counter wrap.
    const { renderProviderStepHeader, renderModelStepHeader, renderKeyStepHeader } = await import("./setup/coldStart.js");
    console.log();
    console.log(renderProviderStepHeader(version));
    console.log();
    const providerIndex = await askChoice(
      rl,
      `Choose your LLM provider${currentProviderHint}`,
      providerOptions,
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
        tierOptions.push(`Custom ${DIM}(enter model name)${RESET}`);

        // v5.9.3 Screen 1.2 chrome \u2014 Header + Title + step counter wrap.
        console.log();
        console.log(renderModelStepHeader(provider, version));
        console.log();
        const tierIndex = await askChoice(
          rl,
          `Choose model tier${currentModelHint}`,
          tierOptions,
        );

        if (tierIndex === tiers.length) {
          model = await askInput(rl, "Enter model name");
        } else {
          model = tiers[tierIndex].model;
        }
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
        await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
        await fs.chmod(configDir, 0o700);
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
        await fs.chmod(envPath, 0o600);
      }
    } else if (isSkip) {
      // Skip step 2 entirely
      console.log();
      console.log(`${DIM}Step 2/5 \u2014 Model tier: skipped${RESET}`);
    }

    // ─── Step 3/5 — API key ───────────────────────────────────────────
    let apiKeyWritten = false;
    let apiKeySource = "";
    // Captured key value (kept in memory for the validation step below).
    // Not persisted beyond the wizard run.
    let capturedApiKey = "";
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
      // v5.9.3 Screen 1.3 chrome \u2014 Header + Title + step counter wrap.
      console.log();
      console.log(renderKeyStepHeader(provider, version));
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
          capturedApiKey = existingKey;
        } else if (existingKeySource === "macOS Keychain" && process.platform === "darwin") {
          // Pull key out of keychain so we can validate
          try {
            capturedApiKey = execSync(
              `security find-generic-password -a "$USER" -s "${envVarName}" -w`,
              { stdio: "pipe", encoding: "utf-8" }
            ).trim();
          } catch {
            // Couldn't read it — validation will be skipped
          }
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
          capturedApiKey = "";
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
              capturedApiKey = key;
            } else {
              console.log(`  ${CROSS} Failed to write to Keychain. Falling back to .env file.`);
              await writeApiKey(provider, key);
              console.log(`  ${CHECK} Key saved to ~/.config/gnosys/.env (${maskKey(key)})`);
              apiKeyWritten = true;
              apiKeySource = "~/.config/gnosys/.env";
              capturedApiKey = key;
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
              capturedApiKey = key;
            } else {
              console.log(`  ${CROSS} Failed to write to GNOME Keyring. Falling back to .env file.`);
              await writeApiKey(provider, key);
              console.log(`  ${CHECK} Key saved to ~/.config/gnosys/.env (${maskKey(key)})`);
              apiKeyWritten = true;
              apiKeySource = "~/.config/gnosys/.env";
              capturedApiKey = key;
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
              capturedApiKey = key;
            }
          } else {
            console.log(`  ${DIM}Skipped. Choose a different method next time.${RESET}`);
          }
        } else {
          // Skip
          console.log(`  ${DIM}Skipped. Set your key later using one of these methods:`);
          for (const hint of getApiKeySkipHints(envVarName, provider)) {
            console.log(`  \u2022 ${hint}`);
          }
          console.log(`${RESET}`);
        }
      }
    } else {
      console.log();
      console.log(`${DIM}Step 3/5 \u2014 API key: not needed (local provider)${RESET}`);
    }

    // ─── Validate model with a quick test call ────────────────────────
    // Only attempt validation when we have what we need: a chosen model,
    // and either a captured key (for cloud providers) or a local provider
    // (which doesn't need a key).
    const isLocalProvider = provider === "ollama" || provider === "lmstudio";
    const canValidate = !isSkip && model && (capturedApiKey || isLocalProvider);

    if (canValidate) {
      console.log();
      console.log(`${DIM}Testing ${provider}/${model}...${RESET}`);
      try {
        const { validateModel } = await import("./modelValidation.js");
        const customBaseUrl = provider === "custom"
          ? process.env.GNOSYS_LLM_BASE_URL
          : undefined;
        const result = await validateModel(provider, model, capturedApiKey, { customBaseUrl });
        if (result.ok) {
          console.log(`  ${CHECK} Model validated (${result.latencyMs}ms)`);
        } else {
          console.log(`  ${WARN} Model test failed: ${result.error}`);
          const proceed = await askYesNo(rl, "  Continue anyway?", true);
          if (!proceed) {
            console.log(`  ${DIM}Setup paused. Re-run when ready: gnosys setup${RESET}`);
            setupCompleted = true;
            rl.close();
            return {
              provider, model, structuringModel: "",
              apiKeyWritten, ides: [], mode: "agent", upgraded,
            };
          }
        }
      } catch (err) {
        console.log(`  ${DIM}Validation skipped: ${err instanceof Error ? err.message : err}${RESET}`);
      }
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
      "claude-desktop": "Claude Desktop",
      cursor: "Cursor",
      codex: "Codex",
      "gemini-cli": "Gemini CLI",
      antigravity: "Antigravity",
      // v5.9.4 Bug 12 — Grok Build (~/.grok/config.toml).
      "grok-build": "Grok Build",
    };

    // IDEs whose MCP config lives at the user level (~/...) rather than per-project.
    // We don't try to create a project-level directory for these.
    const userLevelIdes = new Set(["claude", "claude-desktop", "gemini-cli", "antigravity", "grok-build"]);

    // Build IDE options: show detected ones and offer to create missing ones
    const allIdeKeys = ["claude", "claude-desktop", "cursor", "codex", "gemini-cli", "antigravity", "grok-build"];
    const ideOptions: string[] = [];
    const ideKeyForOption: string[] = []; // parallel array mapping option index to IDE key

    for (const ide of allIdeKeys) {
      const isDetected = detectedIdes.includes(ide);
      const label = ideLabels[ide] ?? ide;
      if (isDetected) {
        ideOptions.push(`${label} (detected)`);
      } else if (userLevelIdes.has(ide)) {
        // User-level IDEs \u2014 config goes under ~/. We can still write the config
        // even if the IDE isn't installed yet (it will be picked up later).
        ideOptions.push(`${label} ${DIM}(not detected \u2014 will configure anyway)${RESET}`);
      } else {
        // Project-level IDEs \u2014 offer to create the local directory
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
      // For non-detected project-level IDEs, create the directory first.
      // User-level IDEs (claude, gemini-cli, antigravity) handle their own
      // ~/-level config dirs inside setupIDE().
      if (!detectedIdes.includes(ide) && !userLevelIdes.has(ide)) {
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
      // v5.9.4 Bug 10 — unified store resolution.
      const storePath = ensureActiveStorePath(projectDir);

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

    // ─── Step: Multi-machine sync (optional) ──────────────────────────────
    let remoteConfigured = false;
    if (!isSkip) {
      console.log();
      console.log(`${BOLD}Multi-machine sync${RESET}`);
      console.log("Share your gnosys.db across machines via NAS or shared drive.");
      console.log(`Your local DB stays fast, the remote is the source of truth.`);
      console.log();

      const setUpRemote = (await safeQuestion(rl, `Configure remote sync now? [y/N] `)).trim().toLowerCase();
      if (setUpRemote === "y" || setUpRemote === "yes") {
        console.log();
        try {
          const { GnosysDB } = await import("./db.js");
          const { runConfigureWizard } = await import("./remoteWizard.js");
          const centralDb = GnosysDB.openCentral();
          if (centralDb.isAvailable()) {
            // Pass our readline to the wizard — it will use ours and not close it
            remoteConfigured = await runConfigureWizard(centralDb, rl);
            centralDb.close();
          } else {
            console.log("Central DB not available — skipping remote sync.");
          }
        } catch (err) {
          console.log(`Remote sync setup failed: ${err instanceof Error ? err.message : err}`);
          console.log("You can run 'gnosys remote configure' later.");
        }
      } else {
        console.log("Skipped. Run 'gnosys remote configure' anytime to set up.");
      }
    }

    if (remoteConfigured) {
      summaryRows.push(["", ""]);
      summaryRows.push(["Remote sync:", "configured"]);
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

// ─── Provider-only setup (v5.9.4 — Bug 4) ──────────────────────────────────

export interface ProviderOnlySetupOpts {
  directory?: string;
  rl?: ReadlineInterface;
}

/**
 * Update ONLY `llm.defaultProvider` in gnosys.json. Used by the summary
 * panel row 1 ("provider") so it stops dragging the user into the full
 * model picker — that's row 2's job.
 *
 * v5.9.4 Bug 4 — before this split, both summary rows routed through
 * `runModelsSetup`, leaving no way to swap provider without also choosing
 * a new model. Now row 1 picks a provider, row 2 picks a model.
 */
export async function runProviderOnlySetup(opts: ProviderOnlySetupOpts = {}): Promise<void> {
  const projectDir = opts.directory ? path.resolve(opts.directory) : process.cwd();
  const ownsRl = !opts.rl;
  const rl = opts.rl ?? createInterface({ input: stdin, output: stdout });

  try {
    const { Header } = await import("./setup/ui/header.js");
    const { Title } = await import("./setup/ui/title.js");
    const { Spinner } = await import("./setup/ui/spinner.js");
    const { printStatus } = await import("./setup/ui/status.js");

    console.log();
    console.log(Header(["gnosys", "setup", "provider"]));
    console.log();
    console.log(Title("Default provider", "pick the LLM provider — model stays as configured"));
    console.log();

    const existingConfig = await loadExistingConfig(projectDir);
    const currentProvider = existingConfig?.llm.defaultProvider;

    const pricingSpin = Spinner("fetching latest pricing from openrouter…");
    const fetchStart = Date.now();
    const dynamicModels = await fetchDynamicModels();
    const fetchMs = Date.now() - fetchStart;
    if (Object.keys(dynamicModels).length > 0) {
      pricingSpin.ok("pricing loaded", `${fetchMs} ms`);
    } else {
      pricingSpin.fail("pricing fetch failed", "using bundled tiers");
    }
    console.log();

    const provider = await pickProvider(rl, dynamicModels, "Choose your LLM provider", currentProvider);
    if (!provider || provider === currentProvider) {
      printStatus("warn", "no change · provider unchanged");
      return;
    }

    const storePath = ensureActiveStorePath(projectDir);
    const existingLlm = existingConfig?.llm ?? {};
    await updateConfig(storePath, {
      llm: { ...existingLlm, defaultProvider: provider as LLMProviderName },
    });
    printStatus("ok", `default provider · ${provider}`, `${storePath}/gnosys.json`);
    printStatus("progress", "model unchanged", "use row 2 to swap the model");
  } finally {
    if (ownsRl) rl.close();
  }
}

// ─── Models-only setup (gnosys setup models / gnosys models) ─────────────────

export interface ModelsSetupOpts {
  provider?: string;
  model?: string;
  validate?: boolean;
  directory?: string;
  /**
   * v5.8.4: accept the caller's readline (e.g. from the summary wizard).
   * When provided, we don't open or close one of our own — preventing two
   * readlines from racing for stdin and doubling every keystroke.
   */
  rl?: ReadlineInterface;
}

/**
 * Models-only configuration — prompts for provider, model, and key (or accepts
 * them via options for non-interactive use). Validates the model against the
 * provider, then writes the result to gnosys.json. Skips IDE and remote setup.
 */
export async function runModelsSetup(opts: ModelsSetupOpts = {}): Promise<void> {
  const projectDir = opts.directory ? path.resolve(opts.directory) : process.cwd();
  const ownsRl = !opts.rl;
  const rl = opts.rl ?? createInterface({ input: stdin, output: stdout });

  try {
    // v5.9.3 Screen 3 — Header + Title at the top.
    const { Header } = await import("./setup/ui/header.js");
    const { Title } = await import("./setup/ui/title.js");
    const { Spinner } = await import("./setup/ui/spinner.js");
    const { printDiff } = await import("./setup/ui/diff.js");
    const { printStatus } = await import("./setup/ui/status.js");

    console.log();
    console.log(Header(["gnosys", "setup", "models"]));
    console.log();
    console.log(Title("Model configuration", "pick a provider and model — we'll validate it before saving"));
    console.log();

    const existingConfig = await loadExistingConfig(projectDir);
    const currentProvider = existingConfig?.llm.defaultProvider;
    const currentModel = existingConfig
      ? getProviderModel(existingConfig, existingConfig.llm.defaultProvider)
      : undefined;

    // Step 1: provider (or use --provider flag). v5.9.3: animate the
    // OpenRouter pricing fetch under a Spinner so the user gets feedback
    // on what would otherwise feel like a hang.
    const pricingSpin = Spinner("fetching latest pricing from openrouter…");
    const fetchStart = Date.now();
    const dynamicModels = await fetchDynamicModels();
    const fetchMs = Date.now() - fetchStart;
    const modelCount = Object.values(dynamicModels).reduce((n, tiers) => n + tiers.length, 0);
    if (Object.keys(dynamicModels).length > 0) {
      pricingSpin.ok(`pricing loaded · ${modelCount} models cached`, `${fetchMs} ms`);
    } else {
      // No-op fallback (cache miss + network fail) — keep the hardcoded
      // tiers but signal that we're running offline.
      pricingSpin.fail("pricing fetch failed", "using bundled tiers");
    }
    console.log();

    let provider: string;
    if (opts.provider) {
      if (!PROVIDER_ORDER.includes(opts.provider)) {
        printStatus("fail", `unknown provider \`${opts.provider}\``, `valid: ${PROVIDER_ORDER.join(", ")}`);
        return;
      }
      provider = opts.provider;
      printStatus("ok", "provider", provider);
    } else {
      provider = await pickProvider(rl, dynamicModels, "Choose your LLM provider", currentProvider);
    }

    // Step 2: model (or use --model flag)
    let model: string;
    if (opts.model) {
      model = opts.model;
      printStatus("ok", "model", model);
    } else {
      const tiers = dynamicModels[provider] ?? PROVIDER_TIERS[provider];
      if (provider === "custom" || !tiers || tiers.length === 0) {
        model = await askInput(rl, "Model name");
      } else {
        const showCurrent = currentProvider === provider ? currentModel : undefined;
        model = await pickModel(rl, provider, dynamicModels, "Choose model", showCurrent);
      }
    }

    if (!model) {
      printStatus("fail", "no model selected · aborting");
      return;
    }

    // Step 3: load API key from existing storage (if available)
    const envVarName = provider === "custom" ? "GNOSYS_CUSTOM_KEY" :
      `GNOSYS_${provider.toUpperCase()}_KEY`;
    const legacyEnvVars: Record<string, string> = {
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      groq: "GROQ_API_KEY",
      xai: "XAI_API_KEY",
      mistral: "MISTRAL_API_KEY",
    };
    const legacyEnvVar = legacyEnvVars[provider] ?? "";

    let apiKey = process.env[envVarName] || (legacyEnvVar ? process.env[legacyEnvVar] : "") || "";

    if (!apiKey && process.platform === "darwin") {
      try {
        apiKey = execSync(
          `security find-generic-password -a "$USER" -s "${envVarName}" -w`,
          { stdio: "pipe", encoding: "utf-8" }
        ).trim();
      } catch {
        // No key in keychain
      }
    }

    if (!apiKey && provider !== "ollama" && provider !== "lmstudio") {
      console.log(`${WARN} No API key found for ${provider}. Run 'gnosys setup' to configure one.`);
      // Continue anyway — user might just want to update the model in config
    }

    // Step 4: validate (default: true) — v5.9.3 Screen 3: animated
    // Spinner with latency reported on success.
    const shouldValidate = opts.validate !== false;
    const isLocalProvider = provider === "ollama" || provider === "lmstudio";
    if (shouldValidate && (apiKey || isLocalProvider)) {
      console.log();
      const validateSpin = Spinner(`validating ${provider} / ${model}…`);
      const customBaseUrl = provider === "custom"
        ? process.env.GNOSYS_LLM_BASE_URL
        : undefined;
      const result = await validateModel(provider, model, apiKey, { customBaseUrl });
      if (result.ok) {
        validateSpin.ok("model validated", `${result.latencyMs} ms · ${provider} / ${model}`);
      } else {
        validateSpin.fail("model test failed", result.error);
        const proceed = await askYesNo(rl, "Save config anyway?", false);
        if (!proceed) {
          printStatus("warn", "cancelled · no changes written");
          return;
        }
      }
    }

    // Step 5: write config (v5.9.4 Bug 10 — unified store resolution).
    const storePath = ensureActiveStorePath(projectDir);

    const existingLlm = existingConfig?.llm;
    const existingProviderConfig = existingLlm
      ? (existingLlm as Record<string, unknown>)[provider]
      : undefined;
    const providerConfigBase = (typeof existingProviderConfig === "object" && existingProviderConfig !== null)
      ? existingProviderConfig as Record<string, unknown>
      : {};

    await updateConfig(storePath, {
      llm: {
        ...(existingLlm ?? {}),
        defaultProvider: provider as LLMProviderName,
        [provider]: {
          ...providerConfigBase,
          model,
        },
      },
    });

    // v5.9.3 Screen 3 — Diff() before the saved confirmation. Shows what
    // landed in gnosys.json.
    const { buildModelsDiffRows } = await import("./setup/modelsRender.js");
    console.log();
    printDiff(buildModelsDiffRows(currentProvider, currentModel, provider, model));
    printStatus("ok", `saved · ${storePath}/gnosys.json`);
  } finally {
    if (ownsRl) rl.close();
  }
}

// ─── Quick `gnosys models` command ───────────────────────────────────────────

interface ModelsCommandOpts {
  list?: boolean;
  refresh?: boolean;
  set?: string;
  directory?: string;
}

/**
 * Lightweight model-management command. Supports three operations:
 *   --list:    print available models for the current provider
 *   --refresh: clear the OpenRouter cache and re-fetch
 *   --set X:   update the default model in gnosys.json (no prompts)
 */
async function runModelsCommand(opts: ModelsCommandOpts = {}): Promise<void> {
  const projectDir = opts.directory ? path.resolve(opts.directory) : process.cwd();
  const existingConfig = await loadExistingConfig(projectDir);
  const currentProvider = existingConfig?.llm.defaultProvider;

  if (opts.refresh) {
    const cacheFile = path.join(os.homedir(), ".config", "gnosys", "models-cache.json");
    try {
      await fs.unlink(cacheFile);
      console.log(`${CHECK} Cache cleared.`);
    } catch {
      console.log(`${DIM}No cache to clear.${RESET}`);
    }
  }

  if (opts.list) {
    if (!currentProvider) {
      console.log(`${WARN} No provider configured. Run 'gnosys setup' first.`);
      return;
    }
    console.log();
    console.log(`${BOLD}Available models for ${currentProvider}:${RESET}`);
    console.log();
    const dynamicModels = await fetchDynamicModels();
    const tiers = dynamicModels[currentProvider] ?? PROVIDER_TIERS[currentProvider] ?? [];
    if (tiers.length === 0) {
      console.log(`  ${DIM}No models in catalog. Try '--refresh' or use a custom model name.${RESET}`);
      return;
    }
    for (const t of tiers) {
      const rec = t.recommended ? `  ${CYAN}<- recommended${RESET}` : "";
      const price = t.input === 0 && t.output === 0
        ? "free"
        : `$${t.input.toFixed(2)}–$${t.output.toFixed(2)}/M`;
      console.log(`  ${t.name.padEnd(24)} ${t.model.padEnd(40)} ${DIM}${price}${RESET}${rec}`);
    }
    return;
  }

  if (opts.set) {
    if (!currentProvider) {
      console.log(`${WARN} No provider configured. Run 'gnosys setup' first.`);
      return;
    }
    // v5.9.4 Bug 10 — unified store resolution.
    const storePath = ensureActiveStorePath(projectDir);

    const existingProviderConfig = (existingConfig?.llm as Record<string, unknown> | undefined)?.[currentProvider];
    const providerConfigBase = (typeof existingProviderConfig === "object" && existingProviderConfig !== null)
      ? existingProviderConfig as Record<string, unknown>
      : {};

    await updateConfig(storePath, {
      llm: {
        ...(existingConfig?.llm ?? {}),
        defaultProvider: currentProvider,
        [currentProvider]: { ...providerConfigBase, model: opts.set },
      },
    });
    console.log(`${CHECK} Default model set to ${GREEN}${opts.set}${RESET} for ${currentProvider}.`);
    return;
  }

  // No flags: show current config
  if (!currentProvider) {
    console.log(`${WARN} No provider configured. Run 'gnosys setup' first.`);
    return;
  }
  const currentModel = existingConfig
    ? getProviderModel(existingConfig, existingConfig.llm.defaultProvider)
    : "";
  console.log();
  console.log(`Provider: ${GREEN}${currentProvider}${RESET}`);
  console.log(`Model:    ${GREEN}${currentModel}${RESET}`);
  console.log();
  console.log(`${DIM}Use '--list' to see options, '--set <model>' to change, '--refresh' to update catalog.${RESET}`);
}

// ─── Dream Setup (gnosys setup dream) ────────────────────────────────────

export interface DreamSetupOpts {
  directory?: string;
  /** v5.8.4: reuse the caller's readline (e.g. summary wizard) to avoid stdin races. */
  rl?: ReadlineInterface;
}

/**
 * Walks the user through configuring dream mode. Handles:
 *   - enable/disable
 *   - designating THIS machine as the dream node (writes central DB meta)
 *   - provider/model picking + validation (Layer 1 alert)
 *   - schedule (idle minutes, max runtime, min memories)
 *   - sub-task toggles (selfCritique, generateSummaries, discoverRelationships)
 *
 * Writes dream config to global gnosys.json and `dream_machine_id` to the
 * central DB meta table.
 */
export async function runDreamSetup(opts: DreamSetupOpts = {}): Promise<void> {
  const projectDir = opts.directory ? path.resolve(opts.directory) : process.cwd();
  const ownsRl = !opts.rl;
  const rl = opts.rl ?? createInterface({ input: stdin, output: stdout });

  try {
    // v5.9.3 Screen 7 — three grouped sub-screens (7.0 enable, 7.1
    // machine+model, 7.2 thresholds+sub-tasks). Each sub-screen renders
    // its own Header with `step N of 3` so the progress is always visible.
    const { Header } = await import("./setup/ui/header.js");
    const { Title } = await import("./setup/ui/title.js");
    const { Spinner } = await import("./setup/ui/spinner.js");
    const { printDiff } = await import("./setup/ui/diff.js");
    const { printStatus } = await import("./setup/ui/status.js");

    const existingConfig = await loadExistingConfig(projectDir);
    const existingDream = existingConfig?.dream;

    // Show current state via central DB
    const { GnosysDB } = await import("./db.js");
    const { getMachineId } = await import("./remote.js");
    const localDb = GnosysDB.openLocal();

    // v5.9.4 Bugs 7+8 — also peek at the remote DB (if configured) so re-entry
    // sees a designation made on a different machine. Open remote read-only;
    // we'll mirror writes below.
    const remoteDb = await openRemoteDbIfConfigured(localDb);
    const designatedMachine = localDb.getDreamMachineId() ?? remoteDb?.getDreamMachineId() ?? null;
    // v5.9.4 Bug 9 — share the canonical machine-id resolver (os.hostname()
    // fallback included) instead of re-rolling HOSTNAME/COMPUTERNAME logic.
    const localMachine = getMachineId(localDb);

    // Mirror dream_machine_id writes to both DBs (Bug 8).
    const setDreamMachineEverywhere = (id: string): void => {
      localDb.setDreamMachineId(id);
      try { remoteDb?.setDreamMachineId(id); } catch { /* remote may be transiently unavailable */ }
    };
    const clearDreamMachineEverywhere = (): void => {
      localDb.clearDreamMachineId();
      try { remoteDb?.clearDreamMachineId(); } catch { /* remote may be transiently unavailable */ }
    };

    // ─── 7.0  Overview & enable ────────────────────────────────────────
    console.log();
    console.log(Header(["gnosys", "setup", "dream"], { version: "step 1 of 3" }));
    console.log();
    console.log(
      Title(
        "Dream Mode",
        "gnosys runs background consolidation while you're idle — merging related memories, generating summaries, surfacing relationships.",
      ),
    );
    console.log();
    const currentStateLine = existingDream?.enabled
      ? `enabled · ${designatedMachine ? designatedMachine === localMachine ? `${localMachine} (this machine)` : designatedMachine : "no designated machine"}`
      : "disabled · no designated machine";
    printStatus("progress", "current", currentStateLine);
    console.log();

    const enabled = await askYesNo(rl, "enable Dream Mode?", existingDream?.enabled ?? true);
    if (!enabled) {
      // Persist disabled state and clear designation
      const storePath = ensureActiveStorePath(projectDir);
      await updateConfig(storePath, {
        dream: { ...(existingDream ?? {}), enabled: false },
      });
      clearDreamMachineEverywhere();
      console.log();
      printStatus("ok", "dream mode disabled · designation cleared");
      localDb.close();
      remoteDb?.close();
      return;
    }

    // ─── 7.1  Designated machine + model ───────────────────────────────
    console.log();
    console.log(Header(["gnosys", "setup", "dream", "machine"], { version: "step 2 of 3" }));
    console.log();
    console.log(Title("Only one machine dreams at a time — we'll designate one now."));
    console.log();
    printStatus("progress", "this machine", localMachine);
    console.log();

    const designate = await askYesNo(
      rl,
      designatedMachine === localMachine
        ? "this machine is currently the dreamer — keep it?"
        : `designate THIS machine (${localMachine}) as the dreamer?`,
      true,
    );
    if (designate) {
      setDreamMachineEverywhere(localMachine);
      printStatus("ok", `${localMachine} is the dreamer`);
    } else if (designatedMachine === localMachine) {
      clearDreamMachineEverywhere();
      printStatus("warn", "designation cleared", "no machine will dream until you re-run on another");
    } else {
      printStatus("progress", "keeping current designation", designatedMachine || "none");
    }

    // Pricing fetch — animated Spinner.
    console.log();
    const pricingSpin = Spinner("fetching latest pricing from openrouter…");
    const fetchStart = Date.now();
    const dynamicModels = await fetchDynamicModels();
    const fetchMs = Date.now() - fetchStart;
    if (Object.keys(dynamicModels).length > 0) {
      pricingSpin.ok("pricing loaded", `${fetchMs} ms`);
    } else {
      pricingSpin.fail("pricing fetch failed", "using bundled tiers");
    }
    console.log();

    const defaultProvider = existingDream?.provider || existingConfig?.llm.defaultProvider || "ollama";
    const dreamProvider = await pickProvider(
      rl,
      dynamicModels,
      "Choose dream LLM provider — local is recommended (dream runs a lot)",
      defaultProvider,
    );

    let dreamModel = "";
    if (dreamProvider === "custom" || dreamProvider === "skip") {
      dreamModel = await askInput(rl, "Enter model name");
    } else {
      const tiers = dynamicModels[dreamProvider] ?? PROVIDER_TIERS[dreamProvider] ?? [];
      if (tiers.length === 0) {
        dreamModel = await askInput(rl, "Enter model name");
      } else {
        dreamModel = await pickModel(
          rl,
          dreamProvider,
          dynamicModels,
          "Choose dream model",
          existingDream?.model,
        );
      }
    }

    // Validate — animated Spinner with the model latency reported.
    if (dreamProvider !== "skip") {
      const apiKey = await getApiKeyForProvider(dreamProvider);
      const isLocalProvider = dreamProvider === "ollama" || dreamProvider === "lmstudio";
      if (apiKey || isLocalProvider) {
        console.log();
        const validateSpin = Spinner(`validating ${dreamProvider} / ${dreamModel}…`);
        try {
          const customBaseUrl = dreamProvider === "custom" ? process.env.GNOSYS_LLM_BASE_URL : undefined;
          const result = await validateModel(dreamProvider, dreamModel, apiKey, { customBaseUrl });
          if (result.ok) {
            validateSpin.ok("model validated", `${result.latencyMs} ms · ${dreamProvider} / ${dreamModel}`);
          } else {
            validateSpin.fail("could not reach model", result.error);
            const proceed = await askYesNo(rl, "save config anyway?", true);
            if (!proceed) {
              printStatus("warn", "setup cancelled · no changes written");
              localDb.close();
              remoteDb?.close();
              return;
            }
          }
        } catch (err) {
          printStatus("warn", "validation skipped", err instanceof Error ? err.message : String(err));
        }
      } else {
        printStatus("warn", `no API key for ${dreamProvider}`, "set one via `gnosys setup models`");
      }
    }

    // ─── 7.2  Thresholds + sub-tasks ───────────────────────────────────
    console.log();
    console.log(Header(["gnosys", "setup", "dream", "when & what"], { version: "step 3 of 3" }));
    console.log();
    console.log(Title("Thresholds & sub-tasks", "press enter to accept defaults, or `e` to edit"));
    console.log();

    // Defaults pulled from the existing config (or the global defaults).
    const dIdle = existingDream?.idleMinutes ?? 10;
    const dRuntime = existingDream?.maxRuntimeMinutes ?? 30;
    const dMinMem = existingDream?.minMemories ?? 10;
    const dSelfCritique = existingDream?.selfCritique ?? true;
    const dGenSummaries = existingDream?.generateSummaries ?? true;
    const dDiscover = existingDream?.discoverRelationships ?? true;

    const { renderThresholdsBlock } = await import("./setup/dreamRender.js");
    for (const line of renderThresholdsBlock(dIdle, dRuntime, dMinMem, {
      selfCritique: dSelfCritique,
      generateSummaries: dGenSummaries,
      discoverRelationships: dDiscover,
    })) {
      console.log(line);
    }
    console.log();

    const editChoice = (await askInput(rl, "press enter to accept defaults, or e to edit")).trim().toLowerCase();
    let idleMinutes = dIdle;
    let maxRuntimeMinutes = dRuntime;
    let minMemories = dMinMem;
    let selfCritique = dSelfCritique;
    let generateSummaries = dGenSummaries;
    let discoverRelationships = dDiscover;

    if (editChoice === "e") {
      const idleAns = await askInput(rl, "idle minutes before triggering", { default: String(dIdle) });
      idleMinutes = Math.max(1, parseInt(idleAns) || dIdle);
      const runtimeAns = await askInput(rl, "max runtime minutes", { default: String(dRuntime) });
      maxRuntimeMinutes = Math.max(1, parseInt(runtimeAns) || dRuntime);
      const minMemAns = await askInput(rl, "minimum memories before activating", { default: String(dMinMem) });
      minMemories = Math.max(1, parseInt(minMemAns) || dMinMem);
      selfCritique = await askYesNo(rl, "self-critique (rule + LLM-based review flagging)", dSelfCritique);
      generateSummaries = await askYesNo(rl, "generate summaries (LLM)", dGenSummaries);
      discoverRelationships = await askYesNo(rl, "discover relationships (LLM)", dDiscover);
    }

    // Save
    const storePath = ensureActiveStorePath(projectDir);
    await updateConfig(storePath, {
      dream: {
        enabled: true,
        idleMinutes,
        maxRuntimeMinutes,
        minMemories,
        provider: dreamProvider as LLMProviderName,
        model: dreamModel || undefined,
        selfCritique,
        generateSummaries,
        discoverRelationships,
      },
    });

    // Reset consecutive failure counter on a fresh setup so Layer 4
    // doesn't fire immediately based on stale history.
    localDb.resetDreamConsecutiveFailures();
    localDb.close();
    remoteDb?.close();

    // Final Diff block per the design — provider/machine + the two
    // threshold fields most users actually care about.
    console.log();
    printStatus("ok", "dream mode enabled");
    console.log();
    const { buildDreamDiffRows } = await import("./setup/dreamRender.js");
    printDiff(
      buildDreamDiffRows(
        existingDream
          ? {
              provider: existingDream.provider,
              model: existingDream.model,
              machine: designatedMachine ?? "—",
              idleMinutes: existingDream.idleMinutes,
              maxRuntimeMinutes: existingDream.maxRuntimeMinutes,
            }
          : null,
        {
          provider: dreamProvider,
          model: dreamModel || undefined,
          machine: designate ? localMachine : (designatedMachine ?? "none"),
          idleMinutes,
          maxRuntimeMinutes,
          selfCritique,
          generateSummaries,
          discoverRelationships,
        },
      ),
    );
    const dreamerName = designate ? localMachine : (designatedMachine ?? "the designated machine");
    printStatus("progress", `first cycle runs after ${dreamerName} is idle for ${idleMinutes} min`);
    printStatus("progress", "check status anytime with `gnosys status --system`");
  } finally {
    if (ownsRl) rl.close();
  }
}

// ─── Chat Setup ────────────────────────────────────────────────────────
//
// v5.8.0 (#1): `gnosys setup chat` wizard. Mirrors the dream / remote /
// routing patterns. Configures:
//   - Chat-specific provider/model (via taskModels.chat)
//   - Recall settings used during chat turns (aggressive, max, threshold)
//   - Chat-only knobs: tools fence on/off, auto-summarize nudge, custom
//     system-prompt prefix
//
// Writes to the merged config chain — project gnosys.json if present,
// else the global one (same rule as setup dream).

interface ChatSetupOpts {
  directory?: string;
  /** v5.8.4: reuse the caller's readline (e.g. summary wizard) to avoid stdin races. */
  rl?: ReadlineInterface;
}

/**
 * v5.9.3 (deci-050): `gnosys setup chat` is deprecated. Chat config
 * moves into the chat TUI's own settings panel in v6.0 (road-014). This
 * stub renders a deprecation notice and exits. The function signature
 * is preserved so existing callers (cli.ts subcommand registration)
 * continue to compile.
 */
export async function runChatSetup(opts: ChatSetupOpts = {}): Promise<void> {
  void opts; // signature preserved; opts unused in deprecation notice
  // Use atom-based render so the notice matches the rest of v5.9.3.
  const { Header } = await import("./setup/ui/header.js");
  const { Status } = await import("./setup/ui/status.js");
  const { Footer } = await import("./setup/ui/footer.js");
  const { c, color } = await import("./setup/ui/tokens.js");
  const v = `v${getVersion()}`;

  console.log();
  console.log(Header(["gnosys", "setup", "chat"], { version: v }));
  console.log();
  console.log(Status("warn", "chat settings have moved"));
  console.log();
  console.log(`   ${color(c.text, "chat is now configured from inside the TUI itself.")}`);
  console.log(`   ${color(c.textDim, "open it with")}                            ${color(c.text, "gnosys chat")}`);
  console.log(`   ${color(c.textDim, "then press")}                              ${color(c.text, "⌃, (settings)")}`);
  console.log();
  console.log(Footer("v6.0 will retire this command entirely"));
}

// ─── runChatSetup body removed in v5.9.3 (deci-050) ─────────────────
// Provider/model override + recall tuning + tools fence + auto-summarize
// + system prompt prefix all move to the v6.0 chat TUI's settings panel
// (road-014). The exported stub above renders a deprecation notice.

/**
 * Open the remote central DB ONLY when sync is configured AND the share
 * is reachable. Returns null otherwise. Used by the dream wizard so it
 * can mirror `dream_machine_id` writes to both DB meta tables (Bug 8).
 */
async function openRemoteDbIfConfigured(
  localDb: import("./db.js").GnosysDB,
): Promise<import("./db.js").GnosysDB | null> {
  try {
    if (!localDb.isAvailable()) return null;
    const remotePath = localDb.getMeta("remote_path");
    if (!remotePath) return null;
    if (!fsSync.existsSync(path.join(remotePath, "gnosys.db"))) return null;
    const { GnosysDB } = await import("./db.js");
    return new GnosysDB(remotePath);
  } catch {
    return null;
  }
}

/**
 * Best-effort lookup of the API key for a provider. Used by the dream setup
 * wizard to power the validation step. Mirrors the resolveApiKey precedence.
 */
export async function getApiKeyForProvider(provider: string): Promise<string> {
  if (provider === "ollama" || provider === "lmstudio" || provider === "skip") return "";
  const envVarName = provider === "custom" ? "GNOSYS_CUSTOM_KEY" : `GNOSYS_${provider.toUpperCase()}_KEY`;
  const legacyVars: Record<string, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    openai: "OPENAI_API_KEY",
    groq: "GROQ_API_KEY",
    xai: "XAI_API_KEY",
    mistral: "MISTRAL_API_KEY",
  };
  const fromEnv = process.env[envVarName] || (legacyVars[provider] && process.env[legacyVars[provider]]) || "";
  if (fromEnv) return fromEnv;
  if (process.platform === "darwin") {
    try {
      return execSync(`security find-generic-password -a "$USER" -s "${envVarName}" -w 2>/dev/null`, {
        stdio: "pipe", encoding: "utf-8", timeout: 2000,
      }).trim();
    } catch {
      // fall through
    }
  }
  return "";
}

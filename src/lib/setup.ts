/**
 * Gnosys Interactive Setup Wizard.
 *
 * Guides users through provider selection, model tier, API key storage,
 * IDE integration, and optional web knowledge base configuration.
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

export interface SetupResult {
  provider: string;
  model: string;
  structuringModel: string;
  apiKeyWritten: boolean;
  ides: string[];
  mode: "agent" | "web" | "both";
  upgraded: boolean;
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
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  groq: "GROQ_API_KEY",
  xai: "XAI_API_KEY",
  mistral: "MISTRAL_API_KEY",
  custom: "GNOSYS_LLM_API_KEY",
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
  console.log(question);
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
    const line = `${key.padEnd(maxKeyLen)}  ${val}`;
    console.log(`\u2502  ${line}${" ".repeat(innerWidth - line.length - 2)}\u2502`);
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

    // ─── Step 1/5 — Usage mode ────────────────────────────────────────
    const modeIndex = await askChoice(
      rl,
      `${BOLD}Step 1/5${RESET} ${DIM}\u2014${RESET} How will you use Gnosys?`,
      [
        "Agent memory (IDE + CLI)",
        "Web knowledge base (serverless chatbots)",
        "Both",
      ]
    );
    const mode: "agent" | "web" | "both" =
      modeIndex === 0 ? "agent" : modeIndex === 1 ? "web" : "both";

    // ─── Step 2/5 — Provider ──────────────────────────────────────────
    const providerOptions = PROVIDER_ORDER.map((key) => {
      const tiers = PROVIDER_TIERS[key];
      const display = PROVIDER_DISPLAY[key];
      if (tiers.length === 0) return display;
      const minIn = Math.min(...tiers.map((t) => t.input));
      const maxOut = Math.max(...tiers.map((t) => t.output));
      if (minIn === 0 && maxOut === 0) return display;
      return `${display}      ${DIM}$${minIn.toFixed(2)}\u2013$${maxOut.toFixed(2)}/M tokens${RESET}`;
    });
    // Add "Skip" option
    providerOptions.push("Skip (core memory works without LLM)");

    const providerIndex = await askChoice(
      rl,
      `${BOLD}Step 2/5${RESET} ${DIM}\u2014${RESET} Choose your LLM provider`,
      providerOptions
    );

    const isSkip = providerIndex === PROVIDER_ORDER.length; // last option
    const provider = isSkip ? "skip" : PROVIDER_ORDER[providerIndex];

    // ─── Step 3/5 — Model tier ────────────────────────────────────────
    let model = "";

    if (!isSkip && provider !== "custom") {
      const tiers = PROVIDER_TIERS[provider];
      if (tiers.length > 0) {
        const isLocal = provider === "ollama" || provider === "lmstudio";

        const tierOptions = tiers.map((t) => {
          const rec = t.recommended ? `  ${CYAN}<- recommended${RESET}` : "";
          if (isLocal) {
            return `${t.name}${rec}`;
          }
          return `${t.name} (${t.model})  ${DIM}${formatPrice(t.input, t.output)}${RESET}${rec}`;
        });

        const tierIndex = await askChoice(
          rl,
          `${BOLD}Step 3/5${RESET} ${DIM}\u2014${RESET} Choose model tier`,
          tierOptions
        );
        model = tiers[tierIndex].model;
      }
    } else if (provider === "custom") {
      // Custom: ask for base URL and model name
      console.log();
      console.log(`${BOLD}Step 3/5${RESET} ${DIM}\u2014${RESET} Custom provider details`);
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
      // Skip step 3 entirely
      console.log();
      console.log(`${DIM}Step 3/5 \u2014 Model tier: skipped${RESET}`);
    }

    // ─── Step 4/5 — API key ───────────────────────────────────────────
    let apiKeyWritten = false;
    const needsKey =
      !isSkip &&
      provider !== "ollama" &&
      provider !== "lmstudio";

    if (needsKey) {
      console.log();
      console.log(`${BOLD}Step 4/5${RESET} ${DIM}\u2014${RESET} API Key`);
      console.log();

      const providerLabel =
        provider === "custom" ? "API" : PROVIDER_DISPLAY[provider]?.split(" ")[0] ?? provider;
      const key = await askInput(rl, `Enter your ${providerLabel} API key (press Enter to skip)`);

      if (key) {
        await writeApiKey(provider, key);
        console.log(`${CHECK} Key saved to ~/.config/gnosys/.env (${maskKey(key)})`);
        apiKeyWritten = true;
      } else {
        console.log(`${DIM}Skipped. You can set it later in ~/.config/gnosys/.env${RESET}`);
      }
    } else {
      console.log();
      console.log(`${DIM}Step 4/5 \u2014 API key: not needed${RESET}`);
    }

    // ─── Step 5/5 — IDE integration ───────────────────────────────────
    const detectedIdes = await detectIDEs(projectDir);
    const configuredIdes: string[] = [];

    if (detectedIdes.length > 0) {
      const ideLabels: Record<string, string> = {
        claude: "Claude Code",
        cursor: "Cursor",
        codex: "Codex",
      };

      const detectedNames = detectedIdes.map((id) => ideLabels[id] ?? id).join(", ");
      console.log();
      console.log(`${BOLD}Step 5/5${RESET} ${DIM}\u2014${RESET} IDE Integration`);
      console.log();
      console.log(`Detected: ${GREEN}${detectedNames}${RESET}`);

      const ideOptions: string[] = [];
      for (const ide of detectedIdes) {
        ideOptions.push(`${ideLabels[ide] ?? ide} only`);
      }
      if (detectedIdes.length > 1) {
        ideOptions.push("All detected");
      }
      ideOptions.push("Skip");

      const ideIndex = await askChoice(rl, "", ideOptions);

      let idesToSetup: string[] = [];
      if (ideIndex < detectedIdes.length) {
        // Individual IDE selected
        idesToSetup = [detectedIdes[ideIndex]];
      } else if (detectedIdes.length > 1 && ideIndex === detectedIdes.length) {
        // "All detected"
        idesToSetup = [...detectedIdes];
      }
      // Last option is always "Skip"

      for (const ide of idesToSetup) {
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
    } else {
      console.log();
      console.log(`${DIM}Step 5/5 \u2014 IDE integration: no IDEs detected${RESET}`);
    }

    // ─── Web extra steps (only if mode is web or both) ────────────────
    let sitemapUrl = "";
    let outputDir = "";
    let llmEnrich = true;

    if (mode === "web" || mode === "both") {
      console.log();
      console.log(`${BOLD}Web Knowledge Base Configuration${RESET}`);
      console.log();

      sitemapUrl = await askInput(rl, "Sitemap URL (or Enter to skip)");
      outputDir = await askInput(rl, "Output directory", { default: "./knowledge" });
      llmEnrich = await askYesNo(rl, "Enable LLM enrichment for ingested pages?", true);

      console.log();
      if (sitemapUrl) {
        console.log(`  ${CHECK} Sitemap: ${sitemapUrl}`);
      }
      console.log(`  ${CHECK} Output: ${outputDir}`);
      console.log(`  ${CHECK} LLM enrichment: ${llmEnrich ? "enabled" : "disabled"}`);
    }

    // ─── Compute structuring model ────────────────────────────────────
    const structuringModel = isSkip ? "" : getStructuringModel(provider, model);

    // ─── Summary ──────────────────────────────────────────────────────
    const summaryRows: [string, string][] = [
      ["Provider:", isSkip ? "none" : provider],
      ["Model:", model || "none"],
      ["Structuring:", structuringModel || "n/a"],
      ["API key:", apiKeyWritten ? "~/.config/gnosys/.env" : "not set"],
    ];

    if (configuredIdes.length > 0) {
      const ideLabels: Record<string, string> = {
        claude: "Claude Code",
        cursor: "Cursor",
        codex: "Codex",
      };
      const ideNames = configuredIdes.map((id) => ideLabels[id] ?? id).join(", ");
      summaryRows.push(["IDEs:", ideNames]);
    }

    if (mode === "web" || mode === "both") {
      summaryRows.push(["Mode:", mode]);
      if (sitemapUrl) summaryRows.push(["Sitemap:", sitemapUrl]);
      summaryRows.push(["Output:", outputDir || "./knowledge"]);
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
      mode,
      upgraded,
    };
  } catch (err) {
    rl.close();
    throw err;
  }
}

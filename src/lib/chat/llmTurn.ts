/**
 * Run one chat turn against the LLM with streaming output.
 *
 * Phase 2 keeps this minimal — no recall, no system prompt customization.
 * Phase 3 adds recall integration; Phase 5 adds intent classification;
 * Phase 6 adds gnosys-choose protocol; Phase 7 adds focus-aware system prompt.
 */

import { GnosysConfig, getProviderModel } from "../config.js";
import { LLMProvider, getLLMProvider, createProvider } from "../llm.js";
import { LLMProviderName } from "../config.js";
import { Turn } from "./types.js";

export interface LLMTurnOptions {
  /** Conversation buffer to send (will be formatted into a single prompt). */
  buffer: Turn[];
  /** New user input to append before sending. */
  userInput: string;
  /** Token-level streaming callback. */
  onToken: (token: string) => void;
}

export interface LLMTurnResult {
  text: string;
  provider: string;
  model: string;
}

const SYSTEM_PROMPT = `You are an assistant inside the Gnosys terminal chat. Be concise and direct. When the user explicitly asks a question, answer it; otherwise have a normal conversation. Markdown is rendered. Code blocks render with syntax highlighting.`;

/** Format the conversation buffer + new input into a single prompt string. */
function buildPrompt(buffer: Turn[], userInput: string): string {
  const lines: string[] = [];
  for (const turn of buffer) {
    if (turn.role === "user") lines.push(`User: ${turn.text}`);
    else if (turn.role === "assistant") lines.push(`Assistant: ${turn.text}`);
    // System turns are not replayed into the prompt (they're TUI-side notices)
  }
  lines.push(`User: ${userInput}`);
  lines.push(`Assistant:`);
  return lines.join("\n\n");
}

/**
 * Run a single turn. Streams via opts.onToken. Returns the full assistant
 * response when done.
 */
export async function runTurn(
  config: GnosysConfig,
  opts: LLMTurnOptions,
): Promise<LLMTurnResult> {
  // Phase 2: use the synthesis provider (suitable for free-form chat).
  // Future phases may route to a "chat" task type if added to config.
  const provider: LLMProvider = getLLMProvider(config, "synthesis");

  const prompt = buildPrompt(opts.buffer, opts.userInput);

  let full = "";
  await provider.generate(
    prompt,
    { system: SYSTEM_PROMPT, stream: true, maxTokens: 4096 },
    {
      onToken: (token) => {
        full += token;
        opts.onToken(token);
      },
    },
  );

  return { text: full, provider: provider.name, model: provider.model };
}

/** Build a provider for /provider switching mid-session. */
export function buildProvider(
  config: GnosysConfig,
  providerName: LLMProviderName,
  model?: string,
): LLMProvider {
  const resolvedModel = model ?? getProviderModel(config, providerName);
  return createProvider(providerName, resolvedModel, config);
}

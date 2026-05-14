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
import { RecalledMemory, formatRecallForPrompt } from "./recall.js";
import { CHOOSE_SYSTEM_PROMPT_ADDENDUM } from "./choose.js";
import { buildToolsSystemPrompt, findTool } from "./tools.js";
import { extractToolFences } from "./toolFence.js";

export interface LLMTurnOptions {
  /** Conversation buffer to send (will be formatted into a single prompt). */
  buffer: Turn[];
  /** New user input to append before sending. */
  userInput: string;
  /** Token-level streaming callback. */
  onToken: (token: string) => void;
  /** Recalled memories to inject into the system prompt. Empty disables recall. */
  recalled?: RecalledMemory[];
  /** Tool-execution status callback (e.g. "calling list_projects..."). Optional. */
  onToolCall?: (info: { tool: string; args: Record<string, string>; result?: string; error?: string }) => void;
  /** Maximum tool-call iterations per turn before forcing a final answer. Default 4. */
  maxToolIterations?: number;
}

export interface LLMTurnResult {
  text: string;
  provider: string;
  model: string;
  /** Memory IDs surfaced in the system prompt for this turn (used for citations). */
  recalledIds: string[];
  /** Tool calls executed during this turn (in order), with results. */
  toolCalls?: Array<{ tool: string; args: Record<string, string>; result: string }>;
}

const BASE_SYSTEM_PROMPT = `You are an assistant inside the Gnosys terminal chat — a memory-aware REPL. The user has persistent memory across sessions; relevant memories are injected as <memory id="..."> blocks before their question. Cite memory IDs in square brackets like [deci-037] when you use them. Be concise and direct. Markdown renders.${CHOOSE_SYSTEM_PROMPT_ADDENDUM}`;

function composeSystemPrompt(recalled: RecalledMemory[] | undefined): string {
  const toolsAddendum = buildToolsSystemPrompt();
  const base = `${BASE_SYSTEM_PROMPT}\n${toolsAddendum}`;
  if (!recalled || recalled.length === 0) return base;
  return `${base}\n\n${formatRecallForPrompt(recalled)}`;
}

/** Format the conversation buffer + new input into a single prompt string. */
function buildPrompt(buffer: Turn[], userInput: string, toolPreamble?: string): string {
  const lines: string[] = [];
  for (const turn of buffer) {
    if (turn.role === "user") lines.push(`User: ${turn.text}`);
    else if (turn.role === "assistant") lines.push(`Assistant: ${turn.text}`);
    // System turns are not replayed into the prompt (they're TUI-side notices)
  }
  lines.push(`User: ${userInput}`);
  if (toolPreamble) lines.push(toolPreamble);
  lines.push(`Assistant:`);
  return lines.join("\n\n");
}

/**
 * Run a single turn against the LLM. Loops if the assistant emits
 * gnosys-tool fences: each tool is executed in-process, the result is
 * appended as a system-style turn, and the LLM is invoked again. Stops
 * when the assistant produces a turn with no fences (or maxToolIterations
 * is hit).
 */
export async function runTurn(
  config: GnosysConfig,
  opts: LLMTurnOptions,
): Promise<LLMTurnResult> {
  // v5.8.0 (#2): chat is its own task in config.taskModels. resolveTaskModel
  // falls back to defaultProvider when no chat override is set, so existing
  // installs keep working without a chat-specific config.
  const provider: LLMProvider = getLLMProvider(config, "chat");
  const system = composeSystemPrompt(opts.recalled);
  const maxIterations = opts.maxToolIterations ?? 4;

  const toolCalls: Array<{ tool: string; args: Record<string, string>; result: string }> = [];
  let toolPreamble: string | undefined;
  let combinedText = "";

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const prompt = buildPrompt(opts.buffer, opts.userInput, toolPreamble);

    let chunk = "";
    await provider.generate(
      prompt,
      { system, stream: true, maxTokens: 4096 },
      {
        onToken: (token) => {
          chunk += token;
          opts.onToken(token);
        },
      },
    );
    combinedText += (combinedText ? "\n\n" : "") + chunk;

    // Look for tool fences; if none, this iteration's chunk IS the answer.
    const extraction = extractToolFences(chunk);
    if (!extraction || extraction.calls.length === 0) {
      break;
    }

    // Run each tool, accumulate results into the next prompt as a system block
    const resultBlocks: string[] = [];
    for (const call of extraction.calls) {
      const tool = findTool(call.tool);
      if (!tool) {
        opts.onToolCall?.({ tool: call.tool, args: call.args, error: `unknown tool: ${call.tool}` });
        resultBlocks.push(`[tool error] unknown tool: ${call.tool}`);
        continue;
      }
      try {
        const result = await tool.run(call.args);
        toolCalls.push({ tool: call.tool, args: call.args, result });
        opts.onToolCall?.({ tool: call.tool, args: call.args, result });
        resultBlocks.push(`[tool result: ${call.tool}]\n${result}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        opts.onToolCall?.({ tool: call.tool, args: call.args, error: message });
        resultBlocks.push(`[tool error: ${call.tool}] ${message}`);
      }
    }

    toolPreamble = resultBlocks.join("\n\n");
  }

  return {
    text: combinedText,
    provider: provider.name,
    model: provider.model,
    recalledIds: (opts.recalled ?? []).map((m) => m.id),
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
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

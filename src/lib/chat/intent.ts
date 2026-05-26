/**
 * Free-text intent detection — converts conversational phrasings into the
 * matching slash command. Lets the user write "let's focus on the auth
 * refactor" instead of `/focus auth refactor`.
 *
 * Hybrid classifier:
 *   1. Pattern match (regex) — instant, free, covers ~80% of intents
 *   2. LLM classifier fallback — only when pattern returns null AND the
 *      message has imperative-y signals
 *   3. Confirm-before-destructive — render layer prompts [Y/n/edit] for
 *      high-impact intents (focus/branch/quit/clear)
 *
 * Phase 5 wires patterns whose target commands already exist (Phases 2–4).
 * /focus and /branch (Phase 7) are added in their own phase.
 */

import type { GnosysConfig } from "../config.js";
import { getLLMProvider } from "../llm.js";

export type InferredIntent =
  | { command: "/pin"; args: string[]; confidence: "high" | "medium"; matchedPattern?: string }
  | { command: "/unpin"; args: string[]; confidence: "high" | "medium"; matchedPattern?: string }
  | { command: "/remember"; args: string[]; confidence: "high" | "medium"; matchedPattern?: string }
  | { command: "/save-turn"; args: string[]; confidence: "high" | "medium"; matchedPattern?: string }
  | { command: "/recall"; args: string[]; confidence: "high" | "medium"; matchedPattern?: string }
  | { command: "/reinforce"; args: string[]; confidence: "high" | "medium"; matchedPattern?: string }
  | { command: "/attach"; args: string[]; confidence: "high" | "medium"; matchedPattern?: string }
  | { command: "/quit"; args: string[]; confidence: "high" | "medium"; matchedPattern?: string };

interface PatternRule {
  /** Regex to match. Capture group 1 is the args text (joined as `args[0]` if present). */
  pattern: RegExp;
  command: InferredIntent["command"];
  /** Whether this is a destructive action that needs confirm-before-fire. */
  destructive: boolean;
  /** Human-readable description shown in the confirm prompt. */
  description: string;
}

// Patterns are ordered most specific → most general. First match wins.
const PATTERNS: PatternRule[] = [
  // Quit/exit
  {
    pattern: /^\s*(?:thanks[,.\s]*)?(?:that(?:'s| is) all|i'?m done|goodbye|bye|quit|exit)\s*[.!]?\s*$/i,
    command: "/quit",
    destructive: true,
    description: "exit chat",
  },

  // Save the last exchange — must come BEFORE /remember (which also matches "save ...")
  {
    pattern: /^\s*(?:let'?s\s+)?save\s+(?:that|this|the)\s+(?:exchange|turn|answer)\s*\.?\s*$/i,
    command: "/save-turn",
    destructive: false,
    description: "save the last exchange",
  },

  // Save / remember (decision-language)
  {
    pattern: /^\s*(?:please\s+)?(?:remember|note|save)\s+(?:that\s+|this[:\s]+)?(.+?)\s*$/i,
    command: "/remember",
    destructive: false,
    description: "save as a memory",
  },
  {
    pattern: /^\s*(?:let'?s\s+)?(?:commit|note this[:\s]+)\s+(?:down\s+)?(.+?)\s*$/i,
    command: "/remember",
    destructive: false,
    description: "save as a memory",
  },

  // Recall / lookup
  {
    pattern: /^\s*(?:what (?:did|do) we (?:decide|say|note)\s+(?:about\s+)?|look up\s+|find me (?:the\s+)?)(.+?)\s*\??$/i,
    command: "/recall",
    destructive: false,
    description: "preview recall",
  },

  // Pin / unpin
  {
    pattern: /^\s*(?:pin|keep)\s+(?:this\s+|that\s+)?([\w-]+(?:-[A-Z0-9]+)?)\s*$/i,
    command: "/pin",
    destructive: false,
    description: "pin a memory",
  },
  {
    pattern: /^\s*unpin\s+([\w-]+(?:-[A-Z0-9]+)?)\s*$/i,
    command: "/unpin",
    destructive: false,
    description: "unpin a memory",
  },

  // Reinforce — explicit positive feedback
  {
    pattern: /^\s*(?:that('s| was)?\s+(?:helpful|useful|perfect|great)|(?:helpful|perfect|great|exactly|spot on)|good answer)[.!\s]*$/i,
    command: "/reinforce",
    destructive: false,
    description: "reinforce the most recent cited memory",
  },

  // Attach — when the user pastes a path that looks like a file
  {
    pattern: /^\s*(?:attach|ingest|see this file:?)\s+(\S+)\s*$/i,
    command: "/attach",
    destructive: false,
    description: "ingest a file",
  },
];

/** Try to match a user input against the pattern rules. Returns null if no pattern fires. */
export function matchPattern(userInput: string): InferredIntent | null {
  for (const rule of PATTERNS) {
    const m = userInput.match(rule.pattern);
    if (m) {
      const captured = m[1]?.trim();
      const args = captured ? [captured] : [];
      return {
        command: rule.command,
        args,
        confidence: "high",
        matchedPattern: rule.pattern.source,
      };
    }
  }
  return null;
}

/** True when the input has imperative-y signals — a hint that LLM classification might pay off. */
export function hasImperativeSignal(userInput: string): boolean {
  const trimmed = userInput.trim().toLowerCase();
  // Starts with a verb or "let's" / "should we" — a hint of intent
  return /^(let'?s |should we |can you |please |go (?:ahead and )?|now |next[,:.\s])/i.test(trimmed);
}

/**
 * Optional: ask a cheap LLM to classify the intent.
 * Returns null when the LLM is unavailable or the response can't be parsed.
 */
async function classifyWithLLM(
  config: GnosysConfig,
  userInput: string,
): Promise<InferredIntent | null> {
  try {
    const provider = getLLMProvider(config, "structuring");
    const prompt = `You are a router. Map this user message to ONE of these chat commands, or "none" if it's just a normal chat turn.

Commands:
  /pin <id>           pin a memory by ID (the user named a specific memory)
  /unpin <id>         unpin a memory by ID
  /remember <text>    save free text as a new memory
  /save-turn          save the last user+assistant exchange
  /recall <query>     preview what would be recalled for this query
  /reinforce <id>     mark a recalled memory as useful
  /attach <path>      ingest a file
  /quit               exit chat

Output STRICT JSON only:
{"command": "/<name>" | "none", "args": ["..."], "confidence": "high" | "medium" | "low"}

User message: ${userInput}`;

    const raw = await provider.generate(prompt, { maxTokens: 200 });
    const trimmed = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    const parsed = JSON.parse(trimmed) as { command?: string; args?: string[]; confidence?: string };

    if (!parsed.command || parsed.command === "none") return null;
    const validCmds = ["/pin", "/unpin", "/remember", "/save-turn", "/recall", "/reinforce", "/attach", "/quit"];
    if (!validCmds.includes(parsed.command)) return null;
    if (parsed.confidence === "low") return null;

    return {
      command: parsed.command as InferredIntent["command"],
      args: parsed.args ?? [],
      confidence: (parsed.confidence as "high" | "medium") ?? "medium",
    };
  } catch {
    return null;
  }
}

/** Whether the inferred command is destructive enough to warrant a confirm prompt. */
export function isDestructive(command: InferredIntent["command"]): boolean {
  return command === "/quit";
}

/** Render a [Y/n/edit] prompt label for the inferred intent. */
export function describeIntent(intent: InferredIntent): string {
  const argsStr = intent.args.length > 0 ? ` ${intent.args.join(" ")}` : "";
  return `${intent.command}${argsStr}`;
}

/**
 * Hybrid classifier — returns the best-guess intent given user input,
 * conversation context, and an optional LLM config for fallback.
 *
 * Strategy:
 *   1. Pattern match first (free, fast)
 *   2. If no pattern AND there's an imperative signal AND we have a config → ask the LLM
 *   3. Otherwise return null (treat as a normal chat turn)
 */
export async function inferIntent(
  userInput: string,
  config: GnosysConfig | null,
): Promise<InferredIntent | null> {
  const fromPattern = matchPattern(userInput);
  if (fromPattern) return fromPattern;
  if (!config) return null;
  if (!hasImperativeSignal(userInput)) return null;
  return classifyWithLLM(config, userInput);
}

// ─── Per-session learning: auto-accept after N confirms of a pattern ─────

export interface IntentAcceptanceLog {
  /** Map of pattern source → number of times the user accepted that pattern. */
  acceptCounts: Map<string, number>;
}

export function newAcceptanceLog(): IntentAcceptanceLog {
  return { acceptCounts: new Map() };
}

const AUTO_ACCEPT_THRESHOLD = 5;

/** Has this pattern been accepted enough times to skip confirmation? */
export function shouldAutoAccept(
  log: IntentAcceptanceLog,
  matchedPattern: string | undefined,
): boolean {
  if (!matchedPattern) return false;
  const count = log.acceptCounts.get(matchedPattern) ?? 0;
  return count >= AUTO_ACCEPT_THRESHOLD;
}

/** Record a confirmed acceptance of a pattern. */
export function recordAcceptance(
  log: IntentAcceptanceLog,
  matchedPattern: string | undefined,
): void {
  if (!matchedPattern) return;
  log.acceptCounts.set(matchedPattern, (log.acceptCounts.get(matchedPattern) ?? 0) + 1);
}

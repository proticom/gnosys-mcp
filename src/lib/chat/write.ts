/**
 * Chat-side memory writing — promote chat content to gnosys memories.
 *
 * Handles three triggers:
 *   /remember <text>     explicit user-marked insight
 *   /save-turn           distill the last user+assistant exchange
 *   /attach <file>       ingest a file via the multimodal pipeline
 *
 * All promoted memories carry session provenance:
 *   tags.session: [<sessionId>]
 *   tags.from-chat: ["true"]
 *   tags.source: ["remember" | "save-turn" | "auto" | "attach"]
 */

import type { GnosysDB, DbMemory } from "../db.js";
import type { GnosysConfig } from "../config.js";
import { getLLMProvider } from "../llm.js";
import type { Turn } from "./types.js";

type PromoteSource = "remember" | "save-turn" | "auto" | "attach";

export interface PromoteOptions {
  /** Free-form text to save. */
  content: string;
  /** Optional override for category (default depends on source). */
  category?: string;
  /** Optional override for title (default: derived from first line / LLM). */
  title?: string;
  /** Source trigger — recorded as a tag for provenance. */
  source: PromoteSource;
  /** Session ID for provenance. */
  sessionId: string;
  /** Project ID to scope the memory to (null → user scope). */
  projectId: string | null;
  /** Optional structuring config (when LLM is available). Set to null to skip LLM. */
  config?: GnosysConfig | null;
}

export interface PromoteResult {
  id: string;
  title: string;
  category: string;
}

/** Build the structuring prompt for save-turn / auto-promote (LLM-assisted). */
function buildStructurePrompt(content: string, source: PromoteSource): string {
  return `You are extracting one memory from chat content. Output STRICT JSON only — no markdown fences, no commentary.

Schema:
{
  "title": "<5–10 word title>",
  "category": "decisions | architecture | concepts | requirements | landscape | open-questions | roadmap",
  "tags": ["<3–6 lowercase domain words>"],
  "relevance": "<space-separated keyword cloud for discovery>"
}

Source: ${source}
Content:
${content}

Output the JSON object only.`;
}

interface StructuredFields {
  title: string;
  category: string;
  tags: string[];
  relevance: string;
}

const VALID_CATEGORIES = new Set([
  "decisions",
  "architecture",
  "concepts",
  "requirements",
  "landscape",
  "open-questions",
  "roadmap",
]);

const FALLBACK_CATEGORY: Record<PromoteSource, string> = {
  remember: "concepts",
  "save-turn": "concepts",
  auto: "decisions",
  attach: "concepts",
};

/** Heuristic fallback when LLM isn't available. Uses the first line as the title. */
function deriveFieldsFallback(content: string, source: PromoteSource): StructuredFields {
  const firstLine = content.split(/\n/, 1)[0].trim();
  const title = firstLine.length > 60 ? firstLine.slice(0, 57) + "..." : firstLine || "Memory";
  return {
    title,
    category: FALLBACK_CATEGORY[source],
    tags: [],
    relevance: content.split(/\s+/).slice(0, 20).join(" "),
  };
}

async function deriveFieldsViaLLM(
  config: GnosysConfig,
  content: string,
  source: PromoteSource,
): Promise<StructuredFields | null> {
  try {
    const provider = getLLMProvider(config, "structuring");
    const raw = await provider.generate(buildStructurePrompt(content, source), { maxTokens: 400 });
    // Tolerate the model returning ```json ... ``` despite our instructions
    const trimmed = raw.replace(/^```(?:json)?\s*|\s*```$/g, "").trim();
    const parsed = JSON.parse(trimmed) as Partial<StructuredFields>;
    if (!parsed.title || !parsed.category) return null;
    return {
      title: parsed.title,
      category: VALID_CATEGORIES.has(parsed.category) ? parsed.category : FALLBACK_CATEGORY[source],
      tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
      relevance: typeof parsed.relevance === "string" ? parsed.relevance : "",
    };
  } catch {
    return null;
  }
}

/**
 * Write a chat-sourced memory to the central DB. Returns the assigned ID.
 *
 * Uses LLM structuring when config is provided and the structuring provider
 * is reachable; falls back to a heuristic title + category otherwise.
 */
export async function promoteToMemory(
  db: GnosysDB,
  opts: PromoteOptions,
): Promise<PromoteResult> {
  // Try LLM first; fall back if unavailable or on error
  let fields: StructuredFields | null = null;
  if (opts.config) {
    fields = await deriveFieldsViaLLM(opts.config, opts.content, opts.source);
  }
  if (!fields) {
    fields = deriveFieldsFallback(opts.content, opts.source);
  }

  // Caller-provided overrides win
  if (opts.title) fields.title = opts.title;
  if (opts.category && VALID_CATEGORIES.has(opts.category)) fields.category = opts.category;

  // Provenance tags injected on top of any LLM-suggested ones
  const allTags = [
    ...fields.tags,
    `session:${opts.sessionId}`,
    `from-chat:true`,
    `source:${opts.source}`,
  ];

  const id = db.getNextId(fields.category, opts.projectId ?? undefined);
  const now = new Date().toISOString();
  const today = now.split("T")[0];

  const memory: Omit<DbMemory, "embedding" | "source_file" | "source_page" | "source_timerange"> = {
    id,
    title: fields.title,
    category: fields.category,
    content: `# ${fields.title}\n\n${opts.content}`,
    summary: null,
    tags: JSON.stringify(allTags),
    relevance: fields.relevance,
    author: opts.source === "auto" ? "ai" : "human+ai",
    authority: "declared",
    confidence: 0.85,
    reinforcement_count: 0,
    content_hash: fnv1a(opts.content),
    status: "active",
    tier: "active",
    supersedes: null,
    superseded_by: null,
    last_reinforced: null,
    created: today,
    modified: today,
    source_path: null,
    project_id: opts.projectId,
    scope: opts.projectId ? "project" : "user",
  };

  db.insertMemory(memory);
  db.logAudit({
    timestamp: now,
    operation: "write",
    memory_id: id,
    details: JSON.stringify({ source: `chat:${opts.source}`, sessionId: opts.sessionId }),
    duration_ms: null,
    trace_id: null,
  });

  return { id, title: fields.title, category: fields.category };
}

/** Build the content for /save-turn from the most recent user+assistant exchange. */
export function lastExchange(buffer: Turn[]): { user: string; assistant: string } | null {
  // Walk from the end to find the last assistant turn, then the user turn before it
  let assistantIdx = -1;
  for (let i = buffer.length - 1; i >= 0; i--) {
    if (buffer[i].role === "assistant") {
      assistantIdx = i;
      break;
    }
  }
  if (assistantIdx < 1) return null;
  let userIdx = -1;
  for (let i = assistantIdx - 1; i >= 0; i--) {
    if (buffer[i].role === "user") {
      userIdx = i;
      break;
    }
  }
  if (userIdx < 0) return null;
  return {
    user: buffer[userIdx].text,
    assistant: buffer[assistantIdx].text,
  };
}

/** Format a save-turn pair as a markdown exchange suitable for memory content. */
export function formatExchange(pair: { user: string; assistant: string }): string {
  return `**Question / context:**\n${pair.user}\n\n**Answer / decision:**\n${pair.assistant}`;
}

// ─── Auto-promote heuristic ──────────────────────────────────────────────

const AUTO_PROMOTE_PATTERNS: Array<{ pattern: RegExp; source: PromoteSource; reason: string }> = [
  { pattern: /\b(we (decided|agreed|chose) to|let's (go with|commit to|use))\b/i, source: "auto", reason: "decision-language" },
  { pattern: /\b(I learned|the answer is|turns out|it works because)\b/i, source: "auto", reason: "insight-language" },
  { pattern: /\b(let's note|note that|let's remember|don't forget)\b/i, source: "auto", reason: "note-request" },
];

export interface AutoPromoteHint {
  reason: string;
  match: string;
}

/**
 * Scan a user turn for "looks like a decision/insight worth saving" patterns.
 * Returns a hint that the TUI can surface as an inline confirm prompt.
 * Returns null when nothing matches.
 */
export function detectAutoPromote(userText: string): AutoPromoteHint | null {
  for (const { pattern, reason } of AUTO_PROMOTE_PATTERNS) {
    const m = userText.match(pattern);
    if (m) {
      return { reason, match: m[0] };
    }
  }
  return null;
}

// ─── helpers ─────────────────────────────────────────────────────────────

function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

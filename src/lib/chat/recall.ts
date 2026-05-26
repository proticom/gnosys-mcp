/**
 * Chat-side memory recall.
 *
 * Wraps the existing federated search to produce a set of memories suitable
 * for injection into the LLM system prompt. Always includes pinned memories
 * regardless of search relevance.
 */

import type { GnosysDB, DbMemory } from "../db.js";
import { federatedSearch } from "../federated.js";
import type { Turn } from "./types.js";

export type RecallScope = "project" | "user" | "global" | "federated";

export interface RecallOptions {
  /** Search query — usually the latest user input plus a tail of conversation. */
  query: string;
  /** Recall scope. "federated" means search across all scopes with tier boosting. */
  scope: RecallScope;
  /** Active project ID (used by federated search for tier boosting). Null when no project context. */
  projectId: string | null;
  /** Confidence threshold — drop memories below this. 0 disables. */
  threshold: number;
  /** Pinned memory IDs — always included, ranked first. */
  pinnedIds: string[];
  /** Max non-pinned results (default 5). */
  limit?: number;
}

export interface RecalledMemory {
  id: string;
  title: string;
  content: string;
  category: string;
  scope: string;
  confidence: number;
  /** True when included because it's pinned (not because the query matched it). */
  pinned: boolean;
  /** Federated search score; 0 for pinned memories that didn't match the query. */
  score: number;
}

export interface RecallResult {
  memories: RecalledMemory[];
  /** The query string actually run (may differ from input — e.g. trimmed). */
  query: string;
  /** Total candidates considered before threshold/limit. */
  considered: number;
}

const MAX_QUERY_LEN = 200;

/** Build a search query from the current user input + a few recent turns for context. */
export function buildRecallQuery(userInput: string, buffer: Turn[]): string {
  const tail = buffer
    .filter((t) => t.role === "user" || t.role === "assistant")
    .slice(-2)
    .map((t) => t.text)
    .join(" ");
  const combined = `${userInput} ${tail}`.trim().slice(0, MAX_QUERY_LEN);
  return combined;
}

/**
 * Run recall for one chat turn. Returns pinned memories first (always),
 * then top federated matches respecting scope and threshold.
 */
export function runRecall(db: GnosysDB, opts: RecallOptions): RecallResult {
  const limit = opts.limit ?? 5;
  const memories: RecalledMemory[] = [];
  const seen = new Set<string>();

  // 1. Pinned memories — always included (ranked first)
  for (const id of opts.pinnedIds) {
    const mem = db.getMemory(id);
    if (!mem) continue;
    seen.add(id);
    memories.push({
      id: mem.id,
      title: mem.title,
      content: mem.content,
      category: mem.category,
      scope: mem.scope,
      confidence: mem.confidence,
      pinned: true,
      score: 0,
    });
  }

  // 2. Federated search — but exclude pinned IDs and apply scope filter
  const scopeFilter =
    opts.scope === "federated" ? undefined : ([opts.scope] as const);

  const results = federatedSearch(db, opts.query, {
    limit: Math.max(limit * 2, 20), // over-fetch so threshold can drop some
    projectId: opts.projectId,
    scopeFilter: scopeFilter as never,
  });

  const considered = results.length + opts.pinnedIds.length;

  for (const r of results) {
    if (memories.length - opts.pinnedIds.length >= limit) break;
    if (seen.has(r.id)) continue;

    const mem = db.getMemory(r.id);
    if (!mem) continue;
    if (mem.confidence < opts.threshold) continue;

    seen.add(r.id);
    memories.push({
      id: mem.id,
      title: mem.title,
      content: mem.content,
      category: mem.category,
      scope: mem.scope,
      confidence: mem.confidence,
      pinned: false,
      score: r.score,
    });
  }

  return {
    memories,
    query: opts.query,
    considered,
  };
}

/**
 * Render recalled memories as a system-prompt block. Pinned memories are
 * marked so the model knows the user has explicitly anchored them.
 */
export function formatRecallForPrompt(memories: RecalledMemory[]): string {
  if (memories.length === 0) return "";
  const blocks = memories.map((m) => {
    const pinTag = m.pinned ? ` pinned="true"` : "";
    return `<memory id="${m.id}" category="${m.category}" confidence="${m.confidence}"${pinTag}>\n# ${m.title}\n${m.content}\n</memory>`;
  });
  return [
    "RELEVANT MEMORY (you have persistent memory via Gnosys; cite ids when you use them):",
    ...blocks,
  ].join("\n\n");
}

/** Reinforce a memory: bump modified date so it's surfaced as recent. */
export function reinforceMemory(db: GnosysDB, memoryId: string): boolean {
  const mem = db.getMemory(memoryId);
  if (!mem) return false;
  db.updateMemory(memoryId, {
    modified: new Date().toISOString(),
    reinforcement_count: (mem.reinforcement_count ?? 0) + 1,
    last_reinforced: new Date().toISOString(),
  } as Partial<DbMemory>);
  return true;
}

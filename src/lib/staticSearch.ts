/**
 * Gnosys Web — Zero-dependency runtime search module.
 *
 * Exported as `gnosys/web` subpath. Loads a pre-computed gnosys-index.json
 * and provides search functions for serverless chatbot integrations.
 *
 * CRITICAL: This module must have ZERO dependencies beyond Node.js built-ins.
 * No better-sqlite3, no gray-matter, no @anthropic-ai/sdk, nothing.
 */

import { readFileSync, existsSync } from "fs";

// ─── Types ───────────────────────────────────────────────────────────────

export interface GnosysWebIndex {
  version: number;
  generated: string;
  documentCount: number;
  documents: DocumentManifest[];
  invertedIndex: Record<string, IndexEntry[]>;
}

export interface DocumentManifest {
  id: string;
  path: string;
  title: string;
  category: string;
  tags: string[];
  relevance: string;
  contentHash: string;
  contentLength: number;
  created: string | null;
  status: string;
}

export interface IndexEntry {
  docIndex: number;
  score: number;
}

export interface SearchOptions {
  limit?: number;
  minScore?: number;
  category?: string;
  tags?: string[];
  boostRecent?: boolean;
}

export interface SearchResult {
  document: DocumentManifest;
  score: number;
  matchedTokens: string[];
}

// ─── Module-level cache ──────────────────────────────────────────────────

let cachedIndex: GnosysWebIndex | null = null;
let cachedSource: string | null = null;

// ─── Stop words (same list used by webIndex.ts at build time) ────────────

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
  "of", "with", "by", "from", "is", "it", "as", "be", "was", "are",
  "been", "has", "had", "have", "do", "does", "did", "will", "would",
  "could", "should", "may", "might", "shall", "can", "this", "that",
  "these", "those", "not", "no", "nor", "so", "if", "then", "than",
  "too", "very", "just", "about", "above", "after", "again", "all",
  "also", "am", "any", "because", "before", "between", "both", "each",
  "few", "he", "she", "her", "him", "his", "how", "its", "me", "more",
  "most", "my", "new", "now", "only", "other", "our", "out", "own",
  "re", "same", "some", "such", "up", "us", "we", "what", "when",
  "where", "which", "who", "whom", "why", "you", "your",
]);

// ─── Tokenization ────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Load a pre-computed Gnosys web index from a file path or raw JSON string.
 * Caches the result for repeated calls with the same source.
 */
export function loadIndex(pathOrJson: string): GnosysWebIndex {
  if (cachedIndex && cachedSource === pathOrJson) {
    return cachedIndex;
  }

  let raw: string;
  if (pathOrJson.trimStart().startsWith("{")) {
    raw = pathOrJson;
  } else {
    if (!existsSync(pathOrJson)) {
      throw new Error(`Gnosys web index not found: ${pathOrJson}`);
    }
    raw = readFileSync(pathOrJson, "utf-8");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON in Gnosys web index");
  }

  const index = parsed as GnosysWebIndex;

  if (!index.version || typeof index.version !== "number") {
    throw new Error("Invalid Gnosys web index: missing or invalid version field");
  }

  if (index.version > 1) {
    throw new Error(
      `Gnosys web index version ${index.version} is not supported by this version of gnosys/web. ` +
        `Please update the gnosys package.`
    );
  }

  cachedIndex = index;
  cachedSource = pathOrJson;
  return index;
}

/**
 * Clear the cached index (useful for testing).
 */
export function clearIndexCache(): void {
  cachedIndex = null;
  cachedSource = null;
}

/**
 * Search the pre-computed index and return ranked results.
 */
export function search(
  index: GnosysWebIndex,
  query: string,
  options: SearchOptions = {}
): SearchResult[] {
  const { limit = 6, minScore = 0.1, category, tags, boostRecent = false } = options;

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  // Accumulate scores per document
  const docScores = new Map<number, { score: number; matchedTokens: string[] }>();

  for (const token of queryTokens) {
    const entries = index.invertedIndex[token];
    if (!entries) continue;

    for (const entry of entries) {
      const existing = docScores.get(entry.docIndex);
      if (existing) {
        existing.score += entry.score;
        if (!existing.matchedTokens.includes(token)) {
          existing.matchedTokens.push(token);
        }
      } else {
        docScores.set(entry.docIndex, {
          score: entry.score,
          matchedTokens: [token],
        });
      }
    }
  }

  // Build results with filters
  const results: SearchResult[] = [];

  for (const [docIndex, { score, matchedTokens }] of docScores) {
    const doc = index.documents[docIndex];
    if (!doc) continue;

    // Apply filters
    if (category && doc.category !== category) continue;
    if (tags && tags.length > 0 && !tags.some((t) => doc.tags.includes(t))) continue;

    let finalScore = score;

    // Optional recency boost
    if (boostRecent && doc.created) {
      const ageMs = Date.now() - new Date(doc.created).getTime();
      const ageDays = ageMs / (1000 * 60 * 60 * 24);
      // Boost documents less than 30 days old, max 1.5x
      if (ageDays < 30) {
        finalScore *= 1 + 0.5 * (1 - ageDays / 30);
      }
    }

    if (finalScore < minScore) continue;

    results.push({ document: doc, score: finalScore, matchedTokens });
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  return results.slice(0, limit);
}

/**
 * Get a specific document's metadata by ID or path.
 */
export function getDocument(
  index: GnosysWebIndex,
  idOrPath: string
): DocumentManifest | null {
  return (
    index.documents.find(
      (d) => d.id === idOrPath || d.path === idOrPath
    ) ?? null
  );
}

/**
 * List all documents, optionally filtered by category, tags, or status.
 */
export function listDocuments(
  index: GnosysWebIndex,
  filter?: { category?: string; tags?: string[]; status?: string }
): DocumentManifest[] {
  if (!filter) return [...index.documents];

  return index.documents.filter((d) => {
    if (filter.category && d.category !== filter.category) return false;
    if (filter.tags && filter.tags.length > 0 && !filter.tags.some((t) => d.tags.includes(t)))
      return false;
    if (filter.status && d.status !== filter.status) return false;
    return true;
  });
}

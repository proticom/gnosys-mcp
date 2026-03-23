/**
 * Gnosys Web Index — Build-time inverted index generator.
 *
 * Reads a directory of Gnosys markdown files (YAML frontmatter + content),
 * builds a TF-IDF weighted inverted index mapping tokens to documents,
 * and writes the result as a JSON file (gnosys-index.json).
 */

import fs from "fs/promises";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import path from "path";
import { createHash } from "crypto";
import matter from "gray-matter";
import type {
  GnosysWebIndex,
  DocumentManifest,
  IndexEntry,
} from "./staticSearch.js";

// Re-export types for convenience
export type { GnosysWebIndex, DocumentManifest, IndexEntry };

// ─── Options ─────────────────────────────────────────────────────────────

export interface BuildIndexOptions {
  stopWords?: boolean;
  minTokenLength?: number;
  maxTokensPerDoc?: number;
  includeArchived?: boolean;
}

// ─── Stop words ──────────────────────────────────────────────────────────

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

function tokenize(text: string, minLength: number): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= minLength);
}

function filterStopWords(tokens: string[]): string[] {
  return tokens.filter((t) => !STOP_WORDS.has(t));
}

// ─── Tag flattening ──────────────────────────────────────────────────────

function flattenTags(
  tags: Record<string, string[]> | string[] | undefined | null
): string[] {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags.map((t) => String(t));
  if (typeof tags === "object") {
    const flat: string[] = [];
    for (const values of Object.values(tags)) {
      if (Array.isArray(values)) {
        for (const v of values) {
          const s = String(v);
          if (!flat.includes(s)) flat.push(s);
        }
      }
    }
    return flat;
  }
  return [];
}

// ─── Find markdown files recursively ─────────────────────────────────────

function findMarkdownFiles(dir: string): string[] {
  const results: string[] = [];

  function walk(current: string): void {
    if (!existsSync(current)) return;
    const entries = readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results.sort();
}

// ─── Build Index ─────────────────────────────────────────────────────────

/**
 * Build a search index from a directory of Gnosys markdown files.
 */
export function buildIndexSync(
  knowledgeDir: string,
  options: BuildIndexOptions = {}
): GnosysWebIndex {
  const {
    stopWords = true,
    minTokenLength = 2,
    maxTokensPerDoc = 500,
    includeArchived = false,
  } = options;

  const resolvedDir = path.resolve(knowledgeDir);
  const mdFiles = findMarkdownFiles(resolvedDir);

  const documents: DocumentManifest[] = [];
  // Collect weighted tokens per document for TF calculation
  const docTokenSets: Array<Map<string, number>> = [];

  for (const filePath of mdFiles) {
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      continue; // skip unreadable files
    }

    let parsed: matter.GrayMatterFile<string>;
    try {
      parsed = matter(raw);
    } catch {
      continue; // skip files with malformed frontmatter
    }

    const fm = parsed.data as Record<string, unknown>;
    const status = (fm.status as string) || "active";

    if (!includeArchived && status === "archived") continue;

    const relativePath = path.relative(resolvedDir, filePath);
    const contentBody = parsed.content.trim();
    const contentHash = createHash("sha256").update(raw).digest("hex");
    const tags = flattenTags(fm.tags as Record<string, string[]> | string[] | undefined);
    const relevance = typeof fm.relevance === "string" ? fm.relevance : "";
    const title = typeof fm.title === "string" ? fm.title : path.basename(filePath, ".md");
    const id = typeof fm.id === "string" ? fm.id : path.basename(filePath, ".md");
    const category = typeof fm.category === "string" ? fm.category : "general";
    const created = typeof fm.created === "string" ? fm.created : null;

    const docIndex = documents.length;
    documents.push({
      id,
      path: relativePath,
      title,
      category,
      tags,
      relevance,
      contentHash,
      contentLength: contentBody.length,
      created,
      status,
    });

    // Build weighted token map for this document
    const tokenScores = new Map<string, number>();

    function addTokens(text: string, weight: number): void {
      let tokens = tokenize(text, minTokenLength);
      if (stopWords) tokens = filterStopWords(tokens);

      // Count term frequency
      const tf = new Map<string, number>();
      for (const t of tokens) {
        tf.set(t, (tf.get(t) || 0) + 1);
      }

      for (const [token, count] of tf) {
        const current = tokenScores.get(token) || 0;
        tokenScores.set(token, current + count * weight);
      }
    }

    // Relevance keywords — highest weight (3x)
    addTokens(relevance, 3);

    // Tags — medium weight (2x)
    addTokens(tags.join(" "), 2);

    // Title — medium weight (2x)
    addTokens(title, 2);

    // Content body — standard weight (1x), capped
    const contentTokens = tokenize(contentBody, minTokenLength);
    const cappedContent = contentTokens.slice(0, maxTokensPerDoc).join(" ");
    addTokens(cappedContent, 1);

    docTokenSets.push(tokenScores);
  }

  // Build inverted index
  const invertedIndex: Record<string, IndexEntry[]> = {};

  // Compute IDF: log(N / df) where df = number of docs containing the token
  const docFrequency = new Map<string, number>();
  for (const tokenScores of docTokenSets) {
    for (const token of tokenScores.keys()) {
      docFrequency.set(token, (docFrequency.get(token) || 0) + 1);
    }
  }

  const N = documents.length || 1;

  for (let docIdx = 0; docIdx < docTokenSets.length; docIdx++) {
    const tokenScores = docTokenSets[docIdx];

    for (const [token, weightedTf] of tokenScores) {
      const df = docFrequency.get(token) || 1;
      const idf = Math.log(1 + N / df);
      const score = parseFloat((weightedTf * idf).toFixed(4));

      if (!invertedIndex[token]) {
        invertedIndex[token] = [];
      }
      invertedIndex[token].push({ docIndex: docIdx, score });
    }
  }

  // Sort tokens alphabetically for deterministic output
  const sortedIndex: Record<string, IndexEntry[]> = {};
  for (const token of Object.keys(invertedIndex).sort()) {
    sortedIndex[token] = invertedIndex[token];
  }

  return {
    version: 1,
    generated: new Date().toISOString(),
    documentCount: documents.length,
    documents,
    invertedIndex: sortedIndex,
  };
}

/**
 * Build a search index (async wrapper).
 */
export async function buildIndex(
  knowledgeDir: string,
  options?: BuildIndexOptions
): Promise<GnosysWebIndex> {
  return buildIndexSync(knowledgeDir, options);
}

/**
 * Write an index to a JSON file.
 */
export async function writeIndex(
  index: GnosysWebIndex,
  outputPath: string
): Promise<void> {
  const dir = path.dirname(outputPath);
  await fs.mkdir(dir, { recursive: true });
  writeFileSync(outputPath, JSON.stringify(index, null, 2), "utf-8");
}

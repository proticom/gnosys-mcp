/**
 * Gnosys Bulk Import — Structured data → atomic memories.
 * Supports CSV, JSON, JSONL formats with LLM or structured ingestion modes.
 * Shared core used by both the MCP tool and CLI command.
 */

import { parse as csvParse } from "csv-parse/sync";
import fs from "fs/promises";
import { GnosysIngestion } from "./ingest.js";
import { GnosysStore, MemoryFrontmatter } from "./store.js";
import { GnosysDB } from "./db.js";
import { syncMemoryToDb } from "./dbWrite.js";

// ─── Interfaces ──────────────────────────────────────────────────────────

export interface ImportOptions {
  format: "csv" | "json" | "jsonl";
  data: string; // File path, URL (http/https), or inline data
  mapping: Record<string, string>; // source field → gnosys field (title, category, content, tags, relevance)
  mode: "llm" | "structured";
  limit?: number;
  offset?: number;
  dryRun?: boolean;
  skipExisting?: boolean;
  batchCommit?: boolean; // Default: true
  concurrency?: number; // Parallel LLM calls, default: 5
  author?: "human" | "ai" | "human+ai";
  authority?: "declared" | "observed" | "imported" | "inferred";
  onProgress?: (progress: ImportProgress) => void;
}

export interface ImportProgress {
  processed: number;
  total: number;
  current: string;
  stage: "parsing" | "deduplicating" | "ingesting" | "writing" | "committing";
}

export interface ImportResult {
  imported: Array<{ title: string; category: string; path: string }>;
  skipped: string[];
  failed: Array<{ record: string; error: string }>;
  totalProcessed: number;
  duration: number;
}

// ─── URL Safety ──────────────────────────────────────────────────────────

function isSafeImportUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const hostname = url.hostname;
    if (hostname === "169.254.169.254" || hostname === "metadata.google.internal") return false;
    const ipv4Match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipv4Match) {
      const [, a, b] = ipv4Match.map(Number);
      if (a === 10) return false;
      if (a === 172 && b >= 16 && b <= 31) return false;
      if (a === 192 && b === 168) return false;
      if (a === 169 && b === 254) return false;
    }
    return true;
  } catch {
    return false;
  }
}

// ─── Parsing ─────────────────────────────────────────────────────────────

async function loadData(
  data: string,
  format: "csv" | "json" | "jsonl"
): Promise<Record<string, unknown>[]> {
  let raw: string;

  // Determine if data is a file path, URL, or inline
  if (data.startsWith("http://") || data.startsWith("https://")) {
    if (!isSafeImportUrl(data)) {
      throw new Error(`Refusing to fetch unsafe URL: ${data}`);
    }
    const response = await fetch(data);
    if (!response.ok) {
      throw new Error(`Failed to fetch URL: ${response.status} ${response.statusText}`);
    }
    raw = await response.text();
  } else if (
    data.trim().startsWith("[") ||
    data.trim().startsWith("{") ||
    data.includes(",") && data.includes("\n") && format === "csv"
  ) {
    // Inline data — use as-is
    raw = data;
  } else {
    // File path
    raw = await fs.readFile(data, "utf-8");
  }

  switch (format) {
    case "csv":
      return csvParse(raw, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });

    case "json": {
      const parsed = JSON.parse(raw);
      // Handle both arrays and objects with a data/foods/results array
      if (Array.isArray(parsed)) return parsed;
      // Common API response patterns
      for (const key of ["data", "foods", "results", "items", "records", "vulnerabilities"]) {
        if (Array.isArray(parsed[key])) return parsed[key];
      }
      throw new Error(
        "JSON must be an array or an object with a recognizable array field (data, foods, results, items, records, vulnerabilities)"
      );
    }

    case "jsonl":
      return raw
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));

    default:
      throw new Error(`Unsupported format: ${format}`);
  }
}

// ─── Field Mapping ───────────────────────────────────────────────────────

interface MappedRecord {
  title: string;
  category: string;
  content: string;
  tags?: Record<string, string[]>;
  relevance?: string;
  extraContext: string; // Unmapped fields concatenated for LLM context
}

function validateMapping(mapping: Record<string, string>): string[] {
  const errors: string[] = [];
  const validTargets = ["title", "category", "content", "tags", "relevance"];
  const hasTitle = Object.values(mapping).includes("title");

  if (!hasTitle) {
    errors.push("Mapping must include a field mapped to 'title'");
  }

  for (const [src, dst] of Object.entries(mapping)) {
    if (!validTargets.includes(dst)) {
      errors.push(`Invalid mapping target "${dst}" for field "${src}". Valid: ${validTargets.join(", ")}`);
    }
  }

  return errors;
}

function applyMapping(
  record: Record<string, unknown>,
  mapping: Record<string, string>
): MappedRecord {
  const mapped: Partial<MappedRecord> = {};
  const mappedSourceFields = new Set(Object.keys(mapping));
  const extraParts: string[] = [];

  for (const [src, dst] of Object.entries(mapping)) {
    const value = record[src];
    if (value === undefined || value === null) continue;

    switch (dst) {
      case "title":
        mapped.title = String(value);
        break;
      case "category":
        mapped.category = String(value)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");
        break;
      case "content":
        mapped.content = String(value);
        break;
      case "relevance":
        mapped.relevance = String(value);
        break;
      case "tags":
        // Accept comma-separated string or array
        if (Array.isArray(value)) {
          mapped.tags = { domain: value.map(String) };
        } else {
          mapped.tags = {
            domain: String(value)
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean),
          };
        }
        break;
    }
  }

  // Collect unmapped fields as extra context for LLM
  for (const [key, value] of Object.entries(record)) {
    if (!mappedSourceFields.has(key) && value !== undefined && value !== null) {
      const strVal = typeof value === "object" ? JSON.stringify(value) : String(value);
      if (strVal.length > 0 && strVal !== "null") {
        extraParts.push(`${key}: ${strVal}`);
      }
    }
  }

  return {
    title: mapped.title || "Untitled",
    category: mapped.category || "imported",
    content: mapped.content || "",
    tags: mapped.tags,
    relevance: mapped.relevance,
    extraContext: extraParts.join("\n"),
  };
}

// ─── Core Import ─────────────────────────────────────────────────────────

export async function performImport(
  store: GnosysStore,
  ingestion: GnosysIngestion,
  options: ImportOptions,
  db?: GnosysDB | null,
  projectId?: string | null,
  scope?: string
): Promise<ImportResult> {
  const startTime = Date.now();
  const results: ImportResult = {
    imported: [],
    skipped: [],
    failed: [],
    totalProcessed: 0,
    duration: 0,
  };

  const batchCommit = options.batchCommit !== false; // Default true
  const concurrency = options.concurrency || 5;
  const author = options.author || "ai";
  const authority = options.authority || "imported";

  // Phase 1: Parse data
  options.onProgress?.({
    processed: 0,
    total: 0,
    current: "Loading data...",
    stage: "parsing",
  });

  let records = await loadData(options.data, options.format);

  // Apply offset and limit
  if (options.offset && options.offset > 0) {
    records = records.slice(options.offset);
  }
  if (options.limit && options.limit > 0) {
    records = records.slice(0, options.limit);
  }

  const total = records.length;

  // Validate mapping
  const mappingErrors = validateMapping(options.mapping);
  if (mappingErrors.length > 0) {
    throw new Error(`Invalid field mapping:\n${mappingErrors.join("\n")}`);
  }

  // Phase 2: Dedup
  let existingTitles = new Set<string>();
  if (options.skipExisting) {
    options.onProgress?.({
      processed: 0,
      total,
      current: "Checking existing memories...",
      stage: "deduplicating",
    });

    const existing = await store.getAllMemories();
    existingTitles = new Set(
      existing.map((m) => m.frontmatter.title.toLowerCase())
    );
  }

  // Phase 3 & 4: Ingest + Write
  if (options.mode === "llm" && !ingestion.isLLMAvailable) {
    throw new Error(
      "LLM mode requires a configured LLM provider. Set ANTHROPIC_API_KEY, configure Ollama, or use --mode structured."
    );
  }

  // Process in batches for LLM concurrency
  for (let i = 0; i < records.length; i += concurrency) {
    const batch = records.slice(
      i,
      Math.min(i + concurrency, records.length)
    );

    const batchPromises = batch.map(async (record, batchIdx) => {
      const globalIdx = i + batchIdx;
      const mapped = applyMapping(record, options.mapping);

      // Dedup check
      if (
        options.skipExisting &&
        existingTitles.has(mapped.title.toLowerCase())
      ) {
        results.skipped.push(mapped.title);
        return;
      }

      options.onProgress?.({
        processed: globalIdx,
        total,
        current: mapped.title,
        stage: "ingesting",
      });

      try {
        let title: string;
        let category: string;
        let tags: Record<string, string[]>;
        let relevance: string;
        let content: string;
        let confidence: number;
        let filename: string;

        if (options.mode === "llm") {
          // Build rich text input for LLM
          let rawInput = `Title: ${mapped.title}\nCategory: ${mapped.category}`;
          if (mapped.content) rawInput += `\n\n${mapped.content}`;
          if (mapped.extraContext) rawInput += `\n\nAdditional data:\n${mapped.extraContext}`;

          const result = await ingestion.ingest(rawInput);
          title = result.title;
          category = result.category;
          tags = result.tags;
          relevance = result.relevance;
          content = result.content;
          confidence = result.confidence;
          filename = result.filename;
        } else {
          // Structured mode — direct mapping
          title = mapped.title;
          category = mapped.category;
          tags = mapped.tags || {};
          relevance = mapped.relevance || "";
          content = mapped.content || mapped.extraContext || title;
          confidence = 0.8;
          filename = title
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "")
            .substring(0, 60);
        }

        if (options.dryRun) {
          results.imported.push({
            title,
            category,
            path: `${category}/${filename}.md`,
          });
          return;
        }

        // Write memory to central DB
        const id = await store.generateId(category);
        const today = new Date().toISOString().split("T")[0];

        const frontmatter: MemoryFrontmatter = {
          id,
          title,
          category,
          tags,
          relevance,
          author,
          authority,
          confidence,
          created: today,
          modified: today,
          status: "active" as const,
          supersedes: null,
        };

        const fullContent = `# ${title}\n\n${content}`;
        const relativePath = `${category}/${filename}.md`;

        if (db) {
          syncMemoryToDb(db, frontmatter, fullContent, relativePath, projectId, scope);
        }

        results.imported.push({ title, category, path: relativePath });
      } catch (err) {
        results.failed.push({
          record: mapped.title || `Record #${globalIdx}`,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    });

    // Wait for batch to complete
    await Promise.all(batchPromises);

    // Small delay between LLM batches to avoid rate limits
    if (
      options.mode === "llm" &&
      i + concurrency < records.length
    ) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  results.totalProcessed = total;

  // Phase 5: (batch commit removed — DB writes are immediate)

  results.duration = Date.now() - startTime;
  return results;
}

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Format a human-readable summary of import results.
 */
export function formatImportSummary(result: ImportResult): string {
  const lines: string[] = [];
  const durationSec = (result.duration / 1000).toFixed(1);

  lines.push(`Import complete in ${durationSec}s`);
  lines.push(`  Imported: ${result.imported.length}`);
  lines.push(`  Skipped:  ${result.skipped.length}`);
  lines.push(`  Failed:   ${result.failed.length}`);
  lines.push(`  Total:    ${result.totalProcessed}`);

  if (result.failed.length > 0) {
    lines.push("");
    lines.push("Failures:");
    for (const f of result.failed.slice(0, 10)) {
      lines.push(`  - ${f.record}: ${f.error}`);
    }
    if (result.failed.length > 10) {
      lines.push(`  ... and ${result.failed.length - 10} more`);
    }
  }

  return lines.join("\n");
}

/**
 * Estimate import duration for smart threshold guidance.
 */
export function estimateDuration(
  recordCount: number,
  mode: "llm" | "structured",
  concurrency: number = 5
): string {
  if (mode === "structured") {
    // ~50ms per record for structured
    const seconds = Math.ceil((recordCount * 50) / 1000);
    return seconds < 60 ? `~${seconds}s` : `~${Math.ceil(seconds / 60)}m`;
  }

  // LLM mode: ~1.5s per record with concurrency batching
  const seconds = Math.ceil((recordCount * 1500) / concurrency / 1000);
  if (seconds < 60) return `~${seconds}s`;
  if (seconds < 3600) return `~${Math.ceil(seconds / 60)}m`;
  return `~${(seconds / 3600).toFixed(1)}h`;
}

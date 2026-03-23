/**
 * Gnosys Bootstrap — Batch-ingest existing documents into the memory store.
 *
 * Scans a directory for markdown/text files and creates memories from them.
 * Supports both raw import (no LLM) and enriched import (LLM structures content).
 */

import fs from "fs/promises";
import path from "path";
import matter from "gray-matter";
import { glob } from "glob";
import { GnosysStore, MemoryFrontmatter, Memory } from "./store.js";

export interface BootstrapOptions {
  /** Source directory to scan */
  sourceDir: string;
  /** File glob patterns to include */
  patterns?: string[];
  /** Whether to skip files that already exist in the store */
  skipExisting?: boolean;
  /** Default category for ingested files */
  defaultCategory?: string;
  /** Default author */
  defaultAuthor?: "human" | "ai" | "human+ai";
  /** Default authority level */
  defaultAuthority?: "declared" | "observed" | "imported" | "inferred";
  /** Default confidence */
  defaultConfidence?: number;
  /** Whether to preserve existing frontmatter if present */
  preserveFrontmatter?: boolean;
  /** Dry run - report what would be imported without writing */
  dryRun?: boolean;
}

export interface BootstrapResult {
  /** Files that were successfully imported */
  imported: string[];
  /** Files that were skipped (already exist) */
  skipped: string[];
  /** Files that failed to import */
  failed: Array<{ path: string; error: string }>;
  /** Total files scanned */
  totalScanned: number;
}

/**
 * Scan a directory and discover importable files.
 */
export async function discoverFiles(
  sourceDir: string,
  patterns: string[] = ["**/*.md"]
): Promise<string[]> {
  const resolvedDir = path.resolve(sourceDir);
  const files: string[] = [];

  for (const pattern of patterns) {
    const matches = await glob(pattern, {
      cwd: resolvedDir,
      nodir: true,
      absolute: false,
    });
    for (const m of matches) {
      if (!files.includes(m)) {
        files.push(m);
      }
    }
  }

  return files.sort();
}

/**
 * Extract a title from file content or filename.
 */
function extractTitle(content: string, filePath: string): string {
  // Try to find a markdown H1
  const h1Match = content.match(/^#\s+(.+)$/m);
  if (h1Match) return h1Match[1].trim();

  // Fall back to filename
  const basename = path.basename(filePath, path.extname(filePath));
  return basename
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Determine category from file path structure.
 * If the file is in a subdirectory, use that as the category.
 */
function inferCategory(relativePath: string, defaultCategory: string): string {
  const dir = path.dirname(relativePath);
  if (dir === "." || dir === "") return defaultCategory;
  // Use the first directory level as category
  return dir.split("/")[0].replace(/[^a-z0-9-]/gi, "-").toLowerCase();
}

/**
 * Create a slug from a title for use as a filename.
 */
function titleToSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .substring(0, 60);
}

/**
 * Parse a single file and prepare it for import.
 */
export function parseFileForImport(
  content: string,
  relativePath: string,
  options: BootstrapOptions
): { frontmatter: Partial<MemoryFrontmatter>; body: string } {
  const defaultCategory = options.defaultCategory || "imported";
  const defaultAuthor = options.defaultAuthor || "human";
  const defaultAuthority = options.defaultAuthority || "imported";
  const defaultConfidence = options.defaultConfidence ?? 0.7;

  // Check if file already has frontmatter
  const parsed = matter(content);
  const existingFm = parsed.data as Partial<MemoryFrontmatter>;
  const body = parsed.content.trim();

  const title = (options.preserveFrontmatter && existingFm.title)
    ? existingFm.title
    : extractTitle(body || content, relativePath);

  const category = (options.preserveFrontmatter && existingFm.category)
    ? existingFm.category
    : inferCategory(relativePath, defaultCategory);

  const today = new Date().toISOString().split("T")[0];

  const frontmatter: Partial<MemoryFrontmatter> = {
    title,
    category,
    tags: (options.preserveFrontmatter && existingFm.tags) ? existingFm.tags : { domain: [], type: ["imported"] },
    relevance: (options.preserveFrontmatter && existingFm.relevance) ? existingFm.relevance : "",
    author: (options.preserveFrontmatter && existingFm.author) ? existingFm.author : defaultAuthor,
    authority: (options.preserveFrontmatter && existingFm.authority) ? existingFm.authority : defaultAuthority,
    confidence: (options.preserveFrontmatter && existingFm.confidence !== undefined) ? existingFm.confidence : defaultConfidence,
    created: (options.preserveFrontmatter && existingFm.created) ? existingFm.created : today,
    modified: today,
    status: (options.preserveFrontmatter && existingFm.status) ? existingFm.status : "active",
    supersedes: null,
  };

  return { frontmatter, body };
}

/**
 * Bootstrap: batch-import files from a directory into a Gnosys store.
 */
export async function bootstrap(
  store: GnosysStore,
  options: BootstrapOptions
): Promise<BootstrapResult> {
  const result: BootstrapResult = {
    imported: [],
    skipped: [],
    failed: [],
    totalScanned: 0,
  };

  // Discover files
  const files = await discoverFiles(options.sourceDir, options.patterns);
  result.totalScanned = files.length;

  if (files.length === 0) return result;

  // Get existing memories for dedup
  const existingMemories = await store.getAllMemories();
  const existingTitles = new Set(
    existingMemories.map((m) => m.frontmatter.title.toLowerCase())
  );

  const resolvedDir = path.resolve(options.sourceDir);

  for (const file of files) {
    try {
      const fullPath = path.join(resolvedDir, file);
      const content = await fs.readFile(fullPath, "utf-8");

      const { frontmatter, body } = parseFileForImport(content, file, options);

      // Check if already exists
      if (options.skipExisting && existingTitles.has((frontmatter.title || "").toLowerCase())) {
        result.skipped.push(file);
        continue;
      }

      if (options.dryRun) {
        result.imported.push(file);
        continue;
      }

      // Generate ID and write
      const id = await store.generateId(frontmatter.category || "imported");
      const slug = titleToSlug(frontmatter.title || path.basename(file, ".md"));

      const fullFrontmatter: MemoryFrontmatter = {
        id,
        title: frontmatter.title || "Untitled",
        category: frontmatter.category || "imported",
        tags: frontmatter.tags || { domain: [], type: ["imported"] },
        relevance: frontmatter.relevance || "",
        author: frontmatter.author || "human",
        authority: frontmatter.authority || "imported",
        confidence: frontmatter.confidence ?? 0.7,
        created: frontmatter.created || new Date().toISOString().split("T")[0],
        modified: frontmatter.modified || new Date().toISOString().split("T")[0],
        status: frontmatter.status || "active",
        supersedes: null,
      };

      const fullContent = body.startsWith("#") ? body : `# ${frontmatter.title}\n\n${body}`;

      await store.writeMemory(
        fullFrontmatter.category,
        `${slug}.md`,
        fullFrontmatter,
        fullContent
      );

      result.imported.push(file);
    } catch (err) {
      result.failed.push({
        path: file,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

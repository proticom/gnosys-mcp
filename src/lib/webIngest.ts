/**
 * Gnosys Web Ingest — Site crawling and content extraction for web knowledge base.
 *
 * Crawls a website (from sitemap, directory, or URL list), converts pages to markdown,
 * generates Gnosys-format memory files with YAML frontmatter, and writes them to the
 * knowledge directory.
 */

import fs from "fs/promises";
import { existsSync, readFileSync, mkdirSync } from "fs";
import path from "path";
import { createHash } from "crypto";
import matter from "gray-matter";
import TurndownService from "turndown";
import { getLLMProvider, type LLMProvider } from "./llm.js";
import type { GnosysConfig } from "./config.js";
import {
  extractStructuredFrontmatter,
  computeTfIdf,
  type MemoryFrontmatterResult,
} from "./structuredIngest.js";

// ─── Types ───────────────────────────────────────────────────────────────

export interface WebIngestConfig {
  source: "sitemap" | "directory" | "urls";
  sitemapUrl?: string;
  contentDir?: string;
  urls?: string[];
  outputDir: string;
  exclude?: string[];
  categories: Record<string, string>;
  llmEnrich?: boolean;
  prune?: boolean;
  concurrency?: number;
  crawlDelayMs?: number;
  dryRun?: boolean;
  verbose?: boolean;
}

export interface IngestResult {
  added: string[];
  updated: string[];
  unchanged: string[];
  removed: string[];
  errors: Array<{ url: string; error: string }>;
  duration: number;
}

interface PageContent {
  url: string;
  content: string;
  contentHash: string;
  isLocal: boolean;
}

// ─── Turndown instance ──────────────────────────────────────────────────

function createTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
  });

  // Remove script, style, nav, footer, header elements
  td.remove(["script", "style", "nav", "footer", "header", "aside", "iframe"]);

  return td;
}

// ─── URL safety ──────────────────────────────────────────────────────────

/** Maximum recursion depth for sitemap index fetching. */
const MAX_SITEMAP_DEPTH = 3;

/** Maximum total URLs collected from sitemaps. */
const MAX_SITEMAP_URLS = 10_000;

/**
 * Validate a URL is safe to fetch (blocks SSRF to internal networks).
 * Only allows http/https schemes and rejects private/loopback IPs.
 */
function isSafeUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    // Only allow http/https
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;

    const hostname = url.hostname;

    // Block loopback
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]") {
      return true; // Allow localhost for local dev — but block metadata endpoints below
    }

    // Block cloud metadata endpoints
    if (hostname === "169.254.169.254" || hostname === "metadata.google.internal") return false;

    // Block private IPv4 ranges
    const ipv4Match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipv4Match) {
      const [, a, b] = ipv4Match.map(Number);
      if (a === 10) return false;                          // 10.0.0.0/8
      if (a === 172 && b >= 16 && b <= 31) return false;   // 172.16.0.0/12
      if (a === 192 && b === 168) return false;             // 192.168.0.0/16
      if (a === 169 && b === 254) return false;             // 169.254.0.0/16 (link-local)
    }

    return true;
  } catch {
    return false;
  }
}

// ─── URL utilities ───────────────────────────────────────────────────────

function matchesExclude(url: string, patterns: string[]): boolean {
  const urlPath = new URL(url, "https://example.com").pathname;
  return patterns.some((pattern) => matchGlobSimple(urlPath, pattern));
}

/** Safe glob matching without regex — avoids ReDoS from user-controlled patterns. */
function matchGlobSimple(value: string, pattern: string): boolean {
  // Split pattern on * to get literal segments
  const parts = pattern.split("*");
  if (parts.length === 1) return value === pattern;

  // First segment must be a prefix
  if (!value.startsWith(parts[0])) return false;

  let pos = parts[0].length;
  for (let i = 1; i < parts.length; i++) {
    const segment = parts[i];
    if (i === parts.length - 1 && segment === "") {
      // Trailing * matches everything
      return true;
    }
    const idx = value.indexOf(segment, pos);
    if (idx === -1) return false;
    pos = idx + segment.length;
  }

  // Last segment must match the end
  return pos === value.length || parts[parts.length - 1] === "";
}

function urlToFilePath(url: string, categories: Record<string, string>): string {
  const urlObj = new URL(url, "https://example.com");
  const urlPath = urlObj.pathname;

  // Determine category directory
  let category = "general";
  for (const [pattern, cat] of Object.entries(categories)) {
    if (matchGlobSimple(urlPath, pattern)) {
      category = cat;
      break;
    }
  }

  // Generate filename from URL path
  const segments = urlPath.split("/").filter(Boolean);
  const slug = segments.pop() || "index";
  const cleanSlug = slug
    .replace(/\.\w+$/, "")
    .replace(/[^a-z0-9-]/gi, "-")
    .toLowerCase();

  return path.join(category, `${cleanSlug}.md`);
}

// ─── Sitemap parsing ─────────────────────────────────────────────────────

async function fetchSitemapUrls(sitemapUrl: string, depth: number = 0): Promise<string[]> {
  if (depth > MAX_SITEMAP_DEPTH) {
    throw new Error(`Sitemap recursion depth exceeded (max ${MAX_SITEMAP_DEPTH})`);
  }

  if (!isSafeUrl(sitemapUrl)) {
    throw new Error(`Refusing to fetch unsafe URL: ${sitemapUrl}`);
  }

  const response = await fetch(sitemapUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch sitemap: ${response.status} ${response.statusText}`);
  }

  const xml = await response.text();

  // Check for sitemap index
  if (xml.includes("<sitemapindex")) {
    const sitemapUrls = [...xml.matchAll(/<loc>\s*(.*?)\s*<\/loc>/g)].map((m) => m[1]);
    const allUrls: string[] = [];
    for (const childUrl of sitemapUrls) {
      if (!isSafeUrl(childUrl)) continue;
      const childUrls = await fetchSitemapUrls(childUrl, depth + 1);
      allUrls.push(...childUrls);
      if (allUrls.length >= MAX_SITEMAP_URLS) {
        return allUrls.slice(0, MAX_SITEMAP_URLS);
      }
    }
    return allUrls;
  }

  // Regular sitemap — extract <loc> URLs, filter unsafe
  return [...xml.matchAll(/<loc>\s*(.*?)\s*<\/loc>/g)]
    .map((m) => m[1])
    .filter((u) => isSafeUrl(u))
    .slice(0, MAX_SITEMAP_URLS);
}

// ─── Content fetching ────────────────────────────────────────────────────

async function fetchPage(url: string): Promise<string> {
  if (!isSafeUrl(url)) {
    throw new Error(`Refusing to fetch unsafe URL: ${url}`);
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.text();
}

function extractArticleContent(html: string): string {
  // Try to find main/article content area
  const articleMatch = html.match(/<(?:article|main)[^>]*>([\s\S]*?)<\/(?:article|main)>/i);
  if (articleMatch) return articleMatch[1];

  // Fallback: try content div patterns
  const contentMatch = html.match(
    /<div[^>]*(?:class|id)=["'][^"']*(?:content|post|entry|article)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i
  );
  if (contentMatch) return contentMatch[1];

  // Last resort: use body
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return bodyMatch ? bodyMatch[1] : html;
}

function htmlToMarkdown(html: string, td: TurndownService): string {
  const articleHtml = extractArticleContent(html);
  return td.turndown(articleHtml).trim();
}

function isMarkdownFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".md" || ext === ".mdx";
}

function stripMdxComponents(content: string): string {
  // Remove JSX-style components: <Component /> and <Component>...</Component>
  return content
    .replace(/<[A-Z][a-zA-Z]*\s*\/>/g, "")
    .replace(/<[A-Z][a-zA-Z]*[^>]*>[\s\S]*?<\/[A-Z][a-zA-Z]*>/g, "")
    .replace(/import\s+.*?from\s+['"].*?['"]\s*;?\s*\n?/g, "")
    .replace(/export\s+default\s+.*?;\s*\n?/g, "");
}

// ─── LLM structuring ────────────────────────────────────────────────────

async function llmStructure(
  content: string,
  url: string,
  categories: Record<string, string>,
  provider: LLMProvider
): Promise<MemoryFrontmatterResult> {
  const categoryList = [...new Set(Object.values(categories))].join(", ");

  const prompt = `You are a knowledge structuring system. Given the following web page content and its URL, produce a JSON object with these fields:

- title: A clear, concise title
- category: One of: ${categoryList}, or "general"
- tags: An object with "domain" (array of topic tags) and "type" (array like ["article", "documentation", "product", "service", "faq", "page"])
- relevance: A keyword cloud (space-separated, 15-25 words) for search discovery. Include synonyms, related terms, abbreviations.
- confidence: 0.0 to 1.0

URL: ${url}

Content:
${content.slice(0, 4000)}

Respond with ONLY valid JSON, no markdown fences.`;

  const response = await provider.generate(prompt, {
    system: "You are a knowledge structuring assistant. Output only valid JSON.",
    maxTokens: 500,
  });

  let parsed: Record<string, unknown>;
  try {
    // Strip markdown fences if present
    const cleaned = response.replace(/```(?:json)?\n?/g, "").trim();
    parsed = JSON.parse(cleaned);
  } catch {
    // Fallback to structured mode
    return extractStructuredFrontmatter(content, url, categories);
  }

  const urlPath = new URL(url, "https://example.com").pathname;
  const slug = urlPath.split("/").filter(Boolean).pop() || "index";
  const category = typeof parsed.category === "string" ? parsed.category : "general";
  const prefix = category.slice(0, 4).toLowerCase();

  return {
    id: `${prefix}-${slug.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`,
    title: typeof parsed.title === "string" ? parsed.title : slug,
    category,
    tags: {
      domain: Array.isArray((parsed.tags as Record<string, unknown>)?.domain)
        ? (parsed.tags as Record<string, string[]>).domain
        : [],
      type: Array.isArray((parsed.tags as Record<string, unknown>)?.type)
        ? (parsed.tags as Record<string, string[]>).type
        : ["page"],
    },
    relevance: typeof parsed.relevance === "string" ? parsed.relevance : "",
    author: "ai",
    authority: "imported",
    confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.8,
    created: new Date().toISOString().split("T")[0],
    status: "active",
  };
}

// ─── Memory file writing ─────────────────────────────────────────────────

function buildMemoryFile(fm: MemoryFrontmatterResult, content: string): string {
  const lines = [
    "---",
    `id: ${fm.id}`,
    `title: '${fm.title.replace(/'/g, "''")}'`,
    `category: ${fm.category}`,
    "tags:",
    "  domain:",
    ...fm.tags.domain.map((t) => `    - ${t}`),
    "  type:",
    ...fm.tags.type.map((t) => `    - ${t}`),
    `relevance: '${fm.relevance.replace(/'/g, "''")}'`,
    `author: ${fm.author}`,
    `authority: ${fm.authority}`,
    `confidence: ${fm.confidence}`,
    `created: '${fm.created}'`,
    `status: ${fm.status}`,
    "---",
    "",
    `# ${fm.title}`,
    "",
    content,
  ];
  return lines.join("\n");
}

// ─── Existing file hash check ────────────────────────────────────────────

function getExistingHash(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed = matter(raw);
    return (parsed.data.contentHash as string) || null;
  } catch {
    return null;
  }
}

// ─── Concurrency limiter ─────────────────────────────────────────────────

async function pLimit<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number
): Promise<T[]> {
  const results: T[] = [];
  let index = 0;

  async function worker(): Promise<void> {
    while (index < tasks.length) {
      const i = index++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, tasks.length) },
    () => worker()
  );
  await Promise.all(workers);
  return results;
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Ingest a website into a Gnosys knowledge directory.
 */
export async function ingestSite(
  config: WebIngestConfig,
  gnosysConfig?: GnosysConfig
): Promise<IngestResult> {
  const start = Date.now();
  const result: IngestResult = {
    added: [],
    updated: [],
    unchanged: [],
    removed: [],
    errors: [],
    duration: 0,
  };

  const outputDir = path.resolve(config.outputDir);
  const exclude = config.exclude || [];
  const concurrency = config.concurrency || 3;
  const crawlDelay = config.crawlDelayMs ?? 200;
  const dryRun = config.dryRun || false;

  // Determine LLM provider availability
  let llmProvider: LLMProvider | null = null;
  if (config.llmEnrich !== false && gnosysConfig) {
    try {
      llmProvider = getLLMProvider(gnosysConfig, "structuring");
    } catch {
      llmProvider = null;
    }
  }

  // Collect URLs/files to process
  let pages: Array<{ url: string; isLocal: boolean }> = [];

  if (config.source === "sitemap" && config.sitemapUrl) {
    const urls = await fetchSitemapUrls(config.sitemapUrl);
    pages = urls
      .filter((u) => !matchesExclude(u, exclude))
      .map((u) => ({ url: u, isLocal: false }));
  } else if (config.source === "directory" && config.contentDir) {
    const contentDir = path.resolve(config.contentDir);
    const files = await findFilesRecursive(contentDir);
    pages = files
      .filter((f) => {
        const ext = path.extname(f).toLowerCase();
        return [".md", ".mdx", ".html", ".htm"].includes(ext);
      })
      .map((f) => ({
        url: `file://${f}`,
        isLocal: true,
      }));
  } else if (config.source === "urls" && config.urls) {
    pages = config.urls
      .filter((u) => !matchesExclude(u, exclude))
      .map((u) => ({ url: u, isLocal: false }));
  }

  if (pages.length === 0) {
    result.duration = Date.now() - start;
    return result;
  }

  // Ensure output directory exists
  if (!dryRun) {
    mkdirSync(outputDir, { recursive: true });
  }

  const td = createTurndown();

  // Track which output files still exist in source (for pruning)
  const processedFiles = new Set<string>();

  // Process pages with concurrency control
  const tasks = pages.map((page, idx) => async () => {
    // Crawl delay for remote URLs (skip for first request and localhost)
    if (!page.isLocal && idx > 0 && crawlDelay > 0) {
      const url = new URL(page.url);
      if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
        await new Promise((resolve) => setTimeout(resolve, crawlDelay));
      }
    }

    try {
      // Fetch content
      let rawContent: string;
      if (page.isLocal) {
        const filePath = page.url.replace("file://", "");
        rawContent = readFileSync(filePath, "utf-8");
      } else {
        rawContent = await fetchPage(page.url);
      }

      // Convert to markdown
      let markdown: string;
      if (page.isLocal && isMarkdownFile(page.url.replace("file://", ""))) {
        const parsed = matter(rawContent);
        markdown = parsed.content.trim();
        if (page.url.endsWith(".mdx")) {
          markdown = stripMdxComponents(markdown);
        }
      } else {
        markdown = htmlToMarkdown(rawContent, td);
      }

      // Compute content hash
      const contentHash = createHash("sha256").update(markdown).digest("hex");

      // Determine output path
      const relativePath = urlToFilePath(page.url, config.categories);
      const fullPath = path.join(outputDir, relativePath);
      processedFiles.add(relativePath);

      // Check for existing file with same hash
      const existingHash = getExistingHash(fullPath);
      if (existingHash === contentHash) {
        result.unchanged.push(relativePath);
        return;
      }

      // Generate frontmatter
      let fm: MemoryFrontmatterResult;
      if (llmProvider) {
        fm = await llmStructure(markdown, page.url, config.categories, llmProvider);
      } else {
        fm = extractStructuredFrontmatter(rawContent, page.url, config.categories);
      }

      // Write file
      if (!dryRun) {
        const dir = path.dirname(fullPath);
        mkdirSync(dir, { recursive: true });

        // Add contentHash to frontmatter for change detection
        const fileContent = buildMemoryFile(fm, markdown).replace(
          "---\n",
          `---\ncontentHash: '${contentHash}'\n`
        );
        await fs.writeFile(fullPath, fileContent, "utf-8");
      }

      if (existingHash) {
        result.updated.push(relativePath);
      } else {
        result.added.push(relativePath);
      }
    } catch (err) {
      result.errors.push({
        url: page.url,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  await pLimit(tasks, concurrency);

  // Pruning
  if (config.prune && !dryRun) {
    const existingFiles = await findMdFilesRecursive(outputDir);
    for (const existing of existingFiles) {
      const rel = path.relative(outputDir, existing);
      if (!processedFiles.has(rel) && rel !== "gnosys-index.json") {
        await fs.unlink(existing);
        result.removed.push(rel);
      }
    }
  }

  // If using structured mode (no LLM), run TF-IDF across corpus for relevance
  if (!llmProvider && !dryRun && (result.added.length > 0 || result.updated.length > 0)) {
    await applyTfIdfRelevance(outputDir);
  }

  result.duration = Date.now() - start;
  return result;
}

/**
 * Ingest a single URL into the knowledge base.
 */
export async function ingestUrl(
  url: string,
  config: WebIngestConfig,
  gnosysConfig?: GnosysConfig
): Promise<IngestResult> {
  return ingestSite(
    { ...config, source: "urls", urls: [url] },
    gnosysConfig
  );
}

/**
 * Ingest from a local directory.
 */
export async function ingestDirectory(
  dir: string,
  config: WebIngestConfig,
  gnosysConfig?: GnosysConfig
): Promise<IngestResult> {
  return ingestSite(
    { ...config, source: "directory", contentDir: dir },
    gnosysConfig
  );
}

/**
 * Remove all knowledge files from the output directory.
 */
export async function removeKnowledge(knowledgePath: string): Promise<void> {
  if (existsSync(knowledgePath)) {
    await fs.rm(knowledgePath, { recursive: true, force: true });
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────

async function findFilesRecursive(dir: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(current: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        results.push(fullPath);
      }
    }
  }

  await walk(dir);
  return results.sort();
}

async function findMdFilesRecursive(dir: string): Promise<string[]> {
  const allFiles = await findFilesRecursive(dir);
  return allFiles.filter((f) => f.endsWith(".md"));
}

async function applyTfIdfRelevance(outputDir: string): Promise<void> {
  const mdFiles = await findMdFilesRecursive(outputDir);
  const docs: Array<{ id: string; content: string; path: string }> = [];

  for (const filePath of mdFiles) {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const parsed = matter(raw);
      const id = (parsed.data.id as string) || path.basename(filePath, ".md");
      docs.push({ id, content: parsed.content, path: filePath });
    } catch {
      continue;
    }
  }

  if (docs.length === 0) return;

  const tfidf = computeTfIdf(docs);

  for (const doc of docs) {
    const terms = tfidf.get(doc.id);
    if (!terms || terms.length === 0) continue;

    const relevance = terms.map((t) => t.term).join(" ");

    try {
      const raw = readFileSync(doc.path, "utf-8");
      const parsed = matter(raw);
      parsed.data.relevance = relevance;
      const updated = matter.stringify(parsed.content, parsed.data);
      await fs.writeFile(doc.path, updated, "utf-8");
    } catch {
      continue;
    }
  }
}

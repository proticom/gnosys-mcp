/**
 * Gnosys Structured Ingest — No-LLM fallback for web knowledge base.
 *
 * Generates Gnosys-format YAML frontmatter without any LLM call.
 * Uses TF-IDF keyword extraction for the relevance field.
 */

// ─── Types ───────────────────────────────────────────────────────────────

export interface MemoryFrontmatterResult {
  id: string;
  title: string;
  category: string;
  tags: { domain: string[]; type: string[] };
  relevance: string;
  author: string;
  authority: string;
  confidence: number;
  created: string;
  status: string;
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

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

// ─── Title extraction ────────────────────────────────────────────────────

function extractTitle(content: string, url: string): string {
  // Try <h1>
  const h1Match = content.match(/<h1[^>]*>(.*?)<\/h1>/is);
  if (h1Match) return stripHtml(h1Match[1]).trim();

  // Try <title>
  const titleMatch = content.match(/<title[^>]*>(.*?)<\/title>/is);
  if (titleMatch) return stripHtml(titleMatch[1]).trim();

  // Try first markdown heading
  const mdH1 = content.match(/^#\s+(.+)$/m);
  if (mdH1) return mdH1[1].trim();

  // Fallback: derive from URL
  const urlPath = new URL(url, "https://example.com").pathname;
  const slug = urlPath.split("/").filter(Boolean).pop() || "untitled";
  return slug
    .replace(/[-_]/g, " ")
    .replace(/\.\w+$/, "")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, "");
}

// ─── Category inference ──────────────────────────────────────────────────

function inferCategory(
  url: string,
  categoryMap: Record<string, string>
): string {
  const urlPath = new URL(url, "https://example.com").pathname;

  for (const [pattern, category] of Object.entries(categoryMap)) {
    if (matchGlob(urlPath, pattern)) {
      return category;
    }
  }

  return "general";
}

/** Safe glob matching without regex — avoids ReDoS from user-controlled patterns. */
function matchGlob(urlPath: string, pattern: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return urlPath === pattern;

  if (!urlPath.startsWith(parts[0])) return false;

  let pos = parts[0].length;
  for (let i = 1; i < parts.length; i++) {
    const segment = parts[i];
    if (i === parts.length - 1 && segment === "") return true;
    const idx = urlPath.indexOf(segment, pos);
    if (idx === -1) return false;
    pos = idx + segment.length;
  }

  return pos === urlPath.length || parts[parts.length - 1] === "";
}

// ─── Tag extraction ──────────────────────────────────────────────────────

function extractTags(content: string, url: string): { domain: string[]; type: string[] } {
  const domain: string[] = [];
  const type: string[] = [];

  // Extract from <meta name="keywords">
  const metaMatch = content.match(/<meta\s+name=["']keywords["']\s+content=["']([^"']+)["']/i);
  if (metaMatch) {
    const keywords = metaMatch[1].split(",").map((k) => k.trim().toLowerCase()).filter(Boolean);
    domain.push(...keywords.slice(0, 5));
  }

  // Infer type from URL path
  const urlPath = new URL(url, "https://example.com").pathname;
  const segments = urlPath.split("/").filter(Boolean);
  if (segments.length > 0) {
    const firstSegment = segments[0].toLowerCase();
    if (["blog", "posts", "articles", "news"].includes(firstSegment)) {
      type.push("article");
    } else if (["docs", "documentation", "guide", "guides"].includes(firstSegment)) {
      type.push("documentation");
    } else if (["products", "product"].includes(firstSegment)) {
      type.push("product");
    } else if (["services", "service"].includes(firstSegment)) {
      type.push("service");
    } else if (["about", "team", "company"].includes(firstSegment)) {
      type.push("company-info");
    } else if (["faq", "faqs", "help", "support"].includes(firstSegment)) {
      type.push("faq");
    } else {
      type.push("page");
    }
  } else {
    type.push("page");
  }

  return { domain, type };
}

// ─── ID generation ───────────────────────────────────────────────────────

function generateId(url: string, category: string): string {
  const urlPath = new URL(url, "https://example.com").pathname;
  const slug = urlPath
    .split("/")
    .filter(Boolean)
    .pop() || "index";
  const cleanSlug = slug
    .replace(/\.\w+$/, "")
    .replace(/[^a-z0-9-]/gi, "-")
    .toLowerCase();
  const prefix = category.slice(0, 4).toLowerCase();
  return `${prefix}-${cleanSlug}`;
}

// ─── Public API ──────────────────────────────────────────────────────────

/**
 * Extract structured frontmatter from content without any LLM call.
 */
export function extractStructuredFrontmatter(
  content: string,
  url: string,
  categoryMap: Record<string, string>
): MemoryFrontmatterResult {
  const category = inferCategory(url, categoryMap);
  const title = extractTitle(content, url);
  const tags = extractTags(content, url);
  const id = generateId(url, category);

  return {
    id,
    title,
    category,
    tags,
    relevance: "", // Populated later by TF-IDF across corpus
    author: "auto-structured",
    authority: "imported",
    confidence: 0.7,
    created: new Date().toISOString().split("T")[0],
    status: "active",
  };
}

/**
 * Compute TF-IDF scores across a corpus of documents.
 * Returns top terms per document for use as relevance keywords.
 */
export function computeTfIdf(
  documents: Array<{ id: string; content: string }>,
  topN: number = 20
): Map<string, Array<{ term: string; score: number }>> {
  const N = documents.length;
  if (N === 0) return new Map();

  // Compute term frequency per document
  const docTermFreqs: Map<string, Map<string, number>> = new Map();

  for (const doc of documents) {
    const tokens = tokenize(doc.content);
    const tf = new Map<string, number>();
    for (const token of tokens) {
      tf.set(token, (tf.get(token) || 0) + 1);
    }
    // Normalize by max frequency in document
    const maxFreq = Math.max(...tf.values(), 1);
    const normalizedTf = new Map<string, number>();
    for (const [term, freq] of tf) {
      normalizedTf.set(term, freq / maxFreq);
    }
    docTermFreqs.set(doc.id, normalizedTf);
  }

  // Compute document frequency for each term
  const df = new Map<string, number>();
  for (const tf of docTermFreqs.values()) {
    for (const term of tf.keys()) {
      df.set(term, (df.get(term) || 0) + 1);
    }
  }

  // Compute TF-IDF and select top N terms per document
  const result = new Map<string, Array<{ term: string; score: number }>>();

  for (const doc of documents) {
    const tf = docTermFreqs.get(doc.id)!;
    const scores: Array<{ term: string; score: number }> = [];

    for (const [term, tfScore] of tf) {
      const docFreq = df.get(term) || 1;
      const idf = Math.log(1 + N / docFreq);
      scores.push({ term, score: parseFloat((tfScore * idf).toFixed(4)) });
    }

    // Sort by score descending, take top N
    scores.sort((a, b) => b.score - a.score);
    result.set(doc.id, scores.slice(0, topN));
  }

  return result;
}

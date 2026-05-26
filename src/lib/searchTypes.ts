/** Shared search result types (extracted to break hybridSearch ↔ dbSearch static cycle). */

export type SearchMode = "keyword" | "semantic" | "hybrid";

export interface HybridSearchResult {
  relativePath: string;
  title: string;
  snippet: string;
  score: number;
  /** Which method(s) found this result */
  sources: ("keyword" | "semantic" | "archive")[];
  /** Full memory content (loaded on demand for ask engine) */
  content?: string;
  /** The memory frontmatter content field */
  fullContent?: string;
  /** Memory ID (used for dearchiving) */
  memoryId?: string;
  /** Whether this result came from the archive */
  fromArchive?: boolean;
}

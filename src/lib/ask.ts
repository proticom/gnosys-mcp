/**
 * Gnosys Ask Engine — Freeform natural-language Q&A over the entire vault.
 * Pipeline: hybridSearch → context assembly → LLM synthesis → cited answer.
 *
 * Supports streaming and "deep query" mode (auto follow-up on insufficient context).
 * Uses the LLM abstraction layer — works with Anthropic, Ollama, or any future provider.
 */

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { GnosysHybridSearch, HybridSearchResult } from "./hybridSearch.js";
import { GnosysConfig, DEFAULT_CONFIG } from "./config.js";
import { LLMProvider, getLLMProvider } from "./llm.js";
import { GnosysArchive } from "./archive.js";
import { GnosysMaintenanceEngine } from "./maintenance.js";
import { GnosysResolver } from "./resolver.js";
import { auditLog } from "./audit.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface AskResult {
  answer: string;
  sources: { relativePath: string; title: string }[];
  deepQueryUsed: boolean;
  searchMode: string;
  /** Memory IDs that were dearchived (moved from archive → active) during this query */
  dearchivedIds: string[];
}

export interface AskStreamCallbacks {
  onToken?: (token: string) => void;
  onSearchComplete?: (count: number, mode: string) => void;
  onDeepQuery?: (refinedQuery: string) => void;
  onSourcesReady?: (sources: { relativePath: string; title: string }[]) => void;
}

/**
 * Phrases that trigger a deep query follow-up.
 */
const NEED_MORE_INFO_PHRASES = [
  "i need more information",
  "i don't have enough",
  "insufficient information",
  "not enough context",
  "no relevant information",
  "cannot find",
  "none of the provided memories",
  "the provided context does not",
];

export class GnosysAsk {
  private provider: LLMProvider | null = null;
  private hybridSearch: GnosysHybridSearch;
  private config: GnosysConfig;
  private promptTemplate: string | null = null;
  private resolver: GnosysResolver | null = null;
  private storePath: string | null = null;

  constructor(
    hybridSearch: GnosysHybridSearch,
    config?: GnosysConfig,
    resolver?: GnosysResolver,
    storePath?: string
  ) {
    this.hybridSearch = hybridSearch;
    this.config = config || DEFAULT_CONFIG;
    this.resolver = resolver || null;
    this.storePath = storePath || null;

    // Initialize LLM provider via abstraction layer
    try {
      this.provider = getLLMProvider(this.config, "synthesis");
    } catch {
      // Provider not available (e.g., no API key for Anthropic)
      this.provider = null;
    }
  }

  get isLLMAvailable(): boolean {
    return this.provider !== null;
  }

  get providerName(): string {
    return this.provider?.name || "none";
  }

  get modelName(): string {
    return this.provider?.model || "none";
  }

  /**
   * Load the synthesis prompt template.
   */
  private async loadPromptTemplate(): Promise<string> {
    if (this.promptTemplate) return this.promptTemplate;

    // Try loading from the installed package prompts/ directory
    const candidates = [
      path.resolve(__dirname, "..", "..", "prompts", "synthesize.md"),
      path.resolve(__dirname, "..", "prompts", "synthesize.md"),
      path.resolve(process.cwd(), "prompts", "synthesize.md"),
    ];

    for (const candidate of candidates) {
      try {
        this.promptTemplate = await fs.readFile(candidate, "utf-8");
        return this.promptTemplate;
      } catch {
        // Try next
      }
    }

    // Fallback inline prompt
    this.promptTemplate = `You are Gnosys, a knowledge synthesis engine. Answer the question using ONLY the provided context memories. Cite every claim with Obsidian wikilinks [[filename.md]]. If the context is insufficient, say "I need more information to fully answer this question."

## Context Memories

{{CONTEXT}}

## Question

{{QUESTION}}`;

    return this.promptTemplate;
  }

  /**
   * Format retrieved memories as numbered context blocks.
   */
  private formatContext(results: HybridSearchResult[]): string {
    return results
      .map((r, i) => {
        const content = r.fullContent || r.snippet;
        return `### [${i + 1}] ${r.title}\n**File:** ${r.relativePath}\n**Score:** ${r.score.toFixed(4)}\n\n${content}`;
      })
      .join("\n\n---\n\n");
  }

  /**
   * Extract a refined search query from a partial answer that needs more info.
   */
  private extractRefinedQuery(question: string, _partialAnswer: string): string {
    // Take the original question but add "related" to broaden the search
    return `${question} related details`;
  }

  /**
   * Ask a question and get a synthesized answer with citations.
   */
  async ask(
    question: string,
    options?: {
      limit?: number;
      mode?: "keyword" | "semantic" | "hybrid";
      stream?: boolean;
      callbacks?: AskStreamCallbacks;
      /** Additional context to prepend (e.g. from federated search) */
      additionalContext?: string;
    }
  ): Promise<AskResult> {
    if (!this.provider) {
      const providerName = this.config.llm.defaultProvider;
      throw new Error(
        providerName === "anthropic"
          ? "No ANTHROPIC_API_KEY set. gnosys_ask requires an LLM for synthesis. " +
            "Set the ANTHROPIC_API_KEY environment variable or switch to Ollama: gnosys config set provider ollama"
          : `LLM provider "${providerName}" is not available. Check your configuration.`
      );
    }

    const limit = options?.limit || 15;
    const mode = options?.mode || "hybrid";
    const callbacks = options?.callbacks;

    // Step 1: Hybrid search for relevant memories
    let results = await this.hybridSearch.hybridSearch(question, limit, mode);
    callbacks?.onSearchComplete?.(results.length, mode);

    if (results.length === 0) {
      return {
        answer: "No relevant memories found. Try importing some data first with `gnosys import` or creating memories with `gnosys add`.",
        sources: [],
        deepQueryUsed: false,
        searchMode: mode,
        dearchivedIds: [],
      };
    }

    // Step 2: Load full content for top results
    results = await this.hybridSearch.loadContent(results);

    // Step 3: Build prompt
    const template = await this.loadPromptTemplate();
    let context = this.formatContext(results);
    // Prepend federated/cross-scope context if provided
    if (options?.additionalContext) {
      context = `## Cross-Scope Context (Federated Search)\n${options.additionalContext}\n\n## Local Context\n${context}`;
    }
    const systemPrompt = template
      .replace("{{CONTEXT}}", context)
      .replace("{{QUESTION}}", question);

    // Step 4: LLM synthesis via abstraction layer
    let answer: string;

    if (options?.stream && callbacks?.onToken) {
      answer = await this.provider.generate(
        question,
        { system: systemPrompt, stream: true },
        { onToken: callbacks.onToken }
      );
    } else {
      answer = await this.provider.generate(question, { system: systemPrompt });
    }

    // Step 5: Check for deep query trigger
    let deepQueryUsed = false;
    const answerLower = answer.toLowerCase();
    const needsMoreInfo = NEED_MORE_INFO_PHRASES.some((phrase) =>
      answerLower.includes(phrase)
    );

    if (needsMoreInfo) {
      const refinedQuery = this.extractRefinedQuery(question, answer);
      callbacks?.onDeepQuery?.(refinedQuery);

      // Run follow-up search
      const moreResults = await this.hybridSearch.hybridSearch(
        refinedQuery,
        limit,
        mode
      );

      if (moreResults.length > 0) {
        // Merge with original results (dedup by path)
        const existingPaths = new Set(results.map((r) => r.relativePath));
        const newResults = moreResults.filter(
          (r) => !existingPaths.has(r.relativePath)
        );

        if (newResults.length > 0) {
          const enrichedNew = await this.hybridSearch.loadContent(newResults);
          const allResults = [...results, ...enrichedNew];

          // Re-synthesize with expanded context
          const expandedContext = this.formatContext(allResults);
          const expandedPrompt = template
            .replace("{{CONTEXT}}", expandedContext)
            .replace("{{QUESTION}}", question);

          if (options?.stream && callbacks?.onToken) {
            answer = await this.provider.generate(
              question,
              { system: expandedPrompt, stream: true },
              { onToken: callbacks.onToken }
            );
          } else {
            answer = await this.provider.generate(question, {
              system: expandedPrompt,
            });
          }

          results = allResults;
          deepQueryUsed = true;
        }
      }
    }

    // Step 6: Extract sources from the answer (only cited files)
    const sources = this.extractCitedSources(answer, results);
    callbacks?.onSourcesReady?.(sources);

    // Step 7: Auto-dearchive — move used archive memories back to active
    const dearchivedIds = await this.dearchiveUsedMemories(results, sources);

    // Audit log
    auditLog({
      operation: "ask",
      query: question,
      resultCount: sources.length,
      details: {
        deepQueryUsed,
        dearchivedCount: dearchivedIds.length,
        searchMode: mode,
      },
    });

    return {
      answer,
      sources,
      deepQueryUsed,
      searchMode: mode,
      dearchivedIds,
    };
  }

  /**
   * Dearchive memories that were used in the synthesis.
   * Uses deterministic fallback: if cited paths don't match archive results,
   * falls back to title-matching from the answer text to ensure anything
   * the answer actually references gets dearchived.
   */
  private async dearchiveUsedMemories(
    results: HybridSearchResult[],
    sources: { relativePath: string; title: string }[]
  ): Promise<string[]> {
    if (!this.storePath || !this.resolver) return [];

    // Find archive results that were cited (or all archive results if they contributed to the answer)
    const archiveResults = results.filter((r) => r.fromArchive && r.memoryId);
    if (archiveResults.length === 0) return [];

    // Determine which archive results were actually used
    const citedPaths = new Set(sources.map((s) => s.relativePath));
    let usedArchiveIds = archiveResults
      .filter((r) => citedPaths.has(r.relativePath))
      .map((r) => r.memoryId!)
      .filter(Boolean);

    // Deterministic fallback: if no archive results matched by path,
    // check if any archive memory titles appear in the cited sources' titles
    if (usedArchiveIds.length === 0) {
      const citedTitles = new Set(sources.map((s) => s.title.toLowerCase()));
      usedArchiveIds = archiveResults
        .filter((r) => citedTitles.has(r.title.toLowerCase()))
        .map((r) => r.memoryId!)
        .filter(Boolean);
    }

    // Final fallback: dearchive ALL archive results that were in the search context
    // (they contributed to the LLM's answer even if not explicitly cited)
    if (usedArchiveIds.length === 0 && archiveResults.length > 0) {
      usedArchiveIds = archiveResults
        .map((r) => r.memoryId!)
        .filter(Boolean);
    }

    if (usedArchiveIds.length === 0) return [];

    try {
      const archive = new GnosysArchive(this.storePath);
      if (!archive.isAvailable()) return [];

      const writeTarget = this.resolver.getWriteTarget();
      if (!writeTarget) {
        archive.close();
        return [];
      }

      const restored = await archive.dearchiveBatch(usedArchiveIds, writeTarget.store);
      archive.close();

      // Reinforce the restored memories
      if (restored.length > 0) {
        try {
          await GnosysMaintenanceEngine.reinforceBatch(writeTarget.store, restored);
        } catch {
          // Reinforcement is best-effort
        }
      }

      return usedArchiveIds;
    } catch {
      return [];
    }
  }

  /**
   * Extract sources that were actually cited in the answer.
   */
  private extractCitedSources(
    answer: string,
    results: HybridSearchResult[]
  ): { relativePath: string; title: string }[] {
    const cited: { relativePath: string; title: string }[] = [];
    const seen = new Set<string>();

    // Match [[filename.md]] patterns
    const wikiLinkRegex = /\[\[([^\]]+)\]\]/g;
    let match;

    while ((match = wikiLinkRegex.exec(answer)) !== null) {
      const cited_file = match[1];

      // Find matching result
      for (const r of results) {
        const filename = r.relativePath.split("/").pop() || r.relativePath;
        if (
          (r.relativePath === cited_file ||
            r.relativePath.endsWith(cited_file) ||
            filename === cited_file ||
            filename === cited_file + ".md") &&
          !seen.has(r.relativePath)
        ) {
          seen.add(r.relativePath);
          cited.push({ relativePath: r.relativePath, title: r.title });
          break;
        }
      }
    }

    // If no wikilinks found in answer, include all search results as sources
    if (cited.length === 0) {
      for (const r of results) {
        if (!seen.has(r.relativePath)) {
          seen.add(r.relativePath);
          cited.push({ relativePath: r.relativePath, title: r.title });
        }
      }
    }

    return cited;
  }
}

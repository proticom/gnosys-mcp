/**
 * Gnosys Ask Engine — Freeform natural-language Q&A over the entire vault.
 * Pipeline: hybridSearch → context assembly → LLM synthesis → cited answer.
 *
 * Supports streaming and "deep query" mode (auto follow-up on insufficient context).
 */

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { GnosysHybridSearch, HybridSearchResult } from "./hybridSearch.js";
import { GnosysConfig, DEFAULT_CONFIG } from "./config.js";
import { withRetry, isTransientError } from "./retry.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface AskResult {
  answer: string;
  sources: { relativePath: string; title: string }[];
  deepQueryUsed: boolean;
  searchMode: string;
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
  private client: Anthropic | null = null;
  private hybridSearch: GnosysHybridSearch;
  private config: GnosysConfig;
  private promptTemplate: string | null = null;

  constructor(
    hybridSearch: GnosysHybridSearch,
    config?: GnosysConfig
  ) {
    this.hybridSearch = hybridSearch;
    this.config = config || DEFAULT_CONFIG;

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
    }
  }

  get isLLMAvailable(): boolean {
    return this.client !== null;
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
  private extractRefinedQuery(question: string, partialAnswer: string): string {
    // Simple heuristic: extract key nouns/phrases from the question
    // that weren't well-covered in the partial answer
    const words = question
      .toLowerCase()
      .replace(/[?.,!]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 3);

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
    }
  ): Promise<AskResult> {
    if (!this.client) {
      throw new Error(
        "No ANTHROPIC_API_KEY set. gnosys_ask requires an LLM for synthesis. " +
          "Set the ANTHROPIC_API_KEY environment variable."
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
      };
    }

    // Step 2: Load full content for top results
    results = await this.hybridSearch.loadContent(results);

    // Step 3: Build prompt
    const template = await this.loadPromptTemplate();
    const context = this.formatContext(results);
    const systemPrompt = template
      .replace("{{CONTEXT}}", context)
      .replace("{{QUESTION}}", question);

    // Step 4: LLM synthesis
    let answer: string;

    if (options?.stream && callbacks?.onToken) {
      answer = await this.streamSynthesis(systemPrompt, question, callbacks.onToken);
    } else {
      answer = await this.synthesize(systemPrompt, question);
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
            answer = await this.streamSynthesis(
              expandedPrompt,
              question,
              callbacks.onToken
            );
          } else {
            answer = await this.synthesize(expandedPrompt, question);
          }

          results = allResults;
          deepQueryUsed = true;
        }
      }
    }

    // Step 6: Extract sources from the answer (only cited files)
    const sources = this.extractCitedSources(answer, results);
    callbacks?.onSourcesReady?.(sources);

    return {
      answer,
      sources,
      deepQueryUsed,
      searchMode: mode,
    };
  }

  /**
   * Run LLM synthesis (non-streaming).
   */
  private async synthesize(
    systemPrompt: string,
    question: string
  ): Promise<string> {
    const response = await withRetry(
      () =>
        this.client!.messages.create({
          model: this.config.defaultModel,
          max_tokens: 4096,
          system: systemPrompt,
          messages: [{ role: "user", content: question }],
        }),
      {
        maxAttempts: this.config.llmRetryAttempts,
        baseDelayMs: this.config.llmRetryBaseDelayMs,
        isRetryable: isTransientError,
      }
    );

    return response.content[0].type === "text" ? response.content[0].text : "";
  }

  /**
   * Run LLM synthesis with streaming.
   */
  private async streamSynthesis(
    systemPrompt: string,
    question: string,
    onToken: (token: string) => void
  ): Promise<string> {
    const stream = this.client!.messages.stream({
      model: this.config.defaultModel,
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: question }],
    });

    let fullText = "";

    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        const token = event.delta.text;
        fullText += token;
        onToken(token);
      }
    }

    return fullText;
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

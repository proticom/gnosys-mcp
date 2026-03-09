/**
 * Gnosys Smart Ingestion — Uses LLM to structure raw input into atomic memories.
 * Accepts messy human input, produces clean markdown files with YAML frontmatter.
 */

import Anthropic from "@anthropic-ai/sdk";
import { GnosysTagRegistry } from "./tags.js";
import { GnosysStore, MemoryFrontmatter } from "./store.js";
import { withRetry, isTransientError } from "./retry.js";
import { GnosysConfig, DEFAULT_CONFIG } from "./config.js";

interface IngestResult {
  title: string;
  category: string;
  tags: Record<string, string[]>;
  relevance: string;
  content: string;
  confidence: number;
  filename: string;
  proposedNewTags?: { category: string; tag: string }[];
}

export class GnosysIngestion {
  private client: Anthropic | null = null;
  private tagRegistry: GnosysTagRegistry;
  private store: GnosysStore;
  private config: GnosysConfig;

  constructor(store: GnosysStore, tagRegistry: GnosysTagRegistry, config?: GnosysConfig) {
    this.store = store;
    this.tagRegistry = tagRegistry;
    this.config = config || DEFAULT_CONFIG;

    // Initialize Anthropic client if API key is available
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
    }
  }

  get isLLMAvailable(): boolean {
    return this.client !== null;
  }

  /**
   * Ingest raw text and structure it into an atomic memory.
   * Uses LLM if available, otherwise requires structured input.
   */
  async ingest(rawInput: string): Promise<IngestResult> {
    if (!this.client) {
      throw new Error(
        "No ANTHROPIC_API_KEY set. Smart ingestion requires an LLM. " +
          "Set the ANTHROPIC_API_KEY environment variable or use gnosys_add_structured."
      );
    }

    const registry = this.tagRegistry.getRegistry();
    const categories = await this.store.getCategories();

    const systemPrompt = `You are Gnosys, a knowledge management system. Your job is to take raw, unstructured input and produce a structured atomic memory.

An atomic memory is ONE concept, decision, or piece of knowledge per file. If the input contains multiple concepts, focus on the primary one.

You must output valid JSON with these fields:
- title: A clear, concise title for this memory
- category: One of the existing categories or suggest a new one. Existing: ${categories.join(", ")}
- tags: An object with tag categories as keys and arrays of tags as values. Use ONLY tags from the registry below. If no existing tag fits, include a "proposed_new_tags" array.
- relevance: A keyword cloud (space-separated words, NOT sentences) describing every context where this memory would be useful. Include synonyms, related terms, abbreviations, and domain variations. Example: "auth authentication OAuth JWT login session tokens SSO identity credentials access-control permissions RBAC". Be generous — 15-30 keywords. This field powers discovery search.
- content: The memory content as clean markdown prose (NOT including the title as an H1 — that's added automatically)
- confidence: 0.0 to 1.0 — how confident you are this is a well-formed atomic memory
- filename: A kebab-case filename (without .md extension)

TAG REGISTRY:
${Object.entries(registry)
  .map(([cat, tags]) => `${cat}: ${tags.join(", ")}`)
  .join("\n")}

Rules:
1. One concept per memory. If the input is about multiple things, pick the most important one.
2. Use existing tags from the registry. Only propose new tags if nothing fits.
3. The content should be self-contained — someone reading just this file should understand the concept.
4. Be concise. Memories are meant to be quickly scanned, not deeply read.
5. Write in third person or neutral voice, not first person.
6. The relevance field is critical for discovery. Include all terms an agent might use to find this memory — think about what someone working on a related task would search for.`;

    const response = await withRetry(
      () =>
        this.client!.messages.create({
          model: this.config.defaultModel,
          max_tokens: 2000,
          system: systemPrompt,
          messages: [
            {
              role: "user",
              content: `Structure this into an atomic memory:\n\n${rawInput}`,
            },
          ],
        }),
      {
        maxAttempts: this.config.llmRetryAttempts,
        baseDelayMs: this.config.llmRetryBaseDelayMs,
        isRetryable: isTransientError,
      }
    );

    // Extract text from response
    const text =
      response.content[0].type === "text" ? response.content[0].text : "";

    // Parse JSON from response (handle markdown code blocks)
    const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) ||
      text.match(/```\s*([\s\S]*?)```/) || [null, text];
    const parsed = JSON.parse(jsonMatch[1] || text);

    // Validate and clean up tags
    const cleanTags: Record<string, string[]> = {};
    const proposedNewTags: { category: string; tag: string }[] = [];

    if (parsed.tags && typeof parsed.tags === "object") {
      for (const [cat, tags] of Object.entries(parsed.tags)) {
        if (Array.isArray(tags)) {
          const validTags: string[] = [];
          for (const tag of tags as string[]) {
            if (this.tagRegistry.hasTag(tag)) {
              validTags.push(tag);
            } else {
              proposedNewTags.push({ category: cat, tag });
            }
          }
          if (validTags.length > 0) cleanTags[cat] = validTags;
        }
      }
    }

    // Add any explicitly proposed new tags
    if (parsed.proposed_new_tags) {
      for (const item of parsed.proposed_new_tags) {
        proposedNewTags.push(item);
      }
    }

    return {
      title: parsed.title || "Untitled Memory",
      category: parsed.category || "uncategorized",
      tags: cleanTags,
      relevance: parsed.relevance || "",
      content: parsed.content || rawInput,
      confidence: parsed.confidence || 0.7,
      filename: parsed.filename || this.slugify(parsed.title || "memory"),
      proposedNewTags:
        proposedNewTags.length > 0 ? proposedNewTags : undefined,
    };
  }

  /**
   * Create a memory from already-structured input (no LLM needed).
   */
  createStructured(input: {
    title: string;
    category: string;
    tags: Record<string, string[]>;
    relevance?: string;
    content: string;
    author?: "human" | "ai" | "human+ai";
    authority?: "declared" | "observed" | "imported" | "inferred";
    confidence?: number;
  }): IngestResult {
    return {
      title: input.title,
      category: input.category,
      tags: input.tags,
      relevance: input.relevance || "",
      content: input.content,
      confidence: input.confidence || 0.8,
      filename: this.slugify(input.title),
    };
  }

  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .substring(0, 60);
  }
}

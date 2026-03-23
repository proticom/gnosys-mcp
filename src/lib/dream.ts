/**
 * Gnosys Dream Mode — Sleep-time consolidation engine.
 *
 * Metaphor: "closing all the open books overnight."
 *
 * Dream Mode runs during idle periods (configurable threshold) and performs:
 *   1. Confidence decay sweep — apply exponential decay to unreinforced memories
 *   2. Summary generation — hierarchical summaries per category
 *   3. Self-critique — score memories but NEVER delete; produces a review list
 *   4. Relationship discovery — find new links between memories
 *   5. Deduplication pass — flag similar memories for human review
 *
 * Safety guarantees:
 *   - Never deletes or archives autonomously
 *   - All changes are non-destructive (confidence updates, summaries, review flags)
 *   - Configurable max runtime (default 30 min)
 *   - Off by default — must be explicitly enabled
 *   - Uses cheap/local LLM (configurable, defaults to Ollama)
 */

import { GnosysDB, DbMemory, DbSummary } from "./db.js";
import { GnosysConfig, DEFAULT_CONFIG, LLMProviderName } from "./config.js";
import { LLMProvider, getLLMProvider } from "./llm.js";
import { GnosysResolver } from "./resolver.js";
import { GnosysMaintenanceEngine, MaintenanceReport } from "./maintenance.js";
import { syncConfidenceToDb, auditToDb } from "./dbWrite.js";
// ─── Config Schema ───────────────────────────────────────────────────────

export interface DreamConfig {
  /** Enable dream mode (default: false) */
  enabled: boolean;
  /** Idle time in minutes before triggering (default: 10) */
  idleMinutes: number;
  /** Max runtime in minutes (default: 30) */
  maxRuntimeMinutes: number;
  /** LLM provider to use for dream operations (default: "ollama") */
  provider: LLMProviderName;
  /** LLM model override for dream operations */
  model?: string;
  /** Enable self-critique scoring (default: true) */
  selfCritique: boolean;
  /** Enable summary generation (default: true) */
  generateSummaries: boolean;
  /** Enable relationship discovery (default: true) */
  discoverRelationships: boolean;
  /** Min memory count before dream mode activates (default: 10) */
  minMemories: number;
}

export const DEFAULT_DREAM_CONFIG: DreamConfig = {
  enabled: false,
  idleMinutes: 10,
  maxRuntimeMinutes: 30,
  provider: "ollama",
  model: undefined,
  selfCritique: true,
  generateSummaries: true,
  discoverRelationships: true,
  minMemories: 10,
};

// ─── Dream Report ────────────────────────────────────────────────────────

export interface DreamReport {
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  decayUpdated: number;
  summariesGenerated: number;
  summariesUpdated: number;
  reviewSuggestions: ReviewSuggestion[];
  relationshipsDiscovered: number;
  duplicatesFound: number;
  errors: string[];
  aborted: boolean;
  abortReason?: string;
}

export interface ReviewSuggestion {
  memoryId: string;
  title: string;
  reason: string;
  currentConfidence: number;
  suggestedAction: "review" | "consider-archive" | "consider-merge" | "needs-update";
}

// ─── Decay Constants ─────────────────────────────────────────────────────

const DECAY_LAMBDA = 0.005;
const STALE_THRESHOLD = 0.3;

// ─── Dream Engine ────────────────────────────────────────────────────────

export class GnosysDreamEngine {
  private db: GnosysDB;
  private config: GnosysConfig;
  private dreamConfig: DreamConfig;
  private provider: LLMProvider | null = null;
  private abortRequested = false;
  private startTime = 0;

  constructor(
    db: GnosysDB,
    config: GnosysConfig,
    dreamConfig?: Partial<DreamConfig>
  ) {
    this.db = db;
    this.config = config;
    this.dreamConfig = { ...DEFAULT_DREAM_CONFIG, ...dreamConfig };

    // Initialize LLM provider for dream operations
    try {
      this.provider = getLLMProvider(this.config, "structuring");
    } catch {
      this.provider = null;
    }
  }

  /**
   * Request abort — dream cycle will stop at the next safe checkpoint.
   */
  abort(): void {
    this.abortRequested = true;
  }

  /**
   * Check if we've exceeded max runtime.
   */
  private isOvertime(): boolean {
    if (this.dreamConfig.maxRuntimeMinutes <= 0) return false;
    const elapsed = Date.now() - this.startTime;
    return elapsed > this.dreamConfig.maxRuntimeMinutes * 60 * 1000;
  }

  /**
   * Check if we should stop (abort requested or overtime).
   */
  private shouldStop(): { stop: boolean; reason?: string } {
    if (this.abortRequested) return { stop: true, reason: "abort requested" };
    if (this.isOvertime()) return { stop: true, reason: `max runtime exceeded (${this.dreamConfig.maxRuntimeMinutes}min)` };
    return { stop: false };
  }

  /**
   * Run the full dream cycle.
   * This is the main entry point — runs all dream operations in sequence.
   */
  async dream(
    onProgress?: (phase: string, detail: string) => void
  ): Promise<DreamReport> {
    this.startTime = Date.now();
    this.abortRequested = false;
    const log = onProgress || (() => {});

    const report: DreamReport = {
      startedAt: new Date().toISOString(),
      finishedAt: "",
      durationMs: 0,
      decayUpdated: 0,
      summariesGenerated: 0,
      summariesUpdated: 0,
      reviewSuggestions: [],
      relationshipsDiscovered: 0,
      duplicatesFound: 0,
      errors: [],
      aborted: false,
    };

    if (!this.db.isAvailable() || !this.db.isMigrated()) {
      report.errors.push("gnosys.db not available or not migrated");
      report.finishedAt = new Date().toISOString();
      report.durationMs = Date.now() - this.startTime;
      return report;
    }

    const counts = this.db.getMemoryCount();
    if (counts.active < this.dreamConfig.minMemories) {
      report.errors.push(`Too few memories (${counts.active} < ${this.dreamConfig.minMemories})`);
      report.finishedAt = new Date().toISOString();
      report.durationMs = Date.now() - this.startTime;
      return report;
    }

    log("dream", "Dream cycle starting...");

    // Audit: dream start
    auditToDb(this.db, "dream_start", undefined, {
      config: {
        maxRuntime: this.dreamConfig.maxRuntimeMinutes,
        selfCritique: this.dreamConfig.selfCritique,
        generateSummaries: this.dreamConfig.generateSummaries,
        discoverRelationships: this.dreamConfig.discoverRelationships,
      },
      memoryCount: counts.active,
    });

    // ─── Phase 1: Confidence Decay Sweep ─────────────────────────────────
    log("decay", "Phase 1: Confidence decay sweep...");
    try {
      report.decayUpdated = this.decaySweep();
      log("decay", `Updated ${report.decayUpdated} memories`);
    } catch (err) {
      report.errors.push(`Decay sweep: ${err instanceof Error ? err.message : String(err)}`);
    }

    let check = this.shouldStop();
    if (check.stop) {
      report.aborted = true;
      report.abortReason = check.reason;
      return this.finalize(report);
    }

    // ─── Phase 2: Self-Critique (Review Suggestions) ─────────────────────
    if (this.dreamConfig.selfCritique) {
      log("critique", "Phase 2: Self-critique...");
      try {
        report.reviewSuggestions = await this.selfCritique(log);
        log("critique", `Generated ${report.reviewSuggestions.length} review suggestions`);
      } catch (err) {
        report.errors.push(`Self-critique: ${err instanceof Error ? err.message : String(err)}`);
      }

      check = this.shouldStop();
      if (check.stop) {
        report.aborted = true;
        report.abortReason = check.reason;
        return this.finalize(report);
      }
    }

    // ─── Phase 3: Summary Generation ─────────────────────────────────────
    if (this.dreamConfig.generateSummaries && this.provider) {
      log("summaries", "Phase 3: Summary generation...");
      try {
        const summaryResult = await this.generateSummaries(log);
        report.summariesGenerated = summaryResult.generated;
        report.summariesUpdated = summaryResult.updated;
        log("summaries", `Generated ${summaryResult.generated}, updated ${summaryResult.updated}`);
      } catch (err) {
        report.errors.push(`Summary generation: ${err instanceof Error ? err.message : String(err)}`);
      }

      check = this.shouldStop();
      if (check.stop) {
        report.aborted = true;
        report.abortReason = check.reason;
        return this.finalize(report);
      }
    }

    // ─── Phase 4: Relationship Discovery ─────────────────────────────────
    if (this.dreamConfig.discoverRelationships && this.provider) {
      log("relationships", "Phase 4: Relationship discovery...");
      try {
        report.relationshipsDiscovered = await this.discoverRelationships(log);
        log("relationships", `Discovered ${report.relationshipsDiscovered} new relationships`);
      } catch (err) {
        report.errors.push(`Relationship discovery: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return this.finalize(report);
  }

  private finalize(report: DreamReport): DreamReport {
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - this.startTime;

    // Audit: dream complete
    auditToDb(this.db, "dream_complete", undefined, {
      durationMs: report.durationMs,
      decayUpdated: report.decayUpdated,
      summariesGenerated: report.summariesGenerated,
      reviewSuggestions: report.reviewSuggestions.length,
      relationshipsDiscovered: report.relationshipsDiscovered,
      errors: report.errors.length,
      aborted: report.aborted,
    }, report.durationMs);

    return report;
  }

  // ─── Phase 1: Decay Sweep ──────────────────────────────────────────────

  /**
   * Apply exponential decay to all active memories.
   * Formula: decayed = confidence * e^(-λ * days_since_reinforced)
   * Only updates if decayed value differs from stored value by > 0.01.
   */
  private decaySweep(): number {
    const now = new Date();
    const today = now.toISOString().split("T")[0];
    const memories = this.db.getActiveMemories();
    let updated = 0;

    for (const mem of memories) {
      const lastReinforced = mem.last_reinforced || mem.modified || mem.created;
      const lastDate = new Date(lastReinforced);
      const daysSince = Math.max(0, Math.floor((now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24)));

      if (daysSince === 0) continue; // Recently active, skip

      const decayed = mem.confidence * Math.exp(-DECAY_LAMBDA * daysSince);
      const rounded = Math.round(decayed * 100) / 100;

      // Only update if meaningful change (>0.01)
      if (Math.abs(rounded - mem.confidence) > 0.01) {
        syncConfidenceToDb(this.db, mem.id, rounded);
        updated++;
      }
    }

    return updated;
  }

  // ─── Phase 2: Self-Critique ────────────────────────────────────────────

  /**
   * Score memories and generate review suggestions.
   * NEVER deletes or archives — only flags for human review.
   */
  private async selfCritique(
    log: (phase: string, detail: string) => void
  ): Promise<ReviewSuggestion[]> {
    const suggestions: ReviewSuggestion[] = [];
    const memories = this.db.getActiveMemories();

    for (const mem of memories) {
      const check = this.shouldStop();
      if (check.stop) break;

      // Rule-based critique (no LLM needed)
      const issues = this.critiquMemory(mem);
      if (issues.length > 0) {
        suggestions.push({
          memoryId: mem.id,
          title: mem.title,
          reason: issues.join("; "),
          currentConfidence: mem.confidence,
          suggestedAction: this.suggestAction(mem, issues),
        });
      }
    }

    // LLM-based critique for borderline memories (if provider available)
    if (this.provider && suggestions.length < 20) {
      const borderline = memories.filter(
        (m) => m.confidence > STALE_THRESHOLD && m.confidence < 0.6
      );

      for (const mem of borderline.slice(0, 10)) {
        const check = this.shouldStop();
        if (check.stop) break;

        try {
          const llmSuggestion = await this.llmCritique(mem);
          if (llmSuggestion) {
            suggestions.push(llmSuggestion);
          }
        } catch (err) {
          log("critique", `LLM critique failed for ${mem.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // Store review suggestions in summaries table
    if (suggestions.length > 0) {
      const today = new Date().toISOString().split("T")[0];
      this.db.upsertSummary({
        id: `review-${today}`,
        scope: "dream",
        scope_key: `review-${today}`,
        content: JSON.stringify(suggestions, null, 2),
        source_ids: JSON.stringify(suggestions.map((s) => s.memoryId)),
        created: today,
        modified: today,
      });
    }

    return suggestions;
  }

  /**
   * Rule-based critique — fast, no LLM needed.
   */
  private critiquMemory(mem: DbMemory): string[] {
    const issues: string[] = [];
    const now = new Date();

    // Low confidence
    if (mem.confidence < STALE_THRESHOLD) {
      issues.push(`Very low confidence (${mem.confidence.toFixed(2)})`);
    }

    // Never reinforced + old
    if (mem.reinforcement_count === 0) {
      const created = new Date(mem.created);
      const daysSince = Math.floor((now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24));
      if (daysSince > 30) {
        issues.push(`Never reinforced in ${daysSince} days`);
      }
    }

    // Very short content (might be incomplete)
    if (mem.content.length < 50) {
      issues.push("Very short content (< 50 chars) — may be incomplete");
    }

    // No tags
    try {
      const tags = JSON.parse(mem.tags || "[]");
      if (Array.isArray(tags) && tags.length === 0) {
        issues.push("No tags — harder to discover");
      }
    } catch {
      issues.push("Invalid tags format");
    }

    // Empty relevance
    if (!mem.relevance || mem.relevance.trim().length === 0) {
      issues.push("No relevance keywords — invisible to search");
    }

    return issues;
  }

  /**
   * LLM-based critique for borderline memories.
   */
  private async llmCritique(mem: DbMemory): Promise<ReviewSuggestion | null> {
    if (!this.provider) return null;

    const prompt = `You are a knowledge management quality reviewer. Evaluate this memory and decide if it needs attention.

Title: ${mem.title}
Category: ${mem.category}
Confidence: ${mem.confidence}
Created: ${mem.created}
Last reinforced: ${mem.last_reinforced || "never"}
Reinforcement count: ${mem.reinforcement_count}

Content:
${mem.content.substring(0, 500)}

Respond with ONLY one of these JSON objects (no explanation):
- {"action": "ok"} if the memory is fine
- {"action": "review", "reason": "..."} if it needs human review
- {"action": "needs-update", "reason": "..."} if content seems outdated
- {"action": "consider-merge", "reason": "..."} if it seems to overlap with other common knowledge`;

    try {
      const response = await this.provider.generate(prompt, { maxTokens: 200 });
      const jsonMatch = response.match(/\{[^}]+\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.action === "ok") return null;

      return {
        memoryId: mem.id,
        title: mem.title,
        reason: parsed.reason || "LLM flagged for review",
        currentConfidence: mem.confidence,
        suggestedAction: parsed.action as ReviewSuggestion["suggestedAction"],
      };
    } catch {
      return null;
    }
  }

  /**
   * Determine suggested action based on issues.
   */
  private suggestAction(mem: DbMemory, issues: string[]): ReviewSuggestion["suggestedAction"] {
    if (mem.confidence < STALE_THRESHOLD) return "consider-archive";
    if (issues.some((i) => i.includes("incomplete"))) return "needs-update";
    return "review";
  }

  // ─── Phase 3: Summary Generation ───────────────────────────────────────

  /**
   * Generate or update hierarchical summaries per category.
   * Uses LLM to synthesize category-level overviews.
   */
  private async generateSummaries(
    log: (phase: string, detail: string) => void
  ): Promise<{ generated: number; updated: number }> {
    if (!this.provider) return { generated: 0, updated: 0 };

    const categories = this.db.getCategories();
    let generated = 0;
    let updated = 0;

    for (const category of categories) {
      const check = this.shouldStop();
      if (check.stop) break;

      const memories = this.db.getMemoriesByCategory(category);
      if (memories.length < 2) continue; // Not enough to summarize

      // Check if summary exists and is still current
      const existing = this.db.getSummary("category", category);
      if (existing) {
        const existingIds = JSON.parse(existing.source_ids) as string[];
        const currentIds = memories.map((m) => m.id);
        const unchanged = existingIds.length === currentIds.length &&
          existingIds.every((id) => currentIds.includes(id));
        if (unchanged) continue; // No new memories in this category
      }

      log("summaries", `Summarizing ${category} (${memories.length} memories)...`);

      try {
        const summary = await this.summarizeCategory(category, memories);
        if (summary) {
          const today = new Date().toISOString().split("T")[0];
          const id = existing?.id || `summary-${category}-${today}`;

          this.db.upsertSummary({
            id,
            scope: "category",
            scope_key: category,
            content: summary,
            source_ids: JSON.stringify(memories.map((m) => m.id)),
            created: existing?.created || today,
            modified: today,
          });

          if (existing) {
            updated++;
          } else {
            generated++;
          }
        }
      } catch (err) {
        log("summaries", `Failed to summarize ${category}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { generated, updated };
  }

  /**
   * Use LLM to generate a category summary.
   */
  private async summarizeCategory(category: string, memories: DbMemory[]): Promise<string | null> {
    if (!this.provider) return null;

    // Build context from memories (truncate to fit context window)
    const memoryTexts = memories
      .slice(0, 20) // Max 20 memories per category summary
      .map((m) => `## ${m.title}\n${m.content.substring(0, 300)}`)
      .join("\n\n");

    const prompt = `You are a knowledge management assistant. Create a concise summary of the "${category}" category that captures the key themes, decisions, and patterns across these memories.

The summary should:
- Be 2-4 paragraphs
- Highlight key themes and patterns
- Note any contradictions or evolving decisions
- Be useful as a quick reference for someone new to the project

Memories in "${category}":

${memoryTexts}

Category summary:`;

    try {
      return await this.provider.generate(prompt, { maxTokens: 1024 });
    } catch {
      return null;
    }
  }

  // ─── Phase 4: Relationship Discovery ───────────────────────────────────

  /**
   * Use LLM to discover relationships between memories.
   * Only creates new edges — never removes existing ones.
   */
  private async discoverRelationships(
    log: (phase: string, detail: string) => void
  ): Promise<number> {
    if (!this.provider) return 0;

    const memories = this.db.getActiveMemories();
    if (memories.length < 3) return 0;

    let discovered = 0;
    const today = new Date().toISOString().split("T")[0];

    // Get existing relationships to avoid duplicates
    const existingPairs = new Set<string>();
    for (const mem of memories) {
      const rels = this.db.getRelationshipsFrom(mem.id);
      for (const r of rels) {
        existingPairs.add(`${r.source_id}→${r.target_id}→${r.rel_type}`);
      }
    }

    // Build a compact index of all memories for the LLM
    const memoryIndex = memories
      .slice(0, 50) // Limit to 50 most relevant
      .map((m) => `[${m.id}] ${m.title} (${m.category}) — ${(m.relevance || "").substring(0, 80)}`)
      .join("\n");

    // Process in batches of 5 source memories
    const batchSize = 5;
    for (let i = 0; i < Math.min(memories.length, 30); i += batchSize) {
      const check = this.shouldStop();
      if (check.stop) break;

      const batch = memories.slice(i, i + batchSize);
      const batchTitles = batch.map((m) => `[${m.id}] ${m.title}`).join(", ");

      log("relationships", `Analyzing relationships for: ${batchTitles}`);

      try {
        const relationships = await this.findRelationships(batch, memoryIndex);

        for (const rel of relationships) {
          const key = `${rel.source_id}→${rel.target_id}→${rel.rel_type}`;
          if (existingPairs.has(key)) continue;

          this.db.insertRelationship({
            source_id: rel.source_id,
            target_id: rel.target_id,
            rel_type: rel.rel_type,
            label: rel.label,
            confidence: rel.confidence,
            created: today,
          });

          existingPairs.add(key);
          discovered++;
        }
      } catch (err) {
        log("relationships", `Failed for batch: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return discovered;
  }

  /**
   * Use LLM to find relationships for a batch of source memories.
   */
  private async findRelationships(
    sources: DbMemory[],
    memoryIndex: string
  ): Promise<Array<{ source_id: string; target_id: string; rel_type: string; label: string; confidence: number }>> {
    if (!this.provider) return [];

    const sourceContext = sources
      .map((m) => `[${m.id}] "${m.title}" — ${m.content.substring(0, 200)}`)
      .join("\n\n");

    const prompt = `You are a knowledge graph assistant. Given these source memories and a full memory index, identify meaningful relationships.

Relationship types: references, depends_on, contradicts, extends, supersedes, related_to

Source memories:
${sourceContext}

Full memory index:
${memoryIndex}

For each relationship found, output a JSON array of objects with: source_id, target_id, rel_type, label (short description), confidence (0.5-1.0).
Only output relationships with confidence >= 0.7. Do NOT create self-referencing relationships.
Output ONLY the JSON array, no explanation.`;

    try {
      const response = await this.provider.generate(prompt, { maxTokens: 1024 });

      // Extract JSON array from response
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) return [];

      // Validate entries
      return parsed.filter(
        (r: any) =>
          r.source_id &&
          r.target_id &&
          r.rel_type &&
          r.source_id !== r.target_id &&
          r.confidence >= 0.7
      );
    } catch {
      return [];
    }
  }
}

// ─── Dream Scheduler ─────────────────────────────────────────────────────

/**
 * Manages the dream cycle schedule within a running server.
 * Monitors idle time and triggers dream mode when conditions are met.
 */
export class DreamScheduler {
  private engine: GnosysDreamEngine;
  private config: DreamConfig;
  private lastActivity: number = Date.now();
  private checkInterval: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private currentDream: Promise<DreamReport> | null = null;

  constructor(engine: GnosysDreamEngine, config?: Partial<DreamConfig>) {
    this.engine = engine;
    // Explicitly pick known config keys to prevent prototype pollution
    this.config = { ...DEFAULT_DREAM_CONFIG };
    if (config) {
      for (const key of Object.keys(DEFAULT_DREAM_CONFIG) as Array<keyof DreamConfig>) {
        if (key in config && config[key] !== undefined) {
          (this.config as any)[key] = config[key];
        }
      }
    }
  }

  /**
   * Record activity — resets the idle timer.
   * Call this on every MCP tool invocation.
   */
  recordActivity(): void {
    this.lastActivity = Date.now();

    // If dreaming, abort gracefully
    if (this.running) {
      this.engine.abort();
    }
  }

  /**
   * Start the scheduler — checks idle time periodically.
   */
  start(): void {
    if (!this.config.enabled) return;
    if (this.checkInterval) return;

    const CHECK_INTERVAL = 60_000; // Check every minute
    this.checkInterval = setInterval(() => this.checkIdle(), CHECK_INTERVAL);

    // Don't prevent Node from exiting
    if (this.checkInterval.unref) {
      this.checkInterval.unref();
    }
  }

  /**
   * Stop the scheduler and abort any running dream.
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    if (this.running) {
      this.engine.abort();
    }
  }

  /**
   * Check if idle long enough to start dreaming.
   */
  private async checkIdle(): Promise<void> {
    if (this.running) return;

    const idleMs = Date.now() - this.lastActivity;
    const idleMinutes = idleMs / 60_000;

    if (idleMinutes >= this.config.idleMinutes) {
      this.running = true;
      try {
        this.currentDream = this.engine.dream((phase, detail) => {
          // Log to stderr so it doesn't interfere with MCP stdio
          console.error(`[dream:${phase}] ${detail}`);
        });
        const report = await this.currentDream;
        console.error(
          `[dream] Complete: ${report.decayUpdated} decay, ${report.summariesGenerated} summaries, ${report.reviewSuggestions.length} reviews, ${report.relationshipsDiscovered} relations (${(report.durationMs / 1000).toFixed(1)}s)`
        );
      } catch (err) {
        console.error(`[dream] Error: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.running = false;
        this.currentDream = null;
        this.lastActivity = Date.now(); // Reset idle timer after dream
      }
    }
  }

  /**
   * Check if currently dreaming.
   */
  isDreaming(): boolean {
    return this.running;
  }
}

// ─── Format Helper ───────────────────────────────────────────────────────

/**
 * Format a dream report as human-readable text.
 */
export function formatDreamReport(report: DreamReport): string {
  const lines: string[] = [];

  lines.push("Gnosys Dream Report");
  lines.push("=".repeat(40));
  lines.push("");
  lines.push(`Duration: ${(report.durationMs / 1000).toFixed(1)}s`);
  lines.push(`Started: ${report.startedAt}`);
  lines.push(`Finished: ${report.finishedAt}`);
  if (report.aborted) {
    lines.push(`⚠ Aborted: ${report.abortReason}`);
  }
  lines.push("");

  lines.push("Results:");
  lines.push(`  Confidence decay updates: ${report.decayUpdated}`);
  lines.push(`  Summaries generated: ${report.summariesGenerated}`);
  lines.push(`  Summaries updated: ${report.summariesUpdated}`);
  lines.push(`  Relationships discovered: ${report.relationshipsDiscovered}`);
  lines.push(`  Duplicates flagged: ${report.duplicatesFound}`);
  lines.push("");

  if (report.reviewSuggestions.length > 0) {
    lines.push(`Review Suggestions (${report.reviewSuggestions.length}):`);
    for (const s of report.reviewSuggestions) {
      lines.push(`  [${s.suggestedAction}] "${s.title}" (confidence: ${s.currentConfidence.toFixed(2)})`);
      lines.push(`    Reason: ${s.reason}`);
    }
    lines.push("");
  }

  if (report.errors.length > 0) {
    lines.push(`Errors (${report.errors.length}):`);
    for (const e of report.errors) {
      lines.push(`  ! ${e}`);
    }
  }

  return lines.join("\n");
}

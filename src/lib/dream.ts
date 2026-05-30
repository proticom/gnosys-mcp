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

import os from "os";
import type { GnosysDB, DbMemory } from "./db.js";
import { getProviderModel, type GnosysConfig, type LLMProviderName } from "./config.js";
import { type LLMProvider, createProvider } from "./llm.js";
import { notifyDesktop } from "./desktopNotify.js";
import { syncConfidenceToDb, auditToDb } from "./dbWrite.js";
import { logError } from "./log.js";
import {
  type DreamEffectivenessRecord,
  type DreamLLMCallRecord,
  type DreamRunPhaseRecord,
  type DreamRunRecord,
  type DreamState,
  type DreamTrigger,
  estimateCost,
  estimateTokens,
  fingerprintMemories,
  memoryWatermark,
  readDreamState,
  writeDreamState,
} from "./dreamRunLog.js";

/** Layer 4 alert threshold: fire desktop notification at this many consecutive provider failures. */
const DREAM_FAILURE_NOTIFY_THRESHOLD = 3;

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
  /** Night-only launch window for scheduled Dream runs. */
  schedule: { startHour: number; endHour: number };
  /** Real system idle minutes required before scheduled Dream runs. */
  systemIdleMinutes: number;
  /** Minimum changed memories required before scheduled Dream runs. */
  minNewMemoriesToDream: number;
  /** Minimum hours between scheduled Dream runs. */
  minHoursBetweenRuns: number;
  /** Hard LLM call ceiling for one Dream run. */
  maxLLMCallsPerRun: number;
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
  schedule: { startHour: 2, endHour: 5 },
  systemIdleMinutes: 30,
  minNewMemoriesToDream: 10,
  minHoursBetweenRuns: 20,
  maxLLMCallsPerRun: 12,
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
  id?: string;
  trigger?: DreamTrigger;
  machine?: { hostname: string; machineId?: string };
  provider?: string;
  model?: string;
  phases?: DreamRunPhaseRecord[];
  llmCalls?: DreamLLMCallRecord[];
  totals?: DreamRunRecord["totals"];
  effectiveness?: DreamEffectivenessRecord;
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
  private trigger: DreamTrigger;
  private machineId?: string;
  private dreamState: DreamState = readDreamState();
  private pendingFingerprints: DreamState["analyzedFingerprints"] = {};
  private llmCallsMade = 0;

  constructor(
    db: GnosysDB,
    config: GnosysConfig,
    dreamConfig?: Partial<DreamConfig>,
    options?: { trigger?: DreamTrigger; machineId?: string }
  ) {
    this.db = db;
    this.config = config;
    this.dreamConfig = {
      ...DEFAULT_DREAM_CONFIG,
      ...dreamConfig,
      schedule: { ...DEFAULT_DREAM_CONFIG.schedule, ...(dreamConfig?.schedule ?? {}) },
    };
    this.trigger = options?.trigger ?? "manual";
    this.machineId = options?.machineId;

    // Initialize LLM provider for dream operations.
    // v5.4.2: Failure here is no longer silent — when dream tries to actually
    // run (in dream()), we record the unavailability to audit_log so the
    // user gets visibility (Layer 2 alert) and can react via the dashboard.
    try {
      const provider = this.dreamConfig.provider;
      const model = this.dreamConfig.model || getProviderModel(this.config, provider);
      this.provider = createProvider(provider, model, this.config);
    } catch (err) {
      this.provider = null;
      this.providerInitError = err instanceof Error ? err.message : String(err);
    }
  }

  /** Captured at construction if getLLMProvider throws. Used in dream() to write a Layer 2 audit entry. */
  private providerInitError: string | null = null;

  private createPhase(name: DreamRunPhaseRecord["name"]): DreamRunPhaseRecord {
    return {
      name,
      status: "ran",
      durationMs: 0,
      memoryIdsTouched: [],
      llmCallsMade: 0,
      llmCallsSkipped: 0,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      estimatedCostUsd: 0,
    };
  }

  private finishPhase(phase: DreamRunPhaseRecord, startedAtMs: number): void {
    phase.durationMs = Date.now() - startedAtMs;
    phase.memoryIdsTouched = Array.from(new Set(phase.memoryIdsTouched));
    phase.estimatedCostUsd = Math.round(phase.estimatedCostUsd * 1_000_000) / 1_000_000;
  }

  private addTouched(phase: DreamRunPhaseRecord, memoryIds: string[]): void {
    for (const id of memoryIds) {
      if (id) phase.memoryIdsTouched.push(id);
    }
  }

  private recordLLMSkip(
    phase: DreamRunPhaseRecord,
    label: string,
    reason: string,
    memoryIds: string[] = [],
    fingerprint?: string,
  ): void {
    phase.llmCallsSkipped++;
    this.llmCalls.push({
      phase: phase.name,
      label,
      status: "skipped",
      reason,
      provider: this.dreamConfig.provider,
      model: this.dreamConfig.model || this.provider?.model || getProviderModel(this.config, this.dreamConfig.provider),
      memoryIds,
      fingerprint,
      estimatedInputTokens: 0,
      estimatedOutputTokens: 0,
      estimatedCostUsd: 0,
    });
  }

  private llmCalls: DreamLLMCallRecord[] = [];

  private async generateWithAccounting(
    phase: DreamRunPhaseRecord,
    label: string,
    prompt: string,
    maxTokens: number,
    memoryIds: string[],
    fingerprint?: string,
  ): Promise<string | null> {
    if (!this.provider) {
      this.recordLLMSkip(phase, label, "provider unavailable", memoryIds, fingerprint);
      return null;
    }

    const inputTokens = estimateTokens(prompt);
    this.llmCallsMade++;
    try {
      const response = await this.provider.generate(prompt, { maxTokens });
      const outputTokens = estimateTokens(response);
      const cost = estimateCost(this.provider.model, inputTokens, outputTokens);
      phase.llmCallsMade++;
      phase.estimatedInputTokens += inputTokens;
      phase.estimatedOutputTokens += outputTokens;
      phase.estimatedCostUsd += cost;
      this.llmCalls.push({
        phase: phase.name,
        label,
        status: "made",
        provider: this.provider.name,
        model: this.provider.model,
        memoryIds,
        fingerprint,
        estimatedInputTokens: inputTokens,
        estimatedOutputTokens: outputTokens,
        estimatedCostUsd: cost,
      });
      if (fingerprint && response) {
        this.pendingFingerprints[fingerprint] = {
          kind: phase.name === "relationships" ? "relationship" : phase.name === "summaries" ? "summary" : "critique",
          lastAnalyzedAt: new Date().toISOString(),
          memoryIds,
        };
      }
      return response;
    } catch (err) {
      phase.llmCallsMade++;
      const cost = estimateCost(this.provider.model, inputTokens, 0);
      phase.estimatedInputTokens += inputTokens;
      phase.estimatedCostUsd += cost;
      this.llmCalls.push({
        phase: phase.name,
        label,
        status: "failed",
        reason: err instanceof Error ? err.message : String(err),
        provider: this.provider.name,
        model: this.provider.model,
        memoryIds,
        fingerprint,
        estimatedInputTokens: inputTokens,
        estimatedOutputTokens: 0,
        estimatedCostUsd: cost,
      });
      throw err;
    }
  }

  /** Expose the local DB so DreamScheduler can read designation meta. */
  getDb(): GnosysDB {
    return this.db;
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
    this.llmCallsMade = 0;
    this.llmCalls = [];
    this.pendingFingerprints = {};
    this.dreamState = readDreamState();
    const log = onProgress || (() => {});
    const startedAt = new Date().toISOString();

    const report: DreamReport = {
      id: `dream-${Date.parse(startedAt)}-${Math.random().toString(36).slice(2, 8)}`,
      trigger: this.trigger,
      startedAt,
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
      machine: { hostname: os.hostname(), machineId: this.machineId },
      provider: this.dreamConfig.provider,
      model: this.dreamConfig.model || this.provider?.model,
      phases: [],
      llmCalls: [],
      totals: {
        llmCallsMade: 0,
        llmCallsSkipped: 0,
        estimatedInputTokens: 0,
        estimatedOutputTokens: 0,
        estimatedCostUsd: 0,
      },
      effectiveness: {
        usefulOutputScore: 0,
        costPerUsefulOutput: null,
        decaysApplied: 0,
        summariesGenerated: 0,
        summariesUpdated: 0,
        reviewSuggestions: 0,
        relationshipsDiscovered: 0,
      },
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
      startedAt: report.startedAt,
      config: {
        maxRuntime: this.dreamConfig.maxRuntimeMinutes,
        selfCritique: this.dreamConfig.selfCritique,
        generateSummaries: this.dreamConfig.generateSummaries,
        discoverRelationships: this.dreamConfig.discoverRelationships,
        provider: this.dreamConfig.provider,
        model: this.dreamConfig.model || null,
      },
      memoryCount: counts.active,
    });

    // v5.4.2 Layer 2 alert: if the LLM provider couldn't be initialized at
    // construction time, record this run as unable to do LLM-driven work.
    // This makes the silent-skip behavior visible in audit_log and dashboard.
    if (!this.provider) {
      const errMsg = this.providerInitError || "LLM provider unavailable (no key, server unreachable, or misconfigured)";
      auditToDb(this.db, "dream_provider_unreachable", undefined, {
        provider: this.dreamConfig.provider,
        model: this.dreamConfig.model || null,
        error: errMsg,
        phase: "init",
      });
      const failures = this.db.incrementDreamConsecutiveFailures();
      report.errors.push(`Provider unavailable: ${errMsg}`);
      // v5.4.2 Layer 4: fire desktop notification on threshold crossing.
      if (failures === DREAM_FAILURE_NOTIFY_THRESHOLD) {
        notifyDesktop(
          `Dream provider has failed ${failures} times in a row. Run 'gnosys setup dream' to reconfigure.`,
          { title: "Gnosys Dream", subtitle: `${this.dreamConfig.provider}/${this.dreamConfig.model || "default"}` }
        ).catch(() => { /* never throws — best effort */ });
      }
    }

    // ─── Phase 1: Confidence Decay Sweep ─────────────────────────────────
    log("decay", "Phase 1: Confidence decay sweep...");
    const decayPhase = this.createPhase("decay");
    const decayStart = Date.now();
    report.phases!.push(decayPhase);
    try {
      const decayResult = this.decaySweep();
      report.decayUpdated = decayResult.count;
      this.addTouched(decayPhase, decayResult.memoryIds);
      log("decay", `Updated ${report.decayUpdated} memories`);
    } catch (err) {
      report.errors.push(`Decay sweep: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.finishPhase(decayPhase, decayStart);
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
      const critiquePhase = this.createPhase("critique");
      const critiqueStart = Date.now();
      report.phases!.push(critiquePhase);
      try {
        report.reviewSuggestions = await this.selfCritique(log, critiquePhase);
        this.addTouched(critiquePhase, report.reviewSuggestions.map((s) => s.memoryId));
        log("critique", `Generated ${report.reviewSuggestions.length} review suggestions`);
      } catch (err) {
        report.errors.push(`Self-critique: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.finishPhase(critiquePhase, critiqueStart);
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
      const summariesPhase = this.createPhase("summaries");
      const summariesStart = Date.now();
      report.phases!.push(summariesPhase);
      try {
        const summaryResult = await this.generateSummaries(log, summariesPhase);
        report.summariesGenerated = summaryResult.generated;
        report.summariesUpdated = summaryResult.updated;
        this.addTouched(summariesPhase, summaryResult.memoryIds);
        log("summaries", `Generated ${summaryResult.generated}, updated ${summaryResult.updated}`);
      } catch (err) {
        report.errors.push(`Summary generation: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.finishPhase(summariesPhase, summariesStart);
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
      const relationshipsPhase = this.createPhase("relationships");
      const relationshipsStart = Date.now();
      report.phases!.push(relationshipsPhase);
      try {
        const relationshipsResult = await this.discoverRelationships(log, relationshipsPhase);
        report.relationshipsDiscovered = relationshipsResult.count;
        this.addTouched(relationshipsPhase, relationshipsResult.memoryIds);
        log("relationships", `Discovered ${report.relationshipsDiscovered} new relationships`);
      } catch (err) {
        report.errors.push(`Relationship discovery: ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        this.finishPhase(relationshipsPhase, relationshipsStart);
      }
    }

    return this.finalize(report);
  }

  private finalize(report: DreamReport): DreamReport {
    report.finishedAt = new Date().toISOString();
    report.durationMs = Date.now() - this.startTime;
    report.llmCalls = this.llmCalls;
    report.totals = this.llmCalls.reduce(
      (totals, call) => {
        if (call.status === "made" || call.status === "failed") totals.llmCallsMade++;
        if (call.status === "skipped") totals.llmCallsSkipped++;
        totals.estimatedInputTokens += call.estimatedInputTokens;
        totals.estimatedOutputTokens += call.estimatedOutputTokens;
        totals.estimatedCostUsd += call.estimatedCostUsd;
        return totals;
      },
      {
        llmCallsMade: 0,
        llmCallsSkipped: 0,
        estimatedInputTokens: 0,
        estimatedOutputTokens: 0,
        estimatedCostUsd: 0,
      }
    );
    report.totals.estimatedCostUsd = Math.round(report.totals.estimatedCostUsd * 1_000_000) / 1_000_000;
    const usefulOutputScore =
      report.decayUpdated +
      report.summariesGenerated * 5 +
      report.summariesUpdated * 3 +
      report.relationshipsDiscovered * 2;
    report.effectiveness = {
      usefulOutputScore,
      costPerUsefulOutput: usefulOutputScore > 0
        ? Math.round((report.totals.estimatedCostUsd / usefulOutputScore) * 1_000_000) / 1_000_000
        : null,
      decaysApplied: report.decayUpdated,
      summariesGenerated: report.summariesGenerated,
      summariesUpdated: report.summariesUpdated,
      reviewSuggestions: report.reviewSuggestions.length,
      relationshipsDiscovered: report.relationshipsDiscovered,
    };

    const memories = this.db.isAvailable() ? this.db.getActiveMemories() : [];
    const watermark = memoryWatermark(memories);
    writeDreamState({
      ...this.dreamState,
      lastRunAt: report.finishedAt,
      lastSuccessfulRunAt: report.errors.length === 0 && !report.aborted ? report.finishedAt : this.dreamState.lastSuccessfulRunAt,
      lastMemoryCount: watermark.count,
      lastMemoryMaxModified: watermark.maxModified,
      analyzedFingerprints: {
        ...this.dreamState.analyzedFingerprints,
        ...this.pendingFingerprints,
      },
    });

    // v5.4.2: A run is considered "successful with LLM work" if any of the
    // LLM-dependent counters moved. Resetting the consecutive-failure count
    // here ensures Layer 4 doesn't keep firing once dream is healthy again.
    const llmDidWork =
      report.summariesGenerated > 0 || report.relationshipsDiscovered > 0;
    if (llmDidWork) {
      this.db.resetDreamConsecutiveFailures();
    }

    // Audit: dream complete
    auditToDb(this.db, "dream_complete", undefined, {
      startedAt: report.startedAt,
      durationMs: report.durationMs,
      decayUpdated: report.decayUpdated,
      summariesGenerated: report.summariesGenerated,
      reviewSuggestions: report.reviewSuggestions.length,
      relationshipsDiscovered: report.relationshipsDiscovered,
      llmCallsMade: report.totals.llmCallsMade,
      llmCallsSkipped: report.totals.llmCallsSkipped,
      estimatedCostUsd: report.totals.estimatedCostUsd,
      usefulOutputScore: report.effectiveness.usefulOutputScore,
      errors: report.errors.length,
      aborted: report.aborted,
      providerUnreachable: !this.provider,
      provider: this.dreamConfig.provider,
      model: this.dreamConfig.model || null,
    }, report.durationMs);

    return report;
  }

  // ─── Phase 1: Decay Sweep ──────────────────────────────────────────────

  /**
   * Apply exponential decay to all active memories.
   * Formula: decayed = confidence * e^(-λ * days_since_reinforced)
   * Only updates if decayed value differs from stored value by > 0.01.
   */
  private decaySweep(): { count: number; memoryIds: string[] } {
    const now = new Date();
    const memories = this.db.getActiveMemories();
    let updated = 0;
    const memoryIds: string[] = [];

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
        memoryIds.push(mem.id);
      }
    }

    return { count: updated, memoryIds };
  }

  // ─── Phase 2: Self-Critique ────────────────────────────────────────────

  /**
   * Score memories and generate review suggestions.
   * NEVER deletes or archives — only flags for human review.
   */
  private async selfCritique(
    log: (phase: string, detail: string) => void,
    phase: DreamRunPhaseRecord,
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
          const llmSuggestion = await this.llmCritique(mem, phase);
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
  private async llmCritique(mem: DbMemory, phase: DreamRunPhaseRecord): Promise<ReviewSuggestion | null> {
    if (!this.provider) return null;
    const fingerprint = fingerprintMemories("critique", [mem]);

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
      const response = await this.generateWithAccounting(
        phase,
        `critique:${mem.id}`,
        prompt,
        200,
        [mem.id],
        fingerprint,
      );
      if (!response) return null;
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
    log: (phase: string, detail: string) => void,
    phase: DreamRunPhaseRecord,
  ): Promise<{ generated: number; updated: number; memoryIds: string[] }> {
    if (!this.provider) return { generated: 0, updated: 0, memoryIds: [] };

    const categories = this.db.getCategories();
    let generated = 0;
    let updated = 0;
    const touched: string[] = [];

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
        if (unchanged) {
          phase.llmCallsSkipped++;
          phase.reason = phase.reason || "unchanged summaries skipped";
          continue; // No new memories in this category
        }
      }

      log("summaries", `Summarizing ${category} (${memories.length} memories)...`);

      try {
        const summary = await this.summarizeCategory(category, memories, phase);
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
          touched.push(...memories.map((m) => m.id));
        }
      } catch (err) {
        log("summaries", `Failed to summarize ${category}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { generated, updated, memoryIds: touched };
  }

  /**
   * Use LLM to generate a category summary.
   */
  private async summarizeCategory(
    category: string,
    memories: DbMemory[],
    phase: DreamRunPhaseRecord,
  ): Promise<string | null> {
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
      return await this.generateWithAccounting(
        phase,
        `summary:${category}`,
        prompt,
        1024,
        memories.map((m) => m.id),
        fingerprintMemories("summary", memories),
      );
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
    log: (phase: string, detail: string) => void,
    phase: DreamRunPhaseRecord,
  ): Promise<{ count: number; memoryIds: string[] }> {
    if (!this.provider) return { count: 0, memoryIds: [] };

    const memories = this.db.getActiveMemories();
    if (memories.length < 3) return { count: 0, memoryIds: [] };

    let discovered = 0;
    const touched = new Set<string>();
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
        const relationships = await this.findRelationships(batch, memoryIndex, phase);

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
          touched.add(rel.source_id);
          touched.add(rel.target_id);
        }
      } catch (err) {
        log("relationships", `Failed for batch: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return { count: discovered, memoryIds: Array.from(touched) };
  }

  /**
   * Use LLM to find relationships for a batch of source memories.
   */
  private async findRelationships(
    sources: DbMemory[],
    memoryIndex: string,
    phase: DreamRunPhaseRecord,
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
      const response = await this.generateWithAccounting(
        phase,
        `relationships:${sources.map((s) => s.id).join(",")}`,
        prompt,
        1024,
        sources.map((s) => s.id),
        fingerprintMemories("relationship", sources),
      );
      if (!response) return [];

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
   *
   * v5.4.2: Designation gate — only the machine designated via
   * `gnosys setup dream` arms the timer. All other machines on the same
   * shared NAS DB no-op silently. Without this, every machine would run
   * dream cycles, fighting for SQLite write locks and duplicating work.
   */
  start(): void {
    if (!this.config.enabled) return;
    if (this.checkInterval) return;
    if (!this.isDesignatedMachine()) {
      // Quiet — non-designated machines simply don't dream. The user can
      // see designation status via `gnosys status --system` if curious.
      return;
    }

    const CHECK_INTERVAL = 60_000; // Check every minute
    this.checkInterval = setInterval(() => this.checkIdle(), CHECK_INTERVAL);

    // Don't prevent Node from exiting
    if (this.checkInterval.unref) {
      this.checkInterval.unref();
    }
  }

  /** Returns true iff this machine is the dream node per central DB meta. */
  private isDesignatedMachine(): boolean {
    try {
      const db = this.engine.getDb();
      const designated = db.getDreamMachineId();
      if (!designated) return false; // No machine designated → no dreams.
      // Lazy-import to avoid circular dependency between dream.ts and remote.ts
      // We can re-derive locally without remote's helper.
      const localId = this.getLocalMachineId(db);
      return designated === localId;
    } catch {
      return false;
    }
  }

  private getLocalMachineId(db: GnosysDB): string {
    let id = db.getMeta("machine_id");
    if (!id) {
      // v5.9.4 Bug 9 — env vars + os.hostname() fallback so macOS shells
      // without HOSTNAME/COMPUTERNAME still produce a useful identifier.
      // Mirrors `remote.resolveHostname()`; kept inlined to avoid a circular
      // import (remote.ts → dream.ts via the dream scheduler types).
      let hostname = process.env.HOSTNAME || process.env.COMPUTERNAME || "";
      if (!hostname) {
        try { hostname = os.hostname() || ""; } catch { /* fall through */ }
      }
      id = `${hostname || "unknown"}-${Date.now().toString(36)}`;
      db.setMeta("machine_id", id);
    }
    return id;
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
        logError(err, { module: "dream", op: "scheduler" });
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
    lines.push(`Aborted: ${report.abortReason}`);
  }
  lines.push("");

  lines.push("Results:");
  lines.push(`  Confidence decay updates: ${report.decayUpdated}`);
  lines.push(`  Summaries generated: ${report.summariesGenerated}`);
  lines.push(`  Summaries updated: ${report.summariesUpdated}`);
  lines.push(`  Relationships discovered: ${report.relationshipsDiscovered}`);
  lines.push(`  Duplicates flagged: ${report.duplicatesFound}`);
  if (report.totals) {
    lines.push(`  LLM calls: ${report.totals.llmCallsMade} made, ${report.totals.llmCallsSkipped} skipped`);
    lines.push(`  Estimated cost: $${report.totals.estimatedCostUsd.toFixed(6)}`);
  }
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

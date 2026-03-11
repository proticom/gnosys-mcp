/**
 * Gnosys Maintenance Engine — Keeps the vault clean and useful forever.
 *
 * Features:
 *   - Duplicate detection (semantic similarity + title overlap)
 *   - Stale marking (confidence decay based on days since last reinforced)
 *   - Reinforcement (increment counter when memories are used)
 *   - Auto-consolidation (LLM-powered merge of similar memories)
 *
 * All operations produce safe Git commits with rollback on failure.
 */

import { GnosysStore, Memory, MemoryFrontmatter } from "./store.js";
import { GnosysEmbeddings } from "./embeddings.js";
import { GnosysConfig, DEFAULT_CONFIG } from "./config.js";
import { LLMProvider, getLLMProvider } from "./llm.js";
import { GnosysResolver, ResolvedStore } from "./resolver.js";
import { GnosysArchive, getArchiveEligible } from "./archive.js";
import { acquireWriteLock } from "./lock.js";
import { auditLog } from "./audit.js";
import { execSync } from "child_process";
import path from "path";
import fs from "fs/promises";
import matter from "gray-matter";

// ─── Constants ────────────────────────────────────────────────────────────

/** Decay rate lambda — 0.005 gives ~50% decay after 139 days */
const DECAY_LAMBDA = 0.005;

/** Cosine similarity threshold for duplicate detection */
const DUPLICATE_SIMILARITY_THRESHOLD = 0.85;

/** Minimum Jaccard word overlap on titles to flag as duplicate */
const TITLE_OVERLAP_THRESHOLD = 0.4;

/** Confidence below which a memory is considered stale */
const STALE_CONFIDENCE_THRESHOLD = 0.3;

// ─── Types ────────────────────────────────────────────────────────────────

export interface MaintenanceOptions {
  /** Show what would change without modifying anything */
  dryRun?: boolean;
  /** Automatically apply all changes (no interactive prompts) */
  autoApply?: boolean;
  /** Progress callback */
  onProgress?: (step: string, current: number, total: number) => void;
  /** Log callback */
  onLog?: (level: "info" | "warn" | "action", message: string) => void;
}

export interface DuplicatePair {
  memoryA: Memory;
  memoryB: Memory;
  similarity: number;
  titleOverlap: number;
}

export interface StaleMemory {
  memory: Memory;
  originalConfidence: number;
  decayedConfidence: number;
  daysSinceReinforced: number;
}

export interface MaintenanceReport {
  /** Total memories scanned */
  totalMemories: number;
  /** Duplicate pairs detected */
  duplicates: DuplicatePair[];
  /** Memories with decayed confidence below threshold */
  staleMemories: StaleMemory[];
  /** Average confidence across all active memories */
  avgConfidence: number;
  /** Average decayed confidence */
  avgDecayedConfidence: number;
  /** Number of memories that were consolidated */
  consolidated: number;
  /** Number of memories with updated decay */
  decayUpdated: number;
  /** Number of memories archived in this run */
  archived: number;
  /** Total memories in archive after this run */
  totalArchived: number;
  /** Actions taken (or that would be taken in dry run) */
  actions: string[];
}

// ─── Core Engine ──────────────────────────────────────────────────────────

export class GnosysMaintenanceEngine {
  private resolver: GnosysResolver;
  private config: GnosysConfig;
  private embeddings: GnosysEmbeddings | null = null;
  private provider: LLMProvider | null = null;

  constructor(resolver: GnosysResolver, config?: GnosysConfig) {
    this.resolver = resolver;
    this.config = config || DEFAULT_CONFIG;

    try {
      this.provider = getLLMProvider(this.config, "structuring");
    } catch {
      this.provider = null;
    }
  }

  /**
   * Run the full maintenance cycle.
   */
  async maintain(options?: MaintenanceOptions): Promise<MaintenanceReport> {
    const log = options?.onLog || (() => {});
    const progress = options?.onProgress || (() => {});
    const dryRun = options?.dryRun ?? false;
    const autoApply = options?.autoApply ?? false;

    log("info", `Starting maintenance${dryRun ? " (dry run)" : ""}...`);

    // Get all memories from all stores
    const stores = this.resolver.getStores();
    const writeTarget = this.resolver.getWriteTarget();

    // Acquire write lock for concurrent safety (skip in dry-run)
    let releaseLock: (() => void) | null = null;
    if (!dryRun && writeTarget) {
      try {
        releaseLock = await acquireWriteLock(writeTarget.path, "maintain");
      } catch (err) {
        log("warn", `Could not acquire write lock: ${(err as Error).message}`);
      }
    }

    if (!writeTarget) {
      throw new Error("No writable store found. Run gnosys init first.");
    }

    const allMemories = await this.loadAllActiveMemories();
    log("info", `Found ${allMemories.length} active memories across ${stores.length} store(s)`);

    const report: MaintenanceReport = {
      totalMemories: allMemories.length,
      duplicates: [],
      staleMemories: [],
      avgConfidence: 0,
      avgDecayedConfidence: 0,
      consolidated: 0,
      decayUpdated: 0,
      archived: 0,
      totalArchived: 0,
      actions: [],
    };

    if (allMemories.length === 0) {
      log("info", "No memories to maintain.");
      releaseLock?.();
      return report;
    }

    // Step 1: Detect duplicates (requires embeddings)
    progress("Detecting duplicates", 0, 4);
    log("info", "Step 1/4: Detecting duplicates...");
    report.duplicates = await this.detectDuplicates(allMemories, writeTarget, log);
    log("info", `  Found ${report.duplicates.length} duplicate pair(s)`);

    // Step 2: Calculate confidence decay
    progress("Calculating decay", 1, 4);
    log("info", "Step 2/4: Calculating confidence decay...");
    const { stale, avgConfidence, avgDecayedConfidence } = this.calculateDecay(allMemories);
    report.staleMemories = stale;
    report.avgConfidence = avgConfidence;
    report.avgDecayedConfidence = avgDecayedConfidence;
    log("info", `  ${stale.length} stale memorie(s) (confidence < ${STALE_CONFIDENCE_THRESHOLD})`);
    log("info", `  Average confidence: ${avgConfidence.toFixed(3)} → decayed: ${avgDecayedConfidence.toFixed(3)}`);

    // Step 3: Archive old/low-confidence memories
    progress("Archiving", 2, 4);
    log("info", "Step 3/4: Archiving old/low-confidence memories...");
    const archiveResult = await this.archiveOldMemories(allMemories, writeTarget, dryRun, autoApply, log);
    report.archived = archiveResult.archived;
    report.totalArchived = archiveResult.totalArchived;
    report.actions.push(...archiveResult.actions);

    // Step 4: Apply changes
    progress("Applying changes", 3, 4);
    log("info", "Step 4/4: Applying changes...");

    if (dryRun) {
      // Report what would happen
      for (const dup of report.duplicates) {
        const action = `[DRY RUN] Would consolidate: "${dup.memoryA.frontmatter.title}" + "${dup.memoryB.frontmatter.title}" (similarity: ${dup.similarity.toFixed(3)})`;
        report.actions.push(action);
        log("action", action);
      }
      for (const sm of report.staleMemories) {
        const action = `[DRY RUN] Would update decay: "${sm.memory.frontmatter.title}" (${sm.originalConfidence.toFixed(2)} → ${sm.decayedConfidence.toFixed(2)}, ${sm.daysSinceReinforced} days since reinforced)`;
        report.actions.push(action);
        log("action", action);
      }
    } else if (autoApply) {
      // Auto-consolidate duplicates
      for (const dup of report.duplicates) {
        try {
          await this.consolidatePair(dup, writeTarget, log);
          report.consolidated++;
          report.actions.push(`Consolidated: "${dup.memoryA.frontmatter.title}" + "${dup.memoryB.frontmatter.title}"`);
        } catch (err) {
          const msg = `Failed to consolidate "${dup.memoryA.frontmatter.title}": ${err instanceof Error ? err.message : String(err)}`;
          log("warn", msg);
          report.actions.push(msg);
        }
      }

      // Update decayed confidences
      for (const sm of report.staleMemories) {
        try {
          await this.updateDecayedConfidence(sm, writeTarget, log);
          report.decayUpdated++;
          report.actions.push(`Decay updated: "${sm.memory.frontmatter.title}" (${sm.originalConfidence.toFixed(2)} → ${sm.decayedConfidence.toFixed(2)})`);
        } catch (err) {
          const msg = `Failed to update decay for "${sm.memory.frontmatter.title}": ${err instanceof Error ? err.message : String(err)}`;
          log("warn", msg);
          report.actions.push(msg);
        }
      }
    }

    progress("Complete", 4, 4);
    log("info", `Maintenance complete. ${report.actions.length} action(s) ${dryRun ? "identified" : "taken"}.`);

    // Release write lock
    releaseLock?.();

    // Audit log
    auditLog({
      operation: "maintain",
      details: {
        dryRun,
        duplicates: report.duplicates.length,
        stale: report.staleMemories.length,
        consolidated: report.consolidated,
        archived: report.archived,
        decayUpdated: report.decayUpdated,
      },
    });

    return report;
  }

  // ─── Duplicate Detection ──────────────────────────────────────────────

  /**
   * Find duplicate pairs using semantic similarity + title overlap.
   */
  private async detectDuplicates(
    memories: Memory[],
    writeTarget: ResolvedStore,
    log: (level: "info" | "warn" | "action", message: string) => void
  ): Promise<DuplicatePair[]> {
    // Initialize embeddings from the write target store
    this.embeddings = new GnosysEmbeddings(writeTarget.path);

    if (!this.embeddings.hasEmbeddings()) {
      log("info", "  No embeddings found — skipping duplicate detection. Run gnosys reindex first.");
      return [];
    }

    const duplicates: DuplicatePair[] = [];
    const allEmbeddings = this.embeddings.getAllEmbeddings();

    // Build a map from file path to embedding
    const embeddingMap = new Map<string, Float32Array>();
    for (const e of allEmbeddings) {
      // Strip store prefix if present (format: "label:relativePath")
      const key = e.filePath.includes(":") ? e.filePath.split(":").slice(1).join(":") : e.filePath;
      embeddingMap.set(key, e.embedding);
    }

    // Compare all pairs
    const checked = new Set<string>();

    for (let i = 0; i < memories.length; i++) {
      for (let j = i + 1; j < memories.length; j++) {
        const a = memories[i];
        const b = memories[j];

        const pairKey = `${a.relativePath}|${b.relativePath}`;
        if (checked.has(pairKey)) continue;
        checked.add(pairKey);

        // Get embeddings for both
        const embA = embeddingMap.get(a.relativePath);
        const embB = embeddingMap.get(b.relativePath);

        if (!embA || !embB) continue;

        const similarity = GnosysEmbeddings.cosineSimilarity(embA, embB);

        if (similarity >= DUPLICATE_SIMILARITY_THRESHOLD) {
          const titleOverlap = jaccardSimilarity(
            a.frontmatter.title.toLowerCase(),
            b.frontmatter.title.toLowerCase()
          );

          if (titleOverlap >= TITLE_OVERLAP_THRESHOLD) {
            duplicates.push({ memoryA: a, memoryB: b, similarity, titleOverlap });
          }
        }
      }
    }

    return duplicates;
  }

  // ─── Confidence Decay ─────────────────────────────────────────────────

  /**
   * Calculate decayed confidence for all memories.
   * Formula: decayed = base_confidence * e^(-lambda * days_since_reinforced)
   */
  private calculateDecay(memories: Memory[]): {
    stale: StaleMemory[];
    avgConfidence: number;
    avgDecayedConfidence: number;
  } {
    const now = new Date();
    const stale: StaleMemory[] = [];
    let sumConfidence = 0;
    let sumDecayed = 0;

    for (const memory of memories) {
      const baseConfidence = memory.frontmatter.confidence || 0.8;
      const lastReinforced = (memory.frontmatter as any).last_reinforced
        || memory.frontmatter.modified
        || memory.frontmatter.created;

      const lastDate = new Date(lastReinforced);
      const daysSince = Math.max(0, Math.floor((now.getTime() - lastDate.getTime()) / (1000 * 60 * 60 * 24)));

      const decayed = baseConfidence * Math.exp(-DECAY_LAMBDA * daysSince);

      sumConfidence += baseConfidence;
      sumDecayed += decayed;

      if (decayed < STALE_CONFIDENCE_THRESHOLD) {
        stale.push({
          memory,
          originalConfidence: baseConfidence,
          decayedConfidence: decayed,
          daysSinceReinforced: daysSince,
        });
      }
    }

    return {
      stale,
      avgConfidence: memories.length > 0 ? sumConfidence / memories.length : 0,
      avgDecayedConfidence: memories.length > 0 ? sumDecayed / memories.length : 0,
    };
  }

  // ─── Consolidation ────────────────────────────────────────────────────

  /**
   * Use LLM to merge two duplicate memories into one.
   * Creates a new memory that supersedes both.
   */
  private async consolidatePair(
    pair: DuplicatePair,
    writeTarget: ResolvedStore,
    log: (level: "info" | "warn" | "action", message: string) => void
  ): Promise<void> {
    if (!this.provider) {
      log("warn", "  No LLM provider available — skipping consolidation. Configure Anthropic or Ollama.");
      return;
    }

    const prompt = `You are a knowledge management assistant. Merge these two memories into a single, comprehensive memory. Preserve all unique information from both. Output ONLY the merged markdown content (no frontmatter).

## Memory A: ${pair.memoryA.frontmatter.title}
${pair.memoryA.content}

## Memory B: ${pair.memoryB.frontmatter.title}
${pair.memoryB.content}

Merged content:`;

    const mergedContent = await this.provider.generate(prompt, { maxTokens: 4096 });

    // Determine the merged title
    const mergedTitle = pair.memoryA.frontmatter.title.length >= pair.memoryB.frontmatter.title.length
      ? pair.memoryA.frontmatter.title
      : pair.memoryB.frontmatter.title;

    // Merge tags
    const tagsA = Array.isArray(pair.memoryA.frontmatter.tags) ? pair.memoryA.frontmatter.tags : [];
    const tagsB = Array.isArray(pair.memoryB.frontmatter.tags) ? pair.memoryB.frontmatter.tags : [];
    const mergedTags = [...new Set([...tagsA, ...tagsB])];

    // Merge relevance
    const relA = pair.memoryA.frontmatter.relevance || "";
    const relB = pair.memoryB.frontmatter.relevance || "";
    const mergedRelevance = [...new Set([...relA.split(/\s+/), ...relB.split(/\s+/)])].filter(Boolean).join(" ");

    // Generate new ID
    const category = pair.memoryA.frontmatter.category || pair.memoryA.relativePath.split("/")[0];
    const newId = await writeTarget.store.generateId(category);
    const today = new Date().toISOString().split("T")[0];

    const newFrontmatter: MemoryFrontmatter = {
      id: newId,
      title: mergedTitle,
      category,
      tags: mergedTags,
      relevance: mergedRelevance,
      author: "human+ai",
      authority: pair.memoryA.frontmatter.authority,
      confidence: Math.max(pair.memoryA.frontmatter.confidence || 0.8, pair.memoryB.frontmatter.confidence || 0.8),
      created: today,
      modified: today,
      last_reviewed: today,
      status: "active",
      supersedes: `${pair.memoryA.frontmatter.id}, ${pair.memoryB.frontmatter.id}`,
    };

    // Write the merged memory
    const filename = `${mergedTitle.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.md`;

    await safeGitOperation(writeTarget.path, `Consolidate: ${pair.memoryA.frontmatter.id} + ${pair.memoryB.frontmatter.id}`, async () => {
      await writeTarget.store.writeMemory(category, filename, newFrontmatter, mergedContent, { autoCommit: false });

      // Mark originals as superseded
      await writeTarget.store.updateMemory(pair.memoryA.relativePath, {
        status: "superseded",
        superseded_by: newId,
      });
      await writeTarget.store.updateMemory(pair.memoryB.relativePath, {
        status: "superseded",
        superseded_by: newId,
      });
    });

    log("action", `  Consolidated "${pair.memoryA.frontmatter.title}" + "${pair.memoryB.frontmatter.title}" → ${newId}`);
  }

  // ─── Decay Updates ────────────────────────────────────────────────────

  /**
   * Update a stale memory's confidence to its decayed value.
   */
  private async updateDecayedConfidence(
    stale: StaleMemory,
    writeTarget: ResolvedStore,
    log: (level: "info" | "warn" | "action", message: string) => void
  ): Promise<void> {
    await safeGitOperation(writeTarget.path, `Decay: ${stale.memory.frontmatter.id} (${stale.originalConfidence.toFixed(2)} → ${stale.decayedConfidence.toFixed(2)})`, async () => {
      await writeTarget.store.updateMemory(stale.memory.relativePath, {
        confidence: Math.round(stale.decayedConfidence * 100) / 100,
      });
    });

    log("action", `  Decay updated: "${stale.memory.frontmatter.title}" → ${stale.decayedConfidence.toFixed(2)}`);
  }

  // ─── Reinforcement ────────────────────────────────────────────────────

  /**
   * Reinforce a memory — increment its usage counter and update last_reinforced.
   * This is a lightweight operation called by search/ask/import.
   */
  static async reinforce(
    store: GnosysStore,
    relativePath: string
  ): Promise<void> {
    const memory = await store.readMemory(relativePath);
    if (!memory) return;

    const currentCount = ((memory.frontmatter as any).reinforcement_count as number) || 0;
    const today = new Date().toISOString().split("T")[0];

    await store.updateMemory(relativePath, {
      reinforcement_count: currentCount + 1,
      last_reinforced: today,
    } as any);
  }

  /**
   * Batch reinforce multiple memories (e.g., all results from a search).
   * Lightweight — just updates counters, no LLM calls.
   */
  static async reinforceBatch(
    store: GnosysStore,
    relativePaths: string[]
  ): Promise<number> {
    let reinforced = 0;
    const today = new Date().toISOString().split("T")[0];

    for (const rp of relativePaths) {
      try {
        const memory = await store.readMemory(rp);
        if (!memory) continue;

        const currentCount = ((memory.frontmatter as any).reinforcement_count as number) || 0;
        await store.updateMemory(rp, {
          reinforcement_count: currentCount + 1,
          last_reinforced: today,
        } as any);
        reinforced++;
      } catch {
        // Skip — reinforcement is best-effort
      }
    }

    return reinforced;
  }

  // ─── Archive Operations ──────────────────────────────────────────────

  /**
   * Archive old/low-confidence memories to archive.db.
   */
  private async archiveOldMemories(
    allMemories: Memory[],
    writeTarget: ResolvedStore,
    dryRun: boolean,
    autoApply: boolean,
    log: (level: "info" | "warn" | "action", message: string) => void
  ): Promise<{ archived: number; totalArchived: number; actions: string[] }> {
    const actions: string[] = [];
    let archived = 0;

    const archive = new GnosysArchive(writeTarget.path);
    if (!archive.isAvailable()) {
      log("info", "  Archive not available (better-sqlite3 not installed). Skipping.");
      return { archived: 0, totalArchived: 0, actions };
    }

    const eligible = getArchiveEligible(allMemories, this.config);
    log("info", `  ${eligible.length} memorie(s) eligible for archiving`);

    if (dryRun) {
      for (const m of eligible) {
        const action = `[DRY RUN] Would archive: "${m.frontmatter.title}" (confidence: ${m.frontmatter.confidence}, last active: ${(m.frontmatter as any).last_reinforced || m.frontmatter.modified})`;
        actions.push(action);
        log("action", action);
      }
    } else if (autoApply) {
      for (const m of eligible) {
        try {
          const success = await archive.archiveMemory(m);
          if (success) {
            archived++;
            const action = `Archived: "${m.frontmatter.title}" → archive.db`;
            actions.push(action);
            log("action", `  ${action}`);
          }
        } catch (err) {
          const msg = `Failed to archive "${m.frontmatter.title}": ${err instanceof Error ? err.message : String(err)}`;
          log("warn", msg);
          actions.push(msg);
        }
      }

      // Git commit archived changes (file deletions)
      if (archived > 0) {
        try {
          execSync("git add -A", { cwd: writeTarget.path, stdio: "pipe" });
          execSync(`git commit -m "maintenance: archive ${archived} old memories"`, { cwd: writeTarget.path, stdio: "pipe" });
        } catch {
          // Ignore commit errors (nothing to commit, no git, etc.)
        }
      }
    }

    const stats = archive.getStats();
    archive.close();

    return { archived, totalArchived: stats.totalArchived, actions };
  }

  // ─── Health Report ────────────────────────────────────────────────────

  /**
   * Get a quick health snapshot (used by gnosys doctor).
   * No LLM calls, no embeddings loading — just frontmatter analysis.
   */
  async getHealthReport(): Promise<{
    totalActive: number;
    totalArchived: number;
    staleCount: number;
    avgConfidence: number;
    avgDecayedConfidence: number;
    neverReinforced: number;
    totalReinforcements: number;
    archiveEligible: number;
  }> {
    const memories = await this.loadAllActiveMemories();
    const { stale, avgConfidence, avgDecayedConfidence } = this.calculateDecay(memories);

    let neverReinforced = 0;
    let totalReinforcements = 0;

    for (const m of memories) {
      const count = ((m.frontmatter as any).reinforcement_count as number) || 0;
      if (count === 0) neverReinforced++;
      totalReinforcements += count;
    }

    // Archive stats
    const writeTarget = this.resolver.getWriteTarget();
    let totalArchived = 0;
    let archiveEligible = 0;

    if (writeTarget) {
      const archive = new GnosysArchive(writeTarget.path);
      if (archive.isAvailable()) {
        totalArchived = archive.getStats().totalArchived;
        archiveEligible = getArchiveEligible(memories, this.config).length;
        archive.close();
      }
    }

    return {
      totalActive: memories.length,
      totalArchived,
      staleCount: stale.length,
      avgConfidence,
      avgDecayedConfidence,
      neverReinforced,
      totalReinforcements,
      archiveEligible,
    };
  }

  // ─── Internals ────────────────────────────────────────────────────────

  /**
   * Load all active (non-superseded, non-archived) memories from all stores.
   */
  private async loadAllActiveMemories(): Promise<Memory[]> {
    const layered = await this.resolver.getAllMemories();
    return layered.filter((m) => m.frontmatter.status === "active");
  }
}

// ─── Utilities ──────────────────────────────────────────────────────────

/**
 * Jaccard similarity between two strings (word-level).
 */
function jaccardSimilarity(a: string, b: string): number {
  const wordsA = new Set(a.split(/\s+/).filter(Boolean));
  const wordsB = new Set(b.split(/\s+/).filter(Boolean));

  if (wordsA.size === 0 && wordsB.size === 0) return 1;

  let intersection = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) intersection++;
  }

  const union = wordsA.size + wordsB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

/**
 * Execute an operation with safe Git commit and rollback on failure.
 */
async function safeGitOperation(
  storePath: string,
  commitMessage: string,
  operation: () => Promise<void>
): Promise<void> {
  // Record the current HEAD for rollback
  let headBefore: string;
  try {
    headBefore = execSync("git rev-parse HEAD", { cwd: storePath, stdio: "pipe" }).toString().trim();
  } catch {
    // No git or no commits yet — just run the operation
    await operation();
    return;
  }

  try {
    await operation();

    // Commit the changes
    try {
      execSync("git add -A", { cwd: storePath, stdio: "pipe" });
      const safeMessage = commitMessage.replace(/"/g, '\\"');
      execSync(`git commit -m "maintenance: ${safeMessage}"`, { cwd: storePath, stdio: "pipe" });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (!errMsg.includes("nothing to commit") && !errMsg.includes("no changes added")) {
        throw err;
      }
    }
  } catch (err) {
    // Rollback on failure
    try {
      execSync(`git reset --hard ${headBefore}`, { cwd: storePath, stdio: "pipe" });
    } catch {
      // If even rollback fails, nothing we can do
    }
    throw err;
  }
}

/**
 * Format a maintenance report as a human-readable string.
 */
export function formatMaintenanceReport(report: MaintenanceReport): string {
  const lines: string[] = [];

  lines.push("Gnosys Maintenance Report");
  lines.push("=".repeat(40));
  lines.push("");
  lines.push(`Total memories scanned: ${report.totalMemories}`);
  lines.push(`Average confidence: ${report.avgConfidence.toFixed(3)} (decayed: ${report.avgDecayedConfidence.toFixed(3)})`);
  lines.push("");

  // Duplicates
  lines.push(`Duplicates found: ${report.duplicates.length}`);
  if (report.duplicates.length > 0) {
    for (const dup of report.duplicates) {
      lines.push(`  • "${dup.memoryA.frontmatter.title}" ↔ "${dup.memoryB.frontmatter.title}"`);
      lines.push(`    Similarity: ${dup.similarity.toFixed(3)} | Title overlap: ${dup.titleOverlap.toFixed(3)}`);
    }
  }
  lines.push("");

  // Stale memories
  lines.push(`Stale memories: ${report.staleMemories.length} (confidence < ${STALE_CONFIDENCE_THRESHOLD})`);
  if (report.staleMemories.length > 0) {
    for (const sm of report.staleMemories) {
      lines.push(`  • "${sm.memory.frontmatter.title}"`);
      lines.push(`    Confidence: ${sm.originalConfidence.toFixed(2)} → ${sm.decayedConfidence.toFixed(2)} (${sm.daysSinceReinforced} days unreinforced)`);
    }
  }
  lines.push("");

  // Actions
  if (report.actions.length > 0) {
    lines.push(`Actions (${report.actions.length}):`);
    for (const action of report.actions) {
      lines.push(`  ${action}`);
    }
  } else {
    lines.push("No actions taken.");
  }

  // Archive
  if (report.archived > 0 || report.totalArchived > 0) {
    lines.push(`Archived this run: ${report.archived}`);
    lines.push(`Total in archive: ${report.totalArchived}`);
    lines.push("");
  }

  // Summary
  if (report.consolidated > 0 || report.decayUpdated > 0 || report.archived > 0) {
    lines.push("");
    lines.push("Summary:");
    if (report.consolidated > 0) lines.push(`  Consolidated: ${report.consolidated} pair(s)`);
    if (report.decayUpdated > 0) lines.push(`  Decay updated: ${report.decayUpdated} memorie(s)`);
    if (report.archived > 0) lines.push(`  Archived: ${report.archived} memorie(s)`);
  }

  return lines.join("\n");
}

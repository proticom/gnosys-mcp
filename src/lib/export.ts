/**
 * Gnosys Obsidian Export Bridge — One-way export from gnosys.db to Obsidian vault.
 *
 * Converts the agent-native SQLite store into human-friendly atomic Markdown
 * files with YAML frontmatter, [[wikilinks]], and proper folder structure.
 *
 * This is a completely separate module — it reads from gnosys.db and writes
 * to a target directory. It never modifies gnosys.db.
 *
 * Output structure:
 *   target/
 *     category/
 *       memory-title.md    (YAML frontmatter + content + wikilinks)
 *     _summaries/
 *       category.md        (category-level summaries from dream mode)
 *     _review/
 *       suggested-reviews.md (review suggestions from dream mode)
 *     _graph/
 *       relationships.md   (relationship index)
 */

import { GnosysDB, DbMemory, DbRelationship, DbSummary } from "./db.js";
import path from "path";
import fs from "fs/promises";

// ─── Types ───────────────────────────────────────────────────────────────

export interface ExportOptions {
  /** Target directory for export (will be created if needed) */
  targetDir: string;
  /** Only export active tier (default: true) */
  activeOnly?: boolean;
  /** Include summaries from dream mode */
  includeSummaries?: boolean;
  /** Include review suggestions */
  includeReviews?: boolean;
  /** Include relationship graph */
  includeGraph?: boolean;
  /** Overwrite existing files (default: false — skip existing) */
  overwrite?: boolean;
  /** Progress callback */
  onProgress?: (current: number, total: number, file: string) => void;
}

export interface ExportReport {
  memoriesExported: number;
  memoriesSkipped: number;
  summariesExported: number;
  reviewsExported: boolean;
  graphExported: boolean;
  targetDir: string;
  errors: string[];
}

// ─── Export Engine ────────────────────────────────────────────────────────

export class GnosysExporter {
  private db: GnosysDB;

  constructor(db: GnosysDB) {
    this.db = db;
  }

  /**
   * Export gnosys.db contents to an Obsidian-compatible vault structure.
   */
  async export(options: ExportOptions): Promise<ExportReport> {
    const {
      targetDir,
      activeOnly = true,
      includeSummaries = true,
      includeReviews = true,
      includeGraph = true,
      overwrite = false,
      onProgress,
    } = options;

    const report: ExportReport = {
      memoriesExported: 0,
      memoriesSkipped: 0,
      summariesExported: 0,
      reviewsExported: false,
      graphExported: false,
      targetDir,
      errors: [],
    };

    // Ensure target directory exists
    await fs.mkdir(targetDir, { recursive: true });

    // Get memories to export
    const memories = activeOnly
      ? this.db.getActiveMemories()
      : this.db.getAllMemories();

    const total = memories.length;

    // Export each memory as a Markdown file
    for (let i = 0; i < memories.length; i++) {
      const mem = memories[i];
      try {
        const exported = await this.exportMemory(mem, targetDir, overwrite);
        if (exported) {
          report.memoriesExported++;
        } else {
          report.memoriesSkipped++;
        }
      } catch (err) {
        report.errors.push(`${mem.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
      onProgress?.(i + 1, total, mem.title);
    }

    // Export summaries
    if (includeSummaries) {
      try {
        report.summariesExported = await this.exportSummaries(targetDir, overwrite);
      } catch (err) {
        report.errors.push(`summaries: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Export review suggestions
    if (includeReviews) {
      try {
        report.reviewsExported = await this.exportReviews(targetDir, overwrite);
      } catch (err) {
        report.errors.push(`reviews: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Export relationship graph
    if (includeGraph) {
      try {
        report.graphExported = await this.exportGraph(targetDir, memories, overwrite);
      } catch (err) {
        report.errors.push(`graph: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return report;
  }

  // ─── Memory Export ───────────────────────────────────────────────────

  /**
   * Export a single memory as a Markdown file with YAML frontmatter.
   * Returns true if exported, false if skipped (already exists).
   */
  private async exportMemory(
    mem: DbMemory,
    targetDir: string,
    overwrite: boolean
  ): Promise<boolean> {
    const categoryDir = path.join(targetDir, mem.category);
    await fs.mkdir(categoryDir, { recursive: true });

    const filename = this.slugify(mem.title) + ".md";
    const filePath = path.join(categoryDir, filename);

    // Check if file exists
    if (!overwrite) {
      try {
        await fs.access(filePath);
        return false; // File exists, skip
      } catch {
        // File doesn't exist, proceed
      }
    }

    // Build YAML frontmatter
    const tags = this.parseTags(mem.tags);
    const relationships = this.getMemoryRelationships(mem.id);
    const wikilinks = this.buildWikilinks(relationships);

    const frontmatter = [
      "---",
      `id: ${mem.id}`,
      `title: '${mem.title.replace(/'/g, "''")}'`,
      `category: ${mem.category}`,
      `tags:`,
      ...tags.map((t) => `- ${t}`),
      `relevance: ${mem.relevance}`,
      `author: ${mem.author}`,
      `authority: ${mem.authority}`,
      `confidence: ${mem.confidence}`,
      `reinforcement_count: ${mem.reinforcement_count}`,
      `created: '${mem.created}'`,
      `modified: '${mem.modified}'`,
      `status: ${mem.status}`,
      ...(mem.supersedes ? [`supersedes: ${mem.supersedes}`] : []),
      ...(mem.superseded_by ? [`superseded_by: ${mem.superseded_by}`] : []),
      ...(mem.last_reinforced ? [`last_reinforced: '${mem.last_reinforced}'`] : []),
      "---",
    ].join("\n");

    // Build content with wikilinks section
    let content = `${frontmatter}\n\n# ${mem.title}\n\n${mem.content}`;

    if (wikilinks.length > 0) {
      content += `\n\n---\n\n## Related\n\n${wikilinks.join("\n")}`;
    }

    await fs.writeFile(filePath, content, "utf-8");
    return true;
  }

  // ─── Summaries Export ────────────────────────────────────────────────

  /**
   * Export category summaries from the summaries table.
   */
  private async exportSummaries(targetDir: string, overwrite: boolean): Promise<number> {
    const summaryDir = path.join(targetDir, "_summaries");
    await fs.mkdir(summaryDir, { recursive: true });

    const summaries = this.db.getAllSummaries();
    let exported = 0;

    for (const summary of summaries) {
      if (summary.scope !== "category") continue;

      const filename = `${this.slugify(summary.scope_key)}.md`;
      const filePath = path.join(summaryDir, filename);

      if (!overwrite) {
        try {
          await fs.access(filePath);
          continue; // Skip existing
        } catch {
          // Proceed
        }
      }

      const content = [
        "---",
        `scope: ${summary.scope}`,
        `scope_key: ${summary.scope_key}`,
        `created: '${summary.created}'`,
        `modified: '${summary.modified}'`,
        "---",
        "",
        `# ${summary.scope_key} — Summary`,
        "",
        summary.content,
      ].join("\n");

      await fs.writeFile(filePath, content, "utf-8");
      exported++;
    }

    return exported;
  }

  // ─── Reviews Export ──────────────────────────────────────────────────

  /**
   * Export review suggestions from dream mode.
   */
  private async exportReviews(targetDir: string, overwrite: boolean): Promise<boolean> {
    const reviewDir = path.join(targetDir, "_review");
    await fs.mkdir(reviewDir, { recursive: true });

    // Find the latest review summary
    const summaries = this.db.getAllSummaries();
    const reviews = summaries
      .filter((s) => s.scope === "dream" && s.scope_key.startsWith("review-"))
      .sort((a, b) => b.modified.localeCompare(a.modified));

    if (reviews.length === 0) return false;

    const filePath = path.join(reviewDir, "suggested-reviews.md");

    if (!overwrite) {
      try {
        await fs.access(filePath);
        return false;
      } catch {
        // Proceed
      }
    }

    // Parse and format review suggestions
    const lines = ["# Suggested Reviews", "", "Generated by Dream Mode. These memories may need attention.", ""];

    for (const review of reviews) {
      try {
        const suggestions = JSON.parse(review.content);
        if (!Array.isArray(suggestions)) continue;

        lines.push(`## Review from ${review.scope_key.replace("review-", "")}`, "");
        for (const s of suggestions) {
          lines.push(`### ${s.title}`);
          lines.push(`- **ID**: ${s.memoryId}`);
          lines.push(`- **Action**: ${s.suggestedAction}`);
          lines.push(`- **Confidence**: ${s.currentConfidence}`);
          lines.push(`- **Reason**: ${s.reason}`);
          lines.push("");
        }
      } catch {
        // Skip malformed reviews
      }
    }

    await fs.writeFile(filePath, lines.join("\n"), "utf-8");
    return true;
  }

  // ─── Graph Export ────────────────────────────────────────────────────

  /**
   * Export the relationship graph as a navigable index with wikilinks.
   */
  private async exportGraph(
    targetDir: string,
    memories: DbMemory[],
    overwrite: boolean
  ): Promise<boolean> {
    const graphDir = path.join(targetDir, "_graph");
    await fs.mkdir(graphDir, { recursive: true });

    const filePath = path.join(graphDir, "relationships.md");

    if (!overwrite) {
      try {
        await fs.access(filePath);
        return false;
      } catch {
        // Proceed
      }
    }

    // Build the relationship index
    const lines = ["# Relationship Graph", "", "Auto-generated from gnosys.db relationships table.", ""];

    // Build a title lookup
    const titleMap = new Map<string, string>();
    for (const mem of memories) {
      titleMap.set(mem.id, mem.title);
    }

    // Group relationships by source
    const bySource = new Map<string, DbRelationship[]>();
    for (const mem of memories) {
      const rels = this.db.getRelationshipsFrom(mem.id);
      if (rels.length > 0) {
        bySource.set(mem.id, rels);
      }
    }

    for (const [sourceId, rels] of bySource) {
      const sourceTitle = titleMap.get(sourceId) || sourceId;
      lines.push(`## [[${sourceTitle}]]`, "");

      for (const rel of rels) {
        const targetTitle = titleMap.get(rel.target_id) || rel.target_id;
        const label = rel.label ? ` — ${rel.label}` : "";
        lines.push(`- **${rel.rel_type}** → [[${targetTitle}]]${label} (confidence: ${rel.confidence})`);
      }
      lines.push("");
    }

    if (bySource.size === 0) {
      lines.push("No relationships discovered yet. Run `gnosys dream` to discover relationships.");
    }

    await fs.writeFile(filePath, lines.join("\n"), "utf-8");
    return true;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────

  /**
   * Get all relationships for a memory (both directions).
   */
  private getMemoryRelationships(id: string): DbRelationship[] {
    const from = this.db.getRelationshipsFrom(id);
    const to = this.db.getRelationshipsTo(id);
    return [...from, ...to];
  }

  /**
   * Build [[wikilinks]] from relationships.
   */
  private buildWikilinks(relationships: DbRelationship[]): string[] {
    const links: string[] = [];
    const seen = new Set<string>();

    for (const rel of relationships) {
      // Look up target memory title
      const targetId = rel.target_id;
      if (seen.has(targetId)) continue;
      seen.add(targetId);

      const target = this.db.getMemory(targetId);
      if (target) {
        const label = rel.label ? ` — ${rel.label}` : "";
        links.push(`- ${rel.rel_type}: [[${target.title}]]${label}`);
      }
    }

    return links;
  }

  /**
   * Parse tags from JSON string.
   */
  private parseTags(tagsJson: string): string[] {
    try {
      const parsed = JSON.parse(tagsJson || "[]");
      if (Array.isArray(parsed)) return parsed;
      return Object.values(parsed).flat() as string[];
    } catch {
      return [];
    }
  }

  /**
   * Slugify a title for use as a filename.
   */
  private slugify(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .substring(0, 80);
  }
}

// ─── Format Helper ───────────────────────────────────────────────────────

/**
 * Format an export report as human-readable text.
 */
export function formatExportReport(report: ExportReport): string {
  const lines: string[] = [];

  lines.push("Gnosys Obsidian Export Report");
  lines.push("=".repeat(40));
  lines.push("");
  lines.push(`Target: ${report.targetDir}`);
  lines.push(`Memories exported: ${report.memoriesExported}`);
  lines.push(`Memories skipped (already exist): ${report.memoriesSkipped}`);
  lines.push(`Summaries exported: ${report.summariesExported}`);
  lines.push(`Reviews exported: ${report.reviewsExported ? "yes" : "no"}`);
  lines.push(`Graph exported: ${report.graphExported ? "yes" : "no"}`);

  if (report.errors.length > 0) {
    lines.push("");
    lines.push(`Errors (${report.errors.length}):`);
    for (const e of report.errors) {
      lines.push(`  ! ${e}`);
    }
  }

  return lines.join("\n");
}

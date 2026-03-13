/**
 * Gnosys Federated Search — Phase 8d
 *
 * Searches across all scopes (project → user → global) with tier boosting,
 * multi-project ambiguity detection, implicit working set recency boost,
 * and project briefing generation.
 *
 * Tier boosting order: project (1.5x) > user (1.0x) > global (0.7x)
 * Recency boost: memories accessed/modified in the last 24h get a 1.3x boost
 */

import { GnosysDB, DbMemory, DbProject, MemoryScope } from "./db.js";
import { findProjectIdentity } from "./projectIdentity.js";

// ─── Types ──────────────────────────────────────────────────────────────

export interface FederatedResult {
  id: string;
  title: string;
  category: string;
  snippet: string;
  score: number;
  scope: MemoryScope;
  projectId: string | null;
  projectName: string | null;
  /** Boost factors applied */
  boosts: string[];
}

export interface AmbiguityError {
  type: "ambiguous_project";
  message: string;
  candidates: Array<{
    projectId: string;
    projectName: string;
    workingDirectory: string;
    memoryCount: number;
  }>;
}

export interface ProjectBriefing {
  projectId: string;
  projectName: string;
  workingDirectory: string;
  totalMemories: number;
  activeMemories: number;
  categories: Record<string, number>;
  recentActivity: Array<{ id: string; title: string; modified: string }>;
  topTags: Array<{ tag: string; count: number }>;
  summary: string;
}

export interface FederatedSearchOptions {
  /** Limit total results */
  limit?: number;
  /** Current project ID (auto-detected if omitted) */
  projectId?: string | null;
  /** Working directory for project auto-detection */
  workingDir?: string;
  /** Include global scope in results */
  includeGlobal?: boolean;
  /** Recency window in hours (default: 24) */
  recencyWindowHours?: number;
  /** Filter to specific scope(s). If set, only memories in these scopes are returned. */
  scopeFilter?: MemoryScope[];
}

// ─── Boost Constants ────────────────────────────────────────────────────

const SCOPE_BOOST: Record<MemoryScope, number> = {
  project: 1.5,
  user: 1.0,
  global: 0.7,
};

const RECENCY_BOOST = 1.3;
const REINFORCEMENT_BOOST_PER = 0.05; // per reinforcement, capped at 0.25

// ─── Federated Search ───────────────────────────────────────────────────

/**
 * Search across all scopes with tier boosting and recency awareness.
 * Results from the current project rank highest, then user-scoped, then global.
 */
export function federatedSearch(
  db: GnosysDB,
  query: string,
  opts: FederatedSearchOptions = {}
): FederatedResult[] {
  const {
    limit = 20,
    projectId = null,
    includeGlobal = true,
    recencyWindowHours = 24,
    scopeFilter,
  } = opts;

  // Run FTS5 search across ALL memories (no scope filter at query time)
  const rawResults = db.searchFts(query, limit * 3);
  if (rawResults.length === 0) return [];

  // Build a project name lookup
  const projects = db.getAllProjects();
  const projectMap = new Map<string, string>();
  for (const p of projects) {
    projectMap.set(p.id, p.name);
  }

  const now = Date.now();
  const recencyThreshold = now - recencyWindowHours * 60 * 60 * 1000;

  // Score each result with tier boosting
  const scored: FederatedResult[] = [];

  for (let i = 0; i < rawResults.length; i++) {
    const r = rawResults[i];
    const mem = db.getMemory(r.id);
    if (!mem || mem.status !== "active") continue;

    const scope = (mem.scope || "project") as MemoryScope;

    // Skip if scope filter is active and this scope isn't included
    if (scopeFilter && scopeFilter.length > 0 && !scopeFilter.includes(scope)) continue;

    // Skip global if not requested (legacy flag, scopeFilter takes precedence)
    if (!scopeFilter && !includeGlobal && scope === "global") continue;

    // Base score: inverse of FTS rank position (higher = better)
    let score = 1 / (60 + i + 1);
    const boosts: string[] = [];

    // 1. Scope boost
    const scopeBoost = SCOPE_BOOST[scope];
    // Extra boost if this memory belongs to the CURRENT project
    if (scope === "project" && projectId && mem.project_id === projectId) {
      score *= scopeBoost * 1.2; // 1.5 * 1.2 = 1.8x for current project
      boosts.push("current-project");
    } else {
      score *= scopeBoost;
    }
    boosts.push(`scope:${scope}`);

    // 2. Recency boost
    const modifiedMs = new Date(mem.modified).getTime();
    if (modifiedMs > recencyThreshold) {
      score *= RECENCY_BOOST;
      boosts.push("recent");
    }

    // 3. Reinforcement boost (capped)
    if (mem.reinforcement_count > 0) {
      const rBoost = 1 + Math.min(mem.reinforcement_count * REINFORCEMENT_BOOST_PER, 0.25);
      score *= rBoost;
      boosts.push(`reinforced:${mem.reinforcement_count}`);
    }

    // 4. Confidence factor
    score *= mem.confidence;

    scored.push({
      id: mem.id,
      title: mem.title,
      category: mem.category,
      snippet: r.snippet,
      score,
      scope,
      projectId: mem.project_id,
      projectName: mem.project_id ? (projectMap.get(mem.project_id) || null) : null,
      boosts,
    });
  }

  // Sort by boosted score descending
  scored.sort((a, b) => b.score - a.score);

  return scored.slice(0, limit);
}

/**
 * Discover across all scopes — lightweight metadata search
 * with the same tier boosting logic.
 */
export function federatedDiscover(
  db: GnosysDB,
  query: string,
  opts: FederatedSearchOptions = {}
): FederatedResult[] {
  const {
    limit = 20,
    projectId = null,
    includeGlobal = true,
    recencyWindowHours = 24,
  } = opts;

  const rawResults = db.discoverFts(query, limit * 3);
  if (rawResults.length === 0) return [];

  const projects = db.getAllProjects();
  const projectMap = new Map<string, string>();
  for (const p of projects) {
    projectMap.set(p.id, p.name);
  }

  const now = Date.now();
  const recencyThreshold = now - recencyWindowHours * 60 * 60 * 1000;
  const scopeFilter = opts.scopeFilter;

  const scored: FederatedResult[] = [];

  for (let i = 0; i < rawResults.length; i++) {
    const r = rawResults[i];
    const mem = db.getMemory(r.id);
    if (!mem || mem.status !== "active") continue;

    const scope = (mem.scope || "project") as MemoryScope;
    if (scopeFilter && scopeFilter.length > 0 && !scopeFilter.includes(scope)) continue;
    if (!scopeFilter && !includeGlobal && scope === "global") continue;

    let score = 1 / (60 + i + 1);
    const boosts: string[] = [];

    const scopeBoost = SCOPE_BOOST[scope];
    if (scope === "project" && projectId && mem.project_id === projectId) {
      score *= scopeBoost * 1.2;
      boosts.push("current-project");
    } else {
      score *= scopeBoost;
    }
    boosts.push(`scope:${scope}`);

    const modifiedMs = new Date(mem.modified).getTime();
    if (modifiedMs > recencyThreshold) {
      score *= RECENCY_BOOST;
      boosts.push("recent");
    }

    if (mem.reinforcement_count > 0) {
      const rBoost = 1 + Math.min(mem.reinforcement_count * REINFORCEMENT_BOOST_PER, 0.25);
      score *= rBoost;
    }

    score *= mem.confidence;

    scored.push({
      id: mem.id,
      title: mem.title,
      category: mem.category,
      snippet: r.relevance,
      score,
      scope,
      projectId: mem.project_id,
      projectName: mem.project_id ? (projectMap.get(mem.project_id) || null) : null,
      boosts,
    });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ─── Multi-Project Ambiguity Detection ──────────────────────────────────

/**
 * Detect ambiguity when multiple projects match a query.
 * Used by write operations — if the user doesn't specify a project and
 * multiple projects have matching content, raise an ambiguity error
 * listing all candidates.
 */
export function detectAmbiguity(
  db: GnosysDB,
  query: string,
  opts?: { threshold?: number }
): AmbiguityError | null {
  const threshold = opts?.threshold ?? 2;

  // Search and group results by project
  const results = db.searchFts(query, 50);
  const projectHits = new Map<string, number>();

  for (const r of results) {
    const mem = db.getMemory(r.id);
    if (!mem || !mem.project_id) continue;
    projectHits.set(mem.project_id, (projectHits.get(mem.project_id) || 0) + 1);
  }

  // Only ambiguous if multiple projects have results
  if (projectHits.size < threshold) return null;

  const projects = db.getAllProjects();
  const projectMap = new Map<string, DbProject>();
  for (const p of projects) {
    projectMap.set(p.id, p);
  }

  const candidates = Array.from(projectHits.entries())
    .map(([pid, count]) => {
      const proj = projectMap.get(pid);
      return {
        projectId: pid,
        projectName: proj?.name || "unknown",
        workingDirectory: proj?.working_directory || "unknown",
        memoryCount: count,
      };
    })
    .sort((a, b) => b.memoryCount - a.memoryCount);

  return {
    type: "ambiguous_project",
    message: `Query "${query}" matches memories in ${candidates.length} projects. Specify a project to narrow results.`,
    candidates,
  };
}

/**
 * Auto-detect the current project from a working directory.
 * Returns the projectId or null.
 */
export async function detectCurrentProject(
  db: GnosysDB,
  workingDir?: string
): Promise<string | null> {
  // Try to find project identity from directory
  if (workingDir) {
    const identity = await findProjectIdentity(workingDir);
    if (identity) return identity.identity.projectId;
  }

  // Try cwd
  const identity = await findProjectIdentity(process.cwd());
  if (identity) return identity.identity.projectId;

  return null;
}

// ─── Dream Mode Project Briefings ───────────────────────────────────────

/**
 * Generate a project briefing — a pre-computed summary of a project's
 * memory state. Designed for "dream mode" pre-computation or on-demand
 * project status checks.
 */
export function generateBriefing(db: GnosysDB, projectId: string): ProjectBriefing | null {
  const project = db.getProject(projectId);
  if (!project) return null;

  const memories = db.getMemoriesByProject(projectId);
  const allProjectMems = memories;

  // Category breakdown
  const categories: Record<string, number> = {};
  for (const m of allProjectMems) {
    categories[m.category] = (categories[m.category] || 0) + 1;
  }

  // Recent activity (last 7 days)
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const recentActivity = allProjectMems
    .filter((m) => m.modified >= weekAgo)
    .sort((a, b) => b.modified.localeCompare(a.modified))
    .slice(0, 10)
    .map((m) => ({ id: m.id, title: m.title, modified: m.modified }));

  // Top tags (parse JSON tag arrays, count occurrences)
  const tagCounts = new Map<string, number>();
  for (const m of allProjectMems) {
    try {
      const tags: string[] = JSON.parse(m.tags || "[]");
      for (const tag of tags) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    } catch {
      // tags might be comma-separated or malformed
      if (m.tags) {
        for (const t of m.tags.split(",").map((s: string) => s.trim()).filter(Boolean)) {
          tagCounts.set(t, (tagCounts.get(t) || 0) + 1);
        }
      }
    }
  }

  const topTags = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([tag, count]) => ({ tag, count }));

  // Generate human-readable summary
  const catList = Object.entries(categories)
    .sort((a, b) => b[1] - a[1])
    .map(([cat, count]) => `${cat} (${count})`)
    .join(", ");

  const summary = [
    `Project "${project.name}" has ${allProjectMems.length} active memories across ${Object.keys(categories).length} categories: ${catList}.`,
    recentActivity.length > 0
      ? `${recentActivity.length} memories modified in the last 7 days.`
      : "No recent activity.",
    topTags.length > 0
      ? `Top tags: ${topTags.slice(0, 5).map((t) => t.tag).join(", ")}.`
      : "",
  ].filter(Boolean).join(" ");

  return {
    projectId,
    projectName: project.name,
    workingDirectory: project.working_directory,
    totalMemories: allProjectMems.length,
    activeMemories: allProjectMems.filter((m) => m.status === "active").length,
    categories,
    recentActivity,
    topTags,
    summary,
  };
}

/**
 * Generate briefings for ALL registered projects.
 * Used by dream mode to pre-compute briefings.
 */
export function generateAllBriefings(db: GnosysDB): ProjectBriefing[] {
  const projects = db.getAllProjects();
  const briefings: ProjectBriefing[] = [];

  for (const project of projects) {
    const briefing = generateBriefing(db, project.id);
    if (briefing) {
      briefings.push(briefing);
    }
  }

  return briefings;
}

// ─── Implicit Working Set ───────────────────────────────────────────────

/**
 * Get the implicit working set — recently accessed/modified memories
 * for the current project. These get boosted in federated search results.
 */
export function getWorkingSet(
  db: GnosysDB,
  projectId: string,
  opts?: { windowHours?: number; limit?: number }
): DbMemory[] {
  const windowHours = opts?.windowHours ?? 24;
  const limit = opts?.limit ?? 20;

  const threshold = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

  const memories = db.getMemoriesByProject(projectId);
  return memories
    .filter((m) => m.modified >= threshold || (m.last_reinforced && m.last_reinforced >= threshold))
    .sort((a, b) => b.modified.localeCompare(a.modified))
    .slice(0, limit);
}

/**
 * Format the working set as a concise context block for agent consumption.
 */
export function formatWorkingSet(memories: DbMemory[]): string {
  if (memories.length === 0) return "No recent activity in working set.";

  const lines = memories.map((m) => {
    const age = getRelativeTime(m.modified);
    return `- [${m.id}] ${m.title} (${m.category}, ${age})`;
  });

  return `Working set (${memories.length} recent memories):\n${lines.join("\n")}`;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function getRelativeTime(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const hours = Math.floor(diffMs / (1000 * 60 * 60));
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

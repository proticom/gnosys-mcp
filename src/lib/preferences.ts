/**
 * Gnosys Preferences — Phase 8b.
 *
 * User preferences stored as regular Gnosys memories in the central DB
 * with scope='user' and category='preferences'. The memory system IS
 * the config system.
 *
 * Preferences have a `key` (stored in the memory id as `pref-<key>`)
 * and a `value` (stored in content). They're searchable, decayable,
 * and versioned just like any other memory.
 */

import { GnosysDB, DbMemory, fnv1a } from "./db.js";

// ─── Types ──────────────────────────────────────────────────────────────

export interface Preference {
  key: string;         // e.g. "commit-convention", "llm-provider"
  value: string;       // The preference value/description
  title: string;       // Human-readable title
  tags: string[];      // Optional tags for discovery
  confidence: number;  // How strongly declared
  created: string;
  modified: string;
}

/** Well-known preference keys used by the rules generator */
export const KNOWN_PREFERENCE_KEYS = [
  "commit-convention",
  "code-style",
  "llm-provider",
  "agent-behavior",
  "testing-approach",
  "documentation-style",
  "naming-convention",
  "error-handling",
  "review-process",
  "deploy-workflow",
] as const;

// ─── Preference CRUD ────────────────────────────────────────────────────

/**
 * Set a user preference. Creates or updates a memory in the central DB
 * with scope='user' and category='preferences'.
 */
export function setPreference(
  db: GnosysDB,
  key: string,
  value: string,
  opts?: { title?: string; tags?: string[]; confidence?: number }
): Preference {
  const now = new Date().toISOString().split("T")[0];
  const id = `pref-${key}`;
  const title = opts?.title || formatPreferenceTitle(key);
  const tags = opts?.tags || [];
  const confidence = opts?.confidence ?? 0.95;

  // Check if it already exists
  const existing = db.getMemory(id);

  db.insertMemory({
    id,
    title,
    category: "preferences",
    content: `# ${title}\n\n${value}`,
    summary: value.length > 200 ? value.substring(0, 200) + "..." : value,
    tags: JSON.stringify(tags),
    relevance: `preference ${key} user-preference ${tags.join(" ")}`,
    author: "human",
    authority: "declared",
    confidence,
    reinforcement_count: existing ? (existing.reinforcement_count + 1) : 0,
    content_hash: fnv1a(value),
    status: "active",
    tier: "active",
    supersedes: null,
    superseded_by: null,
    last_reinforced: existing ? now : null,
    created: existing?.created || now,
    modified: now,
    source_path: null,
    project_id: null,   // user-level, not project-scoped
    scope: "user",
  });

  return {
    key,
    value,
    title,
    tags,
    confidence,
    created: existing?.created || now,
    modified: now,
  };
}

/**
 * Get a single preference by key.
 */
export function getPreference(db: GnosysDB, key: string): Preference | null {
  const id = `pref-${key}`;
  const mem = db.getMemory(id);
  if (!mem || mem.category !== "preferences") return null;
  return memoryToPreference(mem);
}

/**
 * Get all user preferences.
 */
export function getAllPreferences(db: GnosysDB): Preference[] {
  const mems = db.getMemoriesByScope("user");
  return mems
    .filter((m) => m.category === "preferences" && m.status === "active")
    .map(memoryToPreference);
}

/**
 * Delete a preference by key.
 */
export function deletePreference(db: GnosysDB, key: string): boolean {
  const id = `pref-${key}`;
  const mem = db.getMemory(id);
  if (!mem || mem.category !== "preferences") return false;
  db.deleteMemory(id);
  return true;
}

/**
 * Search preferences by keyword.
 */
export function searchPreferences(db: GnosysDB, query: string): Preference[] {
  const results = db.searchFts(`preferences ${query}`, 20);
  const prefs: Preference[] = [];
  for (const r of results) {
    if (r.id.startsWith("pref-")) {
      const mem = db.getMemory(r.id);
      if (mem) prefs.push(memoryToPreference(mem));
    }
  }
  return prefs;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function memoryToPreference(mem: DbMemory): Preference {
  // Extract value from content (strip "# Title\n\n" prefix)
  const content = mem.content;
  const lines = content.split("\n");
  const valueStart = lines[0].startsWith("# ") ? 2 : 0;
  const value = lines.slice(valueStart).join("\n").trim();

  let tags: string[] = [];
  try {
    const parsed = JSON.parse(mem.tags);
    tags = Array.isArray(parsed) ? parsed : Object.values(parsed).flat() as string[];
  } catch {
    tags = [];
  }

  return {
    key: mem.id.replace(/^pref-/, ""),
    value,
    title: mem.title,
    tags,
    confidence: mem.confidence,
    created: mem.created,
    modified: mem.modified,
  };
}

function formatPreferenceTitle(key: string): string {
  return key
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

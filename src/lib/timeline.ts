/**
 * Gnosys Timeline — Temporal views and statistics for memory stores.
 *
 * Group memories by time period to see knowledge evolution.
 * Compute summary statistics across the store.
 */

import { Memory } from "./store.js";

export type TimePeriod = "day" | "week" | "month" | "year";

export interface TimelineEntry {
  period: string;       // "2026-03", "2026-W10", "2026-03-06", "2026"
  created: number;      // Count of memories created in this period
  modified: number;     // Count modified (but not created) in this period
  titles: string[];     // Memory titles in this period (created)
}

export interface MemoryStats {
  totalCount: number;
  byCategory: Record<string, number>;
  byStatus: Record<string, number>;
  byAuthor: Record<string, number>;
  byAuthority: Record<string, number>;
  averageConfidence: number;
  oldestCreated: string | null;
  newestCreated: string | null;
  lastModified: string | null;
}

/**
 * Group memories by time period based on their created/modified dates.
 */
export function groupByPeriod(memories: Memory[], period: TimePeriod): TimelineEntry[] {
  const createdMap = new Map<string, { count: number; titles: string[] }>();
  const modifiedMap = new Map<string, number>();

  for (const m of memories) {
    const createdKey = toPeriodKey(m.frontmatter.created, period);
    if (createdKey) {
      const entry = createdMap.get(createdKey) || { count: 0, titles: [] };
      entry.count++;
      entry.titles.push(m.frontmatter.title);
      createdMap.set(createdKey, entry);
    }

    const modifiedKey = toPeriodKey(m.frontmatter.modified, period);
    if (modifiedKey && modifiedKey !== createdKey) {
      modifiedMap.set(modifiedKey, (modifiedMap.get(modifiedKey) || 0) + 1);
    }
  }

  // Merge all period keys
  const allKeys = new Set([...createdMap.keys(), ...modifiedMap.keys()]);
  const entries: TimelineEntry[] = [];

  for (const key of allKeys) {
    const created = createdMap.get(key);
    entries.push({
      period: key,
      created: created?.count || 0,
      modified: modifiedMap.get(key) || 0,
      titles: created?.titles || [],
    });
  }

  return entries.sort((a, b) => a.period.localeCompare(b.period));
}

/**
 * Compute summary statistics across all memories.
 */
export function computeStats(memories: Memory[]): MemoryStats {
  const byCategory: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  const byAuthor: Record<string, number> = {};
  const byAuthority: Record<string, number> = {};
  let totalConfidence = 0;
  let oldest: string | null = null;
  let newest: string | null = null;
  let lastMod: string | null = null;

  for (const m of memories) {
    const fm = m.frontmatter;

    byCategory[fm.category] = (byCategory[fm.category] || 0) + 1;
    byStatus[fm.status] = (byStatus[fm.status] || 0) + 1;
    byAuthor[fm.author] = (byAuthor[fm.author] || 0) + 1;
    byAuthority[fm.authority] = (byAuthority[fm.authority] || 0) + 1;
    totalConfidence += fm.confidence;

    if (!oldest || fm.created < oldest) oldest = fm.created;
    if (!newest || fm.created > newest) newest = fm.created;
    if (!lastMod || fm.modified > lastMod) lastMod = fm.modified;
  }

  return {
    totalCount: memories.length,
    byCategory,
    byStatus,
    byAuthor,
    byAuthority,
    averageConfidence: memories.length > 0 ? Math.round((totalConfidence / memories.length) * 100) / 100 : 0,
    oldestCreated: oldest,
    newestCreated: newest,
    lastModified: lastMod,
  };
}

/**
 * Convert an ISO date string to a period key.
 */
function toPeriodKey(dateStr: string | undefined | null, period: TimePeriod): string | null {
  if (!dateStr) return null;

  // Parse the date string (YYYY-MM-DD format)
  const parts = dateStr.split("-");
  if (parts.length < 3) return null;

  const year = parseInt(parts[0]);
  const month = parseInt(parts[1]);
  const day = parseInt(parts[2]);

  switch (period) {
    case "day":
      return dateStr; // Already YYYY-MM-DD
    case "week": {
      const d = new Date(year, month - 1, day);
      const weekNum = getISOWeek(d);
      return `${year}-W${String(weekNum).padStart(2, "0")}`;
    }
    case "month":
      return `${year}-${String(month).padStart(2, "0")}`;
    case "year":
      return `${year}`;
  }
}

/**
 * Get ISO week number for a date.
 */
function getISOWeek(d: Date): number {
  const date = new Date(d.getTime());
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7));
  const week1 = new Date(date.getFullYear(), 0, 4);
  return (
    1 +
    Math.round(
      ((date.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7
    )
  );
}

/**
 * Gnosys Lensing — Filtered views of the memory store.
 *
 * A lens is a set of filter criteria applied to memories.
 * Compound lenses combine multiple filters with AND/OR logic.
 */

import { Memory, MemoryFrontmatter } from "./store.js";

export interface LensFilter {
  category?: string;
  tags?: string[];
  tagMatchMode?: "any" | "all"; // default "any"
  status?: ("active" | "archived" | "superseded")[];
  author?: ("human" | "ai" | "human+ai")[];
  authority?: ("declared" | "observed" | "imported" | "inferred")[];
  minConfidence?: number;
  maxConfidence?: number;
  createdAfter?: string;  // ISO date string
  createdBefore?: string;
  modifiedAfter?: string;
  modifiedBefore?: string;
}

export type CompoundOperator = "AND" | "OR";

export interface CompoundLens {
  filters: LensFilter[];
  operator: CompoundOperator;
}

/**
 * Apply a single lens filter to an array of memories.
 */
export function applyLens(memories: Memory[], lens: LensFilter): Memory[] {
  return memories.filter((m) => matchesLens(m, lens));
}

/**
 * Apply a compound lens (multiple filters combined with AND/OR).
 */
export function applyCompoundLens(
  memories: Memory[],
  compound: CompoundLens
): Memory[] {
  if (compound.filters.length === 0) return memories;

  if (compound.operator === "AND") {
    // AND: memory must match ALL filters
    return memories.filter((m) =>
      compound.filters.every((f) => matchesLens(m, f))
    );
  } else {
    // OR: memory must match ANY filter
    return memories.filter((m) =>
      compound.filters.some((f) => matchesLens(m, f))
    );
  }
}

/**
 * Check if a single memory matches a lens filter.
 */
function matchesLens(m: Memory, lens: LensFilter): boolean {
  const fm = m.frontmatter;

  // Category filter
  if (lens.category && fm.category !== lens.category) return false;

  // Status filter (array — memory must match one of the listed statuses)
  if (lens.status && lens.status.length > 0) {
    if (!lens.status.includes(fm.status)) return false;
  }

  // Author filter
  if (lens.author && lens.author.length > 0) {
    if (!lens.author.includes(fm.author)) return false;
  }

  // Authority filter
  if (lens.authority && lens.authority.length > 0) {
    if (!lens.authority.includes(fm.authority)) return false;
  }

  // Confidence range
  if (lens.minConfidence !== undefined && fm.confidence < lens.minConfidence) return false;
  if (lens.maxConfidence !== undefined && fm.confidence > lens.maxConfidence) return false;

  // Tag matching
  if (lens.tags && lens.tags.length > 0) {
    const memTags = flattenTags(fm.tags);
    const mode = lens.tagMatchMode ?? "any";
    const matches = lens.tags.filter((t) => memTags.includes(t));

    if (mode === "all" && matches.length !== lens.tags.length) return false;
    if (mode === "any" && matches.length === 0) return false;
  }

  // Date filters
  if (lens.createdAfter && fm.created < lens.createdAfter) return false;
  if (lens.createdBefore && fm.created > lens.createdBefore) return false;
  if (lens.modifiedAfter && fm.modified < lens.modifiedAfter) return false;
  if (lens.modifiedBefore && fm.modified > lens.modifiedBefore) return false;

  return true;
}

/**
 * Flatten tags from either format to a simple string array.
 */
function flattenTags(tags: Record<string, string[]> | string[]): string[] {
  if (Array.isArray(tags)) return tags;
  return Object.values(tags).flat();
}

/**
 * Gnosys Rules Generation — Phase 8b.
 *
 * Generates agent rules content from user preferences and project conventions.
 * Output is injected into agent rules files (CLAUDE.md, .cursor/rules/gnosys.mdc)
 * inside GNOSYS:START / GNOSYS:END blocks. User content outside these blocks
 * is never touched.
 *
 * The generated block contains:
 *   1. Base Gnosys tool instructions (always present)
 *   2. User preferences (from scope='user' category='preferences')
 *   3. Project conventions (from scope='project' for current projectId)
 */

import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import { GnosysDB, DbMemory } from "./db.js";
import { Preference, getAllPreferences } from "./preferences.js";

// ─── Block markers ──────────────────────────────────────────────────────

const MARKER_START_HTML = "<!-- GNOSYS:START -->";
const MARKER_END_HTML = "<!-- GNOSYS:END -->";
const MARKER_START_MDC = "<!-- GNOSYS:START -->";
const MARKER_END_MDC = "<!-- GNOSYS:END -->";

// ─── Types ──────────────────────────────────────────────────────────────

export interface RulesGenResult {
  /** The full file content after injection */
  content: string;
  /** Whether the file was created (true) or updated (false) */
  created: boolean;
  /** The rules file path */
  filePath: string;
  /** Number of preferences injected */
  prefCount: number;
  /** Number of project conventions injected */
  conventionCount: number;
}

export type RulesFileFormat = "claude" | "cursor" | "generic";

// ─── Base instructions ──────────────────────────────────────────────────

function getBaseInstructions(): string {
  return `## Gnosys Memory System

This project uses **Gnosys** for persistent memory. Run \`gnosys init\` before any other Gnosys command.

### Core workflow
1. **Start of task**: Run \`gnosys_discover\` with keywords to find relevant memories
2. **Read**: Use \`gnosys_read\` to load specific memories
3. **Write**: Use \`gnosys_add\` for new knowledge, \`gnosys_update\` to modify existing
4. **Reinforce**: Use \`gnosys_reinforce\` when a memory proves useful

### Memory triggers — write automatically when:
- A decision is made (library choice, architecture pattern, workflow convention)
- A spec or requirement is provided
- Significant findings emerge from implementation
- Something works differently than expected`;
}

// ─── Content generation ─────────────────────────────────────────────────

/**
 * Generate the full GNOSYS block content from preferences and project conventions.
 */
export function generateRulesBlock(
  preferences: Preference[],
  projectConventions: DbMemory[],
  opts?: { format?: RulesFileFormat }
): string {
  const sections: string[] = [];

  // 1. Base instructions (always present)
  sections.push(getBaseInstructions());

  // 2. User preferences
  if (preferences.length > 0) {
    const prefLines = preferences.map((p) => `- **${p.title}**: ${p.value}`);
    sections.push(
      `### User preferences\n\n${prefLines.join("\n")}`
    );
  }

  // 3. Project conventions
  if (projectConventions.length > 0) {
    const convLines = projectConventions.map((m) => {
      // Extract content body (strip "# Title\n\n" prefix)
      const lines = m.content.split("\n");
      const body = lines[0].startsWith("# ")
        ? lines.slice(2).join("\n").trim()
        : m.content.trim();
      return `- **${m.title}**: ${body.split("\n")[0]}`;
    });
    sections.push(
      `### Project conventions\n\n${convLines.join("\n")}`
    );
  }

  return sections.join("\n\n");
}

/**
 * Wrap content in GNOSYS markers.
 */
function wrapInMarkers(content: string): string {
  return `${MARKER_START_HTML}\n${content}\n${MARKER_END_HTML}`;
}

// ─── File injection ─────────────────────────────────────────────────────

/**
 * Inject generated rules into a file, preserving content outside GNOSYS blocks.
 * Creates the file if it doesn't exist.
 */
export async function injectRules(
  filePath: string,
  generatedBlock: string
): Promise<{ created: boolean }> {
  const wrapped = wrapInMarkers(generatedBlock);

  let existing: string | null = null;
  try {
    existing = await fs.readFile(filePath, "utf-8");
  } catch {
    // File doesn't exist — will create
  }

  if (existing === null) {
    // Create new file with just the GNOSYS block
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, wrapped + "\n", "utf-8");
    return { created: true };
  }

  // File exists — replace existing GNOSYS block or append
  const startIdx = existing.indexOf(MARKER_START_HTML);
  const endIdx = existing.indexOf(MARKER_END_HTML);

  let newContent: string;
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    // Replace existing block
    const before = existing.substring(0, startIdx);
    const after = existing.substring(endIdx + MARKER_END_HTML.length);
    newContent = before + wrapped + after;
  } else {
    // No existing block — append at end
    newContent = existing.trimEnd() + "\n\n" + wrapped + "\n";
  }

  await fs.writeFile(filePath, newContent, "utf-8");
  return { created: false };
}

// ─── High-level sync ────────────────────────────────────────────────────

/**
 * Sync rules for a project: reads preferences + project conventions from
 * central DB, generates the rules block, and injects into the agent rules file.
 */
export async function syncRules(
  centralDb: GnosysDB,
  projectDir: string,
  agentRulesTarget: string | null,
  projectId: string | null
): Promise<RulesGenResult | null> {
  if (!agentRulesTarget) return null;

  const filePath = path.resolve(projectDir, agentRulesTarget);

  // Gather preferences (user-scoped)
  const preferences = getAllPreferences(centralDb);

  // Gather project conventions (decisions + conventions for this project)
  let projectConventions: DbMemory[] = [];
  if (projectId) {
    const projectMems = centralDb.getMemoriesByProject(projectId);
    projectConventions = projectMems.filter(
      (m) =>
        (m.category === "decisions" || m.category === "conventions") &&
        m.status === "active"
    );
  }

  // Determine format from file extension
  let format: RulesFileFormat = "generic";
  if (agentRulesTarget.endsWith(".md")) format = "claude";
  if (agentRulesTarget.endsWith(".mdc")) format = "cursor";

  // Generate and inject
  const block = generateRulesBlock(preferences, projectConventions, { format });
  const { created } = await injectRules(filePath, block);

  return {
    content: block,
    created,
    filePath,
    prefCount: preferences.length,
    conventionCount: projectConventions.length,
  };
}

/**
 * Remove the GNOSYS block from a rules file (cleanup).
 */
export async function removeRulesBlock(filePath: string): Promise<boolean> {
  let content: string;
  try {
    content = await fs.readFile(filePath, "utf-8");
  } catch {
    return false;
  }

  const startIdx = content.indexOf(MARKER_START_HTML);
  const endIdx = content.indexOf(MARKER_END_HTML);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return false;
  }

  const before = content.substring(0, startIdx);
  const after = content.substring(endIdx + MARKER_END_HTML.length);
  const newContent = (before + after).replace(/\n{3,}/g, "\n\n").trim() + "\n";

  await fs.writeFile(filePath, newContent, "utf-8");
  return true;
}

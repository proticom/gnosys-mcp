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
import os from "os";
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

This project uses **Gnosys** for persistent memory via MCP. Gnosys uses a centralized brain (\`~/.gnosys/gnosys.db\`) shared across all projects with project, user, and global scopes.

### Read first

- At task start, call \`gnosys_discover\` with relevant keywords
- Load results with \`gnosys_read\`
- When the user references past decisions, says "recall", "remember when", "what did we decide" — search memory first
- Use \`gnosys_federated_search\` for cross-project search with scope boosting
- Use \`gnosys_working_set\` to see recently modified memories for context

### Write automatically

- When user says "remember", "memorize", "save this", "note this down", "don't forget" — call \`gnosys_add\`
- When user states a decision or preference (even casually) — commit to \`decisions/\`
- When user provides a spec or plan — commit BEFORE starting work
- After significant implementation — commit findings and gotchas
- User preferences (coding style, conventions) — use \`gnosys_preference_set\`

### Key tools

| Action | Tool |
|--------|------|
| Find memories | \`gnosys_discover\` (metadata) → \`gnosys_read\` (content) |
| Search | \`gnosys_hybrid_search\` (best), \`gnosys_federated_search\` (cross-project), \`gnosys_search\` (keyword), \`gnosys_ask\` (Q&A) |
| Write | \`gnosys_add\` (freeform), \`gnosys_add_structured\` (explicit fields) |
| Update | \`gnosys_update\`, \`gnosys_reinforce\` (useful/not_relevant/outdated) |
| Browse | \`gnosys_list\`, \`gnosys_lens\` (filtered), \`gnosys_tags\`, \`gnosys_graph\` |
| Maintain | \`gnosys_maintain\`, \`gnosys_stale\`, \`gnosys_history\`, \`gnosys_dashboard\` |
| Preferences | \`gnosys_preference_set\`, \`gnosys_preference_get\`, \`gnosys_preference_delete\` |
| Projects | \`gnosys_init\` (register), \`gnosys_briefing\` (status), \`gnosys_stores\` (debug) |
| Context | \`gnosys_federated_search\`, \`gnosys_working_set\`, \`gnosys_detect_ambiguity\` |
| Recall | \`gnosys_recall\` (fast context injection, sub-50ms) |
| Export | \`gnosys_export\` (Obsidian vault), \`gnosys_audit\` (operation trail) |

### Project routing

**IMPORTANT:** Always pass the \`projectRoot\` parameter with every Gnosys tool call, set to the workspace root directory. This ensures memories are stored and retrieved for the correct project. Without it, Gnosys may route to the wrong project in multi-project setups.

### Categories

\`architecture\` · \`decisions\` · \`requirements\` · \`concepts\` · \`roadmap\` · \`landscape\` · \`open-questions\``;
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

// ─── Multi-target sync ───────────────────────────────────────────────

/** Known agent rules file targets */
const TARGET_PATHS: Record<string, string> = {
  claude: "CLAUDE.md",
  cursor: ".cursor/rules/gnosys.mdc",
  codex: ".codex/gnosys.md",
};

/**
 * Resolve the global CLAUDE.md path (~/.claude/CLAUDE.md).
 */
function getGlobalClaudeMdPath(): string {
  return path.join(os.homedir(), ".claude", "CLAUDE.md");
}

/**
 * Determine which targets to sync based on what exists in the project directory.
 * Returns an array of relative file paths.
 */
export function detectAllTargets(projectDir: string): string[] {
  const targets: string[] = [];

  // Check for Cursor
  if (fsSync.existsSync(path.join(projectDir, ".cursor"))) {
    targets.push(TARGET_PATHS.cursor);
  }

  // Check for Claude Code (CLAUDE.md or .claude/ directory)
  if (
    fsSync.existsSync(path.join(projectDir, "CLAUDE.md")) ||
    fsSync.existsSync(path.join(projectDir, ".claude"))
  ) {
    targets.push(TARGET_PATHS.claude);
  }

  // Check for Codex
  if (fsSync.existsSync(path.join(projectDir, ".codex"))) {
    targets.push(TARGET_PATHS.codex);
  }

  return targets;
}

/**
 * Sync rules to a specific target (or all detected targets).
 * If target is "all", syncs to every detected agent config in the project.
 * If target is "global", syncs to ~/.claude/CLAUDE.md.
 */
export async function syncToTarget(
  centralDb: GnosysDB,
  projectDir: string,
  target: string,
  projectId: string | null
): Promise<RulesGenResult[]> {
  const preferences = getAllPreferences(centralDb);

  let projectConventions: DbMemory[] = [];
  if (projectId) {
    const projectMems = centralDb.getMemoriesByProject(projectId);
    projectConventions = projectMems.filter(
      (m) =>
        (m.category === "decisions" || m.category === "conventions") &&
        m.status === "active"
    );
  }

  const block = generateRulesBlock(preferences, projectConventions);
  const results: RulesGenResult[] = [];

  if (target === "global") {
    const globalPath = getGlobalClaudeMdPath();
    const { created } = await injectRules(globalPath, block);
    results.push({
      content: block,
      created,
      filePath: globalPath,
      prefCount: preferences.length,
      conventionCount: projectConventions.length,
    });
    return results;
  }

  // Resolve targets
  let targetPaths: string[];
  if (target === "all") {
    targetPaths = detectAllTargets(projectDir);
    if (targetPaths.length === 0) {
      // Default to CLAUDE.md if nothing detected
      targetPaths = [TARGET_PATHS.claude];
    }
  } else if (TARGET_PATHS[target]) {
    targetPaths = [TARGET_PATHS[target]];
  } else {
    // Treat as a literal file path
    targetPaths = [target];
  }

  for (const relPath of targetPaths) {
    const absPath = path.resolve(projectDir, relPath);
    const { created } = await injectRules(absPath, block);
    results.push({
      content: block,
      created,
      filePath: absPath,
      prefCount: preferences.length,
      conventionCount: projectConventions.length,
    });
  }

  return results;
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

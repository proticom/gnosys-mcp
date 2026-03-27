/**
 * Shared test helpers for Gnosys test suite.
 *
 * Provides factory functions, environment setup/teardown, and CLI utilities
 * following the Gnosys Test Case Standard (see TEST_STANDARD.md).
 */

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { GnosysDB, DbMemory, DbProject } from "../lib/db.js";
import { GnosysStore, MemoryFrontmatter } from "../lib/store.js";

// ─── Constants ──────────────────────────────────────────────────────────

export const CLI = `node ${path.resolve("dist/cli.js")}`;

// ─── Test Environment ───────────────────────────────────────────────────

export interface TestEnv {
  tmpDir: string;
  db: GnosysDB;
  store?: GnosysStore;
}

/**
 * Creates an isolated test environment with a temp directory, DB, and
 * optionally a GnosysStore (filesystem layer).
 */
export async function createTestEnv(
  prefix: string,
  opts: { withStore?: boolean } = {}
): Promise<TestEnv> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `gnosys-${prefix}-`));
  const db = new GnosysDB(tmpDir);
  let store: GnosysStore | undefined;

  if (opts.withStore) {
    store = new GnosysStore(tmpDir);
    await store.init();
  }

  return { tmpDir, db, store };
}

/**
 * Tears down a test environment: closes DB, removes temp directory.
 */
export async function cleanupTestEnv(env: TestEnv): Promise<void> {
  env.db.close();
  await fsp.rm(env.tmpDir, { recursive: true, force: true });
}

// ─── CLI Helpers ────────────────────────────────────────────────────────

/**
 * Run a gnosys CLI command with project context. Returns stdout.
 */
export function cli(
  command: string,
  projectDir: string,
  opts: { json?: boolean } = {}
): string {
  const cmd = opts.json ? `${CLI} ${command} --json` : `${CLI} ${command}`;
  return execSync(cmd, {
    encoding: "utf-8",
    env: { ...process.env, GNOSYS_PROJECT: projectDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Run a gnosys CLI command and parse JSON output.
 */
export function cliJson<T = unknown>(command: string, projectDir: string): T {
  const output = cli(command, projectDir, { json: true });
  return JSON.parse(output) as T;
}

/**
 * Initialize a gnosys project in a directory via CLI.
 */
export function cliInit(dir: string): string {
  return execSync(`${CLI} init --directory ${dir}`, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

// ─── Factory: DbMemory ─────────────────────────────────────────────────

let memCounter = 0;

/**
 * Create a DbMemory object with sensible defaults. Every call gets a unique ID.
 */
export function makeMemory(overrides: Partial<DbMemory> = {}): DbMemory {
  const now = new Date().toISOString();
  memCounter++;
  return {
    id: overrides.id || `test-${memCounter.toString().padStart(4, "0")}`,
    title: overrides.title || `Test Memory ${memCounter}`,
    category: overrides.category || "general",
    content: overrides.content || `Test content for memory ${memCounter}.`,
    summary: overrides.summary || null,
    tags: overrides.tags || '["test"]',
    relevance: overrides.relevance || "test general",
    author: overrides.author || "ai",
    authority: overrides.authority || "declared",
    confidence: overrides.confidence ?? 0.9,
    reinforcement_count: overrides.reinforcement_count ?? 0,
    content_hash:
      overrides.content_hash || `hash-${memCounter.toString().padStart(4, "0")}`,
    status: overrides.status || "active",
    tier: overrides.tier || "active",
    supersedes: overrides.supersedes || null,
    superseded_by: overrides.superseded_by || null,
    last_reinforced: overrides.last_reinforced || null,
    created: overrides.created || now,
    modified: overrides.modified || now,
    embedding: overrides.embedding || null,
    source_path: overrides.source_path || null,
    source_file: overrides.source_file ?? null,
    source_page: overrides.source_page ?? null,
    source_timerange: overrides.source_timerange ?? null,
    project_id: overrides.project_id ?? null,
    scope: overrides.scope || "project",
  };
}

// ─── Factory: DbProject ────────────────────────────────────────────────

let projCounter = 0;

/**
 * Create a DbProject object with sensible defaults.
 */
export function makeProject(overrides: Partial<DbProject> = {}): DbProject {
  const now = new Date().toISOString();
  projCounter++;
  const name = overrides.name || `TestProject${projCounter}`;
  return {
    id: overrides.id || `proj-${projCounter.toString().padStart(3, "0")}`,
    name,
    working_directory:
      overrides.working_directory || `/tmp/gnosys-test-${name.toLowerCase()}`,
    user: overrides.user || "testuser",
    agent_rules_target: overrides.agent_rules_target || null,
    obsidian_vault: overrides.obsidian_vault || null,
    created: overrides.created || now,
    modified: overrides.modified || now,
  };
}

// ─── Factory: MemoryFrontmatter ─────────────────────────────────────────

/**
 * Create a MemoryFrontmatter object for GnosysStore tests.
 */
export function makeFrontmatter(
  overrides: Partial<MemoryFrontmatter> = {}
): MemoryFrontmatter {
  return {
    id: "test-001",
    title: "Test Memory",
    category: "decisions",
    tags: { domain: ["testing"], type: ["decision"] },
    relevance: "test unit testing vitest store",
    author: "human",
    authority: "declared",
    confidence: 0.9,
    created: "2026-03-06",
    modified: "2026-03-06",
    last_reviewed: "2026-03-06",
    status: "active",
    supersedes: null,
    ...overrides,
  };
}

// ─── Seed Helpers ───────────────────────────────────────────────────────

/**
 * Seed a DB with N memories across different scopes and projects.
 * Returns the IDs of all seeded memories.
 */
export function seedMultiProjectMemories(
  db: GnosysDB,
  projects: Array<{ id: string; name: string; dir: string }>,
  memoriesPerProject: number = 3
): string[] {
  const ids: string[] = [];
  const now = new Date().toISOString();

  for (const proj of projects) {
    db.insertProject({
      id: proj.id,
      name: proj.name,
      working_directory: proj.dir,
      user: "testuser",
      agent_rules_target: null,
      obsidian_vault: null,
      created: now,
      modified: now,
    });

    for (let i = 1; i <= memoriesPerProject; i++) {
      const id = `${proj.id}-mem-${i}`;
      db.insertMemory(
        makeMemory({
          id,
          title: `${proj.name} Memory ${i}`,
          content: `Content for ${proj.name} memory ${i}`,
          project_id: proj.id,
          scope: "project",
          category: i === 1 ? "decisions" : i === 2 ? "requirements" : "concepts",
        })
      );
      ids.push(id);
    }
  }

  // Add a user-scoped memory
  const userId = "user-pref-001";
  db.insertMemory(
    makeMemory({
      id: userId,
      title: "User Preference",
      content: "Global user preference",
      scope: "user",
      project_id: null,
      category: "preferences",
    })
  );
  ids.push(userId);

  // Add a global-scoped memory
  const globalId = "global-001";
  db.insertMemory(
    makeMemory({
      id: globalId,
      title: "Global Knowledge",
      content: "Global shared knowledge",
      scope: "global",
      project_id: null,
      category: "concepts",
    })
  );
  ids.push(globalId);

  return ids;
}

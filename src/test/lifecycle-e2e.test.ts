/**
 * End-to-end memory lifecycle: add → read → update → archive → dearchive
 * → reinforce×3 → maintain, with DB consistency assertions.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GnosysArchive } from "../lib/archive.js";
import { GnosysMaintenanceEngine } from "../lib/maintenance.js";
import { GnosysResolver } from "../lib/resolver.js";
import { syncArchiveToDb, syncMemoryToDb } from "../lib/dbWrite.js";
import {
  createTestEnv,
  cleanupTestEnv,
  makeFrontmatter,
  type TestEnv,
} from "./_helpers.js";

const MEMORY_ID = "life-001";
const REL_PATH = "decisions/lifecycle-e2e.md";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv("lifecycle-e2e", { withStore: true });
});

afterEach(async () => {
  await cleanupTestEnv(env);
});

function sqlite(db: TestEnv["db"]) {
  return (db as unknown as {
    db: {
      pragma: (s: string, opts?: { simple: boolean }) => unknown;
      prepare: (sql: string) => { get: (...args: unknown[]) => unknown };
    };
  }).db;
}

describe("memory lifecycle e2e", () => {
  it("add → read → update → archive → dearchive → reinforce×3 → maintain stays consistent", async () => {
    const initialContent = "# Lifecycle Test\n\nOriginal body.";
    const fm = makeFrontmatter({
      id: MEMORY_ID,
      title: "Lifecycle Test",
      category: "decisions",
    });

    // 1. add
    await env.store!.writeMemory("decisions", "lifecycle-e2e.md", fm, initialContent);
    syncMemoryToDb(env.db, fm, initialContent, REL_PATH);

    // 2. read back
    expect(env.db.getMemory(MEMORY_ID)?.content).toBe(initialContent);

    // 3. update
    const updatedContent = "# Lifecycle Test\n\nUpdated body.";
    env.db.updateMemory(MEMORY_ID, { content: updatedContent });
    await env.store!.updateMemory(REL_PATH, {}, updatedContent);
    expect(env.db.getMemory(MEMORY_ID)?.content).toBe(updatedContent);

    // 4. archive
    const memory = await env.store!.readMemory(REL_PATH);
    expect(memory).not.toBeNull();

    const archive = new GnosysArchive(env.tmpDir);
    expect(archive.isAvailable()).toBe(true);
    expect(await archive.archiveMemory(memory!)).toBe(true);
    syncArchiveToDb(env.db, MEMORY_ID);
    expect(env.db.getActiveMemories().some((m) => m.id === MEMORY_ID)).toBe(false);
    archive.close();

    // 5. dearchive
    const archive2 = new GnosysArchive(env.tmpDir);
    const restoredPath = await archive2.dearchiveMemory(MEMORY_ID, env.store!, env.db);
    expect(restoredPath).not.toBeNull();
    expect(env.db.getMemory(MEMORY_ID)).not.toBeNull();
    expect(env.db.getMemory(MEMORY_ID)!.tier).toBe("active");
    archive2.close();

    // Dearchive restores DB only — write markdown back for reinforce/maintain
    const dbMem = env.db.getMemory(MEMORY_ID)!;
    await env.store!.writeMemory(
      "decisions",
      "lifecycle-e2e.md",
      makeFrontmatter({
        id: dbMem.id,
        title: dbMem.title,
        category: dbMem.category,
        reinforcement_count: dbMem.reinforcement_count,
      }),
      dbMem.content,
    );

    // 6. reinforce ×3 (sync store frontmatter between calls — reinforce reads count from markdown)
    for (let i = 0; i < 3; i++) {
      await GnosysMaintenanceEngine.reinforce(env.store!, restoredPath!, env.db);
      const count = env.db.getMemory(MEMORY_ID)!.reinforcement_count;
      await env.store!.updateMemory(restoredPath!, { reinforcement_count: count });
    }
    expect(env.db.getMemory(MEMORY_ID)!.reinforcement_count).toBe(3);

    // 7. maintain
    const resolver = new GnosysResolver();
    await resolver.addProjectStore(env.tmpDir);
    const engine = new GnosysMaintenanceEngine(resolver, undefined, env.db);
    const report = await engine.maintain({ dryRun: false, autoApply: false });
    expect(report).toBeTruthy();
    expect(report.totalMemories).toBeGreaterThan(0);

    // 8. consistency
    expect(sqlite(env.db).pragma("integrity_check", { simple: true })).toBe("ok");

    const ids = env.db.getAllMemories().map((m) => m.id);
    expect(ids.filter((x) => x === MEMORY_ID).length).toBe(1);

    const ftsRow = sqlite(env.db)
      .prepare("SELECT COUNT(*) AS c FROM memories_fts WHERE id = ?")
      .get(MEMORY_ID) as { c: number };
    expect(ftsRow.c).toBeGreaterThanOrEqual(1);
  }, 30_000);
});

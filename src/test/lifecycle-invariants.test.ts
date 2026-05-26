/**
 * Lifecycle invariant test — after each op, every memory ID has exactly one
 * row in memories (0 after delete) and 0 or 1 synced row in memories_fts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createTestEnv,
  cleanupTestEnv,
  makeFrontmatter,
  type TestEnv,
} from "./_helpers.js";
import {
  syncMemoryToDb,
  syncUpdateToDb,
  syncArchiveToDb,
  syncDearchiveToDb,
  syncReinforcementToDb,
  syncDeleteToDb,
} from "../lib/dbWrite.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv("lifecycle-inv", { withStore: true });
});

afterEach(async () => {
  await cleanupTestEnv(env);
});

function raw(db: TestEnv["db"]) {
  return (db as unknown as {
    db: {
      prepare: (s: string) => {
        get: (...args: unknown[]) => { c: number };
        all: () => Array<{ id: string; c: number }>;
      };
    };
  }).db;
}

function assertInvariants(testEnv: TestEnv, id: string, expectPresent: boolean) {
  const r = raw(testEnv.db);
  const memCount = r.prepare("SELECT COUNT(*) AS c FROM memories WHERE id = ?").get(id).c;
  const ftsCount = r.prepare("SELECT COUNT(*) AS c FROM memories_fts WHERE id = ?").get(id).c;

  expect(memCount).toBe(expectPresent ? 1 : 0);
  expect(ftsCount).toBeLessThanOrEqual(1);
  expect(ftsCount).toBe(memCount);

  const dupes = r.prepare("SELECT id, COUNT(*) AS c FROM memories GROUP BY id HAVING c > 1").all();
  expect(dupes.length).toBe(0);
}

describe("lifecycle invariants — one primary row, ≤1 sidecar row per id", () => {
  it("holds after every lifecycle op", async () => {
    const id = "inv-001";
    const rel = "decisions/inv.md";
    const fm = makeFrontmatter({ id, title: "Inv", category: "decisions" });

    syncMemoryToDb(env.db, fm, "body", rel);
    assertInvariants(env, id, true);

    syncUpdateToDb(env.db, id, { title: "Inv2" }, "body2");
    assertInvariants(env, id, true);

    syncArchiveToDb(env.db, id);
    assertInvariants(env, id, true);

    syncDearchiveToDb(env.db, id);
    assertInvariants(env, id, true);

    syncReinforcementToDb(env.db, id, 1);
    assertInvariants(env, id, true);

    syncDeleteToDb(env.db, id);
    assertInvariants(env, id, false);
  });
});

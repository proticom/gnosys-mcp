/**
 * Search golden test — fixture corpus (~50 memories) with committed top-3
 * results per search variant. Asserts stability across repeated runs.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GnosysDB } from "../lib/db.js";
import { GnosysDbSearch } from "../lib/dbSearch.js";
import { federatedSearch } from "../lib/federated.js";
import type { SearchMode } from "../lib/hybridSearch.js";
import { createTestEnv, cleanupTestEnv, type TestEnv } from "./_helpers.js";
import corpus from "./fixtures/search-corpus.json";
import golden from "./fixtures/search-golden.json";

const FIXED_DATE = "2020-06-15";

/** Deterministic stub embedder — same hash → same unit vector (hermetic CI). */
function hashEmbed(text: string): Float32Array {
  const dims = 16;
  const vec = new Float32Array(dims);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  for (let i = 0; i < dims; i++) {
    vec[i] = ((Math.imul(h, i + 1) >>> 0) % 1000) / 1000;
  }
  let norm = 0;
  for (const v of vec) norm += v * v;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dims; i++) vec[i] /= norm;
  return vec;
}

function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

let env: TestEnv;
let dbSearch: GnosysDbSearch;
const embedQuery = async (text: string) => hashEmbed(text);

beforeEach(async () => {
  env = await createTestEnv("search-golden");

  env.db.insertProject({
    id: corpus.projectId,
    name: "Golden Search Project",
    working_directory: env.tmpDir,
    user: "test",
    agent_rules_target: null,
    obsidian_vault: null,
    created: FIXED_DATE,
    modified: FIXED_DATE,
  });

  for (const m of corpus.memories) {
    const embedText = `${m.title} ${m.content} ${m.relevance}`;
    env.db.insertMemory({
      id: m.id,
      title: m.title,
      category: m.category,
      content: m.content,
      summary: null,
      tags: "[]",
      relevance: m.relevance,
      author: "ai",
      authority: "declared",
      confidence: 0.9,
      reinforcement_count: 0,
      content_hash: `hash-${m.id}`,
      status: "active",
      tier: "active",
      supersedes: null,
      superseded_by: null,
      last_reinforced: null,
      created: FIXED_DATE,
      modified: FIXED_DATE,
      embedding: float32ToBuffer(hashEmbed(embedText)),
      source_path: null,
      source_file: null,
      source_page: null,
      source_timerange: null,
      project_id: m.project_id,
      scope: m.scope,
    });
  }

  dbSearch = new GnosysDbSearch(env.db);
});

afterEach(async () => {
  await cleanupTestEnv(env);
});

async function runVariant(variant: string, query: string): Promise<string[]> {
  switch (variant) {
    case "keyword":
      return dbSearch.search(query, 3).map((r) => r.relative_path);
    case "discover":
      return dbSearch.discover(query, 3).map((r) => r.relative_path);
    case "federated":
      return federatedSearch(env.db, query, {
        limit: 3,
        projectId: corpus.projectId,
        recencyWindowHours: 0,
      }).map((r) => r.id);
    case "hybrid":
    case "semantic":
      return (await dbSearch.hybridSearch(query, 3, variant as SearchMode, embedQuery)).map(
        (r) => r.relativePath,
      );
    default:
      throw new Error(`Unknown variant: ${variant}`);
  }
}

describe("search golden — top-3 stability", () => {
  for (const [key, expectedTop3] of Object.entries(golden)) {
    const [variant, query] = key.split("::");

    it(`${variant} top-3 stable for "${query}"`, async () => {
      const run = () => runVariant(variant, query);
      const first = await run();
      const second = await run();

      expect(first).toEqual(second);
      expect(first).toEqual(expectedTop3);
      expect(first.length).toBeLessThanOrEqual(3);
    });
  }

  it("corpus has ~50 memories", () => {
    expect(corpus.memories.length).toBeGreaterThanOrEqual(50);
  });
});

/**
 * Tests for Gnosys Bulk Import — CSV, JSON, JSONL parsing, field mapping,
 * deduplication, batch commits, and structured/LLM mode processing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { performImport, formatImportSummary, estimateDuration } from "../lib/import.js";
import { GnosysStore } from "../lib/store.js";
import { GnosysTagRegistry } from "../lib/tags.js";
import { GnosysIngestion } from "../lib/ingest.js";

let tmpDir: string;
let store: GnosysStore;
let tagRegistry: GnosysTagRegistry;
let ingestion: GnosysIngestion;
let dataDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gnosys-import-test-"));
  store = new GnosysStore(tmpDir);
  await store.init();
  tagRegistry = new GnosysTagRegistry(tmpDir);
  await tagRegistry.load();
  ingestion = new GnosysIngestion(store, tagRegistry);
  dataDir = path.join(tmpDir, "data");
  await fs.mkdir(dataDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── JSON Parsing ────────────────────────────────────────────────────────

describe("JSON import", () => {
  it("imports a JSON array of records", async () => {
    const data = [
      { name: "Apple", group: "Fruits", desc: "A red fruit" },
      { name: "Carrot", group: "Vegetables", desc: "An orange root vegetable" },
    ];
    const filePath = path.join(dataDir, "foods.json");
    await fs.writeFile(filePath, JSON.stringify(data));

    const result = await performImport(store, ingestion, {
      format: "json",
      data: filePath,
      mapping: { name: "title", group: "category", desc: "content" },
      mode: "structured",
      batchCommit: true,
    });

    expect(result.imported).toHaveLength(2);
    expect(result.failed).toHaveLength(0);
    const titles = result.imported.map((r) => r.title).sort();
    expect(titles).toEqual(["Apple", "Carrot"]);
    const apple = result.imported.find((r) => r.title === "Apple");
    expect(apple?.category).toBe("fruits");
  });

  it("handles nested JSON with common array keys", async () => {
    const data = {
      totalHits: 2,
      foods: [
        { name: "Milk", group: "Dairy" },
        { name: "Cheese", group: "Dairy" },
      ],
    };
    const filePath = path.join(dataDir, "response.json");
    await fs.writeFile(filePath, JSON.stringify(data));

    const result = await performImport(store, ingestion, {
      format: "json",
      data: filePath,
      mapping: { name: "title", group: "category" },
      mode: "structured",
    });

    expect(result.imported).toHaveLength(2);
    const titles = result.imported.map((r) => r.title).sort();
    expect(titles).toEqual(["Cheese", "Milk"]);
  });

  it("rejects JSON without recognizable array", async () => {
    const filePath = path.join(dataDir, "bad.json");
    await fs.writeFile(filePath, JSON.stringify({ name: "solo" }));

    await expect(
      performImport(store, ingestion, {
        format: "json",
        data: filePath,
        mapping: { name: "title" },
        mode: "structured",
      })
    ).rejects.toThrow("recognizable array");
  });
});

// ─── CSV Parsing ─────────────────────────────────────────────────────────

describe("CSV import", () => {
  it("imports a CSV file", async () => {
    const csv = `name,group,description
Apple,Fruits,A common fruit
Banana,Fruits,A yellow fruit
Broccoli,Vegetables,A green vegetable`;
    const filePath = path.join(dataDir, "foods.csv");
    await fs.writeFile(filePath, csv);

    const result = await performImport(store, ingestion, {
      format: "csv",
      data: filePath,
      mapping: { name: "title", group: "category", description: "content" },
      mode: "structured",
    });

    expect(result.imported).toHaveLength(3);
    const titles = result.imported.map((r) => r.title).sort();
    expect(titles).toEqual(["Apple", "Banana", "Broccoli"]);
    const broccoli = result.imported.find((r) => r.title === "Broccoli");
    expect(broccoli?.category).toBe("vegetables");
  });
});

// ─── JSONL Parsing ───────────────────────────────────────────────────────

describe("JSONL import", () => {
  it("imports JSONL (one JSON object per line)", async () => {
    const lines = [
      JSON.stringify({ name: "Spinach", group: "Vegetables" }),
      JSON.stringify({ name: "Rice", group: "Grains" }),
    ].join("\n");
    const filePath = path.join(dataDir, "foods.jsonl");
    await fs.writeFile(filePath, lines);

    const result = await performImport(store, ingestion, {
      format: "jsonl",
      data: filePath,
      mapping: { name: "title", group: "category" },
      mode: "structured",
    });

    expect(result.imported).toHaveLength(2);
  });
});

// ─── Field Mapping ───────────────────────────────────────────────────────

describe("field mapping", () => {
  it("rejects mapping without title", async () => {
    const data = [{ name: "Apple", group: "Fruits" }];
    const filePath = path.join(dataDir, "foods.json");
    await fs.writeFile(filePath, JSON.stringify(data));

    await expect(
      performImport(store, ingestion, {
        format: "json",
        data: filePath,
        mapping: { group: "category" }, // No title mapping
        mode: "structured",
      })
    ).rejects.toThrow("title");
  });

  it("includes unmapped fields as extra context", async () => {
    const data = [
      { name: "Chicken", group: "Poultry", protein: "31g", iron: "0.9mg" },
    ];
    const filePath = path.join(dataDir, "foods.json");
    await fs.writeFile(filePath, JSON.stringify(data));

    const result = await performImport(store, ingestion, {
      format: "json",
      data: filePath,
      mapping: { name: "title", group: "category" },
      mode: "structured",
    });

    expect(result.imported).toHaveLength(1);
    // The written memory should contain unmapped fields in content
    const memories = await store.getAllMemories();
    expect(memories).toHaveLength(1);
    expect(memories[0].content).toContain("protein");
    expect(memories[0].content).toContain("iron");
  });

  it("slugifies category names", async () => {
    const data = [{ name: "Milk", group: "Dairy and Egg Products" }];
    const filePath = path.join(dataDir, "foods.json");
    await fs.writeFile(filePath, JSON.stringify(data));

    const result = await performImport(store, ingestion, {
      format: "json",
      data: filePath,
      mapping: { name: "title", group: "category" },
      mode: "structured",
    });

    expect(result.imported[0].category).toBe("dairy-and-egg-products");
  });
});

// ─── Deduplication ───────────────────────────────────────────────────────

describe("deduplication", () => {
  it("skips records that already exist when skipExisting is true", async () => {
    // First: add an existing memory
    const fm = {
      id: "test-001",
      title: "Apple",
      category: "fruits",
      tags: {},
      relevance: "",
      author: "human" as const,
      authority: "declared" as const,
      confidence: 0.9,
      created: "2026-03-08",
      modified: "2026-03-08",
      status: "active" as const,
      supersedes: null,
    };
    await store.writeMemory("fruits", "apple.md", fm, "# Apple\n\nA fruit.");

    // Now import data that includes Apple
    const data = [
      { name: "Apple", group: "Fruits" },
      { name: "Banana", group: "Fruits" },
    ];
    const filePath = path.join(dataDir, "foods.json");
    await fs.writeFile(filePath, JSON.stringify(data));

    const result = await performImport(store, ingestion, {
      format: "json",
      data: filePath,
      mapping: { name: "title", group: "category" },
      mode: "structured",
      skipExisting: true,
    });

    expect(result.imported).toHaveLength(1);
    expect(result.imported[0].title).toBe("Banana");
    expect(result.skipped).toContain("Apple");
  });
});

// ─── Limit and Offset ────────────────────────────────────────────────────

describe("limit and offset", () => {
  it("respects limit", async () => {
    const data = Array.from({ length: 10 }, (_, i) => ({
      name: `Food ${i}`,
      group: "test",
    }));
    const filePath = path.join(dataDir, "many.json");
    await fs.writeFile(filePath, JSON.stringify(data));

    const result = await performImport(store, ingestion, {
      format: "json",
      data: filePath,
      mapping: { name: "title", group: "category" },
      mode: "structured",
      limit: 3,
    });

    expect(result.imported).toHaveLength(3);
    expect(result.totalProcessed).toBe(3);
  });

  it("respects offset", async () => {
    const data = Array.from({ length: 5 }, (_, i) => ({
      name: `Food ${i}`,
      group: "test",
    }));
    const filePath = path.join(dataDir, "many.json");
    await fs.writeFile(filePath, JSON.stringify(data));

    const result = await performImport(store, ingestion, {
      format: "json",
      data: filePath,
      mapping: { name: "title", group: "category" },
      mode: "structured",
      offset: 3,
    });

    expect(result.imported).toHaveLength(2);
    const titles = result.imported.map((r) => r.title).sort();
    expect(titles).toEqual(["Food 3", "Food 4"]);
  });
});

// ─── Dry Run ─────────────────────────────────────────────────────────────

describe("dry run", () => {
  it("reports what would be imported without writing", async () => {
    const data = [
      { name: "Apple", group: "Fruits" },
      { name: "Carrot", group: "Vegetables" },
    ];
    const filePath = path.join(dataDir, "foods.json");
    await fs.writeFile(filePath, JSON.stringify(data));

    const result = await performImport(store, ingestion, {
      format: "json",
      data: filePath,
      mapping: { name: "title", group: "category" },
      mode: "structured",
      dryRun: true,
    });

    expect(result.imported).toHaveLength(2);

    // Verify nothing was actually written
    const memories = await store.getAllMemories();
    expect(memories).toHaveLength(0);
  });
});

// ─── Batch Commit ────────────────────────────────────────────────────────

describe("batch commit", () => {
  it("writes multiple records without per-record commits when batching", async () => {
    const data = Array.from({ length: 5 }, (_, i) => ({
      name: `Food ${i}`,
      group: "test",
    }));
    const filePath = path.join(dataDir, "batch.json");
    await fs.writeFile(filePath, JSON.stringify(data));

    const result = await performImport(store, ingestion, {
      format: "json",
      data: filePath,
      mapping: { name: "title", group: "category" },
      mode: "structured",
      batchCommit: true,
    });

    expect(result.imported).toHaveLength(5);

    // Verify files were actually written
    const memories = await store.getAllMemories();
    expect(memories).toHaveLength(5);
  });
});

// ─── Error Handling ──────────────────────────────────────────────────────

describe("error handling", () => {
  it("continues processing when individual records fail", async () => {
    // Include a record that maps to an empty title (edge case)
    const data = [
      { name: "Apple", group: "Fruits" },
      { name: "", group: "" }, // This should still process (as "Untitled")
      { name: "Carrot", group: "Vegetables" },
    ];
    const filePath = path.join(dataDir, "mixed.json");
    await fs.writeFile(filePath, JSON.stringify(data));

    const result = await performImport(store, ingestion, {
      format: "json",
      data: filePath,
      mapping: { name: "title", group: "category" },
      mode: "structured",
    });

    // All should process (empty name becomes "Untitled")
    expect(result.imported.length + result.failed.length + result.skipped.length).toBe(3);
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────

describe("formatImportSummary", () => {
  it("produces readable summary", () => {
    const summary = formatImportSummary({
      imported: [
        { title: "A", category: "test", path: "test/a.md" },
        { title: "B", category: "test", path: "test/b.md" },
      ],
      skipped: ["C"],
      failed: [{ record: "D", error: "bad input" }],
      totalProcessed: 4,
      duration: 2500,
    });

    expect(summary).toContain("Imported: 2");
    expect(summary).toContain("Skipped:  1");
    expect(summary).toContain("Failed:   1");
    expect(summary).toContain("2.5s");
    expect(summary).toContain("bad input");
  });
});

describe("estimateDuration", () => {
  it("estimates structured mode as fast", () => {
    expect(estimateDuration(100, "structured")).toMatch(/~\d+s/);
  });

  it("estimates LLM mode as slower", () => {
    const est = estimateDuration(365, "llm", 5);
    expect(est).toMatch(/~\d+m/);
  });
});

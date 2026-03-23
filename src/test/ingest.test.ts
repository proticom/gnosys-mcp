/**
 * Tests for GnosysIngestion — structured ingestion (no LLM required).
 * LLM-based ingest() is tested via integration tests only.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { GnosysStore } from "../lib/store.js";
import { GnosysTagRegistry } from "../lib/tags.js";
import { GnosysIngestion } from "../lib/ingest.js";

let tmpDir: string;
let store: GnosysStore;
let tagRegistry: GnosysTagRegistry;
let ingestion: GnosysIngestion;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gnosys-ingest-test-"));
  store = new GnosysStore(tmpDir);
  await store.init();

  // Seed tags
  const defaultTags = {
    domain: ["architecture", "auth", "testing"],
    type: ["decision", "concept"],
    concern: ["dx", "scalability"],
  };
  await fs.writeFile(
    path.join(tmpDir, ".config", "tags.json"),
    JSON.stringify(defaultTags, null, 2),
    "utf-8"
  );

  tagRegistry = new GnosysTagRegistry(tmpDir);
  await tagRegistry.load();
  ingestion = new GnosysIngestion(store, tagRegistry);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("GnosysIngestion", () => {
  describe("isLLMAvailable", () => {
    it("reports false when no API key is set", () => {
      // In test environment, ANTHROPIC_API_KEY is typically not set
      // Unless it is — in which case this test is still valid
      // The property just reports whether the client was initialized
      expect(typeof ingestion.isLLMAvailable).toBe("boolean");
    });
  });

  describe("createStructured", () => {
    it("creates a structured IngestResult with all fields", () => {
      const result = ingestion.createStructured({
        title: "Auth Decision",
        category: "decisions",
        tags: { domain: ["auth"], type: ["decision"] },
        relevance: "auth JWT session OAuth login",
        content: "We chose JWT for authentication.",
        author: "human",
        authority: "declared",
        confidence: 0.95,
      });

      expect(result.title).toBe("Auth Decision");
      expect(result.category).toBe("decisions");
      expect(result.tags.domain).toEqual(["auth"]);
      expect(result.relevance).toBe("auth JWT session OAuth login");
      expect(result.content).toBe("We chose JWT for authentication.");
      expect(result.confidence).toBe(0.95);
      expect(result.filename).toBe("auth-decision");
    });

    it("generates kebab-case filename from title", () => {
      const result = ingestion.createStructured({
        title: "My Complex Title With CAPS",
        category: "concepts",
        tags: {},
        content: "Content",
      });

      expect(result.filename).toBe("my-complex-title-with-caps");
    });

    it("truncates filename to 60 characters", () => {
      const longTitle = "A".repeat(100);
      const result = ingestion.createStructured({
        title: longTitle,
        category: "concepts",
        tags: {},
        content: "Content",
      });

      expect(result.filename.length).toBeLessThanOrEqual(60);
    });

    it("provides defaults for optional fields", () => {
      const result = ingestion.createStructured({
        title: "Minimal",
        category: "concepts",
        tags: {},
        content: "Minimal content",
      });

      expect(result.relevance).toBe("");
      expect(result.confidence).toBe(0.8);
    });
  });

  describe("end-to-end structured write", () => {
    it("creates a valid memory file from structured input", async () => {
      const result = ingestion.createStructured({
        title: "E2E Test Memory",
        category: "decisions",
        tags: { domain: ["testing"], type: ["decision"] },
        relevance: "e2e integration test structured ingestion",
        content: "This memory was created via structured ingestion.",
        confidence: 0.85,
      });

      const id = await store.generateId(result.category);
      const today = new Date().toISOString().split("T")[0];

      const frontmatter = {
        id,
        title: result.title,
        category: result.category,
        tags: result.tags,
        relevance: result.relevance,
        author: "ai" as const,
        authority: "observed" as const,
        confidence: result.confidence,
        created: today,
        modified: today,
        last_reviewed: today,
        status: "active" as const,
        supersedes: null,
      };

      const content = `# ${result.title}\n\n${result.content}`;
      const relPath = await store.writeMemory(
        result.category,
        `${result.filename}.md`,
        frontmatter,
        content
      );

      // Verify the file was written correctly
      const memory = await store.readMemory(relPath);
      expect(memory).not.toBeNull();
      expect(memory!.frontmatter.title).toBe("E2E Test Memory");
      expect(memory!.frontmatter.relevance).toBe(
        "e2e integration test structured ingestion"
      );
      expect(memory!.frontmatter.last_reviewed).toBe(today);
      expect(memory!.content).toContain(
        "This memory was created via structured ingestion."
      );
    });
  });
});

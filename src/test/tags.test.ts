/**
 * Tests for GnosysTagRegistry — tag management and validation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { GnosysTagRegistry } from "../lib/tags.js";

let tmpDir: string;
let registry: GnosysTagRegistry;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gnosys-tags-test-"));

  // GnosysTagRegistry expects tags at .config/tags.json inside the store
  const configDir = path.join(tmpDir, ".config");
  await fs.mkdir(configDir, { recursive: true });

  const defaultTags = {
    domain: ["architecture", "auth", "testing"],
    type: ["decision", "concept"],
    concern: ["dx", "scalability"],
  };
  await fs.writeFile(
    path.join(configDir, "tags.json"),
    JSON.stringify(defaultTags, null, 2),
    "utf-8"
  );

  registry = new GnosysTagRegistry(tmpDir);
  await registry.load();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("GnosysTagRegistry", () => {
  describe("load + getRegistry", () => {
    it("loads tags from tags.json", () => {
      const reg = registry.getRegistry();
      expect(reg.domain).toContain("auth");
      expect(reg.type).toContain("decision");
      expect(reg.concern).toContain("dx");
    });
  });

  describe("hasTag", () => {
    it("finds existing tags", () => {
      expect(registry.hasTag("auth")).toBe(true);
      expect(registry.hasTag("architecture")).toBe(true);
    });

    it("returns false for non-existent tags", () => {
      expect(registry.hasTag("nonexistent-tag-xyz")).toBe(false);
    });
  });

  describe("addTag", () => {
    it("adds a new tag to an existing category", async () => {
      const added = await registry.addTag("domain", "frontend");
      expect(added).toBe(true);
      expect(registry.hasTag("frontend")).toBe(true);

      // Verify it was persisted to disk at .config/tags.json
      const raw = await fs.readFile(
        path.join(tmpDir, ".config", "tags.json"),
        "utf-8"
      );
      const parsed = JSON.parse(raw);
      expect(parsed.domain).toContain("frontend");
    });

    it("adds a tag to a new category", async () => {
      const added = await registry.addTag("status_tag", "stable");
      expect(added).toBe(true);
      expect(registry.hasTag("stable")).toBe(true);
    });

    it("returns false if tag already exists", async () => {
      const added = await registry.addTag("domain", "auth");
      expect(added).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("falls back to DEFAULT_REGISTRY when tags.json is missing", async () => {
      // GnosysTagRegistry falls back to a built-in default when no file exists
      const emptyDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "gnosys-tags-empty-")
      );
      const emptyRegistry = new GnosysTagRegistry(emptyDir);
      await emptyRegistry.load();
      const reg = emptyRegistry.getRegistry();
      // Default registry has 4 categories: domain, type, concern, status_tag
      expect(Object.keys(reg).length).toBe(4);
      expect(reg.domain).toBeDefined();
      expect(reg.domain.length).toBeGreaterThan(0);
      await fs.rm(emptyDir, { recursive: true, force: true });
    });
  });
});

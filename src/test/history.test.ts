import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { execSync } from "child_process";
import { GnosysStore, MemoryFrontmatter } from "../lib/store.js";
import {
  getFileHistory,
  getFileAtCommit,
  rollbackToCommit,
  hasGitHistory,
  getFileDiff,
} from "../lib/history.js";

let tmpDir: string;
let store: GnosysStore;

function makeFrontmatter(overrides: Partial<MemoryFrontmatter> = {}): MemoryFrontmatter {
  return {
    id: "test-001",
    title: "Test Memory",
    category: "decisions",
    tags: { domain: ["testing"], type: ["decision"] },
    relevance: "test history rollback versioning",
    author: "human",
    authority: "declared",
    confidence: 0.8,
    created: "2026-03-01",
    modified: "2026-03-01",
    status: "active",
    supersedes: null,
    ...overrides,
  };
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gnosys-history-"));
  store = new GnosysStore(tmpDir);
  await store.init();
  // Configure git user for commits in this temp directory
  execSync('git config user.email "test@gnosys.dev"', { cwd: tmpDir, stdio: "pipe" });
  execSync('git config user.name "Gnosys Test"', { cwd: tmpDir, stdio: "pipe" });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("hasGitHistory", () => {
  it("returns true for a git-initialized store", () => {
    expect(hasGitHistory(tmpDir)).toBe(true);
  });

  it("returns false for a non-git directory", async () => {
    const plainDir = await fs.mkdtemp(path.join(os.tmpdir(), "no-git-"));
    expect(hasGitHistory(plainDir)).toBe(false);
    await fs.rm(plainDir, { recursive: true, force: true });
  });
});

describe("getFileHistory", () => {
  it("returns history after write and update", async () => {
    const fm = makeFrontmatter();
    await store.writeMemory("decisions", "auth.md", fm, "# Auth\n\nVersion 1");

    // Update the memory
    await store.updateMemory("decisions/auth.md", { title: "Auth Updated", confidence: 0.9 });

    const history = getFileHistory(tmpDir, "decisions/auth.md");
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0].message).toContain("Update memory");
    expect(history[1].message).toContain("Add memory");
  });

  it("returns empty array for non-existent file", () => {
    const history = getFileHistory(tmpDir, "no/such/file.md");
    expect(history).toEqual([]);
  });

  it("respects the limit parameter", async () => {
    const fm = makeFrontmatter();
    await store.writeMemory("decisions", "multi.md", fm, "# V1");
    await store.updateMemory("decisions/multi.md", { title: "V2" });
    await store.updateMemory("decisions/multi.md", { title: "V3" });
    await store.updateMemory("decisions/multi.md", { title: "V4" });

    const limited = getFileHistory(tmpDir, "decisions/multi.md", 2);
    expect(limited).toHaveLength(2);
  });
});

describe("getFileAtCommit", () => {
  it("retrieves file content at a specific commit", async () => {
    const fm = makeFrontmatter({ title: "Original Title" });
    await store.writeMemory("decisions", "version.md", fm, "# Original\n\nOriginal content");

    // Get the first commit hash
    const history1 = getFileHistory(tmpDir, "decisions/version.md");
    const firstHash = history1[0].commitHash;

    // Update
    await store.updateMemory("decisions/version.md", { title: "Changed Title" });

    // Retrieve original version
    const original = getFileAtCommit(tmpDir, "decisions/version.md", firstHash);
    expect(original).toBeTruthy();
    expect(original).toContain("Original Title");
  });

  it("returns null for invalid commit hash", () => {
    const result = getFileAtCommit(tmpDir, "decisions/version.md", "0000000000");
    expect(result).toBeNull();
  });
});

describe("getFileDiff", () => {
  it("shows diff between two commits", async () => {
    const fm = makeFrontmatter({ title: "First" });
    await store.writeMemory("decisions", "diff.md", fm, "# First\n\nContent A");

    const history1 = getFileHistory(tmpDir, "decisions/diff.md");
    const hash1 = history1[0].commitHash;

    await store.updateMemory("decisions/diff.md", { title: "Second" }, "# Second\n\nContent B");

    const history2 = getFileHistory(tmpDir, "decisions/diff.md");
    const hash2 = history2[0].commitHash;

    const diff = getFileDiff(tmpDir, "decisions/diff.md", hash1, hash2);
    expect(diff).toBeTruthy();
    expect(diff).toContain("First");
    expect(diff).toContain("Second");
  });
});

describe("rollbackToCommit", () => {
  it("reverts a memory to a prior version", async () => {
    const fm = makeFrontmatter({ title: "Original" });
    await store.writeMemory("decisions", "rollback.md", fm, "# Original\n\nOriginal content");

    const historyBefore = getFileHistory(tmpDir, "decisions/rollback.md");
    const originalHash = historyBefore[0].commitHash;

    // Update to new version
    await store.updateMemory("decisions/rollback.md", { title: "Changed" }, "# Changed\n\nNew content");

    // Verify it changed
    const current = await store.readMemory("decisions/rollback.md");
    expect(current?.frontmatter.title).toBe("Changed");

    // Rollback
    const success = rollbackToCommit(tmpDir, "decisions/rollback.md", originalHash);
    expect(success).toBe(true);

    // Verify it reverted
    const reverted = await store.readMemory("decisions/rollback.md");
    expect(reverted?.frontmatter.title).toBe("Original");
    expect(reverted?.content).toContain("Original content");
  });

  it("creates a new commit for the rollback", async () => {
    const fm = makeFrontmatter({ title: "Start" });
    await store.writeMemory("decisions", "rb2.md", fm, "# Start");

    const h1 = getFileHistory(tmpDir, "decisions/rb2.md");
    await store.updateMemory("decisions/rb2.md", { title: "Middle" });
    rollbackToCommit(tmpDir, "decisions/rb2.md", h1[0].commitHash);

    const finalHistory = getFileHistory(tmpDir, "decisions/rb2.md");
    expect(finalHistory.length).toBeGreaterThanOrEqual(3); // write, update, rollback
    expect(finalHistory[0].message).toContain("Rollback");
  });

  it("returns false for invalid commit hash", () => {
    const result = rollbackToCommit(tmpDir, "decisions/nope.md", "0000000");
    expect(result).toBe(false);
  });
});

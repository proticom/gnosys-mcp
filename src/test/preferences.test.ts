import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { GnosysDB } from "../lib/db.js";
import { setPreference, getPreference, getAllPreferences, deletePreference } from "../lib/preferences.js";
import { generateRulesBlock, injectRules, syncRules } from "../lib/rulesGen.js";

let tmpDir: string;
let db: GnosysDB;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "gnosys-pref-test-"));
  db = new GnosysDB(tmpDir);
});

afterEach(async () => {
  db.close();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("preferences", () => {
  it("sets and gets a preference", () => {
    setPreference(db, "commit-convention", "Use conventional commits format");
    const pref = getPreference(db, "commit-convention");
    expect(pref).not.toBeNull();
    expect(pref!.key).toBe("commit-convention");
    expect(pref!.value).toBe("Use conventional commits format");
    expect(pref!.title).toBe("Commit Convention");
  });

  it("auto-generates title from key", () => {
    setPreference(db, "code-style", "Prefer functional style");
    const pref = getPreference(db, "code-style");
    expect(pref!.title).toBe("Code Style");
  });

  it("allows custom title", () => {
    setPreference(db, "code-style", "Functional", { title: "My Code Style" });
    const pref = getPreference(db, "code-style");
    expect(pref!.title).toBe("My Code Style");
  });

  it("stores as user-scoped memory", () => {
    setPreference(db, "test-key", "test-value");
    const mem = db.getMemory("pref-test-key");
    expect(mem).not.toBeNull();
    expect(mem!.scope).toBe("user");
    expect(mem!.category).toBe("preferences");
    expect(mem!.project_id).toBeNull();
  });

  it("updates existing preference (increments reinforcement)", () => {
    setPreference(db, "test-key", "value1");
    const mem1 = db.getMemory("pref-test-key");
    expect(mem1!.reinforcement_count).toBe(0);

    setPreference(db, "test-key", "value2");
    const mem2 = db.getMemory("pref-test-key");
    expect(mem2!.reinforcement_count).toBe(1);
    expect(mem2!.content).toContain("value2");
  });

  it("lists all preferences", () => {
    setPreference(db, "a-pref", "value A");
    setPreference(db, "b-pref", "value B");
    setPreference(db, "c-pref", "value C");

    const all = getAllPreferences(db);
    expect(all.length).toBe(3);
    expect(all.map((p) => p.key).sort()).toEqual(["a-pref", "b-pref", "c-pref"]);
  });

  it("deletes a preference", () => {
    setPreference(db, "to-delete", "bye");
    expect(getPreference(db, "to-delete")).not.toBeNull();

    const deleted = deletePreference(db, "to-delete");
    expect(deleted).toBe(true);
    expect(getPreference(db, "to-delete")).toBeNull();
  });

  it("returns false when deleting nonexistent preference", () => {
    const deleted = deletePreference(db, "nope");
    expect(deleted).toBe(false);
  });

  it("stores tags on preference", () => {
    setPreference(db, "tagged", "value", { tags: ["git", "workflow"] });
    const pref = getPreference(db, "tagged");
    expect(pref!.tags).toEqual(["git", "workflow"]);
  });
});

describe("rules generation", () => {
  it("generates base instructions with no preferences", () => {
    const block = generateRulesBlock([], []);
    expect(block).toContain("Gnosys Memory System");
    expect(block).toContain("gnosys_discover");
    expect(block).not.toContain("User preferences");
  });

  it("includes preferences in generated block", () => {
    const prefs = [
      { key: "commit-convention", value: "Use conventional commits", title: "Commit Convention", tags: [], confidence: 0.95, created: "2026-01-01", modified: "2026-01-01" },
      { key: "code-style", value: "Prefer functional style", title: "Code Style", tags: [], confidence: 0.9, created: "2026-01-01", modified: "2026-01-01" },
    ];

    const block = generateRulesBlock(prefs, []);
    expect(block).toContain("User preferences");
    expect(block).toContain("Commit Convention");
    expect(block).toContain("conventional commits");
    expect(block).toContain("Code Style");
  });

  it("includes project conventions in generated block", () => {
    const conventions = [
      {
        id: "deci-001", title: "Use PostgreSQL", category: "decisions",
        content: "# Use PostgreSQL\n\nWe chose PostgreSQL over MySQL",
        summary: null, tags: "[]", relevance: "", author: "human",
        authority: "declared", confidence: 0.9, reinforcement_count: 0,
        content_hash: "abc", status: "active", tier: "active",
        supersedes: null, superseded_by: null, last_reinforced: null,
        created: "2026-01-01", modified: "2026-01-01", embedding: null,
        source_path: null, project_id: "proj-1", scope: "project",
      },
    ];

    const block = generateRulesBlock([], conventions);
    expect(block).toContain("Project conventions");
    expect(block).toContain("Use PostgreSQL");
  });
});

describe("rules injection", () => {
  it("creates new file with GNOSYS block", async () => {
    const filePath = path.join(tmpDir, "CLAUDE.md");
    await injectRules(filePath, "Test content");

    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toContain("<!-- GNOSYS:START -->");
    expect(content).toContain("Test content");
    expect(content).toContain("<!-- GNOSYS:END -->");
  });

  it("replaces existing GNOSYS block", async () => {
    const filePath = path.join(tmpDir, "CLAUDE.md");
    const original = `# My Rules

Some user content.

<!-- GNOSYS:START -->
Old generated content
<!-- GNOSYS:END -->

More user content.
`;
    await fs.writeFile(filePath, original, "utf-8");

    await injectRules(filePath, "New generated content");

    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toContain("New generated content");
    expect(content).not.toContain("Old generated content");
    expect(content).toContain("Some user content.");
    expect(content).toContain("More user content.");
  });

  it("preserves user content outside GNOSYS block", async () => {
    const filePath = path.join(tmpDir, "CLAUDE.md");
    const original = `# Important rules

Never delete production data.

<!-- GNOSYS:START -->
Old stuff
<!-- GNOSYS:END -->

Always review PRs.
`;
    await fs.writeFile(filePath, original, "utf-8");

    await injectRules(filePath, "Updated block");

    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toContain("Never delete production data.");
    expect(content).toContain("Always review PRs.");
    expect(content).toContain("Updated block");
  });

  it("appends GNOSYS block to existing file without one", async () => {
    const filePath = path.join(tmpDir, "CLAUDE.md");
    await fs.writeFile(filePath, "# Existing rules\n\nDo good things.\n", "utf-8");

    await injectRules(filePath, "Appended block");

    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toContain("# Existing rules");
    expect(content).toContain("Do good things.");
    expect(content).toContain("<!-- GNOSYS:START -->");
    expect(content).toContain("Appended block");
  });

  it("creates parent directories for new rules file", async () => {
    const filePath = path.join(tmpDir, ".cursor", "rules", "gnosys.mdc");
    await injectRules(filePath, "Cursor rules");

    const content = await fs.readFile(filePath, "utf-8");
    expect(content).toContain("Cursor rules");
  });
});

describe("syncRules (end-to-end)", () => {
  it("generates rules from preferences in DB", async () => {
    // Set some preferences
    setPreference(db, "commit-convention", "Use conventional commits");
    setPreference(db, "testing", "Always write tests first");

    const rulesFile = path.join(tmpDir, "CLAUDE.md");
    const result = await syncRules(db, tmpDir, "CLAUDE.md", null);

    expect(result).not.toBeNull();
    expect(result!.prefCount).toBe(2);
    expect(result!.created).toBe(true);

    const content = await fs.readFile(rulesFile, "utf-8");
    expect(content).toContain("conventional commits");
    expect(content).toContain("Always write tests first");
  });

  it("returns null when no agent rules target", async () => {
    const result = await syncRules(db, tmpDir, null, null);
    expect(result).toBeNull();
  });
});

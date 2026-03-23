/**
 * Phase 8b: Preferences + Rules Generation
 * Test Plan Reference: "Phase 8 Tests — 8b"
 *
 *   TC-8b.1: Add user preference memory (scope=user)
 *   TC-8b.2: gnosys sync generates rules file with GNOSYS:START/END block
 *   TC-8b.3: Preference appears in Cursor/Claude rules
 *   TC-8b.4: User edits outside block are preserved
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fsp from "fs/promises";
import path from "path";
import { GnosysDB } from "../lib/db.js";
import {
  setPreference,
  getPreference,
  getAllPreferences,
  deletePreference,
} from "../lib/preferences.js";
import {
  generateRulesBlock,
  injectRules,
  syncRules,
} from "../lib/rulesGen.js";
import {
  createTestEnv,
  cleanupTestEnv,
  TestEnv,
} from "./_helpers.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv("phase8b");
});

afterEach(async () => {
  await cleanupTestEnv(env);
});

describe("Phase 8b: Preferences + Rules Generation", () => {
  // ─── TC-8b.1: User preference as scope=user memory ──────────────────

  describe("TC-8b.1: User preference stored with scope=user", () => {
    it("setPreference creates a user-scoped memory", () => {
      setPreference(env.db, "commit-style", "Use conventional commits");

      const mem = env.db.getMemory("pref-commit-style");
      expect(mem).not.toBeNull();
      expect(mem!.scope).toBe("user");
      expect(mem!.project_id).toBeNull();
      expect(mem!.category).toBe("preferences");
    });

    it("getPreference retrieves the stored value", () => {
      setPreference(env.db, "editor", "VS Code with Vim mode");

      const pref = getPreference(env.db, "editor");
      expect(pref).not.toBeNull();
      expect(pref!.key).toBe("editor");
      expect(pref!.value).toBe("VS Code with Vim mode");
    });

    it("getAllPreferences returns all user preferences", () => {
      setPreference(env.db, "lang", "TypeScript");
      setPreference(env.db, "test-framework", "Vitest");
      setPreference(env.db, "formatter", "Prettier");

      const all = getAllPreferences(env.db);
      expect(all.length).toBe(3);
      expect(all.map((p) => p.key).sort()).toEqual([
        "formatter",
        "lang",
        "test-framework",
      ]);
    });

    it("deletePreference removes the memory", () => {
      setPreference(env.db, "temp", "temporary value");
      expect(getPreference(env.db, "temp")).not.toBeNull();

      const deleted = deletePreference(env.db, "temp");
      expect(deleted).toBe(true);
      expect(getPreference(env.db, "temp")).toBeNull();
    });

    it("updating a preference increments reinforcement_count", () => {
      setPreference(env.db, "style", "v1");
      setPreference(env.db, "style", "v2");

      const mem = env.db.getMemory("pref-style");
      expect(mem!.reinforcement_count).toBe(1);
      expect(mem!.content).toContain("v2");
    });

    it("preference tags are stored", () => {
      setPreference(env.db, "tagged-pref", "value", {
        tags: ["workflow", "git"],
      });

      const pref = getPreference(env.db, "tagged-pref");
      expect(pref!.tags).toEqual(["workflow", "git"]);
    });
  });

  // ─── TC-8b.2: Rules file with GNOSYS:START/END block ────────────────

  describe("TC-8b.2: gnosys sync generates GNOSYS:START/END block", () => {
    it("injectRules creates new file with markers", async () => {
      const rulesFile = path.join(env.tmpDir, "CLAUDE.md");
      await injectRules(rulesFile, "Generated rules content");

      const content = await fsp.readFile(rulesFile, "utf-8");
      expect(content).toContain("<!-- GNOSYS:START -->");
      expect(content).toContain("Generated rules content");
      expect(content).toContain("<!-- GNOSYS:END -->");
    });

    it("injectRules replaces existing GNOSYS block", async () => {
      const rulesFile = path.join(env.tmpDir, "CLAUDE.md");
      const original = `# My Custom Rules

Some custom instructions.

<!-- GNOSYS:START -->
Old generated content
<!-- GNOSYS:END -->

More custom instructions.
`;
      await fsp.writeFile(rulesFile, original, "utf-8");

      await injectRules(rulesFile, "New generated content");

      const content = await fsp.readFile(rulesFile, "utf-8");
      expect(content).toContain("New generated content");
      expect(content).not.toContain("Old generated content");
    });

    it("syncRules generates rules from DB preferences", async () => {
      setPreference(env.db, "code-style", "Functional TypeScript");
      setPreference(env.db, "testing", "Always test first");

      const result = await syncRules(env.db, env.tmpDir, "CLAUDE.md", null);
      expect(result).not.toBeNull();
      expect(result!.prefCount).toBe(2);
      expect(result!.created).toBe(true);

      const content = await fsp.readFile(
        path.join(env.tmpDir, "CLAUDE.md"),
        "utf-8"
      );
      expect(content).toContain("Functional TypeScript");
      expect(content).toContain("Always test first");
    });
  });

  // ─── TC-8b.3: Preferences appear in generated rules ──────────────────

  describe("TC-8b.3: Preferences appear in generated rules block", () => {
    it("generateRulesBlock includes preference values", () => {
      const prefs = [
        {
          key: "commit-convention",
          value: "Use conventional commits",
          title: "Commit Convention",
          tags: [],
          confidence: 0.95,
          created: "2026-01-01",
          modified: "2026-01-01",
        },
      ];

      const block = generateRulesBlock(prefs, []);
      expect(block).toContain("User preferences");
      expect(block).toContain("Commit Convention");
      expect(block).toContain("conventional commits");
    });

    it("generateRulesBlock includes project conventions", () => {
      const conventions = [
        {
          id: "deci-001",
          title: "Use PostgreSQL",
          category: "decisions",
          content: "# Use PostgreSQL\n\nWe chose PostgreSQL over MySQL",
          summary: null,
          tags: "[]",
          relevance: "",
          author: "human",
          authority: "declared",
          confidence: 0.9,
          reinforcement_count: 0,
          content_hash: "abc",
          status: "active",
          tier: "active",
          supersedes: null,
          superseded_by: null,
          last_reinforced: null,
          created: "2026-01-01",
          modified: "2026-01-01",
          embedding: null,
          source_path: null,
          project_id: "proj-1",
          scope: "project",
        },
      ];

      const block = generateRulesBlock([], conventions);
      expect(block).toContain("Project conventions");
      expect(block).toContain("Use PostgreSQL");
    });

    it("generateRulesBlock always includes base tool instructions", () => {
      const block = generateRulesBlock([], []);
      expect(block).toContain("Gnosys Memory System");
      expect(block).toContain("gnosys_discover");
    });
  });

  // ─── TC-8b.4: User edits outside block are preserved ─────────────────

  describe("TC-8b.4: User content outside GNOSYS block is preserved", () => {
    it("preserves content before GNOSYS block", async () => {
      const rulesFile = path.join(env.tmpDir, "CLAUDE.md");
      const original = `# Important Project Rules

Never delete production data.
Always review PRs before merge.

<!-- GNOSYS:START -->
Old stuff
<!-- GNOSYS:END -->
`;
      await fsp.writeFile(rulesFile, original, "utf-8");
      await injectRules(rulesFile, "Updated block content");

      const content = await fsp.readFile(rulesFile, "utf-8");
      expect(content).toContain("Never delete production data.");
      expect(content).toContain("Always review PRs before merge.");
      expect(content).toContain("Updated block content");
    });

    it("preserves content after GNOSYS block", async () => {
      const rulesFile = path.join(env.tmpDir, "CLAUDE.md");
      const original = `<!-- GNOSYS:START -->
Old stuff
<!-- GNOSYS:END -->

# Additional Rules

Custom rules that must be kept.
`;
      await fsp.writeFile(rulesFile, original, "utf-8");
      await injectRules(rulesFile, "Replaced content");

      const content = await fsp.readFile(rulesFile, "utf-8");
      expect(content).toContain("Custom rules that must be kept.");
      expect(content).toContain("Replaced content");
    });

    it("appends GNOSYS block to file without one", async () => {
      const rulesFile = path.join(env.tmpDir, "CLAUDE.md");
      await fsp.writeFile(
        rulesFile,
        "# Existing rules\n\nDo good things.\n",
        "utf-8"
      );

      await injectRules(rulesFile, "Appended block");

      const content = await fsp.readFile(rulesFile, "utf-8");
      expect(content).toContain("# Existing rules");
      expect(content).toContain("Do good things.");
      expect(content).toContain("<!-- GNOSYS:START -->");
      expect(content).toContain("Appended block");
    });

    it("creates parent directories for rules file", async () => {
      const rulesFile = path.join(
        env.tmpDir,
        ".cursor",
        "rules",
        "gnosys.mdc"
      );
      await injectRules(rulesFile, "Cursor rules content");

      const content = await fsp.readFile(rulesFile, "utf-8");
      expect(content).toContain("Cursor rules content");
    });
  });
});

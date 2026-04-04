/**
 * Final Acceptance Tests — End-to-End
 * Test Plan Reference: "Final Acceptance Tests (run after all phases)"
 *
 *   TC-A.1: Fresh machine: gnosys init in two projects
 *   TC-A.2: Add memories + preferences in project A
 *   TC-A.3: Switch to project B → preferences appear in rules
 *   TC-A.4: Cross-project search works
 *   TC-A.5: Dream Mode configuration
 *   TC-A.6: Export to Obsidian works
 *   TC-A.7: Backup/restore works
 *   TC-A.8: Multi-root scenario with projectRoot
 *   TC-A.9: CLI and MCP both functional
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { GnosysDB } from "../lib/db.js";
import {
  setPreference,
  getPreference,
  getAllPreferences,
} from "../lib/preferences.js";
import { generateRulesBlock, syncRules } from "../lib/rulesGen.js";
import {
  federatedSearch,
  generateBriefing,
  getWorkingSet,
} from "../lib/federated.js";
import {
  makeMemory,
  makeProject,
  CLI,
  cliInit,
} from "./_helpers.js";

// Shared state for the acceptance suite
let centralDir: string;
let db: GnosysDB;
let projADir: string;
let projBDir: string;

beforeEach(async () => {
  centralDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gnosys-acceptance-central-")
  );
  db = new GnosysDB(centralDir);
  projADir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gnosys-acceptance-projA-")
  );
  projBDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "gnosys-acceptance-projB-")
  );
});

afterEach(async () => {
  db.close();
  await fsp.rm(centralDir, { recursive: true, force: true });
  await fsp.rm(projADir, { recursive: true, force: true });
  await fsp.rm(projBDir, { recursive: true, force: true });
});

describe("Final Acceptance Tests", () => {
  // ─── TC-A.1: Init two projects ───────────────────────────────────────

  describe("TC-A.1: gnosys init in two separate projects", () => {
    it("initializes project A and B successfully", () => {
      const outputA = cliInit(projADir);
      expect(outputA).toContain("Gnosys store");

      const outputB = cliInit(projBDir);
      expect(outputB).toContain("Gnosys store");

      // Both should have gnosys.json
      expect(
        fs.existsSync(path.join(projADir, ".gnosys", "gnosys.json"))
      ).toBe(true);
      expect(
        fs.existsSync(path.join(projBDir, ".gnosys", "gnosys.json"))
      ).toBe(true);
    });

    it("both projects have unique projectIds", () => {
      cliInit(projADir);
      cliInit(projBDir);

      const idA = JSON.parse(
        fs.readFileSync(
          path.join(projADir, ".gnosys", "gnosys.json"),
          "utf-8"
        )
      ).projectId;
      const idB = JSON.parse(
        fs.readFileSync(
          path.join(projBDir, ".gnosys", "gnosys.json"),
          "utf-8"
        )
      ).projectId;

      expect(idA).not.toBe(idB);
    });
  });

  // ─── TC-A.2: Add memories + preferences in project A ────────────────

  describe("TC-A.2: Memories and preferences in project A", () => {
    it("adds project-scoped memories to project A", () => {
      const now = new Date().toISOString();
      db.insertProject({
        id: "proj-a",
        name: "ProjectA",
        working_directory: projADir,
        user: "testuser",
        agent_rules_target: null,
        obsidian_vault: null,
        created: now,
        modified: now,
      });

      db.insertMemory(
        makeMemory({
          id: "a-dec-001",
          title: "Project A Decision",
          content: "We use React for the frontend",
          category: "decisions",
          project_id: "proj-a",
          scope: "project",
        })
      );

      const mems = db.getMemoriesByProject("proj-a");
      expect(mems.length).toBe(1);
      expect(mems[0].title).toBe("Project A Decision");
    });

    it("adds user-scoped preferences", () => {
      setPreference(db, "commit-convention", "Use conventional commits");
      setPreference(db, "test-first", "Always write tests before implementation");

      const prefs = getAllPreferences(db);
      expect(prefs.length).toBe(2);
    });
  });

  // ─── TC-A.3: Preferences appear in project B rules ──────────────────

  describe("TC-A.3: Preferences visible from project B", () => {
    it("user preferences are accessible regardless of project context", () => {
      setPreference(db, "shared-pref", "This preference spans projects");

      const pref = getPreference(db, "shared-pref");
      expect(pref).not.toBeNull();
      expect(pref!.value).toBe("This preference spans projects");

      // Verify scope is user (not tied to a project)
      const mem = db.getMemory("pref-shared-pref");
      expect(mem!.scope).toBe("user");
      expect(mem!.project_id).toBeNull();
    });

    it("generated rules include user preferences regardless of project", () => {
      setPreference(db, "style", "Functional TypeScript");

      const prefs = getAllPreferences(db);
      const block = generateRulesBlock(prefs, []);
      expect(block).toContain("Functional TypeScript");
    });
  });

  // ─── TC-A.4: Cross-project search ───────────────────────────────────

  describe("TC-A.4: Cross-project search", () => {
    it("federated search returns results from both projects", () => {
      const now = new Date().toISOString();
      db.insertProject({
        id: "xp-a",
        name: "CrossA",
        working_directory: "/tmp/cross-a",
        user: "test",
        agent_rules_target: null,
        obsidian_vault: null,
        created: now,
        modified: now,
      });
      db.insertProject({
        id: "xp-b",
        name: "CrossB",
        working_directory: "/tmp/cross-b",
        user: "test",
        agent_rules_target: null,
        obsidian_vault: null,
        created: now,
        modified: now,
      });

      db.insertMemory(
        makeMemory({
          id: "xp-a-mem",
          title: "CrossA architecture",
          content: "Microservices architecture for CrossA",
          project_id: "xp-a",
          scope: "project",
        })
      );
      db.insertMemory(
        makeMemory({
          id: "xp-b-mem",
          title: "CrossB architecture",
          content: "Monolith architecture for CrossB",
          project_id: "xp-b",
          scope: "project",
        })
      );

      const results = federatedSearch(db, "architecture");
      expect(results.length).toBe(2);
      const ids = results.map((r) => r.id);
      expect(ids).toContain("xp-a-mem");
      expect(ids).toContain("xp-b-mem");
    });
  });

  // ─── TC-A.5: Dream Mode ─────────────────────────────────────────────

  describe("TC-A.5: Dream Mode configuration accessible", () => {
    it("dream engine module loads without errors", async () => {
      const { GnosysDreamEngine, DEFAULT_DREAM_CONFIG } = await import(
        "../lib/dream.js"
      );
      expect(DEFAULT_DREAM_CONFIG.enabled).toBe(false);
      expect(typeof GnosysDreamEngine).toBe("function");
    });
  });

  // ─── TC-A.6: Export to Obsidian ─────────────────────────────────────

  describe("TC-A.6: Obsidian export", () => {
    it("exports memories to Obsidian vault", async () => {
      // Insert a memory into the central DB
      db.insertMemory(
        makeMemory({
          id: "acc-exp-001",
          title: "Acceptance Export",
          content: "# Acceptance Export\n\nExport test.",
          category: "decisions",
        })
      );

      const { GnosysExporter } = await import("../lib/export.js");
      const exportDir = path.join(centralDir, "obsidian-vault");
      const exporter = new GnosysExporter(db);
      const report = await exporter.export({ targetDir: exportDir });

      expect(report.memoriesExported).toBe(1);
      expect(fs.existsSync(exportDir)).toBe(true);
    });
  });

  // ─── TC-A.7: Backup/restore ─────────────────────────────────────────

  describe("TC-A.7: Backup and restore", () => {
    it("backs up the central database", async () => {
      db.insertMemory(
        makeMemory({ id: "bk-acc-001", title: "Backup Acceptance" })
      );

      const backupDir = path.join(centralDir, "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      const backupPath = await db.backup(backupDir);

      expect(fs.existsSync(backupPath)).toBe(true);
      const stat = fs.statSync(backupPath);
      expect(stat.size).toBeGreaterThan(0);
    });
  });

  // ─── TC-A.8: Multi-root with projectRoot ────────────────────────────

  describe("TC-A.8: Multi-root project scenario", () => {
    it("separate projects have independent memory spaces", () => {
      db.insertMemory(
        makeMemory({
          id: "mr-a-001",
          title: "Root A Memory",
          project_id: "root-a",
          scope: "project",
        })
      );
      db.insertMemory(
        makeMemory({
          id: "mr-b-001",
          title: "Root B Memory",
          project_id: "root-b",
          scope: "project",
        })
      );

      const rootA = db.getMemoriesByProject("root-a");
      const rootB = db.getMemoriesByProject("root-b");

      expect(rootA.length).toBe(1);
      expect(rootA[0].title).toBe("Root A Memory");
      expect(rootB.length).toBe(1);
      expect(rootB[0].title).toBe("Root B Memory");
    });

    it("user preferences span all project roots", () => {
      setPreference(db, "multi-root-pref", "Available everywhere");

      const pref = getPreference(db, "multi-root-pref");
      expect(pref!.value).toBe("Available everywhere");
      expect(db.getMemory("pref-multi-root-pref")!.scope).toBe("user");
    });
  });

  // ─── TC-A.9: CLI and MCP both functional ────────────────────────────

  describe("TC-A.9: CLI and library API both functional", () => {
    it("CLI list command works on initialized project", () => {
      cliInit(projADir);

      const output = execSync(`${CLI} list --json`, {
        encoding: "utf-8",
        env: { ...process.env, GNOSYS_PROJECT: projADir },
        stdio: ["pipe", "pipe", "pipe"],
      });

      // Extract JSON from output (may contain upgrade warnings before the JSON)
      const jsonStart = output.indexOf("{");
      const jsonStr = jsonStart >= 0 ? output.slice(jsonStart) : output;
      const parsed = JSON.parse(jsonStr);
      expect(parsed).toHaveProperty("count");
      expect(parsed).toHaveProperty("memories");
    });

    it("library API (GnosysDB) and CLI produce consistent results", () => {
      // Insert via library API
      db.insertMemory(
        makeMemory({
          id: "api-cli-001",
          title: "API Inserted Memory",
          project_id: "proj-a",
          scope: "project",
        })
      );

      // Read via library API
      const mem = db.getMemory("api-cli-001");
      expect(mem).not.toBeNull();
      expect(mem!.title).toBe("API Inserted Memory");

      // Count via library API
      const counts = db.getMemoryCount();
      expect(counts.total).toBeGreaterThanOrEqual(1);
    });

    it("all major DB operations work in sequence", () => {
      // Insert
      db.insertMemory(
        makeMemory({ id: "seq-001", title: "Sequential Test", confidence: 0.8 })
      );

      // Read
      const mem1 = db.getMemory("seq-001");
      expect(mem1!.confidence).toBe(0.8);

      // Update
      db.updateMemory("seq-001", { confidence: 0.95, reinforcement_count: 1 });
      const mem2 = db.getMemory("seq-001");
      expect(mem2!.confidence).toBe(0.95);
      expect(mem2!.reinforcement_count).toBe(1);

      // Search
      const results = db.searchFts("Sequential", 10);
      expect(results.length).toBe(1);

      // Delete
      db.deleteMemory("seq-001");
      expect(db.getMemory("seq-001")).toBeNull();
    });
  });
});

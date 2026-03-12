/**
 * Phase 8d: Federated Search + Ambiguity Detection
 * Test Plan Reference: "Phase 8 Tests — 8d"
 *
 *   TC-8d.1: Search returns project > user > global with correct boosting
 *   TC-8d.2: Multi-project ambiguity error triggers correctly
 *   TC-8d.3: Dream Mode generates project briefings
 *   TC-8d.4: Cross-project search works
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GnosysDB } from "../lib/db.js";
import {
  federatedSearch,
  federatedDiscover,
  detectAmbiguity,
  generateBriefing,
  generateAllBriefings,
  getWorkingSet,
  formatWorkingSet,
} from "../lib/federated.js";
import {
  createTestEnv,
  cleanupTestEnv,
  makeMemory,
  makeProject,
  seedMultiProjectMemories,
  TestEnv,
} from "./_helpers.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv("phase8d");
});

afterEach(async () => {
  await cleanupTestEnv(env);
});

describe("Phase 8d: Federated Search + Ambiguity", () => {
  // ─── TC-8d.1: Scope-boosted search ──────────────────────────────────

  describe("TC-8d.1: Federated search with tier boosting", () => {
    it("project-scoped results rank higher than user-scoped", () => {
      env.db.insertMemory(
        makeMemory({
          id: "proj-arch",
          title: "Architecture patterns",
          content: "Architecture patterns for microservices design",
          scope: "project",
          project_id: "proj-1",
        })
      );
      env.db.insertMemory(
        makeMemory({
          id: "user-arch",
          title: "Architecture notes",
          content: "Architecture patterns I use across projects",
          scope: "user",
          project_id: null,
        })
      );

      const results = federatedSearch(env.db, "architecture", {
        projectId: "proj-1",
      });
      expect(results.length).toBe(2);

      const projResult = results.find((r) => r.id === "proj-arch");
      const userResult = results.find((r) => r.id === "user-arch");
      expect(projResult).toBeDefined();
      expect(userResult).toBeDefined();
      expect(projResult!.score).toBeGreaterThan(userResult!.score);
    });

    it("user-scoped results rank higher than global-scoped", () => {
      env.db.insertMemory(
        makeMemory({
          id: "user-db",
          title: "Database preferences",
          content: "I always prefer PostgreSQL databases",
          scope: "user",
          project_id: null,
        })
      );
      env.db.insertMemory(
        makeMemory({
          id: "global-db",
          title: "Database standards",
          content: "PostgreSQL databases are recommended org-wide",
          scope: "global",
          project_id: null,
        })
      );

      const results = federatedSearch(env.db, "PostgreSQL databases");
      expect(results.length).toBe(2);

      const userResult = results.find((r) => r.id === "user-db");
      const globalResult = results.find((r) => r.id === "global-db");
      expect(userResult!.score).toBeGreaterThan(globalResult!.score);
    });

    it("recently modified memories get a recency boost", () => {
      const oldDate = new Date(
        Date.now() - 48 * 60 * 60 * 1000
      ).toISOString();
      const newDate = new Date().toISOString();

      env.db.insertMemory(
        makeMemory({
          id: "old-api",
          title: "Old API decision",
          content: "API gateway design from last week",
          modified: oldDate,
          scope: "project",
          project_id: "proj-1",
        })
      );
      env.db.insertMemory(
        makeMemory({
          id: "new-api",
          title: "New API decision",
          content: "API gateway design just decided",
          modified: newDate,
          scope: "project",
          project_id: "proj-1",
        })
      );

      const results = federatedSearch(env.db, "API gateway", {
        projectId: "proj-1",
      });
      const newResult = results.find((r) => r.id === "new-api");
      expect(newResult).toBeDefined();
      expect(newResult!.boosts).toContain("recent");
    });

    it("reinforced memories get a reinforcement boost", () => {
      env.db.insertMemory(
        makeMemory({
          id: "reinforced-001",
          title: "Reinforced REST decision",
          content: "We chose REST over GraphQL for the API",
          reinforcement_count: 5,
          scope: "project",
          project_id: "proj-1",
        })
      );
      env.db.insertMemory(
        makeMemory({
          id: "unreinforced-001",
          title: "Unreinforced REST note",
          content: "We chose REST over GraphQL initially",
          reinforcement_count: 0,
          scope: "project",
          project_id: "proj-1",
        })
      );

      const results = federatedSearch(env.db, "REST GraphQL API", {
        projectId: "proj-1",
      });
      const reinforced = results.find((r) => r.id === "reinforced-001");
      expect(reinforced).toBeDefined();
      if (reinforced) {
        expect(
          reinforced.boosts.some((b) => b.startsWith("reinforced:"))
        ).toBe(true);
      }
    });

    it("respects includeGlobal=false", () => {
      env.db.insertMemory(
        makeMemory({
          id: "global-only",
          title: "Global design patterns",
          content: "Design patterns used globally",
          scope: "global",
        })
      );
      env.db.insertMemory(
        makeMemory({
          id: "proj-only",
          title: "Project design patterns",
          content: "Design patterns for this project",
          scope: "project",
          project_id: "proj-1",
        })
      );

      const results = federatedSearch(env.db, "design patterns", {
        includeGlobal: false,
      });
      expect(results.every((r) => r.scope !== "global")).toBe(true);
    });

    it("returns empty array for no matches", () => {
      const results = federatedSearch(env.db, "nonexistent query xyz");
      expect(results).toEqual([]);
    });
  });

  // ─── TC-8d.2: Ambiguity detection ───────────────────────────────────

  describe("TC-8d.2: Multi-project ambiguity detection", () => {
    it("returns null for single-project match", () => {
      const now = new Date().toISOString();
      env.db.insertProject({
        id: "p1",
        name: "Solo",
        working_directory: "/tmp/solo",
        user: "test",
        agent_rules_target: null,
        obsidian_vault: null,
        created: now,
        modified: now,
      });
      env.db.insertMemory(
        makeMemory({
          id: "solo-mem",
          title: "Solo config",
          content: "Configuration for the solo project",
          project_id: "p1",
        })
      );

      const result = detectAmbiguity(env.db, "configuration");
      expect(result).toBeNull();
    });

    it("detects ambiguity across multiple projects", () => {
      const now = new Date().toISOString();
      env.db.insertProject({
        id: "pa",
        name: "Alpha",
        working_directory: "/tmp/alpha",
        user: "test",
        agent_rules_target: null,
        obsidian_vault: null,
        created: now,
        modified: now,
      });
      env.db.insertProject({
        id: "pb",
        name: "Beta",
        working_directory: "/tmp/beta",
        user: "test",
        agent_rules_target: null,
        obsidian_vault: null,
        created: now,
        modified: now,
      });
      env.db.insertMemory(
        makeMemory({
          id: "alpha-deploy",
          title: "Deploy config",
          content: "Deployment configuration for alpha",
          project_id: "pa",
        })
      );
      env.db.insertMemory(
        makeMemory({
          id: "beta-deploy",
          title: "Deploy config",
          content: "Deployment configuration for beta",
          project_id: "pb",
        })
      );

      const result = detectAmbiguity(env.db, "deployment configuration");
      expect(result).not.toBeNull();
      expect(result!.type).toBe("ambiguous_project");
      expect(result!.candidates.length).toBe(2);
      expect(result!.candidates.map((c) => c.projectName).sort()).toEqual([
        "Alpha",
        "Beta",
      ]);
    });
  });

  // ─── TC-8d.3: Project briefings ──────────────────────────────────────

  describe("TC-8d.3: Project briefing generation", () => {
    it("generates a briefing with correct stats", () => {
      const now = new Date().toISOString();
      env.db.insertProject({
        id: "brief-proj",
        name: "BriefingProject",
        working_directory: "/tmp/briefing",
        user: "test",
        agent_rules_target: null,
        obsidian_vault: null,
        created: now,
        modified: now,
      });
      env.db.insertMemory(
        makeMemory({
          id: "b-001",
          title: "Decision A",
          category: "decisions",
          content: "We chose X",
          project_id: "brief-proj",
          tags: '["architecture"]',
        })
      );
      env.db.insertMemory(
        makeMemory({
          id: "b-002",
          title: "Requirement B",
          category: "requirements",
          content: "Must support Y",
          project_id: "brief-proj",
          tags: '["backend"]',
        })
      );

      const briefing = generateBriefing(env.db, "brief-proj");
      expect(briefing).not.toBeNull();
      expect(briefing!.projectName).toBe("BriefingProject");
      expect(briefing!.totalMemories).toBe(2);
      expect(briefing!.categories).toHaveProperty("decisions");
      expect(briefing!.categories).toHaveProperty("requirements");
      expect(briefing!.summary).toContain("BriefingProject");
    });

    it("returns null for non-existent project", () => {
      const briefing = generateBriefing(env.db, "nonexistent");
      expect(briefing).toBeNull();
    });

    it("generateAllBriefings covers all projects", () => {
      const now = new Date().toISOString();
      env.db.insertProject({
        id: "all-a",
        name: "AllA",
        working_directory: "/tmp/all-a",
        user: "test",
        agent_rules_target: null,
        obsidian_vault: null,
        created: now,
        modified: now,
      });
      env.db.insertProject({
        id: "all-b",
        name: "AllB",
        working_directory: "/tmp/all-b",
        user: "test",
        agent_rules_target: null,
        obsidian_vault: null,
        created: now,
        modified: now,
      });

      const briefings = generateAllBriefings(env.db);
      expect(briefings.length).toBe(2);
      expect(briefings.map((b) => b.projectName).sort()).toEqual([
        "AllA",
        "AllB",
      ]);
    });
  });

  // ─── TC-8d.4: Cross-project search ──────────────────────────────────

  describe("TC-8d.4: Cross-project search", () => {
    it("federatedSearch finds memories across projects", () => {
      env.db.insertMemory(
        makeMemory({
          id: "cross-a",
          title: "Alpha architecture",
          content: "Microservices architecture for Alpha",
          project_id: "proj-alpha",
          scope: "project",
        })
      );
      env.db.insertMemory(
        makeMemory({
          id: "cross-b",
          title: "Beta architecture",
          content: "Monolith architecture for Beta",
          project_id: "proj-beta",
          scope: "project",
        })
      );

      // Search without projectId — should find both
      const results = federatedSearch(env.db, "architecture");
      expect(results.length).toBe(2);
    });

    it("working set returns only recent project memories", () => {
      const now = new Date().toISOString();
      const oldDate = new Date(
        Date.now() - 48 * 60 * 60 * 1000
      ).toISOString();

      env.db.insertMemory(
        makeMemory({
          id: "ws-recent",
          title: "Just edited",
          modified: now,
          project_id: "ws-proj",
        })
      );
      env.db.insertMemory(
        makeMemory({
          id: "ws-old",
          title: "Old work",
          modified: oldDate,
          project_id: "ws-proj",
        })
      );

      const set = getWorkingSet(env.db, "ws-proj", { windowHours: 24 });
      expect(set.length).toBe(1);
      expect(set[0].id).toBe("ws-recent");
    });

    it("formatWorkingSet handles empty set", () => {
      const result = formatWorkingSet([]);
      expect(result).toContain("No recent activity");
    });

    it("formatWorkingSet includes memory details", () => {
      const mem = makeMemory({
        id: "fmt-001",
        title: "Formatted Memory",
        category: "decisions",
      });
      const result = formatWorkingSet([mem]);
      expect(result).toContain("Working set");
      expect(result).toContain("fmt-001");
      expect(result).toContain("Formatted Memory");
    });
  });
});

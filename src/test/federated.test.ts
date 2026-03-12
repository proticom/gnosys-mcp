/**
 * Federated Search Tests — Phase 8d
 *
 * Tests tier boosting, ambiguity detection, project briefings,
 * and implicit working set.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { GnosysDB, DbMemory } from "../lib/db.js";
import {
  federatedSearch,
  federatedDiscover,
  detectAmbiguity,
  generateBriefing,
  generateAllBriefings,
  getWorkingSet,
  formatWorkingSet,
} from "../lib/federated.js";

let tmpDir: string;
let db: GnosysDB;

function makeMemory(overrides: Partial<DbMemory>): DbMemory {
  const now = new Date().toISOString();
  return {
    id: overrides.id || `test-${Math.random().toString(36).slice(2, 8)}`,
    title: overrides.title || "Test Memory",
    category: overrides.category || "general",
    content: overrides.content || "Test content for search indexing.",
    summary: overrides.summary || null,
    tags: overrides.tags || '["test"]',
    relevance: overrides.relevance || "test general",
    author: overrides.author || "ai",
    authority: overrides.authority || "declared",
    confidence: overrides.confidence ?? 0.9,
    reinforcement_count: overrides.reinforcement_count ?? 0,
    content_hash: overrides.content_hash || "abc123",
    status: overrides.status || "active",
    tier: overrides.tier || "active",
    supersedes: overrides.supersedes || null,
    superseded_by: overrides.superseded_by || null,
    last_reinforced: overrides.last_reinforced || null,
    created: overrides.created || now,
    modified: overrides.modified || now,
    embedding: overrides.embedding || null,
    source_path: overrides.source_path || null,
    project_id: overrides.project_id ?? null,
    scope: overrides.scope || "project",
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-fed-test-"));
  db = new GnosysDB(tmpDir);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("federatedSearch", () => {
  it("returns results scored with scope boosting", () => {
    // Insert project-scoped and user-scoped memories with same content
    db.insertMemory(makeMemory({
      id: "proj-mem",
      title: "Architecture patterns",
      content: "Architecture patterns for microservices design",
      scope: "project",
      project_id: "proj-1",
    }));
    db.insertMemory(makeMemory({
      id: "user-mem",
      title: "Architecture notes",
      content: "Architecture patterns I use across projects",
      scope: "user",
      project_id: null,
    }));

    const results = federatedSearch(db, "architecture", { projectId: "proj-1" });

    expect(results.length).toBe(2);
    // Project-scoped result should rank higher due to boost
    const projResult = results.find((r) => r.id === "proj-mem");
    const userResult = results.find((r) => r.id === "user-mem");
    expect(projResult).toBeDefined();
    expect(userResult).toBeDefined();
    expect(projResult!.score).toBeGreaterThan(userResult!.score);
    expect(projResult!.boosts).toContain("current-project");
  });

  it("boosts recently modified memories", () => {
    const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // 2 days ago
    const newDate = new Date().toISOString();

    db.insertMemory(makeMemory({
      id: "old-mem",
      title: "Old architecture decision",
      content: "Architecture decision from last week",
      modified: oldDate,
      scope: "project",
      project_id: "proj-1",
    }));
    db.insertMemory(makeMemory({
      id: "new-mem",
      title: "New architecture decision",
      content: "Architecture decision just made",
      modified: newDate,
      scope: "project",
      project_id: "proj-1",
    }));

    const results = federatedSearch(db, "architecture", { projectId: "proj-1" });
    const newResult = results.find((r) => r.id === "new-mem");
    expect(newResult).toBeDefined();
    expect(newResult!.boosts).toContain("recent");
  });

  it("respects includeGlobal=false", () => {
    db.insertMemory(makeMemory({
      id: "global-mem",
      title: "Global design patterns",
      content: "Design patterns used globally across the org",
      scope: "global",
    }));
    db.insertMemory(makeMemory({
      id: "proj-mem",
      title: "Project design patterns",
      content: "Design patterns for this specific project",
      scope: "project",
      project_id: "proj-1",
    }));

    const results = federatedSearch(db, "design patterns", { includeGlobal: false });
    expect(results.every((r) => r.scope !== "global")).toBe(true);
  });

  it("returns empty array for no matches", () => {
    const results = federatedSearch(db, "nonexistent query xyz");
    expect(results).toEqual([]);
  });

  it("boosts reinforced memories", () => {
    db.insertMemory(makeMemory({
      id: "reinforced",
      title: "Reinforced API decision",
      content: "We chose REST over GraphQL for the API layer",
      reinforcement_count: 5,
      scope: "project",
      project_id: "proj-1",
    }));
    db.insertMemory(makeMemory({
      id: "unreinforced",
      title: "Unreinforced API note",
      content: "We chose REST over GraphQL for simplicity",
      reinforcement_count: 0,
      scope: "project",
      project_id: "proj-1",
    }));

    const results = federatedSearch(db, "REST GraphQL API", { projectId: "proj-1" });
    const reinforced = results.find((r) => r.id === "reinforced");
    expect(reinforced).toBeDefined();
    if (reinforced) {
      expect(reinforced.boosts.some((b) => b.startsWith("reinforced:"))).toBe(true);
    }
  });
});

describe("detectAmbiguity", () => {
  it("returns null when query matches only one project", () => {
    db.insertProject({
      id: "proj-1", name: "Alpha", working_directory: "/tmp/alpha",
      user: "test", agent_rules_target: null, obsidian_vault: null,
      created: new Date().toISOString(), modified: new Date().toISOString(),
    });
    db.insertMemory(makeMemory({
      id: "alpha-mem",
      title: "Alpha config",
      content: "Configuration for the alpha project",
      project_id: "proj-1",
    }));

    const result = detectAmbiguity(db, "configuration");
    expect(result).toBeNull();
  });

  it("returns ambiguity error when query matches multiple projects", () => {
    const now = new Date().toISOString();
    db.insertProject({
      id: "proj-1", name: "Alpha", working_directory: "/tmp/alpha",
      user: "test", agent_rules_target: null, obsidian_vault: null,
      created: now, modified: now,
    });
    db.insertProject({
      id: "proj-2", name: "Beta", working_directory: "/tmp/beta",
      user: "test", agent_rules_target: null, obsidian_vault: null,
      created: now, modified: now,
    });
    db.insertMemory(makeMemory({
      id: "alpha-deploy",
      title: "Deploy config",
      content: "Deployment configuration for alpha production",
      project_id: "proj-1",
    }));
    db.insertMemory(makeMemory({
      id: "beta-deploy",
      title: "Deploy config",
      content: "Deployment configuration for beta staging",
      project_id: "proj-2",
    }));

    const result = detectAmbiguity(db, "deployment configuration");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("ambiguous_project");
    expect(result!.candidates.length).toBe(2);
    expect(result!.candidates.map((c) => c.projectName).sort()).toEqual(["Alpha", "Beta"]);
  });
});

describe("generateBriefing", () => {
  it("generates a briefing for a project with memories", () => {
    const now = new Date().toISOString();
    db.insertProject({
      id: "proj-1", name: "TestProject", working_directory: "/tmp/test",
      user: "test", agent_rules_target: null, obsidian_vault: null,
      created: now, modified: now,
    });
    db.insertMemory(makeMemory({
      id: "mem-1", title: "Decision A", category: "decisions",
      content: "We chose X", project_id: "proj-1",
      tags: '["architecture", "backend"]',
    }));
    db.insertMemory(makeMemory({
      id: "mem-2", title: "Requirement B", category: "requirements",
      content: "Must support Y", project_id: "proj-1",
      tags: '["backend", "api"]',
    }));
    db.insertMemory(makeMemory({
      id: "mem-3", title: "Concept C", category: "concepts",
      content: "What is Z", project_id: "proj-1",
      tags: '["architecture"]',
    }));

    const briefing = generateBriefing(db, "proj-1");
    expect(briefing).not.toBeNull();
    expect(briefing!.projectName).toBe("TestProject");
    expect(briefing!.totalMemories).toBe(3);
    expect(briefing!.activeMemories).toBe(3);
    expect(briefing!.categories).toHaveProperty("decisions");
    expect(briefing!.categories).toHaveProperty("requirements");
    expect(briefing!.categories).toHaveProperty("concepts");
    expect(briefing!.topTags.length).toBeGreaterThan(0);
    // "architecture" appears in 2 memories, "backend" in 2
    const archTag = briefing!.topTags.find((t) => t.tag === "architecture");
    expect(archTag).toBeDefined();
    expect(archTag!.count).toBe(2);
    expect(briefing!.summary).toContain("TestProject");
  });

  it("returns null for non-existent project", () => {
    const briefing = generateBriefing(db, "nonexistent");
    expect(briefing).toBeNull();
  });
});

describe("generateAllBriefings", () => {
  it("generates briefings for all registered projects", () => {
    const now = new Date().toISOString();
    db.insertProject({
      id: "p1", name: "Alpha", working_directory: "/tmp/alpha",
      user: "test", agent_rules_target: null, obsidian_vault: null,
      created: now, modified: now,
    });
    db.insertProject({
      id: "p2", name: "Beta", working_directory: "/tmp/beta",
      user: "test", agent_rules_target: null, obsidian_vault: null,
      created: now, modified: now,
    });

    const briefings = generateAllBriefings(db);
    expect(briefings.length).toBe(2);
    expect(briefings.map((b) => b.projectName).sort()).toEqual(["Alpha", "Beta"]);
  });
});

describe("getWorkingSet", () => {
  it("returns recently modified memories for a project", () => {
    const now = new Date().toISOString();
    const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    db.insertMemory(makeMemory({
      id: "recent-mem",
      title: "Just edited",
      content: "Recent work",
      modified: now,
      project_id: "proj-1",
    }));
    db.insertMemory(makeMemory({
      id: "old-mem",
      title: "Old work",
      content: "From days ago",
      modified: oldDate,
      project_id: "proj-1",
    }));

    const set = getWorkingSet(db, "proj-1", { windowHours: 24 });
    expect(set.length).toBe(1);
    expect(set[0].id).toBe("recent-mem");
  });

  it("returns empty set for no recent activity", () => {
    const oldDate = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    db.insertMemory(makeMemory({
      id: "old-mem",
      title: "Old work",
      modified: oldDate,
      project_id: "proj-1",
    }));

    const set = getWorkingSet(db, "proj-1", { windowHours: 24 });
    expect(set.length).toBe(0);
  });
});

describe("formatWorkingSet", () => {
  it("formats empty working set", () => {
    const result = formatWorkingSet([]);
    expect(result).toContain("No recent activity");
  });

  it("formats non-empty working set", () => {
    const mem = makeMemory({
      id: "ws-mem",
      title: "Active memory",
      category: "decisions",
    });
    const result = formatWorkingSet([mem]);
    expect(result).toContain("Working set");
    expect(result).toContain("ws-mem");
    expect(result).toContain("Active memory");
    expect(result).toContain("decisions");
  });
});

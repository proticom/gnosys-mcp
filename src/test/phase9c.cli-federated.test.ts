/**
 * Phase 9c Tests — CLI Parity + Federated Search
 *
 * TC-9c.1: Federated search ranking with tier boosting
 * TC-9c.2: Scope filtering in federated search
 * TC-9c.3: Federated discover with scope filter
 * TC-9c.4: Recency boosting in federated search
 * TC-9c.5: CLI --json output includes scope info
 * TC-9c.6: CLI parity — all major commands functional
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "child_process";
import path from "path";
import fs from "fs";
import os from "os";
import {
  createTestEnv,
  cleanupTestEnv,
  TestEnv,
  makeMemory,
  makeProject,
  CLI,
  cliInit,
  cli,
  cliJson,
} from "./_helpers.js";
import { GnosysDB, MemoryScope } from "../lib/db.js";
import {
  federatedSearch,
  federatedDiscover,
  FederatedResult,
  FederatedSearchOptions,
} from "../lib/federated.js";

// ─── TC-9c.1: Federated search ranking with tier boosting ──────────────

describe("TC-9c.1: Federated search ranking with tier boosting", () => {
  let env: TestEnv;
  const projA = makeProject({ id: "proj-alpha", name: "Alpha", working_directory: "/tmp/alpha" });

  beforeEach(async () => {
    env = await createTestEnv("9c-ranking");
    env.db.insertProject(projA);

    // Project-scoped memory (highest boost: 1.5x * 1.2 = 1.8x for current project)
    env.db.insertMemory(makeMemory({
      id: "mem-proj",
      title: "Authentication architecture decisions",
      content: "We use JWT tokens for authentication with refresh token rotation.",
      scope: "project",
      project_id: "proj-alpha",
      relevance: "auth authentication jwt tokens",
      confidence: 0.9,
    }));

    // User-scoped memory (1.0x boost)
    env.db.insertMemory(makeMemory({
      id: "mem-user",
      title: "Authentication preferences",
      content: "User prefers OAuth2 with PKCE for all new projects.",
      scope: "user",
      project_id: null,
      relevance: "auth authentication oauth preferences",
      confidence: 0.9,
    }));

    // Global-scoped memory (0.7x boost)
    env.db.insertMemory(makeMemory({
      id: "mem-global",
      title: "Authentication best practices",
      content: "Global best practices for authentication include MFA, password hashing with bcrypt.",
      scope: "global",
      project_id: null,
      relevance: "auth authentication security best practices",
      confidence: 0.9,
    }));
  });

  afterEach(async () => await cleanupTestEnv(env));

  it("project-scoped memories rank higher than user and global", () => {
    const results = federatedSearch(env.db, "authentication", {
      projectId: "proj-alpha",
      limit: 10,
    });

    expect(results.length).toBe(3);
    // Project should be first (highest boost)
    expect(results[0].scope).toBe("project");
    expect(results[0].id).toBe("mem-proj");
    // User second
    expect(results[1].scope).toBe("user");
    // Global last
    expect(results[2].scope).toBe("global");
  });

  it("results include scope and boost information", () => {
    const results = federatedSearch(env.db, "authentication", {
      projectId: "proj-alpha",
    });

    for (const r of results) {
      expect(r.scope).toBeDefined();
      expect(["project", "user", "global"]).toContain(r.scope);
      expect(r.boosts).toBeDefined();
      expect(r.boosts.length).toBeGreaterThan(0);
      expect(r.score).toBeGreaterThan(0);
    }

    // Project result should have current-project boost
    const projResult = results.find(r => r.id === "mem-proj");
    expect(projResult?.boosts).toContain("current-project");
  });

  it("without projectId context, project memories still rank by scope boost", () => {
    const results = federatedSearch(env.db, "authentication", {
      projectId: null,
      limit: 10,
    });

    expect(results.length).toBe(3);
    // Without current-project boost, project still gets 1.5x > user 1.0x > global 0.7x
    expect(results[0].scope).toBe("project");
    expect(results[1].scope).toBe("user");
    expect(results[2].scope).toBe("global");
  });
});

// ─── TC-9c.2: Scope filtering in federated search ─────────────────────

describe("TC-9c.2: Scope filtering in federated search", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv("9c-scope-filter");

    env.db.insertMemory(makeMemory({
      id: "mem-p1",
      title: "Project deployment config",
      content: "Deploy to AWS ECS with Fargate.",
      scope: "project",
      relevance: "deploy deployment aws",
    }));

    env.db.insertMemory(makeMemory({
      id: "mem-u1",
      title: "User deployment preferences",
      content: "Prefer Kubernetes over ECS for new projects.",
      scope: "user",
      relevance: "deploy deployment kubernetes preferences",
    }));

    env.db.insertMemory(makeMemory({
      id: "mem-g1",
      title: "Global deployment standards",
      content: "All deployments must include health checks and rollback.",
      scope: "global",
      relevance: "deploy deployment standards health",
    }));
  });

  afterEach(async () => await cleanupTestEnv(env));

  it("scopeFilter restricts results to specified scope", () => {
    const results = federatedSearch(env.db, "deployment", {
      scopeFilter: ["user"],
    });

    expect(results.length).toBe(1);
    expect(results[0].scope).toBe("user");
    expect(results[0].id).toBe("mem-u1");
  });

  it("scopeFilter with multiple scopes returns matching results", () => {
    const results = federatedSearch(env.db, "deployment", {
      scopeFilter: ["project", "global"],
    });

    expect(results.length).toBe(2);
    const scopes = results.map(r => r.scope);
    expect(scopes).toContain("project");
    expect(scopes).toContain("global");
    expect(scopes).not.toContain("user");
  });

  it("scopeFilter with empty array returns all results", () => {
    const results = federatedSearch(env.db, "deployment", {
      scopeFilter: [],
    });

    // Empty scopeFilter means no filter — all scopes included
    expect(results.length).toBe(3);
  });

  it("includeGlobal=false excludes global when no scopeFilter", () => {
    const results = federatedSearch(env.db, "deployment", {
      includeGlobal: false,
    });

    const scopes = results.map(r => r.scope);
    expect(scopes).not.toContain("global");
    expect(results.length).toBe(2);
  });

  it("scopeFilter takes precedence over includeGlobal", () => {
    // scopeFilter includes global, includeGlobal=false
    const results = federatedSearch(env.db, "deployment", {
      scopeFilter: ["global"],
      includeGlobal: false, // should be ignored when scopeFilter is set
    });

    expect(results.length).toBe(1);
    expect(results[0].scope).toBe("global");
  });
});

// ─── TC-9c.3: Federated discover with scope filter ────────────────────

describe("TC-9c.3: Federated discover with scope filter", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv("9c-discover");

    env.db.insertMemory(makeMemory({
      id: "disc-p1",
      title: "Project API design",
      content: "RESTful API with versioned endpoints.",
      scope: "project",
      relevance: "api design rest endpoints",
    }));

    env.db.insertMemory(makeMemory({
      id: "disc-u1",
      title: "User API preferences",
      content: "Prefer GraphQL for complex queries.",
      scope: "user",
      relevance: "api graphql preferences query",
    }));
  });

  afterEach(async () => await cleanupTestEnv(env));

  it("federatedDiscover returns results with scope info", () => {
    const results = federatedDiscover(env.db, "api", { limit: 10 });

    expect(results.length).toBe(2);
    for (const r of results) {
      expect(r.scope).toBeDefined();
      expect(r.score).toBeGreaterThan(0);
    }
  });

  it("federatedDiscover respects scopeFilter", () => {
    const results = federatedDiscover(env.db, "api", {
      scopeFilter: ["user"],
    });

    expect(results.length).toBe(1);
    expect(results[0].scope).toBe("user");
  });
});

// ─── TC-9c.4: Recency boosting in federated search ────────────────────

describe("TC-9c.4: Recency boosting in federated search", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv("9c-recency");

    // Recent memory (modified just now)
    env.db.insertMemory(makeMemory({
      id: "recent-mem",
      title: "Recent caching strategy",
      content: "We switched to Redis for caching layer.",
      scope: "project",
      relevance: "cache caching redis strategy",
      modified: new Date().toISOString(),
      confidence: 0.8,
    }));

    // Old memory (modified 30 days ago)
    const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    env.db.insertMemory(makeMemory({
      id: "old-mem",
      title: "Old caching approach",
      content: "Originally used Memcached for caching.",
      scope: "project",
      relevance: "cache caching memcached approach",
      modified: oldDate,
      confidence: 0.9, // higher confidence, but older
    }));
  });

  afterEach(async () => await cleanupTestEnv(env));

  it("recent memories get recency boost", () => {
    const results = federatedSearch(env.db, "caching", { limit: 10 });

    expect(results.length).toBe(2);

    const recent = results.find(r => r.id === "recent-mem");
    const old = results.find(r => r.id === "old-mem");

    expect(recent).toBeDefined();
    expect(old).toBeDefined();

    // Recent should have "recent" boost
    expect(recent!.boosts).toContain("recent");
    // Old should NOT have "recent" boost
    expect(old!.boosts).not.toContain("recent");
  });
});

// ─── TC-9c.5: CLI --json output includes scope info ───────────────────

describe("TC-9c.5: CLI --json output includes scope info", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-9c-cli-"));
    cliInit(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("gnosys list --json produces valid JSON", () => {
    const output = cli("list", tmpDir, { json: true });
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty("count");
    expect(Array.isArray(parsed.memories)).toBe(true);
  });

  it("gnosys search --json produces valid JSON with results array", () => {
    // Add a memory first
    try {
      execSync(
        `${CLI} add-structured --title "Test search target" --content "Searchable content about databases" --category general`,
        { encoding: "utf-8", env: { ...process.env, GNOSYS_PROJECT: tmpDir }, stdio: ["pipe", "pipe", "pipe"] }
      );
    } catch { /* may fail without LLM, but add-structured should work */ }

    const output = cli("search databases", tmpDir, { json: true });
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty("query", "databases");
    expect(parsed).toHaveProperty("results");
  });

  it("gnosys stats --json produces valid JSON", () => {
    const output = cli("stats", tmpDir, { json: true });
    const parsed = JSON.parse(output);
    expect(typeof parsed.totalCount).toBe("number");
  });

  it("gnosys dashboard --json produces valid JSON", () => {
    const output = cli("dashboard --json", tmpDir);
    const parsed = JSON.parse(output);
    expect(parsed).toBeDefined();
  });
});

// ─── TC-9c.6: CLI parity — all major commands functional ──────────────

describe("TC-9c.6: CLI parity — all major commands functional", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-9c-parity-"));
    cliInit(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("gnosys --help lists all commands", () => {
    const output = execSync(`${CLI} --help`, { encoding: "utf-8" });
    // Check for key commands
    expect(output).toContain("search");
    expect(output).toContain("discover");
    expect(output).toContain("recall");
    expect(output).toContain("ask");
    expect(output).toContain("fsearch");
    expect(output).toContain("hybrid-search");
    expect(output).toContain("list");
    expect(output).toContain("add");
    expect(output).toContain("update");
    expect(output).toContain("reinforce");
    expect(output).toContain("sync");
    expect(output).toContain("dashboard");
    expect(output).toContain("audit");
    expect(output).toContain("sandbox");
  });

  it("gnosys search --help shows --federated and --scope flags", () => {
    const output = execSync(`${CLI} search --help`, { encoding: "utf-8" });
    expect(output).toContain("--federated");
    expect(output).toContain("--scope");
  });

  it("gnosys discover --help shows --federated and --scope flags", () => {
    const output = execSync(`${CLI} discover --help`, { encoding: "utf-8" });
    expect(output).toContain("--federated");
    expect(output).toContain("--scope");
  });

  it("gnosys recall --help shows --federated and --scope flags", () => {
    const output = execSync(`${CLI} recall --help`, { encoding: "utf-8" });
    expect(output).toContain("--federated");
    expect(output).toContain("--scope");
  });

  it("gnosys hybrid-search --help shows --federated, --scope, and --json flags", () => {
    const output = execSync(`${CLI} hybrid-search --help`, { encoding: "utf-8" });
    expect(output).toContain("--federated");
    expect(output).toContain("--scope");
    expect(output).toContain("--json");
  });

  it("gnosys ask --help shows --federated and --scope flags", () => {
    const output = execSync(`${CLI} ask --help`, { encoding: "utf-8" });
    expect(output).toContain("--federated");
    expect(output).toContain("--scope");
  });

  it("gnosys fsearch --help shows --scope flag", () => {
    const output = execSync(`${CLI} fsearch --help`, { encoding: "utf-8" });
    expect(output).toContain("--scope");
  });

  it("gnosys add-structured --help shows --user and --global flags", () => {
    const output = execSync(`${CLI} add-structured --help`, { encoding: "utf-8" });
    expect(output).toContain("--user");
    expect(output).toContain("--global");
  });

  it("gnosys audit --json outputs valid JSON", () => {
    const output = cli("audit --json", tmpDir);
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty("entries");
  });

  it("gnosys tags lists the tag registry without error", () => {
    const output = execSync(`${CLI} tags`, {
      encoding: "utf-8",
      env: { ...process.env, GNOSYS_PROJECT: tmpDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Tags command produces text output (no --json support)
    expect(typeof output).toBe("string");
  });

  it("gnosys lens runs without error", () => {
    const output = execSync(`${CLI} lens`, {
      encoding: "utf-8",
      env: { ...process.env, GNOSYS_PROJECT: tmpDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    expect(typeof output).toBe("string");
  });
});

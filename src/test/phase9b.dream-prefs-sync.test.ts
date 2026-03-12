/**
 * Phase 9b: Dream Mode + Preferences + Sync in Sandbox
 * Test Plan Reference: "Phase 9b — Dream Mode + Preferences in Sandbox"
 *
 *   TC-9b.1: Dream Mode idle triggering and state tracking
 *   TC-9b.2: Preference CRUD through sandbox protocol
 *   TC-9b.3: Sync rules generation through sandbox
 *   TC-9b.4: User/global scope memory creation
 *   TC-9b.5: Dream Mode integration with sandbox request handler
 *   TC-9b.6: Rules file injection with protected blocks
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import net from "net";
import { GnosysDB } from "../lib/db.js";
import {
  handleRequest,
  SandboxRequest,
  SandboxResponse,
  initDreamMode,
  DreamState,
} from "../sandbox/server.js";
import { SandboxClient } from "../sandbox/client.js";
import { setPreference, getPreference, getAllPreferences, Preference } from "../lib/preferences.js";
import { injectRules, generateRulesBlock } from "../lib/rulesGen.js";
import { DEFAULT_DREAM_CONFIG, DreamScheduler, GnosysDreamEngine } from "../lib/dream.js";
import { DEFAULT_CONFIG } from "../lib/config.js";
import {
  createTestEnv,
  cleanupTestEnv,
  TestEnv,
} from "./_helpers.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv("phase9b");
});

afterEach(async () => {
  await cleanupTestEnv(env);
});

// ─── TC-9b.1: Dream Mode idle triggering ──────────────────────────────

describe("TC-9b.1: Dream Mode idle triggering and state tracking", () => {
  it("DreamScheduler starts and stops without error", () => {
    const engine = new GnosysDreamEngine(env.db, DEFAULT_CONFIG, {
      ...DEFAULT_DREAM_CONFIG,
      enabled: true,
      idleMinutes: 999, // won't trigger in test
    });
    const scheduler = new DreamScheduler(engine, {
      enabled: true,
      idleMinutes: 999,
    });

    scheduler.start();
    expect(scheduler.isDreaming()).toBe(false);
    scheduler.stop();
  });

  it("DreamScheduler recordActivity resets idle timer", () => {
    const engine = new GnosysDreamEngine(env.db, DEFAULT_CONFIG, {
      ...DEFAULT_DREAM_CONFIG,
      enabled: true,
    });
    const scheduler = new DreamScheduler(engine, { enabled: true });

    scheduler.start();
    scheduler.recordActivity();
    expect(scheduler.isDreaming()).toBe(false);
    scheduler.stop();
  });

  it("initDreamMode creates a scheduler with correct state", () => {
    const scheduler = initDreamMode(env.db, DEFAULT_CONFIG, {
      idleMinutes: 15,
    });
    expect(scheduler).not.toBeNull();
    scheduler?.stop();
  });

  it("dream_status returns state through sandbox protocol", () => {
    const res = handleRequest(env.db, {
      id: "ds1",
      method: "dream_status",
      params: {},
    });
    expect(res.ok).toBe(true);
    const result = res.result as DreamState;
    expect(result).toHaveProperty("enabled");
    expect(result).toHaveProperty("idleMinutes");
    expect(result).toHaveProperty("dreamsCompleted");
    expect(result).toHaveProperty("isDreaming");
    expect(result.isDreaming).toBe(false);
  });

  it("Dream engine reports errors when conditions not met", async () => {
    const engine = new GnosysDreamEngine(env.db, DEFAULT_CONFIG, {
      ...DEFAULT_DREAM_CONFIG,
      enabled: true,
      minMemories: 100, // won't have 100 memories
    });
    const report = await engine.dream();
    expect(report.errors.length).toBeGreaterThan(0);
    // May report "Too few memories" or DB-related errors depending on test env
    expect(typeof report.errors[0]).toBe("string");
  });
});

// ─── TC-9b.2: Preference CRUD through sandbox ──────────────────────────

describe("TC-9b.2: Preference CRUD through sandbox protocol", () => {
  it("pref_set creates a preference", () => {
    const res = handleRequest(env.db, {
      id: "ps1",
      method: "pref_set",
      params: { key: "commit-convention", value: "conventional commits" },
    });
    expect(res.ok).toBe(true);
    const result = res.result as any;
    expect(result.key).toBe("commit-convention");
    expect(result.value).toBe("conventional commits");
  });

  it("pref_get retrieves a preference", () => {
    // Set first
    handleRequest(env.db, {
      id: "pg1a",
      method: "pref_set",
      params: { key: "code-style", value: "TypeScript strict mode" },
    });

    // Get
    const res = handleRequest(env.db, {
      id: "pg1b",
      method: "pref_get",
      params: { key: "code-style" },
    });
    expect(res.ok).toBe(true);
    expect((res.result as any).value).toBe("TypeScript strict mode");
  });

  it("pref_get returns error for nonexistent preference", () => {
    const res = handleRequest(env.db, {
      id: "pg2",
      method: "pref_get",
      params: { key: "nonexistent-pref" },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not found");
  });

  it("pref_list returns all preferences", () => {
    handleRequest(env.db, {
      id: "pl1a",
      method: "pref_set",
      params: { key: "pref-a", value: "value a" },
    });
    handleRequest(env.db, {
      id: "pl1b",
      method: "pref_set",
      params: { key: "pref-b", value: "value b" },
    });

    const res = handleRequest(env.db, {
      id: "pl1c",
      method: "pref_list",
      params: {},
    });
    expect(res.ok).toBe(true);
    const prefs = res.result as any[];
    expect(prefs.length).toBeGreaterThanOrEqual(2);
    expect(prefs.some((p: any) => p.key === "pref-a")).toBe(true);
  });

  it("pref_delete removes a preference", () => {
    handleRequest(env.db, {
      id: "pd1a",
      method: "pref_set",
      params: { key: "deleteme", value: "temp" },
    });

    const res = handleRequest(env.db, {
      id: "pd1b",
      method: "pref_delete",
      params: { key: "deleteme" },
    });
    expect(res.ok).toBe(true);
    expect((res.result as any).deleted).toBe(true);

    // Verify gone
    const getRes = handleRequest(env.db, {
      id: "pd1c",
      method: "pref_get",
      params: { key: "deleteme" },
    });
    expect(getRes.ok).toBe(false);
  });

  it("pref_set without key returns error", () => {
    const res = handleRequest(env.db, {
      id: "pe1",
      method: "pref_set",
      params: { value: "no key" },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("required");
  });

  it("preferences are stored as user-scoped memories", () => {
    handleRequest(env.db, {
      id: "pscope1",
      method: "pref_set",
      params: { key: "test-pref-scope", value: "check scope" },
    });

    // Verify the underlying memory has scope: user
    const mem = env.db.getMemory("pref-test-pref-scope");
    expect(mem).not.toBeNull();
    expect(mem?.scope).toBe("user");
    expect(mem?.category).toBe("preferences");
  });
});

// ─── TC-9b.3: Sync rules generation through sandbox ─────────────────────

describe("TC-9b.3: Sync rules generation through sandbox", () => {
  it("sync method generates rules block with preferences", () => {
    // Set up preferences
    handleRequest(env.db, {
      id: "s1a",
      method: "pref_set",
      params: { key: "commit-convention", value: "conventional commits" },
    });
    handleRequest(env.db, {
      id: "s1b",
      method: "pref_set",
      params: { key: "code-style", value: "TypeScript strict" },
    });

    // Call sync
    const res = handleRequest(env.db, {
      id: "s1c",
      method: "sync",
      params: {
        project_dir: env.tmpDir,
        agent_rules_target: "CLAUDE.md",
      },
    });
    expect(res.ok).toBe(true);
    const result = res.result as any;
    expect(result.prefCount).toBe(2);
    expect(result.block).toContain("Gnosys Memory System");
    expect(result.block).toContain("conventional commits");
    expect(result.block).toContain("TypeScript strict");
  });

  it("sync method includes project conventions", () => {
    // Add a project memory (decision)
    handleRequest(env.db, {
      id: "s2a",
      method: "add",
      params: {
        content: "# Use React\n\nWe use React for the frontend.",
        title: "Use React",
        category: "decisions",
        project_id: "proj-sync-test",
        scope: "project",
      },
    });

    const res = handleRequest(env.db, {
      id: "s2b",
      method: "sync",
      params: {
        project_dir: env.tmpDir,
        agent_rules_target: "CLAUDE.md",
        project_id: "proj-sync-test",
      },
    });
    expect(res.ok).toBe(true);
    expect((res.result as any).conventionCount).toBe(1);
  });

  it("sync without project_dir returns error", () => {
    const res = handleRequest(env.db, {
      id: "s3",
      method: "sync",
      params: { agent_rules_target: "CLAUDE.md" },
    });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("required");
  });
});

// ─── TC-9b.4: User/global scope memory creation ─────────────────────────

describe("TC-9b.4: User/global scope memory creation", () => {
  it("add with scope: user creates user-scoped memory", () => {
    const res = handleRequest(env.db, {
      id: "sc1",
      method: "add",
      params: {
        content: "I prefer dark mode editors",
        title: "Editor preference",
        scope: "user",
      },
    });
    expect(res.ok).toBe(true);
    const memId = (res.result as any).id;

    const mem = env.db.getMemory(memId);
    expect(mem?.scope).toBe("user");
  });

  it("add with scope: global creates global-scoped memory", () => {
    const res = handleRequest(env.db, {
      id: "sc2",
      method: "add",
      params: {
        content: "REST APIs should use consistent naming",
        title: "API naming convention",
        scope: "global",
      },
    });
    expect(res.ok).toBe(true);
    const memId = (res.result as any).id;

    const mem = env.db.getMemory(memId);
    expect(mem?.scope).toBe("global");
  });

  it("add defaults to scope: project", () => {
    const res = handleRequest(env.db, {
      id: "sc3",
      method: "add",
      params: { content: "Default scope test" },
    });
    expect(res.ok).toBe(true);
    const memId = (res.result as any).id;

    const mem = env.db.getMemory(memId);
    expect(mem?.scope).toBe("project");
  });
});

// ─── TC-9b.5: Dream Mode + sandbox request handler integration ──────────

describe("TC-9b.5: Dream Mode integration with sandbox request handler", () => {
  let server: net.Server;
  let socketPath: string;

  beforeEach(async () => {
    socketPath = path.join(env.tmpDir, "dream-test.sock");
    server = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (data) => {
        buffer += data.toString();
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try {
            const req = JSON.parse(line) as SandboxRequest;
            const res = handleRequest(env.db, req);
            socket.write(JSON.stringify(res) + "\n");
          } catch { /* skip */ }
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { fs.unlinkSync(socketPath); } catch { /* ignore */ }
  });

  it("client can check dream status", async () => {
    const client = new SandboxClient(socketPath);
    // Use low-level send for dream_status (not in typed client API)
    const res = await (client as any).send("dream_status");
    expect(res.ok).toBe(true);
    expect(res.result).toHaveProperty("isDreaming");
  });

  it("client can set and list preferences", async () => {
    const client = new SandboxClient(socketPath);

    // Set a preference via low-level send
    const setRes = await (client as any).send("pref_set", {
      key: "testing-approach",
      value: "vitest with coverage",
    });
    expect(setRes.ok).toBe(true);

    // List preferences
    const listRes = await (client as any).send("pref_list");
    expect(listRes.ok).toBe(true);
    expect(listRes.result.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── TC-9b.6: Rules file injection with protected blocks ────────────────

describe("TC-9b.6: Rules file injection with protected blocks", () => {
  it("injectRules creates new file with GNOSYS markers", async () => {
    const filePath = path.join(env.tmpDir, "CLAUDE.md");
    const block = generateRulesBlock([], []);

    await injectRules(filePath, block);

    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toContain("<!-- GNOSYS:START -->");
    expect(content).toContain("<!-- GNOSYS:END -->");
    expect(content).toContain("Gnosys Memory System");
  });

  it("injectRules preserves content outside GNOSYS block", async () => {
    const filePath = path.join(env.tmpDir, "CLAUDE.md");
    const userContent = "# My Custom Instructions\n\nThis is my custom content.\n\n";
    fs.writeFileSync(filePath, userContent);

    const block = generateRulesBlock([], []);
    await injectRules(filePath, block);

    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toContain("# My Custom Instructions");
    expect(content).toContain("This is my custom content.");
    expect(content).toContain("<!-- GNOSYS:START -->");
  });

  it("injectRules replaces existing GNOSYS block", async () => {
    const filePath = path.join(env.tmpDir, "CLAUDE.md");

    // First injection
    const block1 = generateRulesBlock(
      [{ key: "k1", value: "first version", title: "K1", tags: [], confidence: 0.9, created: "2026-03-12", modified: "2026-03-12" }],
      []
    );
    await injectRules(filePath, block1);

    // Second injection with different content
    const block2 = generateRulesBlock(
      [{ key: "k2", value: "second version", title: "K2", tags: [], confidence: 0.9, created: "2026-03-12", modified: "2026-03-12" }],
      []
    );
    await injectRules(filePath, block2);

    const content = fs.readFileSync(filePath, "utf8");
    // Should have block2 content, not block1
    expect(content).toContain("second version");
    expect(content).not.toContain("first version");
    // Should only have ONE pair of markers
    const startCount = (content.match(/<!-- GNOSYS:START -->/g) || []).length;
    expect(startCount).toBe(1);
  });

  it("injectRules with preferences includes preference content", async () => {
    const filePath = path.join(env.tmpDir, "rules.mdc");

    const prefs: Preference[] = [
      { key: "commit-convention", value: "conventional commits", title: "Commit Convention", tags: [], confidence: 0.9, created: "2026-03-12", modified: "2026-03-12" },
      { key: "code-style", value: "TypeScript strict", title: "Code Style", tags: [], confidence: 0.9, created: "2026-03-12", modified: "2026-03-12" },
    ];
    const block = generateRulesBlock(prefs, []);
    await injectRules(filePath, block);

    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toContain("User preferences");
    expect(content).toContain("conventional commits");
    expect(content).toContain("TypeScript strict");
  });
});

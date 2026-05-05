/**
 * Phase 4 — chat tool catalog + fence parser.
 *
 * Tests cover:
 * - Tool fence parser (well-formed, malformed, multiple fences)
 * - System-prompt addendum lists every tool
 * - Each tool's run() returns sensible output against a known DB state
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GnosysDB } from "../lib/db.js";
import {
  extractToolFences,
  parseToolBody,
} from "../lib/chat/toolFence.js";
import {
  listTools,
  findTool,
  buildToolsSystemPrompt,
} from "../lib/chat/tools.js";

// Tool runs hit the central DB. The OS keychain isn't relevant here, but
// the central DB is — point GNOSYS_HOME to a fresh temp dir per test so
// tools see a known empty/minimal state.
let tmp: string;
let db: GnosysDB;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gnosys-tools-test-"));
  process.env.GNOSYS_HOME = tmp;
  db = GnosysDB.openLocal();
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.GNOSYS_HOME;
});

// ─── Fence parser ──────────────────────────────────────────────────────────

describe("parseToolBody", () => {
  it("parses a tool name and args from key:value lines", () => {
    const body = "tool: search\nquery: ULID encoding\nlimit: 5";
    const parsed = parseToolBody(body);
    expect(parsed.tool).toBe("search");
    expect(parsed.args).toEqual({ query: "ULID encoding", limit: "5" });
  });

  it("ignores comments and blank lines", () => {
    const body = `# comment\n\ntool: list_projects\n# another`;
    const parsed = parseToolBody(body);
    expect(parsed.tool).toBe("list_projects");
    expect(parsed.args).toEqual({});
  });

  it("tolerates Windows line endings", () => {
    const body = "tool: read\r\nid: deci-037\r\n";
    const parsed = parseToolBody(body);
    expect(parsed.tool).toBe("read");
    expect(parsed.args.id).toBe("deci-037");
  });

  it("returns empty tool when missing", () => {
    expect(parseToolBody("just text").tool).toBe("");
  });
});

describe("extractToolFences", () => {
  it("returns null when there are no fences", () => {
    expect(extractToolFences("Hello, no fence here.")).toBeNull();
  });

  it("extracts a single well-formed fence", () => {
    const text = "Here's some context:\n\n```gnosys-tool\ntool: list_projects\n```\n\nAnything else?";
    const result = extractToolFences(text);
    expect(result).not.toBeNull();
    expect(result!.calls).toHaveLength(1);
    expect(result!.calls[0].tool).toBe("list_projects");
    expect(result!.before).toContain("Here's some context");
    expect(result!.after).toContain("Anything else");
  });

  it("extracts multiple fences in order", () => {
    const text = `\`\`\`gnosys-tool
tool: list_projects
\`\`\`

\`\`\`gnosys-tool
tool: read
id: deci-037
\`\`\``;
    const result = extractToolFences(text);
    expect(result!.calls).toHaveLength(2);
    expect(result!.calls[0].tool).toBe("list_projects");
    expect(result!.calls[1].tool).toBe("read");
    expect(result!.calls[1].args.id).toBe("deci-037");
  });

  it("collects parse errors for malformed fences", () => {
    const text = "```gnosys-tool\nno tool line here\n```";
    const result = extractToolFences(text);
    expect(result!.calls).toHaveLength(0);
    expect(result!.parseErrors).toHaveLength(1);
    expect(result!.parseErrors[0].reason).toMatch(/missing/i);
  });
});

// ─── Tool catalog ──────────────────────────────────────────────────────────

describe("listTools / findTool", () => {
  it("returns the catalog of available tools", () => {
    const tools = listTools();
    expect(tools.length).toBeGreaterThan(5);
    const names = tools.map((t) => t.name);
    expect(names).toContain("list_projects");
    expect(names).toContain("search");
    expect(names).toContain("read");
    expect(names).toContain("briefing");
    expect(names).toContain("stats");
    expect(names).toContain("audit");
    expect(names).toContain("recent_memories");
  });

  it("findTool resolves by exact name", () => {
    expect(findTool("list_projects")?.name).toBe("list_projects");
    expect(findTool("not_a_tool")).toBeUndefined();
  });
});

describe("buildToolsSystemPrompt", () => {
  it("includes every tool name in the addendum", () => {
    const prompt = buildToolsSystemPrompt();
    for (const t of listTools()) {
      expect(prompt).toContain(t.name);
    }
    expect(prompt).toContain("```gnosys-tool");
  });
});

// ─── Tool execution ────────────────────────────────────────────────────────

describe("tool execution against a known DB state", () => {
  it("list_projects returns 'No projects' on empty DB, then lists them after seeding", async () => {
    const tool = findTool("list_projects")!;

    // Empty
    const empty = await tool.run({});
    expect(empty).toMatch(/no projects/i);

    // Seed two projects
    db.insertProject({
      id: "p1", name: "Alpha", working_directory: "/tmp/a", user: "u",
      agent_rules_target: null, obsidian_vault: null,
      created: new Date().toISOString(), modified: new Date().toISOString(),
    });
    db.insertProject({
      id: "p2", name: "Beta", working_directory: "/tmp/b", user: "u",
      agent_rules_target: null, obsidian_vault: null,
      created: new Date().toISOString(), modified: new Date().toISOString(),
    });

    const out = await tool.run({});
    expect(out).toContain("Alpha");
    expect(out).toContain("Beta");
    expect(out).toContain("p1");
  });

  it("search returns an error when query is missing", async () => {
    const tool = findTool("search")!;
    const out = await tool.run({});
    expect(out).toMatch(/query.*required/i);
  });

  it("read returns 'Memory not found' for a missing id", async () => {
    const tool = findTool("read")!;
    const out = await tool.run({ id: "does-not-exist" });
    expect(out).toMatch(/not found/i);
  });

  it("stats reports total active count", async () => {
    db.insertProject({
      id: "p1", name: "Alpha", working_directory: "/tmp/a", user: "u",
      agent_rules_target: null, obsidian_vault: null,
      created: new Date().toISOString(), modified: new Date().toISOString(),
    });
    const now = new Date().toISOString();
    db.insertMemory({
      id: "mem-1", title: "T", category: "test", content: "body",
      summary: null, tags: "[]", relevance: "", author: "ai",
      authority: "imported", confidence: 0.8, reinforcement_count: 0,
      content_hash: "h", status: "active", tier: "active",
      supersedes: null, superseded_by: null, last_reinforced: null,
      created: now, modified: now, embedding: null, source_path: null,
      source_file: null, source_page: null, source_timerange: null,
      project_id: "p1", scope: "project",
    });

    const tool = findTool("stats")!;
    const out = await tool.run({});
    expect(out).toContain("Alpha");
    expect(out).toContain("1 active");
    expect(out).toContain("Total active: 1");
  });

  it("audit returns an empty message when no recent activity", async () => {
    const tool = findTool("audit")!;
    const out = await tool.run({ days: "1" });
    expect(out).toMatch(/no audit/i);
  });

  it("audit returns entries after logAudit calls", async () => {
    db.logAudit({
      timestamp: new Date().toISOString(),
      operation: "write",
      memory_id: "mem-x",
      details: null,
      duration_ms: null,
      trace_id: null,
    });
    const tool = findTool("audit")!;
    const out = await tool.run({ days: "1" });
    expect(out).toContain("write");
    expect(out).toContain("mem-x");
  });

  it("recent_memories filters by project name when given", async () => {
    db.insertProject({
      id: "p1", name: "Alpha", working_directory: "/tmp/a", user: "u",
      agent_rules_target: null, obsidian_vault: null,
      created: new Date().toISOString(), modified: new Date().toISOString(),
    });
    const today = new Date().toISOString().slice(0, 10);
    db.insertMemory({
      id: "mem-recent", title: "Recent thing", category: "test", content: "body",
      summary: null, tags: "[]", relevance: "", author: "ai",
      authority: "imported", confidence: 0.8, reinforcement_count: 0,
      content_hash: "h", status: "active", tier: "active",
      supersedes: null, superseded_by: null, last_reinforced: null,
      created: today, modified: today, embedding: null, source_path: null,
      source_file: null, source_page: null, source_timerange: null,
      project_id: "p1", scope: "project",
    });
    const tool = findTool("recent_memories")!;
    const out = await tool.run({ project_name: "Alpha", days: "1" });
    expect(out).toContain("Recent thing");
  });
});

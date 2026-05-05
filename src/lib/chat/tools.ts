/**
 * Chat-side tool catalog.
 *
 * The LLM in `gnosys chat` can call gnosys functions directly via a fenced
 * protocol (gnosys-tool). Each tool is a small read-only query into the
 * central DB; the result is injected back into the conversation as a system
 * turn before the LLM's next response.
 *
 * Why a fenced protocol instead of native tool_use APIs:
 * - Provider-agnostic: works with Anthropic, OpenAI, Groq, Ollama, LM Studio,
 *   and anything that streams plain text. Same approach as gnosys-choose.
 * - Same in-process function calls the MCP server uses internally — no MCP
 *   roundtrip, no schema duplication.
 * - The model can chain tool calls naturally (call list_projects, then
 *   briefing on a name) because each tool result is a normal turn.
 *
 * Format the model emits:
 *
 *   ```gnosys-tool
 *   tool: list_projects
 *   ```
 *
 *   ```gnosys-tool
 *   tool: search
 *   query: ULID encoding
 *   limit: 5
 *   ```
 *
 *   ```gnosys-tool
 *   tool: read
 *   id: deci-037
 *   ```
 *
 * The fence syntax is parsed by toolFence.ts.
 */

import { GnosysDB, type DbMemory } from "../db.js";
import { federatedSearch } from "../federated.js";

// ─── Tool definitions ──────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  /** Parameter names + brief descriptions, shown in the system prompt. */
  params: Record<string, string>;
  /** Run the tool. Returns a markdown string for injection as a system turn. */
  run: (args: Record<string, string>) => Promise<string>;
}

const TOOLS: ToolDefinition[] = [
  {
    name: "list_projects",
    description: "List every registered project across the central DB",
    params: {},
    run: async () => {
      const db = GnosysDB.openCentral();
      try {
        const projects = db.getAllProjects();
        if (projects.length === 0) return "No projects registered.";
        const lines = ["Projects:"];
        for (const p of projects) {
          const memCount = db.getMemoriesByProject(p.id).length;
          lines.push(`- ${p.name} (id: \`${p.id}\`, ${memCount} active memories) — ${p.working_directory}`);
        }
        return lines.join("\n");
      } finally {
        db.close();
      }
    },
  },
  {
    name: "search",
    description: "Search memories by free text. Federated across project/user/global with tier boosting.",
    params: {
      query: "the search string (required)",
      limit: "max results (default 10)",
      project_id: "optional — filter to a project ID",
    },
    run: async (args) => {
      if (!args.query) return "Error: `query` is required for the search tool.";
      const db = GnosysDB.openCentral();
      try {
        const results = federatedSearch(db, args.query, {
          limit: args.limit ? parseInt(args.limit, 10) : 10,
          projectId: args.project_id ?? null,
        });
        if (results.length === 0) return `No matches for "${args.query}".`;
        const lines = [`Results for "${args.query}" (${results.length}):`];
        for (const r of results) {
          const score = r.score.toFixed(2);
          lines.push(`- [${r.id}] ${r.title} (${r.scope}, score=${score})`);
          lines.push(`    ${r.snippet.slice(0, 140)}${r.snippet.length > 140 ? "..." : ""}`);
        }
        return lines.join("\n");
      } finally {
        db.close();
      }
    },
  },
  {
    name: "read",
    description: "Read a specific memory by ID. Use after `search` to fetch full content.",
    params: {
      id: "the memory ID (required)",
    },
    run: async (args) => {
      if (!args.id) return "Error: `id` is required for the read tool.";
      const db = GnosysDB.openCentral();
      try {
        const mem = db.getMemory(args.id);
        if (!mem) return `Memory not found: \`${args.id}\``;
        const tags = (() => {
          try {
            const t = JSON.parse(mem.tags || "[]");
            return Array.isArray(t) ? t.join(", ") : "—";
          } catch {
            return "—";
          }
        })();
        return [
          `# ${mem.title}`,
          `id: ${mem.id} · category: ${mem.category} · scope: ${mem.scope} · confidence: ${mem.confidence}`,
          `tags: ${tags}`,
          "",
          mem.content,
        ].join("\n");
      } finally {
        db.close();
      }
    },
  },
  {
    name: "briefing",
    description: "Generate a project briefing — categories, recent activity, top tags. Pass project_id OR project_name (current project if neither given).",
    params: {
      project_id: "the project ID (optional)",
      project_name: "the project name (optional, looked up if id not given)",
    },
    run: async (args) => {
      const db = GnosysDB.openCentral();
      try {
        const { generateBriefing, detectCurrentProject } = await import("../federated.js");
        let pid: string | null = args.project_id ?? null;
        if (!pid && args.project_name) {
          const all = db.getAllProjects();
          const found = all.find((p) => p.name === args.project_name);
          if (found) pid = found.id;
        }
        if (!pid) pid = await detectCurrentProject(db, undefined);
        if (!pid) return "No project specified or detected.";
        const briefing = generateBriefing(db, pid);
        if (!briefing) return `Project not found: ${pid}`;
        return briefing.summary;
      } finally {
        db.close();
      }
    },
  },
  {
    name: "stats",
    description: "Memory counts by project (active, archived, reinforcements). The 'how many memories?' tool.",
    params: {},
    run: async () => {
      const db = GnosysDB.openCentral();
      try {
        const projects = db.getAllProjects();
        const all = db.getAllMemories();
        const lines = ["Project statistics:"];
        let totalActive = 0;
        for (const p of projects) {
          const ms = all.filter((m) => m.project_id === p.id);
          const active = ms.filter((m) => m.tier === "active" && m.status === "active").length;
          const archived = ms.filter((m) => m.tier === "archive").length;
          totalActive += active;
          lines.push(`- ${p.name}: ${active} active, ${archived} archived`);
        }
        const userScope = all.filter((m) => !m.project_id && m.scope === "user").length;
        const globalScope = all.filter((m) => !m.project_id && m.scope === "global").length;
        if (userScope > 0) lines.push(`- (user-scope): ${userScope}`);
        if (globalScope > 0) lines.push(`- (global): ${globalScope}`);
        lines.push(`Total active: ${totalActive + userScope + globalScope}`);
        return lines.join("\n");
      } finally {
        db.close();
      }
    },
  },
  {
    name: "tags",
    description: "List all tags used across memories with their occurrence counts.",
    params: {
      limit: "max tags to return (default 30)",
    },
    run: async (args) => {
      const db = GnosysDB.openCentral();
      try {
        const all = db.getActiveMemories();
        const counts = new Map<string, number>();
        for (const m of all) {
          try {
            const tags = JSON.parse(m.tags || "[]");
            if (Array.isArray(tags)) {
              for (const t of tags) counts.set(t, (counts.get(t) ?? 0) + 1);
            }
          } catch { /* skip malformed */ }
        }
        const limit = args.limit ? parseInt(args.limit, 10) : 30;
        const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
        if (sorted.length === 0) return "No tags found.";
        return ["Tags (most common):", ...sorted.map(([t, n]) => `- ${t}: ${n}`)].join("\n");
      } finally {
        db.close();
      }
    },
  },
  {
    name: "audit",
    description: "Recent operations from the audit log (writes, reads, dream cycles). Useful for 'what did you do recently?'",
    params: {
      days: "look back N days (default 7)",
      operation: "filter by operation (write, read, recall, dream_complete, etc.)",
      limit: "max entries (default 20)",
    },
    run: async (args) => {
      const db = GnosysDB.openCentral();
      try {
        const days = args.days ? parseInt(args.days, 10) : 7;
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        const limit = args.limit ? parseInt(args.limit, 10) : 20;
        const entries = db.queryAuditLog({
          sinceIso: cutoff.toISOString(),
          operation: args.operation,
          limit,
        });
        if (entries.length === 0) return `No audit entries in the last ${days} day(s).`;
        const lines = [`Recent ${entries.length} audit entr${entries.length === 1 ? "y" : "ies"} (last ${days} days):`];
        for (const e of entries) {
          const memRef = e.memory_id ? ` → ${e.memory_id}` : "";
          const dur = e.duration_ms ? ` (${e.duration_ms}ms)` : "";
          lines.push(`- ${e.timestamp.slice(0, 19)}  ${e.operation}${memRef}${dur}`);
        }
        return lines.join("\n");
      } finally {
        db.close();
      }
    },
  },
  {
    name: "recent_memories",
    description: "Memories created or modified recently. Useful for 'what's the latest in project X?'",
    params: {
      project_name: "filter to a project name (optional)",
      project_id: "filter to a project ID (optional)",
      days: "look back N days (default 7)",
      limit: "max results (default 20)",
    },
    run: async (args) => {
      const db = GnosysDB.openCentral();
      try {
        const days = args.days ? parseInt(args.days, 10) : 7;
        const limit = args.limit ? parseInt(args.limit, 10) : 20;
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        const cutoffStr = cutoff.toISOString().slice(0, 10);

        let pid = args.project_id ?? null;
        if (!pid && args.project_name) {
          const found = db.getAllProjects().find((p) => p.name === args.project_name);
          if (found) pid = found.id;
        }

        const all: DbMemory[] = pid
          ? db.getMemoriesByProject(pid)
          : db.getActiveMemories();
        const recent = all
          .filter((m) => (m.modified || m.created) >= cutoffStr)
          .sort((a, b) => (b.modified || b.created).localeCompare(a.modified || a.created))
          .slice(0, limit);
        if (recent.length === 0) {
          return `No memories modified in the last ${days} day(s)${pid ? " for that project" : ""}.`;
        }
        const lines = [`Recent ${recent.length} memor${recent.length === 1 ? "y" : "ies"} (last ${days} days):`];
        for (const m of recent) {
          lines.push(`- [${m.id}] ${m.title}  (${m.modified || m.created})`);
        }
        return lines.join("\n");
      } finally {
        db.close();
      }
    },
  },
];

// ─── Public API ────────────────────────────────────────────────────────────

const TOOL_INDEX = new Map<string, ToolDefinition>(TOOLS.map((t) => [t.name, t]));

export function findTool(name: string): ToolDefinition | undefined {
  return TOOL_INDEX.get(name);
}

export function listTools(): ToolDefinition[] {
  return [...TOOLS];
}

/** System prompt addendum that teaches the LLM the tool-fence syntax. */
export function buildToolsSystemPrompt(): string {
  const lines = [
    "",
    "You can call gnosys functions to look up live data the user is asking about. Emit a fenced block:",
    "",
    "```gnosys-tool",
    "tool: <name>",
    "<param>: <value>",
    "```",
    "",
    "After the fence, STOP. The runtime will execute the tool and inject the result before your next message. Then continue your reply naturally, citing the tool result.",
    "",
    "Available tools:",
  ];
  for (const t of TOOLS) {
    const params = Object.keys(t.params).length > 0
      ? ` (params: ${Object.entries(t.params).map(([k, d]) => `${k} — ${d}`).join("; ")})`
      : "";
    lines.push(`- ${t.name}: ${t.description}${params}`);
  }
  lines.push("");
  lines.push("Don't make up data — call a tool when the user asks anything specific about projects, memories, recent activity, tags, or stats.");
  return lines.join("\n");
}

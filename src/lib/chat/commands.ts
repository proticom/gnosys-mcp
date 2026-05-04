/**
 * Slash command dispatcher for the chat TUI.
 *
 * Each command receives the chat state and returns a result describing what
 * happened. The TUI translates the result into UI updates (system messages,
 * exit, conversation buffer changes, etc.). Commands run synchronously when
 * possible; async ones return a Promise.
 *
 * Phase 2 commands: /help, /clear, /history, /read, /list, /tags, /dashboard,
 * /quit, /provider. Phases 3–7 add /pin, /scope, /recall, /threshold,
 * /reinforce, /remember, /save-turn, /attach, /focus, /branch, /resume-focus,
 * /dream-here, /search-chats, /export.
 */

import { Turn } from "./types.js";

export interface CommandContext {
  /** Current session ID. */
  sessionId: string;
  /** Conversation buffer as the LLM sees it. Commands may read or mutate (via the result's nextBuffer). */
  buffer: Turn[];
  /** Current provider name. */
  provider: string;
  /** Current model. */
  model: string;
}

export type CommandResult =
  | { kind: "ok"; message?: string }                              // Plain success, optionally with a system message to display
  | { kind: "clear-buffer" }                                      // /clear
  | { kind: "exit" }                                              // /quit
  | { kind: "switch-provider"; provider: string; model?: string } // /provider
  | { kind: "show"; lines: string[] }                             // /help, /history, /list, /tags, etc. — multi-line output
  | { kind: "pin"; memoryId: string }                             // /pin
  | { kind: "unpin"; memoryId: string }                           // /unpin
  | { kind: "scope"; scope: "project" | "user" | "global" | "federated" } // /scope
  | { kind: "threshold"; value: number }                          // /threshold
  | { kind: "preview-recall"; query: string }                     // /recall
  | { kind: "reinforce"; memoryId: string }                       // /reinforce
  | { kind: "remember"; text: string }                            // /remember
  | { kind: "save-turn" }                                         // /save-turn
  | { kind: "attach"; filePath: string }                          // /attach
  | { kind: "error"; message: string };

export interface CommandSpec {
  name: string;
  aliases?: string[];
  summary: string;
  usage?: string;
  handler: (ctx: CommandContext, args: string[]) => CommandResult | Promise<CommandResult>;
}

// ─── Built-in commands ──────────────────────────────────────────────────

const helpCmd: CommandSpec = {
  name: "/help",
  summary: "Show available commands",
  handler: (_ctx, _args) => {
    const all = listCommands();
    const lines: string[] = ["Available commands:"];
    for (const c of all) {
      const alias = c.aliases?.length ? `  (alias: ${c.aliases.join(", ")})` : "";
      lines.push(`  ${c.name.padEnd(14)}${c.summary}${alias}`);
      if (c.usage) lines.push(`                ${c.usage}`);
    }
    lines.push("");
    lines.push("Type any other text to chat with the model.");
    return { kind: "show", lines };
  },
};

const clearCmd: CommandSpec = {
  name: "/clear",
  summary: "Clear the visible conversation buffer (session log preserved)",
  handler: () => ({ kind: "clear-buffer" }),
};

const quitCmd: CommandSpec = {
  name: "/quit",
  aliases: ["/exit", "/q"],
  summary: "Exit chat (session log preserved)",
  handler: () => ({ kind: "exit" }),
};

const historyCmd: CommandSpec = {
  name: "/history",
  summary: "Show the visible buffer turn-by-turn",
  handler: (ctx) => {
    if (ctx.buffer.length === 0) {
      return { kind: "show", lines: ["(no turns yet)"] };
    }
    const lines: string[] = [`Buffer has ${ctx.buffer.length} turn(s):`];
    ctx.buffer.forEach((t, i) => {
      const preview = t.text.length > 80 ? t.text.slice(0, 77) + "..." : t.text;
      lines.push(`  [${i}] ${t.role.padEnd(9)} ${preview}`);
    });
    return { kind: "show", lines };
  },
};

const providerCmd: CommandSpec = {
  name: "/provider",
  usage: "/provider <name> [model]",
  summary: "Switch LLM provider mid-session (anthropic, openai, groq, ollama, etc.)",
  handler: (_ctx, args) => {
    if (args.length === 0) {
      return { kind: "error", message: "Usage: /provider <name> [model]" };
    }
    return { kind: "switch-provider", provider: args[0], model: args[1] };
  },
};

const readCmd: CommandSpec = {
  name: "/read",
  usage: "/read <memoryId>",
  summary: "Read a specific memory by ID",
  handler: async (_ctx, args) => {
    if (args.length === 0) {
      return { kind: "error", message: "Usage: /read <memoryId>" };
    }
    const { GnosysDB } = await import("../db.js");
    const db = GnosysDB.openCentral();
    if (!db.isAvailable()) {
      db.close();
      return { kind: "error", message: "Central DB unavailable" };
    }
    try {
      const mem = db.getMemory(args[0]);
      if (!mem) return { kind: "error", message: `Memory not found: ${args[0]}` };
      return {
        kind: "show",
        lines: [
          `# ${mem.title}`,
          `id: ${mem.id}`,
          `category: ${mem.category}`,
          `confidence: ${mem.confidence}`,
          `tags: ${mem.tags}`,
          ``,
          mem.content,
        ],
      };
    } finally {
      db.close();
    }
  },
};

const listCmd: CommandSpec = {
  name: "/list",
  usage: "/list [limit]",
  summary: "List recent chat sessions",
  handler: async (_ctx, args) => {
    const { listSessions } = await import("./session.js");
    const limit = args[0] ? parseInt(args[0], 10) : 20;
    const sessions = listSessions().slice(0, limit);
    if (sessions.length === 0) {
      return { kind: "show", lines: ["(no sessions yet)"] };
    }
    const lines: string[] = [`Recent ${sessions.length} session(s):`];
    for (const s of sessions) {
      const proj = s.project_id ? s.project_id.slice(0, 8) : "—";
      const sizeKb = (s.size_bytes / 1024).toFixed(1);
      lines.push(`  ${s.id.slice(0, 12)}…  ${s.last_active.slice(0, 19)}  proj=${proj}  turns=${s.turns}  ${sizeKb}KB`);
    }
    return { kind: "show", lines };
  },
};

const tagsCmd: CommandSpec = {
  name: "/tags",
  summary: "Show the tag registry for the current store",
  handler: async () => {
    const { GnosysResolver } = await import("../resolver.js");
    const { GnosysTagRegistry } = await import("../tags.js");
    const r = new GnosysResolver();
    await r.resolve();
    const stores = r.getStores();
    if (stores.length === 0) return { kind: "error", message: "No store found." };
    const reg = new GnosysTagRegistry(stores[0].path);
    await reg.load();
    const all = reg.getAllTags();
    if (all.length === 0) return { kind: "show", lines: ["(no tags registered)"] };
    return {
      kind: "show",
      lines: [`Tags (${all.length}):`, ...all.map((t) => `  ${t}`)],
    };
  },
};

const dashboardCmd: CommandSpec = {
  name: "/dashboard",
  summary: "Show project memory dashboard",
  handler: async () => {
    const { GnosysDB } = await import("../db.js");
    const db = GnosysDB.openCentral();
    if (!db.isAvailable()) {
      db.close();
      return { kind: "error", message: "Central DB unavailable" };
    }
    try {
      const projects = db.getAllProjects();
      const counts = db.getMemoryCount();
      const lines = [
        `Projects:         ${projects.length}`,
        `Active memories:  ${counts.active}`,
        `Archived memories: ${counts.archived}`,
        ``,
        ...projects.slice(0, 10).map((p) => `  ${p.id.slice(0, 8)}  ${p.name}`),
      ];
      return { kind: "show", lines };
    } finally {
      db.close();
    }
  },
};

// ─── Phase 3 commands: recall, pinning, scope, threshold, reinforce ───

const pinCmd: CommandSpec = {
  name: "/pin",
  usage: "/pin <memoryId>",
  summary: "Pin a memory so it's included in every recall (until /unpin)",
  handler: (_ctx, args) => {
    if (args.length === 0) return { kind: "error", message: "Usage: /pin <memoryId>" };
    return { kind: "pin", memoryId: args[0] };
  },
};

const unpinCmd: CommandSpec = {
  name: "/unpin",
  usage: "/unpin <memoryId>",
  summary: "Remove a pinned memory",
  handler: (_ctx, args) => {
    if (args.length === 0) return { kind: "error", message: "Usage: /unpin <memoryId>" };
    return { kind: "unpin", memoryId: args[0] };
  },
};

const scopeCmd: CommandSpec = {
  name: "/scope",
  usage: "/scope project|user|global|federated",
  summary: "Change recall scope mid-session (default: federated)",
  handler: (_ctx, args) => {
    if (args.length === 0) return { kind: "error", message: "Usage: /scope project|user|global|federated" };
    const valid = ["project", "user", "global", "federated"] as const;
    if (!valid.includes(args[0] as typeof valid[number])) {
      return { kind: "error", message: `Invalid scope. Use one of: ${valid.join(", ")}` };
    }
    return { kind: "scope", scope: args[0] as typeof valid[number] };
  },
};

const thresholdCmd: CommandSpec = {
  name: "/threshold",
  usage: "/threshold <0.0-1.0>",
  summary: "Drop recalled memories below this confidence (0 disables)",
  handler: (_ctx, args) => {
    if (args.length === 0) return { kind: "error", message: "Usage: /threshold <0.0-1.0>" };
    const v = parseFloat(args[0]);
    if (Number.isNaN(v) || v < 0 || v > 1) {
      return { kind: "error", message: "Threshold must be between 0.0 and 1.0" };
    }
    return { kind: "threshold", value: v };
  },
};

const recallCmd: CommandSpec = {
  name: "/recall",
  usage: "/recall <query>",
  summary: "Preview what would be recalled for this query (metadata only, no LLM call)",
  handler: (_ctx, args) => {
    if (args.length === 0) return { kind: "error", message: "Usage: /recall <query>" };
    return { kind: "preview-recall", query: args.join(" ") };
  },
};

const reinforceCmd: CommandSpec = {
  name: "/reinforce",
  usage: "/reinforce <memoryId>",
  summary: "Mark a memory as useful — boosts future ranking",
  handler: (_ctx, args) => {
    if (args.length === 0) return { kind: "error", message: "Usage: /reinforce <memoryId>" };
    return { kind: "reinforce", memoryId: args[0] };
  },
};

// ─── Phase 4 commands: memory writing ────────────────────────────────────

const rememberCmd: CommandSpec = {
  name: "/remember",
  usage: "/remember <text>",
  summary: "Save text as a new memory in the current project",
  handler: (_ctx, args) => {
    if (args.length === 0) return { kind: "error", message: "Usage: /remember <text>" };
    return { kind: "remember", text: args.join(" ") };
  },
};

const saveTurnCmd: CommandSpec = {
  name: "/save-turn",
  summary: "Distill the most recent user+assistant exchange into a memory",
  handler: () => ({ kind: "save-turn" }),
};

const attachCmd: CommandSpec = {
  name: "/attach",
  usage: "/attach <filePath>",
  summary: "Ingest a file (PDF, image, audio, video, DOCX, MD) and pin it to this session",
  handler: (_ctx, args) => {
    if (args.length === 0) return { kind: "error", message: "Usage: /attach <filePath>" };
    return { kind: "attach", filePath: args.join(" ") };
  },
};

const REGISTRY: CommandSpec[] = [
  helpCmd,
  clearCmd,
  quitCmd,
  historyCmd,
  providerCmd,
  readCmd,
  listCmd,
  tagsCmd,
  dashboardCmd,
  pinCmd,
  unpinCmd,
  scopeCmd,
  thresholdCmd,
  recallCmd,
  reinforceCmd,
  rememberCmd,
  saveTurnCmd,
  attachCmd,
];

export function listCommands(): CommandSpec[] {
  return REGISTRY;
}

export function findCommand(name: string): CommandSpec | undefined {
  const lower = name.toLowerCase();
  return REGISTRY.find(
    (c) =>
      c.name.toLowerCase() === lower ||
      c.aliases?.some((a) => a.toLowerCase() === lower),
  );
}

/** Parse a raw input line and dispatch if it's a slash command. Returns null if it's not a command. */
export async function dispatchCommand(
  raw: string,
  ctx: CommandContext,
): Promise<CommandResult | null> {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("/")) return null;

  const parts = trimmed.split(/\s+/);
  const name = parts[0];
  const args = parts.slice(1);

  const cmd = findCommand(name);
  if (!cmd) {
    return { kind: "error", message: `Unknown command: ${name}. Type /help.` };
  }
  return await cmd.handler(ctx, args);
}

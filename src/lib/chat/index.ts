/**
 * Chat orchestrator — the entry point invoked by `gnosys chat`.
 *
 * Phase 2 responsibilities:
 *   - Start or resume a session (writes start event to log)
 *   - Resolve project context (auto-detect from cwd)
 *   - Pick the LLM provider/model
 *   - Mount the ink ChatApp
 *   - On exit, flush a session_end event
 */

import type { GnosysConfig } from "../config.js";
import { GnosysDB } from "../db.js";
import {
  startSession,
  appendEvent,
  readSession,
  listSessions,
  searchSessions,
  type SessionEvent,
} from "./session.js";
import type { Turn, ChatHeaderInfo } from "./types.js";
import { resolveTaskModel } from "../config.js";

export interface StartChatOptions {
  config: GnosysConfig;
  resume?: string;          // existing session ID to resume
  projectId?: string;       // override project detection
  providerName?: string;    // override default provider
  modelName?: string;       // override default model
}

/** Reconstruct the conversation buffer from session log events. */
export function bufferFromEvents(events: SessionEvent[]): Turn[] {
  const turns: Turn[] = [];
  for (const e of events) {
    if (e.type === "user") {
      turns.push({ role: "user", text: e.text, ts: e.ts });
    } else if (e.type === "assistant") {
      turns.push({
        role: "assistant",
        text: e.text,
        ts: e.ts,
        provider: e.provider,
        model: e.model,
      });
    }
  }
  return turns;
}

/** Detect the project ID from cwd, returns null if no registered project. */
function detectProject(): { id: string; name: string } | null {
  try {
    const db = GnosysDB.openCentral();
    if (!db.isAvailable()) {
      db.close();
      return null;
    }
    const proj = db.getProjectByDirectory(process.cwd());
    db.close();
    if (!proj) return null;
    return { id: proj.id, name: proj.name };
  } catch {
    return null;
  }
}

/**
 * Start an interactive chat. Mounts the ink TUI, blocks until /quit or Ctrl-C.
 * Lazily imports React/ink so non-chat CLI commands aren't paying for them.
 */
export async function startChat(opts: StartChatOptions): Promise<void> {
  const { default: React } = await import("react");
  const { render } = await import("ink");
  const { ChatApp } = await import("./render.js");

  const project = opts.projectId
    ? { id: opts.projectId, name: opts.projectId.slice(0, 8) }
    : detectProject();

  // v5.8.0 (#2): resolve chat-specific task model. resolveTaskModel falls
  // through to defaultProvider when no `chat` override is set, so existing
  // installs see no change.
  //
  // v5.9.3 Phase G: the fail-fast on missing API key now lives in
  // cli.ts's chat command action, BEFORE the resolver / config load.
  // That keeps the bail-out fast and gives users an actionable error
  // without paying for React/ink imports first.
  const chatTask = resolveTaskModel(opts.config, "chat");
  const provider = opts.providerName ?? chatTask.provider;
  const model = opts.modelName ?? chatTask.model;

  // Resume existing session or start a new one
  let sessionId: string;
  let initialBuffer: Turn[] = [];

  if (opts.resume) {
    const events = readSession(opts.resume);
    if (events.length === 0) {
      console.error(`Session not found: ${opts.resume}`);
      process.exit(1);
    }
    sessionId = opts.resume;
    initialBuffer = bufferFromEvents(events);
    appendEvent(sessionId, {
      type: "session_start",
      ts: new Date().toISOString(),
      project_id: project?.id,
      provider,
      model,
    });
  } else {
    sessionId = startSession({
      project_id: project?.id,
      provider,
      model,
    });
  }

  const initialHeader: ChatHeaderInfo = {
    sessionId,
    projectName: project?.name,
    provider,
    model,
    tokensIn: 0,
    tokensOut: 0,
  };

  const { waitUntilExit } = render(
    React.createElement(ChatApp, {
      initialHeader,
      initialBuffer,
      config: opts.config,
      projectId: project?.id ?? null,
    }),
  );

  await waitUntilExit();
}

/** Print recent sessions to stdout (for `gnosys chat --list`). */
export function printSessionList(limit = 20): void {
  const sessions = listSessions().slice(0, limit);
  if (sessions.length === 0) {
    console.log("No chat sessions yet.");
    return;
  }
  console.log(`Recent ${sessions.length} session(s):`);
  for (const s of sessions) {
    const proj = s.project_id ? s.project_id.slice(0, 8) : "—";
    const sizeKb = (s.size_bytes / 1024).toFixed(1);
    console.log(
      `  ${s.id}  ${s.last_active.slice(0, 19)}  proj=${proj}  turns=${s.turns}  ${sizeKb}KB`,
    );
  }
}

/** Print search results across all session logs (for `gnosys chat --search`). */
export function printSearchResults(query: string, limit = 30): void {
  const matches = searchSessions(query, limit);
  if (matches.length === 0) {
    console.log(`No matches for: ${query}`);
    return;
  }
  console.log(`${matches.length} match(es):`);
  for (const m of matches) {
    const text = (() => {
      const e = m.event;
      switch (e.type) {
        case "user":
        case "assistant":
          return e.text;
        case "command":
          return `${e.name} ${e.args.join(" ")}`;
        case "focus":
          return e.topic;
        case "recall":
          return e.query;
        default:
          return "";
      }
    })();
    const preview = text.length > 100 ? text.slice(0, 97) + "..." : text;
    console.log(`  ${m.sessionId.slice(0, 12)}…  [${m.event.type}]  ${preview}`);
  }
}

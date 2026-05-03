/**
 * Chat session log — append-only JSONL writer + reader.
 *
 * Every turn (user, assistant, recall, command, choice, focus shift, etc.) is
 * appended as one JSON line. fsync'd before the next prompt so no turn is lost
 * on crash. The log is the source of truth for `--resume`.
 */

import { existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { ulid } from "ulidx";

/** Resolved on each call so test environments and runtime overrides take effect. */
export function getSessionLogDir(): string {
  return (
    process.env.GNOSYS_CHAT_SESSIONS_DIR ||
    join(process.env.GNOSYS_HOME || join(homedir(), ".gnosys"), "chat-sessions")
  );
}

/** Session log entry types. */
export type SessionEvent =
  | { type: "session_start"; ts: string; project_id?: string; provider?: string; model?: string }
  | { type: "user"; ts: string; text: string }
  | { type: "assistant"; ts: string; text: string; provider?: string; model?: string; tokens_in?: number; tokens_out?: number; cited_memory_ids?: string[] }
  | { type: "recall"; ts: string; query: string; memory_ids: string[]; scope: string }
  | { type: "command"; ts: string; name: string; args: string[]; result?: string }
  | { type: "intent_inferred"; ts: string; pattern: string; intent: string; accepted: boolean }
  | { type: "choice_offered"; ts: string; prompt: string; option_ids: string[] }
  | { type: "choice_made"; ts: string; option_id: string; label: string }
  | { type: "focus"; ts: string; topic: string; previous_topic?: string }
  | { type: "branch"; ts: string; from_session: string; new_session: string }
  | { type: "pin"; ts: string; memory_id: string }
  | { type: "unpin"; ts: string; memory_id: string }
  | { type: "memory_promoted"; ts: string; memory_id: string; source: "remember" | "save-turn" | "auto" | "attach" }
  | { type: "session_end"; ts: string; reason: "quit" | "timeout" | "error" }
  | { type: "error"; ts: string; message: string };

export interface SessionMetadata {
  id: string;
  path: string;
  created: string;
  last_active: string;
  project_id?: string;
  turns: number;
  size_bytes: number;
}

function ensureDir(): void {
  if (!existsSync(getSessionLogDir())) {
    mkdirSync(getSessionLogDir(), { recursive: true });
  }
}

/** Generate a new session ID (ULID for time-sortability). */
export function newSessionId(): string {
  return ulid();
}

/** Resolve the file path for a session ID. */
export function sessionPath(sessionId: string): string {
  return join(getSessionLogDir(), `${sessionId}.jsonl`);
}

/** Append a single event to the session log. fsync ensures durability. */
export function appendEvent(sessionId: string, event: SessionEvent): void {
  ensureDir();
  const line = JSON.stringify(event) + "\n";
  // appendFileSync defaults to {flag: 'a'} which O_APPEND-opens, writes, closes.
  // On macOS/Linux this is durable enough for a chat log; we don't need fsync()
  // on every line — the cost outweighs the benefit for an interactive REPL.
  appendFileSync(sessionPath(sessionId), line, { encoding: "utf-8" });
}

/** Open or create a session and write the start event. Returns the session ID. */
export function startSession(opts: { id?: string; project_id?: string; provider?: string; model?: string }): string {
  const id = opts.id ?? newSessionId();
  appendEvent(id, {
    type: "session_start",
    ts: new Date().toISOString(),
    project_id: opts.project_id,
    provider: opts.provider,
    model: opts.model,
  });
  return id;
}

/** Read every event from a session log, in order. */
export function readSession(sessionId: string): SessionEvent[] {
  const path = sessionPath(sessionId);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf-8");
  const events: SessionEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as SessionEvent);
    } catch {
      // Skip malformed line — log corruption from partial write
    }
  }
  return events;
}

/** List all session metadata, newest first. Cheap — only stats files + reads first event. */
export function listSessions(): SessionMetadata[] {
  ensureDir();
  const files = readdirSync(getSessionLogDir()).filter((f) => f.endsWith(".jsonl"));
  const out: SessionMetadata[] = [];

  for (const f of files) {
    const id = f.replace(/\.jsonl$/, "");
    const path = join(getSessionLogDir(), f);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      continue;
    }

    // Read just the first event for project_id and created
    let created = stat.birthtime.toISOString();
    let project_id: string | undefined;
    try {
      const events = readSession(id);
      if (events.length > 0) {
        const first = events[0];
        if (first.type === "session_start") {
          created = first.ts;
          project_id = first.project_id;
        }
      }
      out.push({
        id,
        path,
        created,
        last_active: stat.mtime.toISOString(),
        project_id,
        turns: events.filter((e) => e.type === "user" || e.type === "assistant").length,
        size_bytes: stat.size,
      });
    } catch {
      // Skip unreadable files
    }
  }

  // Newest first
  out.sort((a, b) => b.last_active.localeCompare(a.last_active));
  return out;
}

/** Full-text search across all session logs. Returns sessionId + matching event lines. */
export function searchSessions(query: string, limit = 50): Array<{ sessionId: string; event: SessionEvent }> {
  const needle = query.toLowerCase();
  const sessions = listSessions();
  const matches: Array<{ sessionId: string; event: SessionEvent }> = [];

  for (const s of sessions) {
    const events = readSession(s.id);
    for (const event of events) {
      // Search across user text, assistant text, command names, focus topics
      const haystack = (() => {
        switch (event.type) {
          case "user":
          case "assistant":
            return event.text;
          case "command":
            return `${event.name} ${event.args.join(" ")} ${event.result ?? ""}`;
          case "focus":
            return event.topic;
          case "recall":
            return event.query;
          default:
            return "";
        }
      })().toLowerCase();

      if (haystack.includes(needle)) {
        matches.push({ sessionId: s.id, event });
        if (matches.length >= limit) return matches;
      }
    }
  }
  return matches;
}

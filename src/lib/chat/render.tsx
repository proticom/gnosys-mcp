/**
 * Chat TUI — ink-based React components.
 *
 * Layout:
 *   ┌────────────────────────────────────────┐
 *   │ Header: project | provider/model | tokens │
 *   ├────────────────────────────────────────┤
 *   │ Conversation                           │
 *   │   user / assistant turns scroll        │
 *   │   system messages in dim text          │
 *   ├────────────────────────────────────────┤
 *   │ Status: idle | thinking… | error       │
 *   ├────────────────────────────────────────┤
 *   │ > input prompt                         │
 *   └────────────────────────────────────────┘
 */

import React, { useState, useEffect, useRef } from "react";
import { Box, Text, useApp } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import { ChatHeaderInfo, ChatStatus, Turn } from "./types.js";
import { dispatchCommand, CommandContext } from "./commands.js";
import { appendEvent } from "./session.js";
import { runTurn, buildProvider } from "./llmTurn.js";
import { runRecall, reinforceMemory, buildRecallQuery, RecallScope } from "./recall.js";
import { GnosysConfig, LLMProviderName } from "../config.js";
import { GnosysDB } from "../db.js";

export interface ChatAppProps {
  initialHeader: ChatHeaderInfo;
  initialBuffer: Turn[];
  config: GnosysConfig;
  /** Project ID for recall scoping (null when no project context). */
  projectId: string | null;
  /** Called on exit so the parent CLI process can clean up. */
  onExit?: () => void;
}

export const ChatApp: React.FC<ChatAppProps> = ({ initialHeader, initialBuffer, config, projectId, onExit }) => {
  const { exit } = useApp();
  const [header, setHeader] = useState<ChatHeaderInfo>(initialHeader);
  const [buffer, setBuffer] = useState<Turn[]>(initialBuffer);
  const [status, setStatus] = useState<ChatStatus>({ kind: "idle" });
  const [input, setInput] = useState<string>("");
  const [systemNotice, setSystemNotice] = useState<string[]>([]);
  const configRef = useRef<GnosysConfig>(config);

  // Recall state — pinned IDs, scope, threshold
  const [pinnedIds, setPinnedIds] = useState<string[]>([]);
  const [scope, setScope] = useState<RecallScope>("federated");
  const [threshold, setThreshold] = useState<number>(0);

  function nowIso(): string {
    return new Date().toISOString();
  }

  function pushSystem(lines: string | string[]): void {
    const arr = Array.isArray(lines) ? lines : [lines];
    setSystemNotice(arr);
    // Auto-clear after a few seconds so the buffer doesn't grow with stale notices
    setTimeout(() => setSystemNotice([]), 5000);
  }

  async function handleSubmit(raw: string): Promise<void> {
    const text = raw.trim();
    if (!text) return;

    setInput("");

    // Slash command path
    if (text.startsWith("/")) {
      const ctx: CommandContext = {
        sessionId: header.sessionId,
        buffer,
        provider: header.provider,
        model: header.model,
      };
      appendEvent(header.sessionId, {
        type: "command",
        ts: nowIso(),
        name: text.split(/\s+/)[0],
        args: text.split(/\s+/).slice(1),
      });

      const result = await dispatchCommand(text, ctx);
      if (!result) return; // not a command, fall through (shouldn't happen since we checked /)

      switch (result.kind) {
        case "ok":
          if (result.message) pushSystem(result.message);
          break;
        case "show":
          pushSystem(result.lines);
          break;
        case "clear-buffer":
          setBuffer([]);
          pushSystem("Buffer cleared (session log preserved).");
          break;
        case "switch-provider": {
          try {
            const p = buildProvider(configRef.current, result.provider as LLMProviderName, result.model);
            setHeader((h) => ({ ...h, provider: p.name, model: p.model }));
            pushSystem(`Switched to ${p.name} / ${p.model}`);
          } catch (err) {
            pushSystem(`Failed to switch provider: ${err instanceof Error ? err.message : String(err)}`);
          }
          break;
        }
        case "exit":
          appendEvent(header.sessionId, { type: "session_end", ts: nowIso(), reason: "quit" });
          if (onExit) onExit();
          exit();
          break;
        case "pin":
          if (pinnedIds.includes(result.memoryId)) {
            pushSystem(`Already pinned: ${result.memoryId}`);
          } else {
            setPinnedIds((p) => [...p, result.memoryId]);
            appendEvent(header.sessionId, { type: "pin", ts: nowIso(), memory_id: result.memoryId });
            pushSystem(`Pinned ${result.memoryId} — included in every turn until /unpin`);
          }
          break;
        case "unpin":
          if (!pinnedIds.includes(result.memoryId)) {
            pushSystem(`Not pinned: ${result.memoryId}`);
          } else {
            setPinnedIds((p) => p.filter((id) => id !== result.memoryId));
            appendEvent(header.sessionId, { type: "unpin", ts: nowIso(), memory_id: result.memoryId });
            pushSystem(`Unpinned ${result.memoryId}`);
          }
          break;
        case "scope":
          setScope(result.scope);
          pushSystem(`Recall scope set to ${result.scope}`);
          break;
        case "threshold":
          setThreshold(result.value);
          pushSystem(`Confidence threshold set to ${result.value}`);
          break;
        case "preview-recall": {
          const db = GnosysDB.openCentral();
          if (!db.isAvailable()) {
            pushSystem("Central DB unavailable");
            db.close();
            break;
          }
          try {
            const recalled = runRecall(db, {
              query: result.query,
              scope,
              projectId,
              threshold,
              pinnedIds,
            });
            if (recalled.memories.length === 0) {
              pushSystem(`No memories matched "${result.query}"`);
            } else {
              const lines = [`Recall preview (${recalled.memories.length} match${recalled.memories.length === 1 ? "" : "es"}):`];
              for (const m of recalled.memories) {
                const tag = m.pinned ? " [pinned]" : "";
                lines.push(`  ${m.id.padEnd(14)} ${m.confidence.toFixed(2)}  ${m.title}${tag}`);
              }
              pushSystem(lines);
            }
          } finally {
            db.close();
          }
          break;
        }
        case "reinforce": {
          const db = GnosysDB.openCentral();
          if (!db.isAvailable()) {
            pushSystem("Central DB unavailable");
            db.close();
            break;
          }
          try {
            const ok = reinforceMemory(db, result.memoryId);
            pushSystem(ok ? `Reinforced ${result.memoryId}` : `Memory not found: ${result.memoryId}`);
          } finally {
            db.close();
          }
          break;
        }
        case "error":
          pushSystem(`Error: ${result.message}`);
          break;
      }
      return;
    }

    // Chat turn path
    const userTurn: Turn = { role: "user", text, ts: nowIso() };
    setBuffer((b) => [...b, userTurn]);
    appendEvent(header.sessionId, { type: "user", ts: userTurn.ts, text });

    setStatus({ kind: "thinking" });

    // Run recall before the LLM call so the model sees relevant memories.
    let recalled: ReturnType<typeof runRecall>["memories"] = [];
    try {
      const db = GnosysDB.openCentral();
      if (db.isAvailable()) {
        const query = buildRecallQuery(text, [...buffer, userTurn]);
        const result = runRecall(db, {
          query,
          scope,
          projectId,
          threshold,
          pinnedIds,
        });
        recalled = result.memories;
        appendEvent(header.sessionId, {
          type: "recall",
          ts: nowIso(),
          query,
          memory_ids: recalled.map((m) => m.id),
          scope,
        });
      }
      db.close();
    } catch {
      // Recall errors shouldn't block the chat — proceed without recall
    }

    setStatus({ kind: "streaming", partial: "" });

    try {
      let partial = "";
      const result = await runTurn(configRef.current, {
        buffer: [...buffer, userTurn],
        userInput: text,
        recalled,
        onToken: (tok) => {
          partial += tok;
          setStatus({ kind: "streaming", partial });
        },
      });

      const assistantTurn: Turn = {
        role: "assistant",
        text: result.text,
        ts: nowIso(),
        provider: result.provider,
        model: result.model,
        citedMemoryIds: result.recalledIds,
      };
      setBuffer((b) => [...b, assistantTurn]);
      appendEvent(header.sessionId, {
        type: "assistant",
        ts: assistantTurn.ts,
        text: result.text,
        provider: result.provider,
        model: result.model,
        cited_memory_ids: result.recalledIds,
      });
      setStatus({ kind: "idle" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setStatus({ kind: "error", message });
      appendEvent(header.sessionId, { type: "error", ts: nowIso(), message });
    }
  }

  // Trap Ctrl-C → graceful exit, mirroring /quit
  useEffect(() => {
    const handler = () => {
      appendEvent(header.sessionId, { type: "session_end", ts: nowIso(), reason: "quit" });
      if (onExit) onExit();
      exit();
    };
    process.on("SIGINT", handler);
    return () => {
      process.off("SIGINT", handler);
    };
  }, []);

  return (
    <Box flexDirection="column">
      <ChatHeader info={header} recallScope={scope} threshold={threshold} pinnedCount={pinnedIds.length} />

      <Box flexDirection="column" marginTop={1}>
        {buffer.map((turn, i) => (
          <ConversationTurn key={i} turn={turn} />
        ))}
        {status.kind === "streaming" && (
          <Box flexDirection="column">
            <Text color="cyan">assistant:</Text>
            <Text>{status.partial}</Text>
          </Box>
        )}
      </Box>

      {systemNotice.length > 0 && (
        <Box flexDirection="column" marginTop={1}>
          {systemNotice.map((line, i) => (
            <Text key={i} dimColor>
              {line}
            </Text>
          ))}
        </Box>
      )}

      <Box marginTop={1}>
        <StatusLine status={status} />
      </Box>

      <Box marginTop={1}>
        <Text>&gt; </Text>
        <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
      </Box>
    </Box>
  );
};

const ChatHeader: React.FC<{
  info: ChatHeaderInfo;
  recallScope: RecallScope;
  threshold: number;
  pinnedCount: number;
}> = ({ info, recallScope, threshold, pinnedCount }) => (
  <Box flexDirection="column">
    <Box>
      <Text color="green">gnosys chat</Text>
      <Text>  </Text>
      <Text dimColor>session={info.sessionId.slice(0, 8)}…</Text>
      <Text>  </Text>
      {info.projectName && (
        <>
          <Text dimColor>project={info.projectName}</Text>
          <Text>  </Text>
        </>
      )}
      <Text dimColor>{info.provider}/{info.model}</Text>
    </Box>
    <Box>
      <Text dimColor>recall: scope={recallScope}</Text>
      <Text>  </Text>
      <Text dimColor>threshold={threshold.toFixed(2)}</Text>
      <Text>  </Text>
      <Text dimColor>pinned={pinnedCount}</Text>
    </Box>
  </Box>
);

const ConversationTurn: React.FC<{ turn: Turn }> = ({ turn }) => {
  if (turn.role === "user") {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color="yellow">you:</Text>
        <Text>{turn.text}</Text>
      </Box>
    );
  }
  if (turn.role === "assistant") {
    const cited = turn.citedMemoryIds ?? [];
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyan">assistant:</Text>
        <Text>{turn.text}</Text>
        {cited.length > 0 && (
          <Text dimColor>
            cited: {cited.map((id) => `[${id}]`).join(" ")}
          </Text>
        )}
      </Box>
    );
  }
  return (
    <Box marginBottom={1}>
      <Text dimColor>· {turn.text}</Text>
    </Box>
  );
};

const StatusLine: React.FC<{ status: ChatStatus }> = ({ status }) => {
  switch (status.kind) {
    case "idle":
      return <Text dimColor>ready — type /help for commands, /quit to exit</Text>;
    case "thinking":
      return (
        <Text color="cyan">
          <Spinner type="dots" /> thinking…
        </Text>
      );
    case "streaming":
      return (
        <Text color="cyan">
          <Spinner type="dots" /> streaming…
        </Text>
      );
    case "error":
      return <Text color="red">error: {status.message}</Text>;
  }
};

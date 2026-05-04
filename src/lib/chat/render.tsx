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
import { promoteToMemory, lastExchange, formatExchange, detectAutoPromote } from "./write.js";
import {
  inferIntent,
  describeIntent,
  isDestructive,
  shouldAutoAccept,
  recordAcceptance,
  newAcceptanceLog,
  IntentAcceptanceLog,
  InferredIntent,
} from "./intent.js";
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

  // Intent detection — inferred-but-not-yet-confirmed action
  const [pendingIntent, setPendingIntent] = useState<InferredIntent | null>(null);
  const acceptanceLogRef = useRef<IntentAcceptanceLog>(newAcceptanceLog());

  function nowIso(): string {
    return new Date().toISOString();
  }

  function pushSystem(lines: string | string[]): void {
    const arr = Array.isArray(lines) ? lines : [lines];
    setSystemNotice(arr);
    // Auto-clear after a few seconds so the buffer doesn't grow with stale notices
    setTimeout(() => setSystemNotice([]), 5000);
  }

  /** Run an inferred intent as if the user had typed the equivalent slash command. */
  async function executeIntent(intent: InferredIntent): Promise<void> {
    const cmdText = describeIntent(intent);
    appendEvent(header.sessionId, {
      type: "intent_inferred",
      ts: nowIso(),
      pattern: intent.matchedPattern ?? "(llm)",
      intent: intent.command,
      accepted: true,
    });
    // Re-enter handleSubmit with the slash form — reuses the existing dispatch path
    await handleSubmit(cmdText);
  }

  async function handleSubmit(raw: string): Promise<void> {
    const text = raw.trim();
    if (!text) {
      // Empty submit while a pending intent is shown → accept
      if (pendingIntent) {
        const intent = pendingIntent;
        recordAcceptance(acceptanceLogRef.current, intent.matchedPattern);
        setPendingIntent(null);
        setInput("");
        await executeIntent(intent);
        return;
      }
      return;
    }

    setInput("");

    // Pending-intent confirm step ──────────────────────────────────────
    if (pendingIntent) {
      const lower = text.toLowerCase();
      if (lower === "y" || lower === "yes") {
        const intent = pendingIntent;
        recordAcceptance(acceptanceLogRef.current, intent.matchedPattern);
        setPendingIntent(null);
        await executeIntent(intent);
        return;
      }
      if (lower === "n" || lower === "no") {
        appendEvent(header.sessionId, {
          type: "intent_inferred",
          ts: nowIso(),
          pattern: pendingIntent.matchedPattern ?? "(llm)",
          intent: pendingIntent.command,
          accepted: false,
        });
        setPendingIntent(null);
        pushSystem("Intent declined. Type your message normally.");
        return;
      }
      if (lower === "e" || lower === "edit") {
        // Drop the intent into the input box for tweaking
        const cmdText = describeIntent(pendingIntent);
        setPendingIntent(null);
        setInput(cmdText);
        return;
      }
      // Anything else cancels the pending intent and is treated as the new input
      setPendingIntent(null);
      pushSystem("Intent declined.");
      // Fall through to normal handling of `text`
    }

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
        case "remember": {
          const db = GnosysDB.openCentral();
          if (!db.isAvailable()) {
            pushSystem("Central DB unavailable");
            db.close();
            break;
          }
          try {
            const promoted = await promoteToMemory(db, {
              content: result.text,
              source: "remember",
              sessionId: header.sessionId,
              projectId,
              config: configRef.current,
            });
            appendEvent(header.sessionId, {
              type: "memory_promoted",
              ts: nowIso(),
              memory_id: promoted.id,
              source: "remember",
            });
            pushSystem(`Saved as ${promoted.id} — "${promoted.title}" [${promoted.category}]`);
          } catch (err) {
            pushSystem(`Failed to save: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            db.close();
          }
          break;
        }
        case "save-turn": {
          const pair = lastExchange(buffer);
          if (!pair) {
            pushSystem("No recent user+assistant exchange to save.");
            break;
          }
          const db = GnosysDB.openCentral();
          if (!db.isAvailable()) {
            pushSystem("Central DB unavailable");
            db.close();
            break;
          }
          try {
            const promoted = await promoteToMemory(db, {
              content: formatExchange(pair),
              source: "save-turn",
              sessionId: header.sessionId,
              projectId,
              config: configRef.current,
            });
            appendEvent(header.sessionId, {
              type: "memory_promoted",
              ts: nowIso(),
              memory_id: promoted.id,
              source: "save-turn",
            });
            pushSystem(`Saved exchange as ${promoted.id} — "${promoted.title}" [${promoted.category}]`);
          } catch (err) {
            pushSystem(`Failed to save: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            db.close();
          }
          break;
        }
        case "attach": {
          // Ingest the file via the existing multimodal pipeline, then pin
          // any resulting memories so they're injected into the next turn.
          pushSystem(`Ingesting ${result.filePath}…`);
          try {
            const { ingestFile } = await import("../multimodalIngest.js");
            const { GnosysResolver } = await import("../resolver.js");
            const r = new GnosysResolver();
            await r.resolve();
            const stores = r.getStores();
            if (stores.length === 0) {
              pushSystem("No store found — run 'gnosys init' first.");
              break;
            }
            const ingestResult = await ingestFile({
              filePath: result.filePath,
              storePath: stores[0].path,
            });
            const newIds = ingestResult.memories.map((m) => m.id).slice(0, 10);
            for (const id of newIds) {
              if (!pinnedIds.includes(id)) {
                setPinnedIds((p) => [...p, id]);
                appendEvent(header.sessionId, { type: "memory_promoted", ts: nowIso(), memory_id: id, source: "attach" });
                appendEvent(header.sessionId, { type: "pin", ts: nowIso(), memory_id: id });
              }
            }
            pushSystem(
              `Ingested ${newIds.length} memor${newIds.length === 1 ? "y" : "ies"} from ${result.filePath} — pinned for this session.`,
            );
          } catch (err) {
            pushSystem(`Attach failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          break;
        }
        case "error":
          pushSystem(`Error: ${result.message}`);
          break;
      }
      return;
    }

    // Free-text intent detection ──────────────────────────────────────
    // Try to map the user's natural-language input to a slash command.
    // If we find a match: auto-accept when the user has confirmed this
    // pattern N times before, or render a [Y/n/edit] confirm prompt.
    {
      const intent = await inferIntent(text, configRef.current);
      if (intent) {
        const auto = shouldAutoAccept(acceptanceLogRef.current, intent.matchedPattern);
        if (auto && !isDestructive(intent.command)) {
          await executeIntent(intent);
          return;
        }
        setPendingIntent(intent);
        appendEvent(header.sessionId, {
          type: "intent_inferred",
          ts: nowIso(),
          pattern: intent.matchedPattern ?? "(llm)",
          intent: intent.command,
          accepted: false, // not yet
        });
        return;
      }
    }

    // Chat turn path
    const userTurn: Turn = { role: "user", text, ts: nowIso() };
    setBuffer((b) => [...b, userTurn]);
    appendEvent(header.sessionId, { type: "user", ts: userTurn.ts, text });

    // Auto-promote heuristic — non-blocking hint; user can /save-turn
    // explicitly or ignore. We don't auto-write without consent.
    const hint = detectAutoPromote(text);
    if (hint) {
      pushSystem(`hint: that looks like a ${hint.reason} — type /save-turn after the response to capture it.`);
    }

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

      {pendingIntent && (
        <Box marginTop={1} flexDirection="column">
          <Text color="magenta">
            inferred: {describeIntent(pendingIntent)}{isDestructive(pendingIntent.command) ? " (destructive)" : ""}
          </Text>
          <Text dimColor>[Y]es · [N]o · [E]dit · or type a new message</Text>
        </Box>
      )}

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

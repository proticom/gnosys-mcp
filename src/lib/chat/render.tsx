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
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import type { ChatHeaderInfo, ChatStatus, Turn } from "./types.js";
import { dispatchCommand, type CommandContext, listCommands } from "./commands.js";
import { SlashPalette, filterCommands } from "./SlashPalette.js";
import { THEME, ROLES } from "./theme.js";
import { BootSplash } from "./boot-splash.js";
import { MarkdownRenderer } from "./components/MarkdownRenderer.js";
import { ToolCallCard } from "./components/ToolCallCard.js";
import { appendEvent } from "./session.js";
import { runTurn, buildProvider } from "./llmTurn.js";
import { runRecall, reinforceMemory, buildRecallQuery, type RecallScope } from "./recall.js";
import { promoteToMemory, lastExchange, formatExchange, detectAutoPromote } from "./write.js";
import {
  inferIntent,
  describeIntent,
  isDestructive,
  shouldAutoAccept,
  recordAcceptance,
  newAcceptanceLog,
  type IntentAcceptanceLog,
  type InferredIntent,
} from "./intent.js";
import { extractChooseFence, type ChooseBlock, type ChooseOption, formatSelection } from "./choose.js";
import {
  newFocusState,
  applyFocus,
  applyBranch,
  applyResumeFocus,
  popBranch,
  type FocusState,
} from "./focus.js";
import type { GnosysConfig, LLMProviderName } from "../config.js";
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

  // Multiple-choice — when the LLM emits a gnosys-choose fence, capture
  // the block here and render a SelectInput in place of the regular text input.
  const [pendingChoice, setPendingChoice] = useState<ChooseBlock | null>(null);

  // Focus boundaries — declared topic + saved snapshots + branch stack
  const [focusState, setFocusState] = useState<FocusState>(newFocusState());

  // v5.8.0 (#5): slash-command palette state. Opens when input starts with "/",
  // closes on Esc or when input no longer starts with "/". paletteIndex is the
  // highlighted match; Enter replaces the input with the chosen command name.
  const [paletteIndex, setPaletteIndex] = useState(0);
  const paletteOpen = input.startsWith("/") && !pendingChoice && !pendingIntent;
  const allCommands = React.useMemo(() => listCommands(), []);
  const paletteMatches = React.useMemo(
    () => (paletteOpen ? filterCommands(allCommands, input) : []),
    [paletteOpen, input, allCommands],
  );

  // Reset palette selection when the filter changes (avoids landing on a
  // stale index that points past the end of the new match list).
  useEffect(() => {
    setPaletteIndex(0);
  }, [input]);

  useInput(
    (rawInput, key) => {
      if (!paletteOpen) return;
      if (paletteMatches.length === 0) {
        if (key.escape) setInput("");
        return;
      }
      if (key.upArrow) {
        setPaletteIndex((i) => (i <= 0 ? paletteMatches.length - 1 : i - 1));
      } else if (key.downArrow) {
        setPaletteIndex((i) => (i >= paletteMatches.length - 1 ? 0 : i + 1));
      } else if (key.escape) {
        // Dismiss the palette by clearing the leading slash.
        setInput("");
      } else if (key.tab) {
        // Tab autocompletes the highlighted command into the input,
        // leaving the cursor at the end (with a trailing space so the
        // user can keep typing arguments).
        const chosen = paletteMatches[paletteIndex];
        if (chosen) setInput(`${chosen.name} `);
      }
    },
    { isActive: paletteOpen },
  );

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
        case "focus": {
          const updated = applyFocus(focusState, buffer, result.topic, nowIso());
          setFocusState(updated.state);
          setBuffer(updated.buffer);
          appendEvent(header.sessionId, {
            type: "focus",
            ts: nowIso(),
            topic: result.topic,
            previous_topic: updated.previousTopic ?? undefined,
          });
          pushSystem(
            updated.previousTopic
              ? `Focus: ${result.topic} (${updated.previousTopic} stashed — /resume-focus ${updated.previousTopic})`
              : `Focus: ${result.topic}`,
          );
          break;
        }
        case "branch": {
          if (buffer.length === 0) {
            pushSystem("Nothing to branch — buffer is empty.");
            break;
          }
          setFocusState(applyBranch(focusState, buffer, nowIso()));
          appendEvent(header.sessionId, {
            type: "branch",
            ts: nowIso(),
            from_session: header.sessionId,
            new_session: header.sessionId, // Phase 7 keeps the same session log
          });
          pushSystem(
            `Branch saved (${focusState.branches.length + 1} on stack — /resume-focus to pop the latest).`,
          );
          break;
        }
        case "resume-focus": {
          if (result.topic) {
            const restored = applyResumeFocus(focusState, buffer, result.topic, nowIso());
            if (!restored) {
              pushSystem(`No saved focus named "${result.topic}".`);
              break;
            }
            setFocusState(restored.state);
            setBuffer(restored.buffer);
            pushSystem(`Resumed focus: ${result.topic}`);
          } else {
            // No arg → pop most recent branch
            const popped = popBranch(focusState);
            if (!popped) {
              pushSystem("No branches on the stack and no topic given.");
              break;
            }
            setFocusState(popped.state);
            setBuffer(popped.buffer);
            pushSystem(`Restored branch (focus: ${popped.topic})`);
          }
          break;
        }
        case "export-session": {
          try {
            const { writeFileSync } = await import("fs");
            const path = await import("path");
            const md = renderSessionAsMarkdown(buffer, header.sessionId);
            const targetPath = path.resolve(result.filePath);
            writeFileSync(targetPath, md, "utf-8");
            pushSystem(`Exported ${buffer.length} turn(s) to ${targetPath}`);
          } catch (err) {
            pushSystem(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          break;
        }
        case "search-chats": {
          const { searchSessions } = await import("./session.js");
          const matches = searchSessions(result.query, 20);
          if (matches.length === 0) {
            pushSystem(`No matches for: ${result.query}`);
            break;
          }
          const lines = [`${matches.length} match(es):`];
          for (const m of matches.slice(0, 15)) {
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
            const preview = text.length > 80 ? text.slice(0, 77) + "..." : text;
            lines.push(`  ${m.sessionId.slice(0, 12)}…  [${m.event.type}]  ${preview}`);
          }
          pushSystem(lines);
          break;
        }
        case "dream-here": {
          // Run a focused dream cycle scoped to the memories surfaced in this session.
          // Pulls the cited_memory_ids from the session log and uses them as the
          // workset for the dream engine.
          pushSystem("Starting dream cycle for this session…");
          try {
            const { GnosysDB } = await import("../db.js");
            const { GnosysDreamEngine } = await import("../dream.js");
            const { readSession } = await import("./session.js");
            const db = GnosysDB.openCentral();
            if (!db.isAvailable()) {
              pushSystem("Central DB unavailable");
              db.close();
              break;
            }
            try {
              const events = readSession(header.sessionId);
              const cited = new Set<string>();
              for (const e of events) {
                if (e.type === "assistant" && e.cited_memory_ids) {
                  for (const id of e.cited_memory_ids) cited.add(id);
                }
                if (e.type === "recall") {
                  for (const id of e.memory_ids) cited.add(id);
                }
              }
              if (cited.size === 0) {
                pushSystem("No memories surfaced this session yet — nothing to dream on.");
                db.close();
                break;
              }
              const engine = new GnosysDreamEngine(db, configRef.current, {
                enabled: true,
                idleMinutes: 0,
                maxRuntimeMinutes: 5,
                selfCritique: true,
                generateSummaries: false,
                discoverRelationships: true,
                minMemories: 1,
                provider: configRef.current.dream?.provider ?? "ollama",
                model: configRef.current.dream?.model,
              });
              const report = await engine.dream();
              pushSystem(`Dream complete — duration ${report.durationMs}ms; surfaced ${cited.size} session memories.`);
            } finally {
              db.close();
            }
          } catch (err) {
            pushSystem(`Dream-here failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          break;
        }
        case "error":
          pushSystem(`Error: ${result.message}`);
          break;
      }
      return;
    }

    // v5.8.0 (#3): push the user turn into the buffer SYNCHRONOUSLY here,
    // before any await. React 19's automatic batching folds this setBuffer
    // call together with the setInput("") at line ~126 into one render —
    // so the user sees input-clear + user-turn-pushed in the same frame.
    // Previously: the await on inferIntent yielded between those two state
    // updates, producing a visible glitch where the input cleared but no
    // user turn appeared until the LLM intent inference completed.
    //
    // If intent inference matches and auto-runs, the user's natural-language
    // text still shows in the buffer (which is honest — they typed it),
    // followed by the slash-command result.
    //
    // v5.8.0 (#6): also flip the status to "thinking" right here, before
    // any sync work (recall, autoPromote, etc.) or async await. Batched
    // together with the input-clear + user-turn-push, so the spinner
    // appears in the same frame the user sees their message land.
    const userTurn: Turn = { role: "user", text, ts: nowIso() };
    setBuffer((b) => [...b, userTurn]);
    setStatus({ kind: "thinking" });
    appendEvent(header.sessionId, { type: "user", ts: userTurn.ts, text });

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

    // Auto-promote heuristic — non-blocking hint; user can /save-turn
    // explicitly or ignore. We don't auto-write without consent.
    const hint = detectAutoPromote(text);
    if (hint) {
      pushSystem(`hint: that looks like a ${hint.reason} — type /save-turn after the response to capture it.`);
    }

    // File-path detection — suggest /attach if the user pasted a path
    const detectedPath = detectFilePath(text);
    if (detectedPath) {
      pushSystem(`hint: detected file path "${detectedPath}" — type "/attach ${detectedPath}" to ingest it.`);
    }

    // v5.8.0 (#6): status was already flipped to "thinking" up at the
    // user-turn-push, so the spinner is visible the moment the user
    // submits — no duplicate setStatus here.

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
      // v5.8.0 (#6): smoother streaming — batch token updates into ~16ms
      // chunks (one render frame at 60Hz) instead of firing setStatus on
      // every token. Reduces ink render jitter on fast providers (Groq /
      // xAI / cached responses) where tokens land at 100+/sec.
      let lastRenderAt = 0;
      const flushPartial = () => {
        setStatus({ kind: "streaming", partial });
        lastRenderAt = Date.now();
      };
      // v5.9.0 (#101 phase δ): collect tool calls into a per-turn record list
      // so the assistant turn can render them as inline cards instead of
      // ephemeral system notices.
      const turnToolCalls: Array<{
        tool: string;
        args: Record<string, string>;
        result?: string;
        error?: string;
        ts: string;
      }> = [];
      const result = await runTurn(configRef.current, {
        buffer: [...buffer, userTurn],
        userInput: text,
        recalled,
        onToken: (tok) => {
          partial += tok;
          if (Date.now() - lastRenderAt >= 16) flushPartial();
        },
        onToolCall: (info) => {
          turnToolCalls.push({
            tool: info.tool,
            args: info.args,
            result: info.error ? undefined : info.result,
            error: info.error,
            ts: nowIso(),
          });
          appendEvent(header.sessionId, {
            type: "command",
            ts: nowIso(),
            name: `tool:${info.tool}`,
            args: Object.entries(info.args).map(([k, v]) => `${k}=${v}`),
            result: info.result?.slice(0, 200),
          });
        },
      });

      // v5.8.0 (#6): flush any partial that didn't make the last 16ms tick
      // so the final "streaming" frame matches the full result text.
      if (partial.length > 0) flushPartial();

      // Check for gnosys-choose fence — if present, strip it from the
      // visible turn and surface as an interactive picker.
      const fence = extractChooseFence(result.text);

      let visibleText = result.text;
      let pendingBlock: ChooseBlock | null = null;
      if (fence?.kind === "ok") {
        visibleText = [fence.before, fence.after].filter((s) => s.length > 0).join("\n\n");
        pendingBlock = fence.block;
        appendEvent(header.sessionId, {
          type: "choice_offered",
          ts: nowIso(),
          prompt: fence.block.prompt,
          option_ids: fence.block.options.map((o) => o.id),
        });
      } else if (fence?.kind === "parse-error") {
        // Fail-soft: leave the raw fence in the visible text so the user can
        // see what the LLM tried to emit. Log the parse error for debugging.
        pushSystem(`malformed gnosys-choose fence: ${fence.reason}`);
        appendEvent(header.sessionId, {
          type: "error",
          ts: nowIso(),
          message: `gnosys-choose parse error: ${fence.reason}`,
        });
      }

      const assistantTurn: Turn = {
        role: "assistant",
        text: visibleText,
        ts: nowIso(),
        provider: result.provider,
        model: result.model,
        citedMemoryIds: result.recalledIds,
        // v5.9.0 (#101 phase δ): attach this turn's tool calls so they
        // render as inline cards inside ConversationTurn.
        toolCalls: turnToolCalls.length > 0 ? turnToolCalls : undefined,
      };
      setBuffer((b) => [...b, assistantTurn]);
      appendEvent(header.sessionId, {
        type: "assistant",
        ts: assistantTurn.ts,
        text: result.text, // log the FULL text (including fence) for fidelity
        provider: result.provider,
        model: result.model,
        cited_memory_ids: result.recalledIds,
      });

      if (pendingBlock) {
        setPendingChoice(pendingBlock);
      }

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
      <ChatHeader
        info={header}
        recallScope={scope}
        threshold={threshold}
        pinnedCount={pinnedIds.length}
        focus={focusState.current}
        branchCount={focusState.branches.length}
      />

      {/* v5.9.0 (#101 phase α): boot splash shows only on truly fresh
          sessions (empty buffer) — disappears as soon as the first turn
          lands so it doesn't waste vertical space mid-conversation. */}
      {buffer.length === 0 && status.kind === "idle" && (
        <BootSplash
          subtitle={`memory for ai agents · ${header.provider}/${header.model}`}
        />
      )}

      <Box flexDirection="column" marginTop={1}>
        {buffer.map((turn, i) => (
          <ConversationTurn key={i} turn={turn} />
        ))}
        {status.kind === "streaming" && (
          <Box flexDirection="column">
            <Text color={ROLES.assistant} bold>
              gnosys
            </Text>
            <Text color={THEME.text}>{status.partial}</Text>
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
          <Text color={THEME.accentHover}>
            inferred: {describeIntent(pendingIntent)}{isDestructive(pendingIntent.command) ? " (destructive)" : ""}
          </Text>
          <Text color={THEME.muted}>[Y]es · [N]o · [E]dit · or type a new message</Text>
        </Box>
      )}

      {pendingChoice ? (
        <ChoosePicker
          block={pendingChoice}
          onSelect={async (option) => {
            const selectionText = formatSelection(option);
            appendEvent(header.sessionId, {
              type: "choice_made",
              ts: nowIso(),
              option_id: option.id,
              label: option.label,
            });
            setPendingChoice(null);
            // Fire the selection as a synthetic user turn — runs through
            // the normal handleSubmit path so recall + LLM happen.
            await handleSubmit(selectionText);
          }}
        />
      ) : (
        <Box flexDirection="column">
          {/* v5.8.0 (#6): paste preview — when the input crosses the paste
              threshold (newlines or >200 chars), surface a compact summary
              above the editor so the buffer doesn't get visually swamped.
              The actual input value is unchanged; this is purely a hint. */}
          {(() => {
            const PASTE_CHARS = 200;
            const isPasted = input.includes("\n") || input.length > PASTE_CHARS;
            if (!isPasted) return null;
            const lines = input.split("\n").length;
            const chars = input.length;
            const firstLine = input.split("\n")[0].slice(0, 60);
            return (
              <Box marginTop={1}>
                <Text dimColor>
                  [paste: {lines} line{lines !== 1 ? "s" : ""}, {chars} chars
                  {firstLine && firstLine !== input ? ` — "${firstLine}…"` : ""}
                  ] — Enter to submit
                </Text>
              </Box>
            );
          })()}
          <Box marginTop={1}>
            <Text>&gt; </Text>
            <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
          </Box>
          {/* v5.8.0 (#5): slash-command palette — opens when input starts with "/" */}
          {paletteOpen && (
            <SlashPalette
              filter={input}
              commands={allCommands}
              selectedIndex={paletteIndex}
            />
          )}
        </Box>
      )}
    </Box>
  );
};

/** Render the conversation buffer as a human-readable markdown transcript for /export. */
function renderSessionAsMarkdown(buffer: Turn[], sessionId: string): string {
  const lines: string[] = [
    `# Gnosys chat session ${sessionId}`,
    ``,
    `_Exported ${new Date().toISOString()}_`,
    ``,
    `---`,
    ``,
  ];
  for (const turn of buffer) {
    if (turn.role === "user") {
      lines.push(`## You`);
      lines.push(turn.text);
      lines.push(``);
    } else if (turn.role === "assistant") {
      const provider = turn.provider ? ` (${turn.provider}/${turn.model})` : "";
      lines.push(`## Assistant${provider}`);
      lines.push(turn.text);
      if (turn.citedMemoryIds && turn.citedMemoryIds.length > 0) {
        lines.push(``);
        lines.push(`_cited: ${turn.citedMemoryIds.map((id) => `\`${id}\``).join(", ")}_`);
      }
      lines.push(``);
    } else if (turn.role === "system") {
      lines.push(`> ${turn.text}`);
      lines.push(``);
    }
  }
  return lines.join("\n");
}

/** Detect a file path in user input — returns the path if found, null otherwise. */
function detectFilePath(text: string): string | null {
  // Match common file path formats — absolute, ~, or ./relative — with extensions
  const m = text.match(/(?<![\w/])((?:~|\.{1,2})?\/[^\s]+\.(?:pdf|md|txt|docx|png|jpg|jpeg|gif|mp3|wav|m4a|mp4|mov|webm))/i);
  return m ? m[1] : null;
}

const ChoosePicker: React.FC<{ block: ChooseBlock; onSelect: (opt: ChooseOption) => void }> = ({ block, onSelect }) => {
  const items = block.options.map((opt) => ({
    label: opt.detail ? `${opt.label}  —  ${opt.detail}` : opt.label,
    value: opt.id,
  }));
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={THEME.accent} bold>
        {block.prompt}
      </Text>
      <SelectInput
        items={items}
        onSelect={(item) => {
          const picked = block.options.find((o) => o.id === item.value);
          if (picked) onSelect(picked);
        }}
      />
    </Box>
  );
};

const ChatHeader: React.FC<{
  info: ChatHeaderInfo;
  recallScope: RecallScope;
  threshold: number;
  pinnedCount: number;
  focus: string | null;
  branchCount: number;
}> = ({ info, recallScope, threshold, pinnedCount, focus, branchCount }) => (
  <Box flexDirection="column">
    <Box>
      <Text color={THEME.accent} bold>
        gnosys
      </Text>
      <Text color={THEME.muted}>  ·  </Text>
      <Text color={THEME.muted}>session={info.sessionId.slice(0, 8)}…</Text>
      <Text color={THEME.muted}>  ·  </Text>
      {info.projectName && (
        <>
          <Text color={THEME.muted}>project={info.projectName}</Text>
          <Text color={THEME.muted}>  ·  </Text>
        </>
      )}
      <Text color={THEME.muted}>{info.provider}/{info.model}</Text>
    </Box>
    <Box>
      <Text color={THEME.muted}>recall: scope={recallScope}</Text>
      <Text color={THEME.muted}>  ·  </Text>
      <Text color={THEME.muted}>threshold={threshold.toFixed(2)}</Text>
      <Text color={THEME.muted}>  ·  </Text>
      <Text color={THEME.muted}>pinned={pinnedCount}</Text>
      {focus && (
        <>
          <Text color={THEME.muted}>  ·  </Text>
          <Text color={THEME.accentHover}>focus={focus}</Text>
        </>
      )}
      {branchCount > 0 && (
        <>
          <Text color={THEME.muted}>  ·  </Text>
          <Text color={THEME.muted}>branches={branchCount}</Text>
        </>
      )}
    </Box>
  </Box>
);

const ConversationTurn: React.FC<{ turn: Turn }> = ({ turn }) => {
  // v5.9.0 (#101 phase α): role-colored turn labels using the brand palette.
  // - user label: brand red
  // - assistant label: text primary (de-emphasized so prose carries it)
  // - system: muted gray
  if (turn.role === "user") {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color={ROLES.user} bold>
          you
        </Text>
        <Text color={THEME.text}>{turn.text}</Text>
      </Box>
    );
  }
  if (turn.role === "assistant") {
    const cited = turn.citedMemoryIds ?? [];
    const toolCalls = turn.toolCalls ?? [];
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color={ROLES.assistant} bold>
          gnosys
        </Text>
        {/* v5.9.0 (#101 phase β): full markdown rendering for assistant turns. */}
        <MarkdownRenderer text={turn.text} />
        {/* v5.9.0 (#101 phase δ): tool-call cards (collapsed by default). */}
        {toolCalls.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {toolCalls.map((call, i) => (
              <ToolCallCard key={i} call={call} expanded={false} />
            ))}
          </Box>
        )}
        {cited.length > 0 && (
          <Text color={THEME.muted}>
            cited: {cited.map((id) => `[${id}]`).join(" ")}
          </Text>
        )}
      </Box>
    );
  }
  return (
    <Box marginBottom={1}>
      <Text color={ROLES.system}>· {turn.text}</Text>
    </Box>
  );
};

const StatusLine: React.FC<{ status: ChatStatus }> = ({ status }) => {
  switch (status.kind) {
    case "idle":
      return (
        <Text color={THEME.muted}>
          ready — type /help for commands, /quit to exit
        </Text>
      );
    case "thinking":
      return (
        <Text color={ROLES.spinner}>
          <Spinner type="dots" /> thinking…
        </Text>
      );
    case "streaming":
      return (
        <Text color={ROLES.spinner}>
          <Spinner type="dots" /> streaming…
        </Text>
      );
    case "error":
      return <Text color={THEME.error}>error: {status.message}</Text>;
  }
};

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
import { GnosysConfig, LLMProviderName } from "../config.js";

export interface ChatAppProps {
  initialHeader: ChatHeaderInfo;
  initialBuffer: Turn[];
  config: GnosysConfig;
  /** Called on exit so the parent CLI process can clean up. */
  onExit?: () => void;
}

export const ChatApp: React.FC<ChatAppProps> = ({ initialHeader, initialBuffer, config, onExit }) => {
  const { exit } = useApp();
  const [header, setHeader] = useState<ChatHeaderInfo>(initialHeader);
  const [buffer, setBuffer] = useState<Turn[]>(initialBuffer);
  const [status, setStatus] = useState<ChatStatus>({ kind: "idle" });
  const [input, setInput] = useState<string>("");
  const [systemNotice, setSystemNotice] = useState<string[]>([]);
  const configRef = useRef<GnosysConfig>(config);

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

    setStatus({ kind: "streaming", partial: "" });

    try {
      let partial = "";
      const result = await runTurn(configRef.current, {
        buffer: [...buffer, userTurn],
        userInput: text,
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
      };
      setBuffer((b) => [...b, assistantTurn]);
      appendEvent(header.sessionId, {
        type: "assistant",
        ts: assistantTurn.ts,
        text: result.text,
        provider: result.provider,
        model: result.model,
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
      <ChatHeader info={header} />

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

const ChatHeader: React.FC<{ info: ChatHeaderInfo }> = ({ info }) => (
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
    <Text>  </Text>
    <Text dimColor>tok in:{info.tokensIn} out:{info.tokensOut}</Text>
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
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color="cyan">assistant:</Text>
        <Text>{turn.text}</Text>
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

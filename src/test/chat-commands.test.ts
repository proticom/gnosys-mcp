/**
 * Phase 2 — slash command dispatcher tests.
 *
 * Each command has a focused unit test verifying its CommandResult shape
 * without booting the full ink TUI. Commands that touch the central DB
 * (read, dashboard) are verified at the dispatch level only — actual DB
 * paths are exercised in their owning test files.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  dispatchCommand,
  findCommand,
  listCommands,
  CommandContext,
} from "../lib/chat/commands.js";
import { Turn } from "../lib/chat/types.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "gnosys-cmd-test-"));
  process.env.GNOSYS_CHAT_SESSIONS_DIR = tmp;
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.GNOSYS_CHAT_SESSIONS_DIR;
});

const baseCtx: CommandContext = {
  sessionId: "01HXX",
  buffer: [],
  provider: "anthropic",
  model: "claude-sonnet-4-6",
};

describe("chat command registry", () => {
  it("listCommands returns the phase 2+3 commands", () => {
    const cmds = listCommands();
    const names = cmds.map((c) => c.name);
    // Phase 2
    expect(names).toContain("/help");
    expect(names).toContain("/clear");
    expect(names).toContain("/quit");
    expect(names).toContain("/history");
    expect(names).toContain("/read");
    expect(names).toContain("/list");
    expect(names).toContain("/tags");
    expect(names).toContain("/dashboard");
    expect(names).toContain("/provider");
    // Phase 3
    expect(names).toContain("/pin");
    expect(names).toContain("/unpin");
    expect(names).toContain("/scope");
    expect(names).toContain("/threshold");
    expect(names).toContain("/recall");
    expect(names).toContain("/reinforce");
    expect(cmds.length).toBeGreaterThanOrEqual(15);
  });

  it("findCommand resolves aliases (case-insensitive)", () => {
    expect(findCommand("/quit")?.name).toBe("/quit");
    expect(findCommand("/exit")?.name).toBe("/quit");
    expect(findCommand("/Q")?.name).toBe("/quit");
  });

  it("findCommand returns undefined for unknown name", () => {
    expect(findCommand("/blarg")).toBeUndefined();
  });
});

describe("dispatchCommand", () => {
  it("returns null for non-slash input (chat turn passthrough)", async () => {
    const result = await dispatchCommand("hello there", baseCtx);
    expect(result).toBeNull();
  });

  it("/help returns multi-line show result", async () => {
    const result = await dispatchCommand("/help", baseCtx);
    expect(result?.kind).toBe("show");
    if (result?.kind === "show") {
      expect(result.lines.some((l) => l.includes("/help"))).toBe(true);
      expect(result.lines.some((l) => l.includes("/quit"))).toBe(true);
    }
  });

  it("/clear returns clear-buffer result", async () => {
    const result = await dispatchCommand("/clear", baseCtx);
    expect(result?.kind).toBe("clear-buffer");
  });

  it("/quit returns exit result (and aliases /exit /q work)", async () => {
    expect((await dispatchCommand("/quit", baseCtx))?.kind).toBe("exit");
    expect((await dispatchCommand("/exit", baseCtx))?.kind).toBe("exit");
    expect((await dispatchCommand("/q", baseCtx))?.kind).toBe("exit");
  });

  it("/history returns the buffer turn-by-turn", async () => {
    const buffer: Turn[] = [
      { role: "user", text: "hi", ts: new Date().toISOString() },
      { role: "assistant", text: "hello", ts: new Date().toISOString() },
    ];
    const result = await dispatchCommand("/history", { ...baseCtx, buffer });
    expect(result?.kind).toBe("show");
    if (result?.kind === "show") {
      expect(result.lines[0]).toContain("2 turn");
      expect(result.lines[1]).toContain("user");
      expect(result.lines[2]).toContain("assistant");
    }
  });

  it("/history on an empty buffer reports (no turns yet)", async () => {
    const result = await dispatchCommand("/history", baseCtx);
    expect(result?.kind).toBe("show");
    if (result?.kind === "show") {
      expect(result.lines[0]).toMatch(/no turns/i);
    }
  });

  it("/provider with no args returns error result", async () => {
    const result = await dispatchCommand("/provider", baseCtx);
    expect(result?.kind).toBe("error");
  });

  it("/provider with a name returns switch-provider result", async () => {
    const result = await dispatchCommand("/provider ollama", baseCtx);
    expect(result?.kind).toBe("switch-provider");
    if (result?.kind === "switch-provider") {
      expect(result.provider).toBe("ollama");
    }
  });

  it("/provider with name + model passes both through", async () => {
    const result = await dispatchCommand("/provider anthropic claude-haiku-4-5-20251001", baseCtx);
    expect(result?.kind).toBe("switch-provider");
    if (result?.kind === "switch-provider") {
      expect(result.provider).toBe("anthropic");
      expect(result.model).toBe("claude-haiku-4-5-20251001");
    }
  });

  it("unknown slash command returns error", async () => {
    const result = await dispatchCommand("/blarg", baseCtx);
    expect(result?.kind).toBe("error");
    if (result?.kind === "error") {
      expect(result.message).toMatch(/unknown/i);
    }
  });

  it("/list returns show result with no sessions message when empty", async () => {
    const result = await dispatchCommand("/list", baseCtx);
    expect(result?.kind).toBe("show");
    if (result?.kind === "show") {
      expect(result.lines[0]).toMatch(/no sessions/i);
    }
  });

  it("/read with no args returns usage error", async () => {
    const result = await dispatchCommand("/read", baseCtx);
    expect(result?.kind).toBe("error");
  });

  // ─── Phase 3 commands ─────────────────────────────────────────────────

  it("/pin with id returns pin result", async () => {
    const result = await dispatchCommand("/pin deci-037", baseCtx);
    expect(result?.kind).toBe("pin");
    if (result?.kind === "pin") expect(result.memoryId).toBe("deci-037");
  });

  it("/unpin returns unpin result", async () => {
    const result = await dispatchCommand("/unpin deci-037", baseCtx);
    expect(result?.kind).toBe("unpin");
  });

  it("/scope with valid value returns scope result", async () => {
    const result = await dispatchCommand("/scope project", baseCtx);
    expect(result?.kind).toBe("scope");
    if (result?.kind === "scope") expect(result.scope).toBe("project");
  });

  it("/scope with invalid value returns error", async () => {
    const result = await dispatchCommand("/scope nonsense", baseCtx);
    expect(result?.kind).toBe("error");
  });

  it("/threshold accepts 0.0 to 1.0", async () => {
    const result = await dispatchCommand("/threshold 0.7", baseCtx);
    expect(result?.kind).toBe("threshold");
    if (result?.kind === "threshold") expect(result.value).toBe(0.7);
  });

  it("/threshold rejects out-of-range", async () => {
    expect((await dispatchCommand("/threshold 1.5", baseCtx))?.kind).toBe("error");
    expect((await dispatchCommand("/threshold -0.1", baseCtx))?.kind).toBe("error");
    expect((await dispatchCommand("/threshold abc", baseCtx))?.kind).toBe("error");
  });

  it("/recall returns preview-recall result with the joined query", async () => {
    const result = await dispatchCommand("/recall how does ULID encoding work", baseCtx);
    expect(result?.kind).toBe("preview-recall");
    if (result?.kind === "preview-recall") {
      expect(result.query).toBe("how does ULID encoding work");
    }
  });

  it("/reinforce returns reinforce result", async () => {
    const result = await dispatchCommand("/reinforce deci-037", baseCtx);
    expect(result?.kind).toBe("reinforce");
    if (result?.kind === "reinforce") expect(result.memoryId).toBe("deci-037");
  });
});

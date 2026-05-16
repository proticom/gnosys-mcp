/**
 * v5.8.4 — regression test for the updateConfig anthropic-revert bug.
 *
 * Before v5.8.4, calling `updateConfig` with a partial update against a
 * missing gnosys.json would silently seed the file with all the schema's
 * defaults — including `llm.defaultProvider: "anthropic"`. That clobbered
 * a value the user might have set via env var, keychain, or a previous
 * session that hadn't yet been persisted to that exact path.
 *
 * Fix: updateConfig now reads via `readRawConfig` (raw JSON, no defaults
 * applied) and writes only the raw merged object. The schema still
 * validates for shape, but defaults aren't persisted.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";

import { updateConfig } from "../lib/config.js";

describe("updateConfig — v5.8.4 anthropic-revert regression", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-updateConfig-"));
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  async function readJSON(p: string): Promise<Record<string, unknown>> {
    return JSON.parse(await fsp.readFile(p, "utf8"));
  }

  it("writes only the keys the caller supplied + any that were already in the file (no defaults seeded)", async () => {
    // No existing gnosys.json. updateConfig writes only the chat section.
    await updateConfig(scratch, {
      chat: { toolsEnabled: false, autoSummarizeAfterTurns: 5, systemPromptPrefix: "" },
    });

    const raw = await readJSON(path.join(scratch, "gnosys.json"));

    // The chat section should be present.
    expect(raw.chat).toEqual({
      toolsEnabled: false,
      autoSummarizeAfterTurns: 5,
      systemPromptPrefix: "",
    });

    // CRITICAL: llm / llm.defaultProvider must NOT have been seeded with
    // the schema default. If this regresses, future setup-chat-from-fresh
    // runs will silently revert the user's provider to "anthropic".
    expect(raw.llm).toBeUndefined();
    expect(raw.defaultProvider).toBeUndefined();
  });

  it("preserves explicit values already in the file when adding a new section", async () => {
    // Seed the file with an explicit xai provider (this is how the user's
    // real-world config looks after running `gnosys setup models`).
    const initial = {
      llm: {
        defaultProvider: "xai",
        xai: { model: "grok-4.20" },
      },
    };
    await fsp.writeFile(
      path.join(scratch, "gnosys.json"),
      JSON.stringify(initial, null, 2),
      "utf8",
    );

    // Now add a chat section (the v5.8.0 setup-chat flow).
    await updateConfig(scratch, {
      chat: { toolsEnabled: true, autoSummarizeAfterTurns: 0, systemPromptPrefix: "" },
    });

    const raw = await readJSON(path.join(scratch, "gnosys.json"));

    // The xai provider must survive — the bug we're regression-testing.
    expect((raw.llm as Record<string, unknown>)?.defaultProvider).toBe("xai");
    expect((raw.llm as Record<string, unknown>)?.xai).toEqual({ model: "grok-4.20" });
    // And the new chat section landed.
    expect((raw.chat as Record<string, unknown>)?.toolsEnabled).toBe(true);
  });

  it("deep-merges nested objects rather than replacing them outright", async () => {
    // Seed with a partial llm section.
    const initial = {
      llm: {
        defaultProvider: "xai",
        xai: { model: "grok-4.20" },
        openai: { model: "gpt-5.4-mini" },
      },
    };
    await fsp.writeFile(
      path.join(scratch, "gnosys.json"),
      JSON.stringify(initial, null, 2),
      "utf8",
    );

    // Update just llm.xai.model — the merge should keep openai intact AND
    // keep defaultProvider.
    await updateConfig(scratch, {
      llm: { xai: { model: "grok-4.3" } },
    });

    const raw = await readJSON(path.join(scratch, "gnosys.json"));
    const llm = raw.llm as Record<string, unknown>;
    expect(llm.defaultProvider).toBe("xai");
    expect(llm.xai).toEqual({ model: "grok-4.3" });
    expect(llm.openai).toEqual({ model: "gpt-5.4-mini" });
  });
});

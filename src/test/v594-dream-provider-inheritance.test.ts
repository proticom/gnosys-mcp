/**
 * v5.9.4 Bug 6 — `loadConfig` post-processes `dream.provider` to inherit
 * from `llm.defaultProvider` when the user never set ollama explicitly.
 *
 * Detection: dream.provider missing from raw config AND no `llm.ollama`
 * block. Either signal means the user opted into ollama; we leave it alone.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { loadConfig } from "../lib/config.js";

describe("v5.9.4 Bug 6 — dream.provider inheritance from llm.defaultProvider", () => {
  let tmp: string;
  const originalHome = process.env.GNOSYS_HOME;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-dream-inherit-"));
    // Point GNOSYS_HOME at a sibling so loadConfig doesn't think we're loading
    // the global config (which short-circuits the project-vs-global merge).
    process.env.GNOSYS_HOME = path.join(tmp, "global");
    fs.mkdirSync(process.env.GNOSYS_HOME, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    if (originalHome === undefined) delete process.env.GNOSYS_HOME;
    else process.env.GNOSYS_HOME = originalHome;
  });

  it("dream.provider inherits defaultProvider when neither dream.provider nor llm.ollama is set", async () => {
    fs.writeFileSync(
      path.join(tmp, "gnosys.json"),
      JSON.stringify({
        llm: { defaultProvider: "xai", xai: { model: "grok-4.3" } },
      }),
    );
    const cfg = await loadConfig(tmp);
    expect(cfg.dream.provider).toBe("xai");
  });

  it("dream.provider stays ollama when user has an llm.ollama block (explicit opt-in)", async () => {
    fs.writeFileSync(
      path.join(tmp, "gnosys.json"),
      JSON.stringify({
        llm: {
          defaultProvider: "anthropic",
          anthropic: { model: "claude-sonnet-4-6" },
          ollama: { baseUrl: "http://localhost:11434" },
        },
      }),
    );
    const cfg = await loadConfig(tmp);
    expect(cfg.dream.provider).toBe("ollama");
  });

  it("dream.provider is left alone when user explicitly set it (even to ollama)", async () => {
    fs.writeFileSync(
      path.join(tmp, "gnosys.json"),
      JSON.stringify({
        llm: { defaultProvider: "xai", xai: { model: "grok-4.3" } },
        dream: { provider: "ollama" },
      }),
    );
    const cfg = await loadConfig(tmp);
    expect(cfg.dream.provider).toBe("ollama");
  });

  it("dream.provider takes the user's explicit value over inheritance", async () => {
    fs.writeFileSync(
      path.join(tmp, "gnosys.json"),
      JSON.stringify({
        llm: { defaultProvider: "anthropic", anthropic: { model: "claude-sonnet-4-6" } },
        dream: { provider: "groq" },
      }),
    );
    const cfg = await loadConfig(tmp);
    expect(cfg.dream.provider).toBe("groq");
  });

  it("inheritance is skipped when defaultProvider is ollama (no change needed)", async () => {
    fs.writeFileSync(
      path.join(tmp, "gnosys.json"),
      JSON.stringify({
        llm: { defaultProvider: "ollama" },
      }),
    );
    const cfg = await loadConfig(tmp);
    expect(cfg.dream.provider).toBe("ollama");
  });
});

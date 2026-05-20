/**
 * Phase G regression — `gnosys chat` must fail fast when the configured
 * provider has no API key. Pre-v5.9.3 the chat TUI would render, then
 * crash on the first message; the new behavior exits 1 BEFORE rendering
 * and prints an actionable Status.fail line on stderr.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import path from "path";
import os from "os";
import fs from "fs";

const CLI = path.resolve("dist/cli.js");

describe("Phase G — chat fail-fast on missing API key", () => {
  it("exits 1 with actionable error when ANTHROPIC_API_KEY is missing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-chatff-"));
    try {
      // Write a config pointing at anthropic.
      fs.writeFileSync(
        path.join(tmp, "gnosys.json"),
        JSON.stringify({
          llm: { defaultProvider: "anthropic", anthropic: { model: "claude-sonnet-4-6" } },
        }),
      );

      // Strip every potential key out of env so the fail-fast triggers.
      const env: NodeJS.ProcessEnv = { ...process.env };
      delete env.ANTHROPIC_API_KEY;
      delete env.OPENAI_API_KEY;
      delete env.GROQ_API_KEY;
      delete env.XAI_API_KEY;
      delete env.MISTRAL_API_KEY;

      const result = spawnSync("node", [CLI, "chat"], {
        env: {
          ...env,
          HOME: tmp,
          GNOSYS_HOME: tmp,
          GNOSYS_LOCAL_ONLY: "1",
          GNOSYS_SKIP_UPGRADE_NUDGE: "1",
          VITEST: "true",
        },
        encoding: "utf-8",
        timeout: 15_000,
        cwd: tmp,
      });

      expect(result.status, `expected exit code 1, got ${result.status}; stdout=${result.stdout?.slice(0, 200)}; stderr=${result.stderr?.slice(0, 400)}`).toBe(1);
      expect(result.stderr).toMatch(/no API key for anthropic/);
      expect(result.stderr).toMatch(/gnosys setup/);
      expect(result.stderr).toMatch(/ANTHROPIC_API_KEY/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});

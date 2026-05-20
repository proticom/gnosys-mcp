/**
 * Phase E — Screen 8 — `gnosys setup chat` now prints a deprecation
 * notice and exits. Regression covers:
 *   - the deprecation copy mentions `gnosys chat` and `⌃,`
 *   - no taskModels.chat / chat / recall fields are written to gnosys.json
 *   - the legacy "Chat config saved:" line is gone
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "child_process";
import path from "path";
import os from "os";
import fs from "fs";

const CLI = path.resolve("dist/cli.js");

describe("Phase E — Screen 8 — setup chat is deprecated", () => {
  it("prints the v6.0 TUI pointer and writes nothing", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-chat-dep-"));
    try {
      const result = spawnSync("node", [CLI, "setup", "chat"], {
        env: {
          ...process.env,
          HOME: tmp,
          GNOSYS_HOME: tmp,
          GNOSYS_LOCAL_ONLY: "1",
          GNOSYS_SKIP_UPGRADE_NUDGE: "1",
        },
        encoding: "utf-8",
        timeout: 10_000,
      });

      const out = `${result.stdout}\n${result.stderr}`;
      expect(out).toMatch(/chat settings have moved/);
      expect(out).toMatch(/gnosys chat/);
      // Make sure we no longer print the old "Chat config saved" success line.
      expect(out).not.toMatch(/Chat config saved/);

      // Nothing should have been persisted.
      const cfg = path.join(tmp, "gnosys.json");
      expect(fs.existsSync(cfg)).toBe(false);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});

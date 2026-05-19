/**
 * v5.9.2 regression test — writeProjectIdentity MUST preserve non-identity
 * config fields when re-writing gnosys.json.
 *
 * Before v5.9.2: `writeProjectIdentity` did a flat fs.writeFile of just the
 * identity object, wiping anything else in the file. Every
 * `gnosys setup sync-projects` run (triggered by `gnosys upgrade`) called
 * createProjectIdentity → writeProjectIdentity over every registered
 * project, silently wiping `llm.defaultProvider` and other user-set fields.
 * The Zod schema default at config.ts:65 then re-seeded "anthropic" on the
 * next loadConfig — so every upgrade reverted the default provider back to
 * Anthropic. See decision memory deci-046.
 *
 * v5.9.2 makes writeProjectIdentity read-then-merge. This test proves it.
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { writeProjectIdentity, ProjectIdentity } from "../lib/projectIdentity.js";

describe("v5.9.2 regression: writeProjectIdentity preserves user config", () => {
  it("does NOT wipe llm config or other user fields when re-writing identity", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-identity-merge-"));
    const gnosysDir = path.join(tmpDir, ".gnosys");
    fs.mkdirSync(gnosysDir, { recursive: true });
    const gnosysJsonPath = path.join(gnosysDir, "gnosys.json");

    // Pre-existing gnosys.json has BOTH identity AND user config — the
    // shared-file pattern that the pre-v5.9.2 bug clobbered.
    const preExisting = {
      projectId: "test-stable-id-7777",
      projectName: "test-project",
      workingDirectory: tmpDir,
      user: "tester",
      agentRulesTarget: ".cursor/rules/gnosys.mdc",
      obsidianVault: ".gnosys/vault",
      createdAt: "2026-01-01T00:00:00.000Z",
      schemaVersion: 1,
      llm: {
        defaultProvider: "xai",
        xai: { model: "grok-4.20" },
      },
      taskModels: {
        embeddings: { provider: "openai", model: "text-embedding-3-small" },
      },
      dream: { enabled: false },
    };
    await fsp.writeFile(gnosysJsonPath, JSON.stringify(preExisting, null, 2));

    try {
      // Now call writeProjectIdentity with a new identity (e.g. a project
      // move + sync-projects run would do this).
      const newIdentity: ProjectIdentity = {
        projectId: "test-stable-id-7777", // identity preserved
        projectName: "test-project-renamed",
        workingDirectory: tmpDir,
        user: "tester",
        agentRulesTarget: ".cursor/rules/gnosys.mdc",
        obsidianVault: ".gnosys/vault",
        createdAt: "2026-01-01T00:00:00.000Z",
        schemaVersion: 1,
      };
      await writeProjectIdentity(tmpDir, newIdentity);

      const after = JSON.parse(await fsp.readFile(gnosysJsonPath, "utf-8"));

      // Identity fields should update.
      expect(after.projectName).toBe("test-project-renamed");

      // User config MUST survive.
      expect(after.llm, "llm config must be preserved — wiping caused revert-to-anthropic").toEqual({
        defaultProvider: "xai",
        xai: { model: "grok-4.20" },
      });
      expect(after.taskModels).toEqual({
        embeddings: { provider: "openai", model: "text-embedding-3-small" },
      });
      expect(after.dream).toEqual({ enabled: false });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

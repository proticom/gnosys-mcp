/**
 * v5.9.4 Bugs 7 + 8 tests — dream-state reconciliation across config +
 * local DB + remote DB.
 *
 * Locks in the rules:
 *   - When `cfg.dream.enabled` is true but no machine_id is set anywhere,
 *     the description reports "enabled · provider" without a machine slug.
 *   - When `cfg.dream.enabled` is false but a local-DB machine_id is set,
 *     the panel shows it (e.g. another session enabled it).
 *   - When only the remote DB has a machine_id, the panel falls through
 *     to it (re-entry on a fresh machine).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { GnosysDB } from "../lib/db.js";
import type { GnosysConfig } from "../lib/config.js";
import { getDreamState, describeDreamState } from "../lib/setup/dreamState.js";

function baseConfig(overrides: Partial<GnosysConfig["dream"]> = {}): GnosysConfig {
  return {
    llm: { defaultProvider: "anthropic", anthropic: { model: "claude-sonnet-4-6" } },
    dream: {
      enabled: false,
      idleMinutes: 10,
      maxRuntimeMinutes: 30,
      provider: "ollama",
      selfCritique: true,
      generateSummaries: true,
      discoverRelationships: true,
      minMemories: 10,
      ...overrides,
    },
  } as unknown as GnosysConfig;
}

describe("v5.9.4 dream-state reconciliation (Bugs 7+8)", () => {
  let tmp: string;
  let localDb: GnosysDB;
  let remoteDb: GnosysDB;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-dream-state-"));
    localDb = new GnosysDB(path.join(tmp, "local"));
    remoteDb = new GnosysDB(path.join(tmp, "remote"));
  });

  afterEach(() => {
    localDb.close();
    remoteDb.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("config-disabled + no machine designated → disabled", () => {
    const state = getDreamState(baseConfig({ enabled: false }), localDb, remoteDb);
    expect(state.enabled).toBe(false);
    expect(state.machineId).toBeNull();
    expect(state.source).toBe("default");
    expect(describeDreamState(state)).toBe("disabled");
  });

  it("config-disabled + local-DB designation → enabled via local-db", () => {
    localDb.setDreamMachineId("workstation-a");
    const state = getDreamState(baseConfig({ enabled: false }), localDb, remoteDb);
    expect(state.enabled).toBe(true);
    expect(state.machineId).toBe("workstation-a");
    expect(state.source).toBe("local-db");
    expect(describeDreamState(state)).toContain("workstation-a");
  });

  it("config-enabled + no DB designation → enabled via config", () => {
    const state = getDreamState(baseConfig({ enabled: true, provider: "anthropic", model: "claude-sonnet-4-6" }), localDb, remoteDb);
    expect(state.enabled).toBe(true);
    expect(state.machineId).toBeNull();
    expect(state.source).toBe("config");
    expect(describeDreamState(state)).toBe("anthropic / claude-sonnet-4-6");
  });

  it("config-disabled + only remote DB has machine_id → falls through to remote-db", () => {
    remoteDb.setDreamMachineId("nas-dreamer");
    const state = getDreamState(baseConfig({ enabled: false }), localDb, remoteDb);
    expect(state.enabled).toBe(true);
    expect(state.machineId).toBe("nas-dreamer");
    expect(state.source).toBe("remote-db");
  });

  it("local DB wins over remote when both set", () => {
    localDb.setDreamMachineId("local-pick");
    remoteDb.setDreamMachineId("remote-pick");
    const state = getDreamState(baseConfig({ enabled: true }), localDb, remoteDb);
    expect(state.machineId).toBe("local-pick");
    expect(state.source).toBe("local-db");
  });

  it("describe shows machine when designated", () => {
    localDb.setDreamMachineId("dreamer-1");
    const state = getDreamState(baseConfig({ enabled: true, provider: "anthropic" }), localDb, null);
    expect(describeDreamState(state)).toBe("anthropic · dreamer-1");
  });

  it("missing remote DB is fine (null)", () => {
    localDb.setDreamMachineId("solo");
    const state = getDreamState(baseConfig({ enabled: true }), localDb, null);
    expect(state.enabled).toBe(true);
    expect(state.machineId).toBe("solo");
  });
});

/**
 * Machine ID stability — override pin, restart persistence, clone detection.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  ensureMachineConfig,
  getMachineId,
  writeMachineConfig,
  type MachineConfig,
} from "../lib/machineConfig.js";

let tmp: string;
let prevConfigDir: string | undefined;
let prevMachineIdOverride: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-machine-id-stability-"));
  prevConfigDir = process.env.GNOSYS_CONFIG_DIR;
  prevMachineIdOverride = process.env.GNOSYS_MACHINE_ID;
  process.env.GNOSYS_CONFIG_DIR = tmp;
  delete process.env.GNOSYS_MACHINE_ID;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.GNOSYS_CONFIG_DIR;
  else process.env.GNOSYS_CONFIG_DIR = prevConfigDir;
  if (prevMachineIdOverride === undefined) delete process.env.GNOSYS_MACHINE_ID;
  else process.env.GNOSYS_MACHINE_ID = prevMachineIdOverride;
  fs.rmSync(tmp, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("machine ID stability", () => {
  it("GNOSYS_MACHINE_ID stays stable across a hostname change", () => {
    process.env.GNOSYS_MACHINE_ID = "pinned-container-id";

    const foreign: MachineConfig = {
      machineId: "old-synced-id",
      hostname: `${os.hostname()}-docker-restart`,
      roots: {},
      remote: { enabled: false },
      schemaVersion: 1,
    };
    writeMachineConfig(foreign);

    const res = ensureMachineConfig();
    expect(res.regenerated).toBe(false);
    expect(res.config.machineId).toBe("pinned-container-id");
    expect(res.config.hostname).toBe(os.hostname());
    expect(getMachineId()).toBe("pinned-container-id");
  });

  it("preserves machine ID across restart when hostname is unchanged", () => {
    const first = ensureMachineConfig();
    const second = ensureMachineConfig();

    expect(second.created).toBe(false);
    expect(second.regenerated).toBe(false);
    expect(second.config.machineId).toBe(first.config.machineId);
    expect(getMachineId()).toBe(first.config.machineId);
  });

  it("regenerates a distinct ID when a foreign config is cloned without override", () => {
    const foreign: MachineConfig = {
      machineId: "foreign-fixed-id",
      hostname: `${os.hostname()}-other-machine`,
      roots: { dev: "/Users/other/projects" },
      remote: { enabled: false },
      schemaVersion: 1,
    };
    writeMachineConfig(foreign);

    const res = ensureMachineConfig();
    expect(res.regenerated).toBe(true);
    expect(res.config.machineId).not.toBe("foreign-fixed-id");
    expect(res.config.hostname).toBe(os.hostname());
  });
});

/**
 * v5.11 — machine-local config (machine.json).
 *
 * Covers the machine-portable-paths foundation: stable machineId, named
 * roots, the synced-in-foreign-file (hostname mismatch) guard, and the
 * root <-> relative-path helpers used by cross-machine resolution.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  defaultMachineConfig,
  readMachineConfig,
  writeMachineConfig,
  ensureMachineConfig,
  getMachineId,
  absPathFromRoot,
  relPathUnderRoot,
  type MachineConfig,
} from "../lib/machineConfig.js";
import { getMachineConfigPath } from "../lib/paths.js";

let tmp: string;
let prevConfigDir: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-machinecfg-"));
  prevConfigDir = process.env.GNOSYS_CONFIG_DIR;
  process.env.GNOSYS_CONFIG_DIR = tmp;
});

afterEach(() => {
  if (prevConfigDir === undefined) delete process.env.GNOSYS_CONFIG_DIR;
  else process.env.GNOSYS_CONFIG_DIR = prevConfigDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("v5.11 machineConfig: shape & persistence", () => {
  it("defaultMachineConfig has a UUID, hostname, empty roots, disabled remote", () => {
    const cfg = defaultMachineConfig();
    expect(cfg.machineId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(cfg.hostname).toBe(os.hostname());
    expect(cfg.roots).toEqual({});
    expect(cfg.remote.enabled).toBe(false);
  });

  it("writes machine.json under the config dir and reads it back", () => {
    const cfg = defaultMachineConfig();
    cfg.roots = { dev: "/Users/test/Dev/projects" };
    cfg.remote = { enabled: true, path: "/Volumes/Remote/gnosys.db" };
    writeMachineConfig(cfg);

    expect(fs.existsSync(getMachineConfigPath())).toBe(true);
    expect(getMachineConfigPath()).toBe(path.join(tmp, "machine.json"));

    const read = readMachineConfig();
    expect(read?.machineId).toBe(cfg.machineId);
    expect(read?.roots.dev).toBe("/Users/test/Dev/projects");
    expect(read?.remote).toEqual({ enabled: true, path: "/Volumes/Remote/gnosys.db" });
  });

  it("readMachineConfig returns null when the file is absent", () => {
    expect(readMachineConfig()).toBeNull();
  });

  it("normalize drops non-string roots and resolves to absolute", () => {
    fs.writeFileSync(
      getMachineConfigPath(),
      JSON.stringify({ machineId: "x", hostname: "h", roots: { dev: "/a/b", bad: 5 } }),
      "utf-8",
    );
    const read = readMachineConfig();
    expect(read?.roots.dev).toBe(path.resolve("/a/b"));
    expect(read?.roots.bad).toBeUndefined();
  });
});

describe("v5.11 machineConfig: ensure & hostname guard", () => {
  it("creates machine.json on first run", () => {
    const res = ensureMachineConfig();
    expect(res.created).toBe(true);
    expect(res.regenerated).toBe(false);
    expect(fs.existsSync(getMachineConfigPath())).toBe(true);
  });

  it("returns the existing config unchanged when the hostname matches", () => {
    const first = ensureMachineConfig();
    const second = ensureMachineConfig();
    expect(second.created).toBe(false);
    expect(second.regenerated).toBe(false);
    expect(second.config.machineId).toBe(first.config.machineId);
  });

  it("regenerates machineId when a foreign (synced-in) config has a different hostname", () => {
    const foreign: MachineConfig = {
      machineId: "foreign-fixed-id",
      hostname: `${os.hostname()}-NOT-THIS-MACHINE`,
      roots: { dev: "/Users/other/MBPDev/projects" },
      remote: { enabled: true, path: "/keep/me" },
      schemaVersion: 1,
    };
    writeMachineConfig(foreign);

    const res = ensureMachineConfig();
    expect(res.regenerated).toBe(true);
    expect(res.config.machineId).not.toBe("foreign-fixed-id");
    expect(res.config.hostname).toBe(os.hostname());
    // roots/remote are preserved (benign rename keeps them; scan fixes a true foreign file)
    expect(res.config.roots.dev).toBe(path.resolve("/Users/other/MBPDev/projects"));
    expect(res.config.remote.path).toBe("/keep/me");
  });

  it("getMachineId is stable across calls", () => {
    const a = getMachineId();
    const b = getMachineId();
    expect(a).toBe(b);
  });
});

describe("v5.11 machineConfig: root <-> relative path helpers", () => {
  const cfg: MachineConfig = {
    machineId: "m",
    hostname: "h",
    roots: {
      dev: "/Users/edward/MSDev/projects",
      docs: "/Users/edward/MSDev/projects/docs-area",
    },
    remote: { enabled: false },
    schemaVersion: 1,
  };

  it("absPathFromRoot joins root + rel, returns null when root/rel missing", () => {
    expect(absPathFromRoot(cfg, "dev", "gnosys-ai/gnosys-public")).toBe(
      "/Users/edward/MSDev/projects/gnosys-ai/gnosys-public",
    );
    expect(absPathFromRoot(cfg, "nope", "x")).toBeNull();
    expect(absPathFromRoot(cfg, null, "x")).toBeNull();
    expect(absPathFromRoot(cfg, "dev", null)).toBeNull();
  });

  it("relPathUnderRoot picks the deepest matching root", () => {
    const r = relPathUnderRoot(cfg, "/Users/edward/MSDev/projects/gnosys-ai/gnosys-public");
    expect(r).toEqual({ rootId: "dev", relPath: "gnosys-ai/gnosys-public" });

    // A path under the nested docs root should prefer the deeper root.
    const d = relPathUnderRoot(cfg, "/Users/edward/MSDev/projects/docs-area/guide");
    expect(d).toEqual({ rootId: "docs", relPath: "guide" });
  });

  it("relPathUnderRoot returns null for a path outside every root", () => {
    expect(relPathUnderRoot(cfg, "/Volumes/Dev/projects/gnosys-ai")).toBeNull();
    expect(relPathUnderRoot(cfg, "/Users/edward")).toBeNull();
  });
});

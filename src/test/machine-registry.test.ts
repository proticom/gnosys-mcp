/**
 * Connected-machines registry — rename self-heal + `forget`.
 *
 * Regression cover for the "phantom machine" bug: renaming a host (e.g.
 * `Edwards-MBP.localdomain` → `EdsMBP`) used to leave an orphaned entry that
 * could never be cleaned up. recordMachine now prunes the old entry via the
 * machine's previous hostnames / shared machineId, and forgetMachine removes
 * a stale entry on demand.
 */

import { describe, it, expect, beforeEach } from "vitest";
import type { GnosysDB } from "../lib/db.js";
import {
  readMachineRegistry,
  writeMachineRegistry,
  recordMachine,
  forgetMachine,
  type MachineRegistry,
} from "../lib/machineRegistry.js";

/**
 * Minimal in-memory stand-in for GnosysDB — the registry helpers only touch
 * getMeta/setMeta, so a one-key map is enough and avoids a real sqlite file.
 */
function fakeDb(): GnosysDB {
  const store = new Map<string, string>();
  return {
    getMeta: (key: string) => store.get(key) ?? null,
    setMeta: (key: string, value: string) => {
      store.set(key, value);
    },
  } as unknown as GnosysDB;
}

let db: GnosysDB;

beforeEach(() => {
  db = fakeDb();
});

describe("machineRegistry: read/write", () => {
  it("returns {} when nothing is stored", () => {
    expect(readMachineRegistry(db)).toEqual({});
  });

  it("round-trips through write/read", () => {
    const reg: MachineRegistry = { Box: { version: "5.11.4", lastSeen: "2026-05-30T00:00:00.000Z" } };
    writeMachineRegistry(db, reg);
    expect(readMachineRegistry(db)).toEqual(reg);
  });

  it("returns {} for malformed JSON instead of throwing", () => {
    db.setMeta("machines", "{not json");
    expect(readMachineRegistry(db)).toEqual({});
  });
});

describe("machineRegistry: recordMachine", () => {
  it("adds this machine with version, lastSeen, and machineId", () => {
    const reg = recordMachine(db, { hostname: "EdsMBP", version: "5.11.4", machineId: "id-1" });
    expect(reg.EdsMBP.version).toBe("5.11.4");
    expect(reg.EdsMBP.machineId).toBe("id-1");
    expect(reg.EdsMBP.lastSeen).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("prunes the orphaned entry left by a previous hostname (the phantom)", () => {
    // Old entry recorded under the laptop's former name.
    writeMachineRegistry(db, {
      "Edwards-MBP.localdomain": { version: "5.7.0", lastSeen: "2026-05-05T00:00:00.000Z" },
    });

    const reg = recordMachine(db, {
      hostname: "EdsMBP",
      version: "5.11.4",
      machineId: "id-1",
      aliases: ["Edwards-MBP.localdomain"],
    });

    expect(reg["Edwards-MBP.localdomain"]).toBeUndefined();
    expect(reg.EdsMBP).toBeDefined();
    expect(Object.keys(reg)).toEqual(["EdsMBP"]);
  });

  it("prunes a differently-named entry that shares this machineId", () => {
    writeMachineRegistry(db, {
      OldName: { version: "5.10.0", lastSeen: "2026-05-01T00:00:00.000Z", machineId: "id-1" },
    });

    const reg = recordMachine(db, { hostname: "NewName", version: "5.11.4", machineId: "id-1" });

    expect(reg.OldName).toBeUndefined();
    expect(reg.NewName.machineId).toBe("id-1");
  });

  it("never removes a different physical machine", () => {
    writeMachineRegistry(db, {
      EdsMacStudio: { version: "5.11.0", lastSeen: "2026-05-27T00:00:00.000Z", machineId: "studio-id" },
    });

    const reg = recordMachine(db, {
      hostname: "EdsMBP",
      version: "5.11.4",
      machineId: "mbp-id",
      aliases: ["Edwards-MBP.localdomain"],
    });

    expect(reg.EdsMacStudio).toBeDefined();
    expect(reg.EdsMBP).toBeDefined();
  });

  it("persists the result so a re-read sees the pruned registry", () => {
    writeMachineRegistry(db, {
      "Edwards-MBP.localdomain": { version: "5.7.0", lastSeen: "2026-05-05T00:00:00.000Z" },
    });
    recordMachine(db, {
      hostname: "EdsMBP",
      version: "5.11.4",
      machineId: "id-1",
      aliases: ["Edwards-MBP.localdomain"],
    });
    expect(readMachineRegistry(db)["Edwards-MBP.localdomain"]).toBeUndefined();
  });
});

describe("machineRegistry: forgetMachine", () => {
  it("removes a named entry and reports true", () => {
    writeMachineRegistry(db, {
      "Edwards-MBP.localdomain": { version: "5.7.0", lastSeen: "2026-05-05T00:00:00.000Z" },
      EdsMBP: { version: "5.11.4", lastSeen: "2026-05-30T00:00:00.000Z" },
    });

    expect(forgetMachine(db, "Edwards-MBP.localdomain")).toBe(true);
    const reg = readMachineRegistry(db);
    expect(reg["Edwards-MBP.localdomain"]).toBeUndefined();
    expect(reg.EdsMBP).toBeDefined();
  });

  it("reports false when the entry doesn't exist", () => {
    writeMachineRegistry(db, { EdsMBP: { version: "5.11.4", lastSeen: "2026-05-30T00:00:00.000Z" } });
    expect(forgetMachine(db, "ghost")).toBe(false);
  });
});

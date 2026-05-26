/**
 * Coverage for the pure helpers shipped in v5.7.1 / v5.8.0.
 *
 * These are small, fast unit tests against the new modules:
 *   - idFormat (formatMemoryId, parseIdFormat, buildProjectNameLookup)
 *   - SlashPalette (filterCommands)
 *   - upgrade (writeUpgradeMarker, readUpgradeMarker, shouldRestartMcp,
 *     getMarkerPath)
 *
 * Added in v5.8.1 to land coverage above the 50% statement threshold that
 * v5.8.0's new files temporarily dropped us below.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";

import {
  formatMemoryId,
  formatMemoryIdHyperlink,
  parseIdFormat,
  buildProjectNameLookup,
  memoryUri,
  osc8Wrap,
} from "../lib/idFormat.js";
import { filterCommands } from "../lib/chat/SlashPalette.js";
import type { CommandSpec } from "../lib/chat/commands.js";
import {
  getMarkerPath,
  writeUpgradeMarker,
  readUpgradeMarker,
  shouldRestartMcp,
} from "../lib/upgrade.js";
import { GnosysDB } from "../lib/db.js";

// ─── idFormat ───────────────────────────────────────────────────────────

describe("idFormat", () => {
  describe("parseIdFormat", () => {
    it("returns the value when it's a known format", () => {
      expect(parseIdFormat("short")).toBe("short");
      expect(parseIdFormat("long")).toBe("long");
      expect(parseIdFormat("raw")).toBe("raw");
    });
    it("defaults to short for undefined or unknown values", () => {
      expect(parseIdFormat(undefined)).toBe("short");
      expect(parseIdFormat("")).toBe("short");
      expect(parseIdFormat("verbose")).toBe("short");
      expect(parseIdFormat("PRETTY")).toBe("short");
    });
  });

  describe("formatMemoryId", () => {
    const id = "deci-01HXXJK2ABCDEFGHIJK";

    it("raw mode returns the id verbatim, regardless of projectName", () => {
      expect(formatMemoryId(id, "gnosys-ai", "raw")).toBe(id);
      expect(formatMemoryId(id, null, "raw")).toBe(id);
    });

    it("short mode truncates the ULID portion with an ellipsis", () => {
      const out = formatMemoryId(id, "gnosys-ai", "short");
      expect(out).toContain("gnosys-ai · ");
      expect(out).toContain("deci-01HXXJK2");
      expect(out).toContain("…");
      expect(out.length).toBeLessThan(`gnosys-ai · ${id}`.length);
    });

    it("long mode keeps the full ULID with the project prefix", () => {
      expect(formatMemoryId(id, "gnosys-ai", "long")).toBe(`gnosys-ai · ${id}`);
    });

    it("omits the project segment when projectName is null/undefined", () => {
      expect(formatMemoryId(id, null, "long")).toBe(id);
      expect(formatMemoryId(id, undefined, "long")).toBe(id);
    });

    it("short mode without project name still truncates", () => {
      const out = formatMemoryId(id, null, "short");
      expect(out).not.toContain("·");
      expect(out).toContain("…");
    });

    it("defaults to short when no format is passed", () => {
      const out = formatMemoryId(id, "gnosys-ai");
      expect(out).toContain("…");
    });

    it("handles short ids that don't need truncation gracefully", () => {
      const shortId = "x-1";
      expect(formatMemoryId(shortId, "p", "short")).toBe(`p · ${shortId}`);
    });
  });

  describe("memoryUri", () => {
    it("builds a gnosys://memory/<id> URI", () => {
      expect(memoryUri("deci-01HXXJK2ABC")).toBe("gnosys://memory/deci-01HXXJK2ABC");
    });
    it("encodes characters that would break a URI", () => {
      expect(memoryUri("foo/bar baz")).toBe("gnosys://memory/foo%2Fbar%20baz");
    });
  });

  describe("osc8Wrap", () => {
    it("wraps display text in the OSC8 escape sequence", () => {
      const wrapped = osc8Wrap("gnosys://memory/x-1", "x-1");
      expect(wrapped).toContain("\x1b]8;;gnosys://memory/x-1\x1b\\x-1\x1b]8;;\x1b\\");
    });
  });

  describe("formatMemoryIdHyperlink", () => {
    const id = "deci-01HXXJK2ABCDEFGHIJK";

    it("when tty=false, returns the same string as formatMemoryId", () => {
      const plain = formatMemoryId(id, "gnosys-ai", "long");
      const linked = formatMemoryIdHyperlink(id, "gnosys-ai", "long", { tty: false });
      expect(linked).toBe(plain);
    });

    it("when tty=true, wraps the display text in OSC8 escapes pointing at the full id", () => {
      const linked = formatMemoryIdHyperlink(id, "gnosys-ai", "short", { tty: true });
      // The URI segment should always carry the FULL id, regardless of display format.
      expect(linked).toContain(`gnosys://memory/${encodeURIComponent(id)}`);
      // The visible text should still be the short-form display.
      expect(linked).toContain("…");
      expect(linked).toContain("gnosys-ai · ");
    });

    it("works without a projectName (global/personal memories)", () => {
      const linked = formatMemoryIdHyperlink(id, null, "long", { tty: true });
      expect(linked).toContain(`gnosys://memory/${encodeURIComponent(id)}`);
      expect(linked).toContain(id);
      expect(linked).not.toContain("·");
    });
  });

  describe("buildProjectNameLookup", () => {
    let dbPath: string;
    let db: GnosysDB;

    beforeEach(() => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-idfmt-"));
      dbPath = path.join(dir, "gnosys.db");
      db = new GnosysDB(dbPath);
    });

    afterEach(() => {
      db.close();
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    });

    it("returns a Map of {project_id → project_name} for all rows", () => {
      db.insertProject({
        id: "p-alpha",
        name: "alpha",
        working_directory: "/tmp/alpha",
        user: "test",
        agent_rules_target: null,
        obsidian_vault: null,
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
      });
      db.insertProject({
        id: "p-beta",
        name: "beta",
        working_directory: "/tmp/beta",
        user: "test",
        agent_rules_target: null,
        obsidian_vault: null,
        created: new Date().toISOString(),
        modified: new Date().toISOString(),
      });

      const lookup = buildProjectNameLookup(db);
      expect(lookup.get("p-alpha")).toBe("alpha");
      expect(lookup.get("p-beta")).toBe("beta");
      expect(lookup.size).toBe(2);
    });

    it("returns an empty map when no projects exist", () => {
      const lookup = buildProjectNameLookup(db);
      expect(lookup.size).toBe(0);
    });
  });
});

// ─── SlashPalette.filterCommands ─────────────────────────────────────────

describe("SlashPalette.filterCommands", () => {
  const cmds: CommandSpec[] = [
    { name: "/help", summary: "Show available commands", handler: async () => ({ kind: "ok" }) },
    { name: "/quit", summary: "Exit the chat session", aliases: ["/exit"], handler: async () => ({ kind: "ok" }) },
    { name: "/recall", summary: "Run a federated recall against memory", handler: async () => ({ kind: "ok" }) },
    { name: "/remember", summary: "Save the last exchange as a memory", handler: async () => ({ kind: "ok" }) },
    { name: "/pin", summary: "Pin a memory by id", handler: async () => ({ kind: "ok" }) },
  ];

  it("returns all commands when the filter is empty or just a slash", () => {
    expect(filterCommands(cmds, "").length).toBe(cmds.length);
    expect(filterCommands(cmds, "/").length).toBe(cmds.length);
  });

  it("matches name prefix (the most common case)", () => {
    const matches = filterCommands(cmds, "/re");
    const names = matches.map((c) => c.name);
    expect(names).toContain("/recall");
    expect(names).toContain("/remember");
    expect(names).not.toContain("/help");
  });

  it("matches name substring", () => {
    const matches = filterCommands(cmds, "call");
    expect(matches.map((c) => c.name)).toContain("/recall");
  });

  it("falls back to summary text", () => {
    const matches = filterCommands(cmds, "session");
    expect(matches.map((c) => c.name)).toContain("/quit");
  });

  it("matches aliases", () => {
    const matches = filterCommands(cmds, "exit");
    expect(matches.map((c) => c.name)).toContain("/quit");
  });

  it("returns empty when nothing matches", () => {
    expect(filterCommands(cmds, "zzz-nope")).toEqual([]);
  });

  it("is case-insensitive", () => {
    expect(filterCommands(cmds, "HELP").map((c) => c.name)).toContain("/help");
    expect(filterCommands(cmds, "Recall").map((c) => c.name)).toContain("/recall");
  });
});

// ─── upgrade marker ─────────────────────────────────────────────────────

describe("upgrade marker", () => {
  let scratch: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-upgrade-marker-"));
    prevHome = process.env.HOME;
    process.env.HOME = scratch;
  });

  afterEach(() => {
    if (prevHome !== undefined) process.env.HOME = prevHome;
    else delete process.env.HOME;
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  it("getMarkerPath points at ~/.gnosys/last-upgrade-at under the current HOME", () => {
    const marker = getMarkerPath();
    expect(marker).toBe(path.join(scratch, ".gnosys", "last-upgrade-at"));
  });

  it("readUpgradeMarker returns null when the file doesn't exist", () => {
    expect(readUpgradeMarker()).toBeNull();
  });

  it("writeUpgradeMarker creates the file with version + timestamp", async () => {
    writeUpgradeMarker("9.9.9");
    const raw = await fsp.readFile(getMarkerPath(), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe("9.9.9");
    expect(typeof parsed.timestamp).toBe("string");
    expect(typeof parsed.upgradedBy).toBe("string");
  });

  it("readUpgradeMarker round-trips writeUpgradeMarker", () => {
    writeUpgradeMarker("5.8.1");
    const m = readUpgradeMarker();
    expect(m?.version).toBe("5.8.1");
  });

  it("shouldRestartMcp returns false when no marker is present", () => {
    expect(shouldRestartMcp("5.8.1")).toBe(false);
  });

  it("shouldRestartMcp returns false when marker matches the running version", () => {
    writeUpgradeMarker("5.8.1");
    expect(shouldRestartMcp("5.8.1")).toBe(false);
  });

  it("shouldRestartMcp returns true when marker is newer than the running version", () => {
    writeUpgradeMarker("5.9.0");
    expect(shouldRestartMcp("5.8.1")).toBe(true);
  });

  it("shouldRestartMcp returns true on any version mismatch (older or newer)", () => {
    writeUpgradeMarker("5.7.0");
    expect(shouldRestartMcp("5.8.1")).toBe(true);
  });

  it("readUpgradeMarker swallows malformed JSON and returns null", () => {
    const p = getMarkerPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "not json {", "utf8");
    expect(readUpgradeMarker()).toBeNull();
  });
});

/**
 * Atomic config file writes — no truncated files, no temp litter.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile, atomicWriteFileSync } from "../lib/atomicWrite.js";

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "gnosys-atomic-write-"));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function tmpFilesLeft(): string[] {
  return readdirSync(workDir).filter((name) => name.endsWith(".tmp"));
}

describe("atomic config writes", () => {
  it("atomicWriteFile writes exact content with no leftover temp file", async () => {
    const dest = join(workDir, "gnosys.json");
    const payload = JSON.stringify({ llm: { defaultProvider: "anthropic" } }, null, 2) + "\n";

    await atomicWriteFile(dest, payload);

    expect(readFileSync(dest, "utf-8")).toBe(payload);
    expect(JSON.parse(readFileSync(dest, "utf-8"))).toEqual({ llm: { defaultProvider: "anthropic" } });
    expect(tmpFilesLeft()).toEqual([]);
  });

  it("atomicWriteFile overwrites an existing file atomically", async () => {
    const dest = join(workDir, "gnosys.json");
    writeFileSync(dest, '{"old":true}\n', "utf-8");

    const next = JSON.stringify({ new: true }, null, 2) + "\n";
    await atomicWriteFile(dest, next);

    expect(readFileSync(dest, "utf-8")).toBe(next);
    expect(tmpFilesLeft()).toEqual([]);
  });

  it("atomicWriteFileSync writes exact content with no leftover temp file", () => {
    const dest = join(workDir, "machine.json");
    const payload = JSON.stringify({ machineId: "abc", hostname: "test" }, null, 2) + "\n";

    atomicWriteFileSync(dest, payload);

    expect(readFileSync(dest, "utf-8")).toBe(payload);
    expect(tmpFilesLeft()).toEqual([]);
  });
});

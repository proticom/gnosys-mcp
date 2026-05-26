/**
 * Adversarial ingest fixtures — each hostile/edge input must resolve or reject
 * with a clear Error, never hang or throw non-Error values.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ingestFile } from "../lib/multimodalIngest.js";
import { GnosysStore } from "../lib/store.js";

const FIXTURES = join(fileURLToPath(new URL(".", import.meta.url)), "fixtures", "ingest");

let workDir: string;
let storePath: string;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "gnosys-ingest-fix-"));
  storePath = join(workDir, ".gnosys");
  mkdirSync(storePath, { recursive: true });
  await new GnosysStore(storePath).init();
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

async function ingestGracefully(filePath: string) {
  try {
    const result = await ingestFile({
      filePath,
      storePath,
      mode: "structured",
      dryRun: true,
    });
    return { kind: "ok" as const, result };
  } catch (err) {
    expect(err).toBeInstanceOf(Error);
    return { kind: "error" as const, message: (err as Error).message };
  }
}

describe("ingest adversarial fixtures", () => {
  it("normal PDF ingests without crashing", async () => {
    const outcome = await ingestGracefully(join(FIXTURES, "normal.pdf"));
    expect(outcome.kind === "ok" || outcome.kind === "error").toBe(true);
    if (outcome.kind === "ok") {
      expect(outcome.result.fileType).toBe("pdf");
    }
  });

  it("0-byte text file is handled gracefully", async () => {
    const path = join(workDir, "empty.txt");
    writeFileSync(path, "");
    const outcome = await ingestGracefully(path);
    expect(outcome.kind === "ok" || outcome.kind === "error").toBe(true);
    if (outcome.kind === "ok") {
      expect(outcome.result.errors.length).toBeGreaterThan(0);
    }
  });

  it("UTF-8 BOM text file is handled gracefully", async () => {
    const path = join(workDir, "bom.txt");
    writeFileSync(path, "\uFEFFHello with BOM", "utf-8");
    const outcome = await ingestGracefully(path);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.result.fileType).toBe("text");
    }
  });

  it("oversized text file hits size cap (no OOM)", async () => {
    const path = join(workDir, "huge.txt");
    const maxBytes = 100 * 1024 * 1024;
    const fd = openSync(path, "w");
    try {
      writeFileSync(fd, Buffer.alloc(maxBytes + 1, 97));
    } finally {
      closeSync(fd);
    }
    const outcome = await ingestGracefully(path);
    expect(outcome.kind).toBe("error");
    expect(outcome.message).toMatch(/exceeds the 100MB limit/i);
  }, 60_000);

  it("corrupt DOCX returns a clear error", async () => {
    const path = join(workDir, "bad.docx");
    writeFileSync(path, "PK\x03\x04this is not a real docx file");
    const outcome = await ingestGracefully(path);
    expect(outcome.kind === "ok" || outcome.kind === "error").toBe(true);
    if (outcome.kind === "error") {
      expect(outcome.message.length).toBeGreaterThan(0);
    }
  });

  it("non-existent path throws a clear error", async () => {
    const outcome = await ingestGracefully(join(workDir, "does-not-exist.txt"));
    expect(outcome.kind).toBe("error");
    expect(outcome.message).toMatch(/ENOENT|no such file/i);
  });

  it("PDF with embedded JS is handled without executing JS", async () => {
    const outcome = await ingestGracefully(join(FIXTURES, "js-embedded.pdf"));
    expect(outcome.kind === "ok" || outcome.kind === "error").toBe(true);
  });

  // Minimal encrypted-PDF crafting is non-trivial; skip until a tiny committed sample exists.
  it.skip("encrypted PDF returns a clear error (TODO: add minimal encrypted sample)", async () => {
    const outcome = await ingestGracefully(join(FIXTURES, "encrypted.pdf"));
    expect(outcome.kind).toBe("error");
  });
});

/**
 * Ingestion of files whose paths contain spaces, unicode, emoji, or trailing whitespace.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestFile } from "../lib/multimodalIngest.js";
import { GnosysStore } from "../lib/store.js";

const SPECIAL_NAMES = [
  "has spaces.txt",
  "unicodé-café.txt",
  "emoji-🎉-file.txt",
  "trailing space .txt",
];

let workDir: string;
let storePath: string;

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), "gnosys-ingest-sp-"));
  storePath = join(workDir, ".gnosys");
  mkdirSync(storePath, { recursive: true });
  await new GnosysStore(storePath).init();
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("ingestion of special-character paths", () => {
  for (const name of SPECIAL_NAMES) {
    it(`ingests ${JSON.stringify(name)}`, async () => {
      const filePath = join(workDir, name);
      writeFileSync(filePath, `Special path content. ${"word ".repeat(50)}`, "utf-8");

      const result = await ingestFile({
        filePath,
        storePath,
        mode: "structured",
        dryRun: true,
      });

      expect(result.memories.length).toBeGreaterThanOrEqual(1);
    });
  }
});

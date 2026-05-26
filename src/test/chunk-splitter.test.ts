/**
 * chunkSplitter determinism — identical input must yield identical chunks.
 */

import { describe, it, expect } from "vitest";
import { splitIntoChunks } from "../lib/chunkSplitter.js";
import { fnv1a } from "../lib/db.js";

const inputs = [
  "",
  "one short paragraph",
  Array.from({ length: 40 }, (_, i) => `Para ${i}. ${"lorem ipsum. ".repeat(20)}`).join("\n\n"),
  "x".repeat(10_000),
];

describe("chunkSplitter determinism", () => {
  for (const [i, text] of inputs.entries()) {
    it(`input #${i} produces identical chunks across runs`, () => {
      const a = splitIntoChunks(text);
      const b = splitIntoChunks(text);
      expect(a).toEqual(b);
    });
  }

  it("is stable across many repetitions", () => {
    const text = inputs[2];
    const first = JSON.stringify(splitIntoChunks(text));
    for (let run = 0; run < 20; run++) {
      expect(JSON.stringify(splitIntoChunks(text))).toBe(first);
    }
  });

  it("fnv1a content hash is stable for identical content and differs for different content", () => {
    const content = "same memory body text";
    expect(fnv1a(content)).toBe(fnv1a(content));
    expect(fnv1a(content)).not.toBe(fnv1a(content + " "));
  });
});

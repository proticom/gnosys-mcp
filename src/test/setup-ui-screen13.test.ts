/**
 * Screen 13 — `gnosys config set`.
 *
 * Tests the pure render helpers in configSetRender.ts — schema validation,
 * did-you-mean suggestion, and store-source classification.
 */

import { describe, it, expect, beforeAll } from "vitest";
import path from "path";

beforeAll(() => {
  Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
});

async function load() {
  return await import("../lib/setup/configSetRender.js");
}

describe("Screen 13 — config set helpers", () => {
  it("KNOWN_CONFIG_KEYS includes the documented keys", async () => {
    const { KNOWN_CONFIG_KEYS } = await load();
    expect(KNOWN_CONFIG_KEYS).toContain("provider");
    expect(KNOWN_CONFIG_KEYS).toContain("model");
    expect(KNOWN_CONFIG_KEYS).toContain("task");
    expect(KNOWN_CONFIG_KEYS).toContain("recall");
    expect(KNOWN_CONFIG_KEYS).toContain("anthropic-model");
    expect(KNOWN_CONFIG_KEYS).toContain("xai-model");
  });

  it("suggestConfigKey returns null on exact match", async () => {
    const { suggestConfigKey } = await load();
    expect(suggestConfigKey("provider")).toBe(null);
    expect(suggestConfigKey("xai-model")).toBe(null);
  });

  it("suggestConfigKey suggests close matches on typo", async () => {
    const { suggestConfigKey } = await load();
    expect(suggestConfigKey("providr")).toBe("provider");
    expect(suggestConfigKey("modle")).toBe("model");
    expect(suggestConfigKey("xai-modl")).toBe("xai-model");
  });

  it("suggestConfigKey returns null on wild miss", async () => {
    const { suggestConfigKey } = await load();
    // Edit distance > 3 → no suggestion (avoid silly hints)
    expect(suggestConfigKey("definitely-not-a-key")).toBe(null);
  });

  it("classifyStore returns 'global' for ~/.gnosys", async () => {
    const { classifyStore } = await load();
    expect(classifyStore("/Users/edward/.gnosys", "/Users/edward")).toBe("global");
  });

  it("classifyStore returns 'project' for any other path", async () => {
    const { classifyStore } = await load();
    expect(classifyStore("/Volumes/Dev/proj/.gnosys", "/Users/edward")).toBe("project");
    expect(classifyStore(path.join("/tmp/work", ".gnosys"), "/Users/edward")).toBe("project");
  });

  it("levenshtein computes edit distance correctly", async () => {
    const { levenshtein } = await load();
    expect(levenshtein("", "")).toBe(0);
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("modle", "model")).toBe(2);
    expect(levenshtein("abc", "abc")).toBe(0);
  });
});

/**
 * Screens 1.1, 1.2, 1.3 — cold-start sub-screen headers.
 *
 * The brief was explicit: don't rewrite pickProvider / pickModel —
 * just wrap the cold-start path with atom-rendered chrome. These tests
 * pin the chrome (Header + Title + step counter) rendered around each
 * picker call.
 */

import { describe, it, expect, beforeAll } from "vitest";

beforeAll(() => {
  Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
});

function strip(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

async function load() {
  return await import("../lib/setup/coldStart.js");
}

describe("Screens 1.1 / 1.2 / 1.3 — cold-start sub-screen headers", () => {
  it("renders the provider sub-screen header (Screen 1.1)", async () => {
    const { renderProviderStepHeader } = await load();
    const out = strip(renderProviderStepHeader("5.9.3"));
    expect(out).toContain("gnosys");
    expect(out).toContain("setup");
    expect(out).toContain("provider");
    expect(out).toContain("step 1 of 4");
    expect(out).toContain("v5.9.3");
    expect(out).toContain("Choose your LLM provider");
    expect(out).toContain("prices are per-1M-tokens");
    expect(out.split("\n")).toMatchSnapshot();
  });

  it("renders the model sub-screen header (Screen 1.2)", async () => {
    const { renderModelStepHeader } = await load();
    const out = strip(renderModelStepHeader("anthropic", "5.9.3"));
    expect(out).toContain("step 2 of 4");
    expect(out).toContain("provider");
    expect(out).toContain("model");
    expect(out).toContain("Choose a model for anthropic");
    expect(out.split("\n")).toMatchSnapshot();
  });

  it("renders the key sub-screen header (Screen 1.3)", async () => {
    const { renderKeyStepHeader } = await load();
    const out = strip(renderKeyStepHeader("anthropic", "5.9.3"));
    expect(out).toContain("step 3 of 4");
    expect(out).toContain("API key for anthropic");
    expect(out).toContain("we'll validate it before saving anything");
    expect(out.split("\n")).toMatchSnapshot();
  });

  it("renderKeySourceRows tags the env-var row with `◂ found` when detected", async () => {
    const { renderKeySourceRows } = await load();
    const out = renderKeySourceRows([
      { label: "environment variable", meta: "ANTHROPIC_API_KEY", found: true },
      { label: "macos keychain", meta: "(will store securely)" },
      { label: "paste inline", meta: "(we'll move it to keychain)" },
      { label: "skip for now", meta: "(configure later)" },
    ]).map(strip);
    expect(out.length).toBe(4);
    expect(out[0]).toContain("environment variable");
    expect(out[0]).toContain("ANTHROPIC_API_KEY");
    expect(out[0]).toContain("◂ found");
    expect(out[1]).not.toContain("◂ found");
    expect(out).toMatchSnapshot();
  });

  it("renderKeyStepFooter has the 1-4 hint", async () => {
    const { renderKeyStepFooter } = await load();
    const out = strip(renderKeyStepFooter());
    expect(out).toContain("1–4 · pick");
    expect(out).toContain("b · back");
  });
});

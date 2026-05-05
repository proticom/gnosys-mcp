/**
 * Phase 6 — gnosys-choose fenced YAML protocol parser.
 *
 * Tests cover well-formed fences, malformed fences, partial captures,
 * trailing/leading text preservation, and the formatSelection helper.
 */

import { describe, it, expect } from "vitest";
import {
  parseChooseYaml,
  extractChooseFence,
  formatSelection,
  CHOOSE_SYSTEM_PROMPT_ADDENDUM,
} from "../lib/chat/choose.js";

describe("parseChooseYaml", () => {
  it("parses a well-formed block with two options + details", () => {
    const yaml = `prompt: Which approach should we take?
options:
  - id: a
    label: Refactor in place
    detail: Lower risk
  - id: b
    label: Extract to a new module
    detail: Cleaner separation`;
    const block = parseChooseYaml(yaml);
    expect(block.prompt).toBe("Which approach should we take?");
    expect(block.options).toHaveLength(2);
    expect(block.options[0]).toEqual({ id: "a", label: "Refactor in place", detail: "Lower risk" });
    expect(block.options[1]).toEqual({ id: "b", label: "Extract to a new module", detail: "Cleaner separation" });
  });

  it("parses a block without details", () => {
    const yaml = `prompt: Pick one
options:
  - id: x
    label: First
  - id: y
    label: Second`;
    const block = parseChooseYaml(yaml);
    expect(block.options[0].detail).toBeUndefined();
    expect(block.options[1].detail).toBeUndefined();
  });

  it("tolerates Windows line endings", () => {
    const yaml = "prompt: q\r\noptions:\r\n  - id: a\r\n    label: A\r\n";
    const block = parseChooseYaml(yaml);
    expect(block.prompt).toBe("q");
    expect(block.options).toHaveLength(1);
  });

  it("ignores unknown top-level fields (forward-compat)", () => {
    const yaml = `prompt: q
description: extra metadata
options:
  - id: a
    label: A`;
    const block = parseChooseYaml(yaml);
    expect(block.prompt).toBe("q");
    expect(block.options).toHaveLength(1);
  });

  it("returns empty options when none are listed", () => {
    const yaml = `prompt: empty`;
    const block = parseChooseYaml(yaml);
    expect(block.options).toEqual([]);
  });
});

describe("extractChooseFence", () => {
  it("returns null when there is no fence", () => {
    expect(extractChooseFence("Just a regular response.")).toBeNull();
  });

  it("extracts the fence and the surrounding text", () => {
    const text = `Here are your options:

\`\`\`gnosys-choose
prompt: Which path?
options:
  - id: a
    label: Go left
  - id: b
    label: Go right
\`\`\`

Pick one.`;
    const result = extractChooseFence(text);
    expect(result?.kind).toBe("ok");
    if (result?.kind === "ok") {
      expect(result.before).toBe("Here are your options:");
      expect(result.after).toBe("Pick one.");
      expect(result.block.options).toHaveLength(2);
    }
  });

  it("returns parse-error for a fence with no prompt", () => {
    const text = `\`\`\`gnosys-choose
options:
  - id: a
    label: A
\`\`\``;
    const result = extractChooseFence(text);
    expect(result?.kind).toBe("parse-error");
    if (result?.kind === "parse-error") {
      expect(result.reason).toMatch(/missing prompt/i);
    }
  });

  it("returns parse-error for a fence with no options", () => {
    const text = `\`\`\`gnosys-choose
prompt: empty
\`\`\``;
    const result = extractChooseFence(text);
    expect(result?.kind).toBe("parse-error");
    if (result?.kind === "parse-error") {
      expect(result.reason).toMatch(/empty options/i);
    }
  });

  it("preserves the rawFence for fail-soft rendering on parse error", () => {
    const text = `\`\`\`gnosys-choose
prompt: q
\`\`\``;
    const result = extractChooseFence(text);
    if (result?.kind === "parse-error") {
      expect(result.rawFence).toContain("gnosys-choose");
    }
  });

  it("only extracts the first fence when multiple are present", () => {
    const text = `\`\`\`gnosys-choose
prompt: first
options:
  - id: a
    label: A
\`\`\`

\`\`\`gnosys-choose
prompt: second
options:
  - id: b
    label: B
\`\`\``;
    const result = extractChooseFence(text);
    if (result?.kind === "ok") {
      expect(result.block.prompt).toBe("first");
      expect(result.after).toContain("second");
    }
  });
});

describe("formatSelection", () => {
  it("formats a selection with detail", () => {
    expect(
      formatSelection({ id: "a", label: "First", detail: "Lower risk" }),
    ).toBe("[picked: a — First (Lower risk)]");
  });

  it("formats a selection without detail", () => {
    expect(formatSelection({ id: "b", label: "Second" })).toBe("[picked: b — Second]");
  });
});

describe("system prompt addendum", () => {
  it("contains the gnosys-choose fence example", () => {
    expect(CHOOSE_SYSTEM_PROMPT_ADDENDUM).toContain("gnosys-choose");
    expect(CHOOSE_SYSTEM_PROMPT_ADDENDUM).toContain("options:");
    expect(CHOOSE_SYSTEM_PROMPT_ADDENDUM).toContain("- id:");
  });
});

/**
 * v5.9.0 chat TUI — unit tests for pure helpers shipped in the
 * graphical-rebuild phases (α-δ).
 */

import { describe, it, expect } from "vitest";
import { splitCitations } from "../lib/chat/components/CitationText.js";

describe("splitCitations (v5.9.0 phase γ)", () => {
  it("returns a single plain segment when there are no citations", () => {
    const out = splitCitations("just some prose with no ids in it");
    expect(out).toEqual([{ kind: "plain", text: "just some prose with no ids in it" }]);
  });

  it("returns a plain segment for empty input", () => {
    const out = splitCitations("");
    expect(out).toEqual([{ kind: "plain", text: "" }]);
  });

  it("splits a single ULID citation in mid-sentence", () => {
    const out = splitCitations("see deci-01J7XQ2K9F4MNRPST5VWXYZBCD for context");
    expect(out).toEqual([
      { kind: "plain", text: "see " },
      { kind: "citation", id: "deci-01J7XQ2K9F4MNRPST5VWXYZBCD", display: "deci-01J7XQ2K9F4MNRPST5VWXYZBCD" },
      { kind: "plain", text: " for context" },
    ]);
  });

  it("matches a kebab-case pref id (pref-some-key)", () => {
    const out = splitCitations("the value of pref-code-style is...");
    expect(out.find((s) => s.kind === "citation")).toEqual({
      kind: "citation",
      id: "pref-code-style",
      display: "pref-code-style",
    });
  });

  it("preserves an ellipsis suffix in the display but not the URI id", () => {
    const out = splitCitations("see deci-01J7XQ2K9F4…");
    const cite = out.find((s) => s.kind === "citation");
    expect(cite).toBeDefined();
    if (cite?.kind !== "citation") throw new Error("not a citation");
    expect(cite.id).toBe("deci-01J7XQ2K9F4");
    expect(cite.display).toBe("deci-01J7XQ2K9F4…");
  });

  it("handles multiple citations in one string", () => {
    const out = splitCitations("compare deci-01J7X12 with deci-01J7X34 today");
    const cites = out.filter((s) => s.kind === "citation");
    expect(cites).toHaveLength(2);
  });

  it("handles a citation at the start of the string", () => {
    const out = splitCitations("deci-01J7X12 was decided in march");
    expect(out[0].kind).toBe("citation");
  });

  it("handles a citation at the end of the string", () => {
    const out = splitCitations("decided in deci-01J7X12");
    expect(out[out.length - 1].kind).toBe("citation");
  });

  it("does NOT match plain kebab-case words like 'test-cases' or 'well-known'", () => {
    // Citations require either explicit `pref-` prefix OR at least one
    // uppercase letter or digit in the suffix. Plain kebab prose stays plain.
    const out = splitCitations("test-cases and well-known need to use this-or-that");
    const cites = out.filter((s) => s.kind === "citation");
    expect(cites).toHaveLength(0);
  });

  it("matches pref- even when the rest is plain kebab (no digits/uppercase)", () => {
    const out = splitCitations("apply pref-commit-convention to all commits");
    const cite = out.find((s) => s.kind === "citation");
    expect(cite?.kind).toBe("citation");
    if (cite?.kind === "citation") {
      expect(cite.id).toBe("pref-commit-convention");
    }
  });
});

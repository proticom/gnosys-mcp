/**
 * Preference key validation — typo hints without blocking custom keys.
 */

import { describe, it, expect } from "vitest";
import { suggestPreferenceKey } from "../lib/preferences.js";

describe("suggestPreferenceKey", () => {
  it("returns null for an exact known key", () => {
    expect(suggestPreferenceKey("code-style")).toBeNull();
    expect(suggestPreferenceKey("commit-convention")).toBeNull();
  });

  it("returns the closest known key for a close typo", () => {
    expect(suggestPreferenceKey("commit-conventon")).toBe("commit-convention");
    expect(suggestPreferenceKey("code-styl")).toBe("code-style");
  });

  it("returns null for a far custom key (allowed through)", () => {
    expect(suggestPreferenceKey("my-team-ritual")).toBeNull();
    expect(suggestPreferenceKey("prefer-simple-solutions")).toBeNull();
  });
});

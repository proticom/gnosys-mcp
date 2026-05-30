/**
 * Upgrade-output filtering — strip the two unfixable deprecation warnings
 * (prebuild-install, boolean) from `gnosys upgrade` without hiding anything
 * else npm prints.
 */

import { describe, it, expect } from "vitest";
import { isSuppressedNpmLine, makeNpmStderrFilter } from "../lib/installOutput.js";

const PREBUILD_LINE =
  "npm warn deprecated prebuild-install@7.1.3: No longer maintained. Please contact the author of the relevant native addon; alternatives are available.";
const BOOLEAN_LINE =
  "npm warn deprecated boolean@3.2.0: Package no longer supported. Contact Support at https://www.npmjs.com/support for more info.";

describe("isSuppressedNpmLine", () => {
  it("suppresses the prebuild-install and boolean deprecation lines", () => {
    expect(isSuppressedNpmLine(PREBUILD_LINE)).toBe(true);
    expect(isSuppressedNpmLine(BOOLEAN_LINE)).toBe(true);
  });

  it("does NOT suppress other deprecation warnings", () => {
    expect(
      isSuppressedNpmLine("npm warn deprecated some-other-pkg@1.0.0: please upgrade"),
    ).toBe(false);
  });

  it("does NOT suppress a lookalike package name (requires the @ boundary)", () => {
    // "boolean-x" must not be caught by the "boolean" rule.
    expect(
      isSuppressedNpmLine("npm warn deprecated boolean-x@2.0.0: deprecated"),
    ).toBe(false);
  });

  it("leaves normal npm output and errors untouched", () => {
    expect(isSuppressedNpmLine("changed 309 packages in 35s")).toBe(false);
    expect(isSuppressedNpmLine("npm error code E404")).toBe(false);
    expect(isSuppressedNpmLine("")).toBe(false);
  });
});

describe("makeNpmStderrFilter", () => {
  function collect(): { box: { out: string }; write: (t: string) => void } {
    const box = { out: "" };
    return { box, write: (t: string) => { box.out += t; } };
  }

  it("drops suppressed lines and keeps the rest, in order", () => {
    const { box, write } = collect();
    const filter = makeNpmStderrFilter(write);
    filter.feed(
      `${PREBUILD_LINE}\n${BOOLEAN_LINE}\nchanged 309 packages in 35s\n`,
    );
    filter.end();
    expect(box.out).toBe("changed 309 packages in 35s\n");
  });

  it("handles a suppressed line split across two chunks", () => {
    const { box, write } = collect();
    const filter = makeNpmStderrFilter(write);
    const mid = Math.floor(PREBUILD_LINE.length / 2);
    filter.feed(PREBUILD_LINE.slice(0, mid));
    filter.feed(`${PREBUILD_LINE.slice(mid)}\nkept line\n`);
    filter.end();
    expect(box.out).toBe("kept line\n");
  });

  it("flushes a trailing partial line that has no newline", () => {
    const { box, write } = collect();
    const filter = makeNpmStderrFilter(write);
    filter.feed("npm notice New minor version of npm available!");
    filter.end();
    expect(box.out).toBe("npm notice New minor version of npm available!");
  });

  it("suppresses a trailing partial line if it matches", () => {
    const { box, write } = collect();
    const filter = makeNpmStderrFilter(write);
    filter.feed(PREBUILD_LINE); // no trailing newline
    filter.end();
    expect(box.out).toBe("");
  });
});

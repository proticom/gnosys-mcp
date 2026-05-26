import { afterEach, describe, expect, it, vi } from "vitest";
import { createProgress } from "../lib/progress.js";

describe("createProgress", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a no-op progress instance when verbose is false", () => {
    const progress = createProgress(false);
    expect(progress.noop).toBe(true);
    expect(() => {
      progress.header("ignored");
      progress.step("ignored");
      progress.tick("ignored");
      progress.done("ignored");
    }).not.toThrow();
  });

  it("emits header, step, and done lines when verbose is true", () => {
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk));
      return true;
    });

    const progress = createProgress(true);
    expect(progress.noop).toBe(false);

    progress.header("Sync");
    progress.step("Pushing memories");
    progress.done("Done");

    expect(writes.join("")).toContain("=== Sync ===");
    expect(writes.join("")).toContain("Pushing memories");
    expect(writes.join("")).toContain("Done");
  });
});

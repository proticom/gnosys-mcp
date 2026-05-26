import { afterEach, describe, expect, it, vi } from "vitest";
import { isTransientError, withRetry } from "../lib/retry.js";

describe("isTransientError", () => {
  it("returns true for rate limits, timeouts, 5xx, and network errors", () => {
    expect(isTransientError(new Error("HTTP 429 too many requests"))).toBe(true);
    expect(isTransientError(new Error("request timed out"))).toBe(true);
    expect(isTransientError(new Error("ECONNRESET"))).toBe(true);
    expect(isTransientError(new Error("503 service overloaded"))).toBe(true);
    expect(isTransientError(new Error("fetch failed"))).toBe(true);
  });

  it("returns false for ordinary errors", () => {
    expect(isTransientError(new Error("invalid api key"))).toBe(false);
  });
});

describe("withRetry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves after transient failures", async () => {
    vi.useFakeTimers();
    let attempts = 0;
    const fn = vi.fn(async () => {
      attempts++;
      if (attempts < 3) throw new Error("503 overloaded");
      return "ok";
    });

    const promise = withRetry(fn, { maxAttempts: 3, baseDelayMs: 100, exponential: false });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("rethrows non-transient errors immediately", async () => {
    vi.useFakeTimers();
    const fn = vi.fn(async () => {
      throw new Error("invalid api key");
    });

    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 100 })).rejects.toThrow(
      "invalid api key",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

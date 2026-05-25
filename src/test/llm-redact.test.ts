import { describe, it, expect } from "vitest";
import { redactKey } from "../lib/llm.js";

describe("redactKey", () => {
  it("strips a literal xai key from error text", () => {
    const key = "xai-SECRET123456789";
    const result = redactKey(`error: ${key} is invalid`, key);
    expect(result).not.toContain("SECRET123456789");
    expect(result).toContain("***");
  });

  it("redacts sk-ant- prefixed keys via regex", () => {
    const result = redactKey("Invalid key sk-ant-api03-abcdef1234567890");
    expect(result).not.toContain("api03-abcdef");
    expect(result).toContain("***");
  });

  it("leaves short keys unchanged when below length threshold", () => {
    const result = redactKey("error: short-key bad", "short");
    expect(result).toBe("error: short-key bad");
  });
});

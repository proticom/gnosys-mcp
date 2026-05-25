/**
 * webIngest SSRF guard tests — hostile URLs and redirect bypasses.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { isSafeUrl, safeFetch } from "../lib/webIngest.js";

const BLOCKED = [
  "file:///etc/passwd",
  "gopher://example.com/",
  "http://127.0.0.1/",
  "http://localhost/",
  "http://169.254.169.254/",
  "http://10.0.0.1/",
  "http://192.168.1.1/",
  "http://2130706433/",
  "http://0.0.0.0/",
  "http://0x7f000001/",
  "http://0x7f.0.0.1/",
  "http://[::1]/",
  "http://[fc00::1]/",
  "http://[fe80::1]/",
];

describe("webIngest SSRF guards", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const url of BLOCKED) {
    it(`rejects ${url}`, () => {
      expect(isSafeUrl(url)).toBe(false);
    });
  }

  it("allows a normal public https URL", () => {
    expect(isSafeUrl("https://example.com/page")).toBe(true);
  });

  it("allows loopback only when explicitly opted in", () => {
    expect(isSafeUrl("http://127.0.0.1/", { allowLoopback: true })).toBe(true);
    expect(isSafeUrl("http://127.0.0.1/")).toBe(false);
  });

  it("rejects redirects to cloud metadata endpoints", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const target = String(input);
      if (init?.redirect === "manual" && target === "https://example.com/redirect") {
        return new Response(null, {
          status: 302,
          headers: { Location: "http://169.254.169.254/latest/meta-data/" },
        });
      }
      return new Response("ok", { status: 200 });
    });

    await expect(safeFetch("https://example.com/redirect")).rejects.toThrow(/unsafe URL/i);
  });
});

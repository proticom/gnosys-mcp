/**
 * import-from-URL SSRF guard tests — same protections as webIngest (task 7.7).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { loadData } from "../lib/import.js";

const BLOCKED = [
  "http://127.0.0.1:7777/x",
  "http://localhost/x",
  "http://[::1]/x",
  "http://0x7f000001/x",
  "http://2130706433/x",
  "http://169.254.169.254/",
  "http://10.0.0.1/",
  "http://192.168.1.1/",
];

describe("import URL SSRF guards", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const url of BLOCKED) {
    it(`refuses ${url}`, async () => {
      await expect(loadData(url, "json")).rejects.toThrow(/unsafe URL/i);
    });
  }

  it("rejects redirects to loopback", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const target = String(input);
      if (init?.redirect === "manual" && target === "https://example.com/redirect") {
        return new Response(null, {
          status: 302,
          headers: { Location: "http://127.0.0.1:7777/x" },
        });
      }
      return new Response("[]", { status: 200 });
    });

    await expect(loadData("https://example.com/redirect", "json")).rejects.toThrow(
      /unsafe URL/i
    );
  });
});

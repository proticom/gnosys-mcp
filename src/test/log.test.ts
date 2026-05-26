import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

describe("structured logger", () => {
  const envBackup = { ...process.env };
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    process.env = { ...envBackup };
    stderrSpy?.mockRestore();
    vi.resetModules();
  });

  async function loadLog() {
    return await import("../lib/log.js");
  }

  it("writes plain text to stderr by default", async () => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { logError } = await loadLog();
    logError(new Error("boom"), { ctx: "demo" });
    const output = stderrSpy.mock.calls.map((call: unknown[]) => String(call[0])).join("");
    expect(output).toContain("boom");
    expect(output).not.toMatch(/^\s*\{/);
  });

  it("writes JSON lines when GNOSYS_LOG_FORMAT=json", async () => {
    process.env.GNOSYS_LOG_FORMAT = "json";
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { logError } = await loadLog();
    logError(new Error("boom"), { ctx: "demo" });
    const line = String(stderrSpy.mock.calls[0][0]).trim();
    const parsed = JSON.parse(line) as {
      timestamp: string;
      level: string;
      message: string;
      ctx: string;
      error: { stack: string };
    };
    expect(parsed.level).toBe("error");
    expect(parsed.message).toBe("boom");
    expect(parsed.ctx).toBe("demo");
    expect(parsed.timestamp).toBeTruthy();
    expect(parsed.error.stack).toContain("boom");
  });

  it("appends JSON lines to GNOSYS_LOG_FILE", async () => {
    const logFile = path.join(os.tmpdir(), `gnosys-log-${Date.now()}.jsonl`);
    process.env.GNOSYS_LOG_FILE = logFile;
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { logError } = await loadLog();
    logError(new Error("file sink"), { module: "test" });
    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
    const parsed = JSON.parse(lines.at(-1)!) as { level: string; message: string; module: string };
    expect(parsed.level).toBe("error");
    expect(parsed.message).toBe("file sink");
    expect(parsed.module).toBe("test");
    fs.unlinkSync(logFile);
  });

  it("respects GNOSYS_LOG_LEVEL gating", async () => {
    process.env.GNOSYS_LOG_LEVEL = "error";
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { logInfo, logError } = await loadLog();
    logInfo("hidden");
    logError(new Error("shown"));
    expect(stderrSpy).toHaveBeenCalledTimes(1);
  });

  it("never throws on bad file paths", async () => {
    process.env.GNOSYS_LOG_FILE = "/definitely/not/a/writable/path/gnosys.log";
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { logError } = await loadLog();
    expect(() => logError(new Error("safe"))).not.toThrow();
  });
});

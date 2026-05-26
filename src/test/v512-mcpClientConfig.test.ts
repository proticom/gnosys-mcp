/**
 * v5.12 Phase B — client config: point an IDE at a remote gnosys server.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import os from "os";
import path from "path";
import {
  remoteMcpEntry,
  writeCursorRemote,
  mergeJsonMcpServer,
} from "../lib/mcpClientConfig.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-client-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("v5.12 remoteMcpEntry", () => {
  it("returns a url entry without a token", () => {
    expect(remoteMcpEntry({ url: "http://host:7777/mcp" })).toEqual({ url: "http://host:7777/mcp" });
  });

  it("includes a bearer header when a token is given", () => {
    expect(remoteMcpEntry({ url: "http://host:7777/mcp", token: "abc" })).toEqual({
      url: "http://host:7777/mcp",
      headers: { Authorization: "Bearer abc" },
    });
  });
});

describe("v5.12 writeCursorRemote", () => {
  it("writes .cursor/mcp.json pointing gnosys at the URL", async () => {
    const file = await writeCursorRemote(dir, { url: "http://studio:7777/mcp", token: "t0ken" });
    expect(file).toBe(path.join(dir, ".cursor", "mcp.json"));
    const cfg = JSON.parse(await fsp.readFile(file, "utf-8"));
    expect(cfg.mcpServers.gnosys).toEqual({
      url: "http://studio:7777/mcp",
      headers: { Authorization: "Bearer t0ken" },
    });
  });

  it("merges with an existing mcpServers map (preserves other servers)", async () => {
    const file = path.join(dir, ".cursor", "mcp.json");
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, JSON.stringify({ mcpServers: { other: { command: "x" } } }), "utf-8");

    await writeCursorRemote(dir, { url: "http://studio:7777/mcp" });
    const cfg = JSON.parse(await fsp.readFile(file, "utf-8"));
    expect(cfg.mcpServers.other).toEqual({ command: "x" });
    expect(cfg.mcpServers.gnosys).toEqual({ url: "http://studio:7777/mcp" });
  });

  it("mergeJsonMcpServer creates the file fresh when absent", async () => {
    const file = path.join(dir, "nested", "mcp.json");
    await mergeJsonMcpServer(file, remoteMcpEntry({ url: "http://h/mcp" }));
    const cfg = JSON.parse(await fsp.readFile(file, "utf-8"));
    expect(cfg.mcpServers.gnosys.url).toBe("http://h/mcp");
  });
});

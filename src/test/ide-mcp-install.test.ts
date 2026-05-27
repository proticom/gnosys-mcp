/**
 * IDE MCP install audit — every supported host gets gnosys-mcp (not gnosys serve).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  normalizeIdeKey,
  isStaleGnosysMcpEntry,
  gnosysStdioMcpEntry,
  cursorMcpPaths,
  removeTomlSection,
} from "../lib/ideMcpInstall.js";
import { setupIDE } from "../lib/setup.js";
import { upsertGrokMcpBlock } from "../lib/setup.js";
import { getClaudeDesktopConfigPath } from "../lib/platform.js";

function assertGnosysMcp(entry: unknown): void {
  expect(entry).toBeTruthy();
  const e = entry as { command: string; args: string[] };
  expect(e.command).toMatch(/gnosys-mcp$/);
  expect(e.args).toEqual([]);
  expect(isStaleGnosysMcpEntry(entry)).toBe(false);
}

describe("ideMcpInstall helpers", () => {
  it("normalizeIdeKey accepts grok alias", () => {
    expect(normalizeIdeKey("grok")).toBe("grok-build");
    expect(normalizeIdeKey("cursor")).toBe("cursor");
    expect(normalizeIdeKey("nosuch")).toBeNull();
  });

  it("detects stale gnosys serve entries", () => {
    expect(isStaleGnosysMcpEntry({ command: "gnosys", args: ["serve"] })).toBe(true);
    expect(isStaleGnosysMcpEntry({ command: "/bin/gnosys-mcp", args: [] })).toBe(false);
  });

  it("gnosysStdioMcpEntry uses gnosys-mcp command", () => {
    const e = gnosysStdioMcpEntry();
    expect(e.command).toMatch(/gnosys-mcp/);
    expect(e.args).toEqual([]);
  });
});

describe("setupIDE MCP outputs", () => {
  let projectDir: string;
  let fakeHome: string;
  let savedHome: string | undefined;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "gnosys-ide-mcp-"));
    fakeHome = mkdtempSync(join(tmpdir(), "gnosys-fake-home-"));
    savedHome = process.env.HOME;
    process.env.HOME = fakeHome;
  });

  afterEach(() => {
    if (savedHome !== undefined) process.env.HOME = savedHome;
    else delete process.env.HOME;
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it("cursor writes project and user mcp.json", async () => {
    const r = await setupIDE("cursor", projectDir);
    expect(r.success).toBe(true);
    const paths = cursorMcpPaths(projectDir);
    for (const p of [paths.project, paths.user]) {
      const cfg = JSON.parse(readFileSync(p, "utf-8")) as { mcpServers?: Record<string, unknown> };
      assertGnosysMcp(cfg.mcpServers?.gnosys);
    }
  });

  it("grok writes mcp_servers.gnosys in ~/.grok/config.toml", async () => {
    const r = await setupIDE("grok", projectDir);
    expect(r.success).toBe(true);
    const toml = readFileSync(join(fakeHome, ".grok", "config.toml"), "utf-8");
    expect(toml).toContain("[mcp_servers.gnosys]");
    expect(toml).not.toContain("[mcp.gnosys]");
    expect(toml).toMatch(/gnosys-mcp/);
    expect(toml).toContain("startup_timeout_sec = 90");
  });

  it("gemini-cli and antigravity write mcpServers.gnosys", async () => {
    for (const ide of ["gemini-cli", "antigravity"] as const) {
      const r = await setupIDE(ide, projectDir);
      expect(r.success).toBe(true);
    }
    const gemini = JSON.parse(
      readFileSync(join(fakeHome, ".gemini", "settings.json"), "utf-8"),
    ) as { mcpServers?: Record<string, unknown> };
    assertGnosysMcp(gemini.mcpServers?.gnosys);

    const ag = JSON.parse(
      readFileSync(join(fakeHome, ".gemini", "antigravity", "mcp_config.json"), "utf-8"),
    ) as { mcpServers?: Record<string, unknown> };
    assertGnosysMcp(ag.mcpServers?.gnosys);
  });

  it("claude-desktop writes mcpServers.gnosys", async () => {
    const r = await setupIDE("claude-desktop", projectDir);
    expect(r.success).toBe(true);
    const cfgPath = getClaudeDesktopConfigPath();
    if (!existsSync(cfgPath)) return;
    const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as {
      mcpServers?: Record<string, unknown>;
    };
    assertGnosysMcp(cfg.mcpServers?.gnosys);
  });
});

describe("removeTomlSection — Codex legacy cleanup", () => {
  it("removes [gnosys] regardless of field order", () => {
    const before = `[other]
x = 1

[gnosys]
args = ["serve"]
command = "gnosys"

[mcp.gnosys]
type = "local"
command = ["gnosys", "serve"]
`;
    let out = removeTomlSection(before, "[mcp.gnosys]");
    out = removeTomlSection(out, "[gnosys]");
    expect(out).not.toContain("[gnosys]");
    expect(out).not.toContain("[mcp.gnosys]");
    expect(out).toContain("[other]");
  });
});

describe("setupIDE(claude) resilience", () => {
  let projectDir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), "gnosys-claude-res-"));
    savedPath = process.env.PATH;
    process.env.PATH = "/usr/empty";
  });

  afterEach(() => {
    if (savedPath !== undefined) process.env.PATH = savedPath;
    else delete process.env.PATH;
    rmSync(projectDir, { recursive: true, force: true });
  });

  it("still writes Claude Desktop when claude CLI is unavailable", async () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "gnosys-claude-home-"));
    const savedHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const r = await setupIDE("claude", projectDir);
      expect(r.message).toMatch(/Claude Desktop MCP config updated/);
      const cfgPath = getClaudeDesktopConfigPath();
      const cfg = JSON.parse(readFileSync(cfgPath, "utf-8")) as {
        mcpServers?: Record<string, unknown>;
      };
      assertGnosysMcp(cfg.mcpServers?.gnosys);
    } finally {
      process.env.HOME = savedHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});

describe("upsertGrokMcpBlock", () => {
  it("uses mcp_servers header per Grok Build spec", () => {
    const out = upsertGrokMcpBlock("", "gnosys", {
      command: "/usr/local/bin/gnosys-mcp",
      args: [],
      startup_timeout_sec: 90,
    });
    expect(out).toContain("[mcp_servers.gnosys]");
  });
});

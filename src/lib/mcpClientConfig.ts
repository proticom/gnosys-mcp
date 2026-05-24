/**
 * Point an IDE at a REMOTE gnosys server (v5.12 Phase B).
 *
 * In the central-server topology, a client machine doesn't spawn a local
 * `gnosys serve` — its IDE connects to the host's URL. This writes the URL-based
 * MCP entry into the IDE config (instead of the `{ command, args }` stdio form
 * the local setup writes).
 */

import fs from "fs/promises";
import path from "path";
import os from "os";

export interface RemoteOpts {
  url: string;
  token?: string;
}

/** The MCP server entry for a remote (HTTP/URL) gnosys server. */
export function remoteMcpEntry(opts: RemoteOpts): Record<string, unknown> {
  return {
    url: opts.url,
    ...(opts.token ? { headers: { Authorization: `Bearer ${opts.token}` } } : {}),
  };
}

/** Platform-specific Claude Desktop config path (mirrors setup.ts). */
export function claudeDesktopConfigPath(): string {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  return path.join(home, ".config", "Claude", "claude_desktop_config.json");
}

/** Merge a `gnosys` entry into a JSON file's `mcpServers` map (create if absent). */
export async function mergeJsonMcpServer(file: string, entry: Record<string, unknown>): Promise<void> {
  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(await fs.readFile(file, "utf-8"));
  } catch {
    // missing or invalid — start fresh
  }
  const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
  servers.gnosys = entry;
  config.mcpServers = servers;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

/** Write the remote entry into a project's `.cursor/mcp.json`. Returns the path. */
export async function writeCursorRemote(projectDir: string, opts: RemoteOpts): Promise<string> {
  const file = path.join(projectDir, ".cursor", "mcp.json");
  await mergeJsonMcpServer(file, remoteMcpEntry(opts));
  return file;
}

/** Write the remote entry into the Claude Desktop config. Returns the path. */
export async function writeClaudeDesktopRemote(opts: RemoteOpts): Promise<string> {
  const file = claudeDesktopConfigPath();
  await mergeJsonMcpServer(file, remoteMcpEntry(opts));
  return file;
}

export type RemoteIde = "cursor" | "claude-desktop";

export async function writeRemoteClientConfig(
  ide: RemoteIde,
  projectDir: string,
  opts: RemoteOpts,
): Promise<string> {
  return ide === "claude-desktop"
    ? writeClaudeDesktopRemote(opts)
    : writeCursorRemote(projectDir, opts);
}

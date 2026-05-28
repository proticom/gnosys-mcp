import { remoteMcpEntry, writeRemoteClientConfig } from "./mcpClientConfig.js";

export type ConnectCommandOptions = {
  url: string;
  token?: string;
  ide?: string;
  dir?: string;
  print?: boolean;
};

export async function runConnectCommand(opts: ConnectCommandOptions): Promise<void> {
  const remote = { url: opts.url, token: opts.token };
  if (opts.print) {
    console.log(JSON.stringify({ mcpServers: { gnosys: remoteMcpEntry(remote) } }, null, 2));
    return;
  }

  const ide: "cursor" | "claude-desktop" =
    opts.ide === "claude-desktop" ? "claude-desktop" : "cursor";
  try {
    const file = await writeRemoteClientConfig(ide, opts.dir || process.cwd(), remote);
    console.log(`✓ Pointed ${ide} at ${opts.url}`);
    console.log(`  wrote: ${file}${opts.token ? "  (bearer token included)" : ""}`);
    console.log("  Restart the IDE / MCP servers to pick it up.");
  } catch (e) {
    console.error(`connect failed: ${e instanceof Error ? e.message : e}`);
    process.exitCode = 1;
  }
}

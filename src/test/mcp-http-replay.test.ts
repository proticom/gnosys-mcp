import { describe, it, expect, afterEach } from "vitest";
import { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMcpHttpServer, type McpHttpHandle } from "../lib/mcpHttp.js";
import { registerCapabilities } from "../index.js";

let handle: McpHttpHandle | null = null;
const clients: Client[] = [];

afterEach(async () => {
  for (const c of clients) {
    try {
      await c.close();
    } catch {
      /* ignore */
    }
  }
  clients.length = 0;
  if (handle) {
    await handle.close();
    handle = null;
  }
});

async function connect(base: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"));
  const client = new Client({ name: "replay-client", version: "0.0.0" });
  await client.connect(transport);
  clients.push(client);
  return client;
}

describe("MCP HTTP registration replay", () => {
  it("two concurrent sessions both see the full real tool list", async () => {
    handle = await startMcpHttpServer({
      host: "127.0.0.1",
      port: 0,
      makeServer: () => {
        const server = new McpServer({ name: "gnosys", version: "test" });
        registerCapabilities(server);
        return server;
      },
    });

    const base = `http://127.0.0.1:${(handle.server.address() as AddressInfo).port}`;
    const [client1, client2] = await Promise.all([connect(base), connect(base)]);
    const [list1, list2] = await Promise.all([client1.listTools(), client2.listTools()]);
    const names1 = list1.tools.map((t) => t.name).sort();
    const names2 = list2.tools.map((t) => t.name).sort();

    expect(names1.length).toBeGreaterThanOrEqual(51);
    expect(names1).toEqual(names2);

    for (const expected of ["gnosys_discover", "gnosys_recall", "gnosys_add", "gnosys_ingest_file"]) {
      expect(names1).toContain(expected);
    }
  }, 60_000);
});

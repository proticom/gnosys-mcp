/**
 * MCP tool input schema fuzzing — verifies Zod schemas reject malformed arguments.
 */

import { describe, it, expect, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerCapabilities } from "../index.js";

const CALL_TIMEOUT_MS = 5_000;

async function connect() {
  const server = new McpServer({ name: "fuzz", version: "0.0.0" });
  registerCapabilities(server);
  const client = new Client({ name: "fuzz-client", version: "0.0.0" });
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { server, client };
}

function schemaFields(tool: { inputSchema?: { properties?: Record<string, unknown>; required?: string[] } }) {
  const properties = tool.inputSchema?.properties ?? {};
  const required = tool.inputSchema?.required ?? [];
  return { required, properties };
}

function badValueForProperty(prop: unknown): unknown {
  const type = (prop as { type?: string })?.type;
  if (type === "number" || type === "integer") return "not-a-number";
  if (type === "boolean") return "not-a-boolean";
  if (type === "array") return "not-an-array";
  if (type === "object") return "not-an-object";
  return 123;
}

async function callRejected(client: Client, name: string, args: unknown): Promise<boolean> {
  const call = (async () => {
    try {
      const result = await client.callTool({ name, arguments: args as Record<string, unknown> });
      return result.isError === true;
    } catch {
      return true;
    }
  })();

  const timedOut = new Promise<boolean>((_, reject) => {
    setTimeout(() => reject(new Error(`callTool timed out for ${name}`)), CALL_TIMEOUT_MS);
  });

  return Promise.race([call, timedOut]);
}

describe("MCP tool input fuzzing", () => {
  let client: Client;
  let server: McpServer;

  afterEach(async () => {
    try {
      await client?.close();
    } catch {
      /* ignore */
    }
    try {
      await server?.close();
    } catch {
      /* ignore */
    }
  });

  it("rejects malformed input for every tool with required fields", async () => {
    ({ server, client } = await connect());
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(51);

    for (const tool of tools) {
      const { required, properties } = schemaFields(tool);
      if (required.length === 0) continue;

      const field = required[0];
      const prop = properties[field];
      const wrongType = { [field]: badValueForProperty(prop) };
      const badInputs: unknown[] = [{}, wrongType];

      for (const bad of badInputs) {
        const rejected = await callRejected(client, tool.name, bad);
        expect(
          rejected,
          `${tool.name} accepted bad input: ${JSON.stringify(bad).slice(0, 60)}`,
        ).toBe(true);
      }
    }
  }, 180_000);
});

/**
 * Acceptance feature smokes — one happy path each for headline README features
 * not covered in acceptance.test.ts (MCP server, Web KB, multi-machine sync).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { buildIndexSync } from "../lib/webIndex.js";
import { loadIndex, search, clearIndexCache } from "../lib/staticSearch.js";
import { GnosysDB, type DbMemory } from "../lib/db.js";
import { RemoteSync } from "../lib/remote.js";

const WEB_FIXTURES = path.resolve(__dirname, "fixtures/web");
const MCP_ENTRY = path.resolve("dist/index.js");

function toolText(result: { content?: unknown; isError?: boolean | null | undefined }): string {
  const blocks = result.content as Array<{ type: string; text?: string }> | undefined;
  return blocks?.find((block) => block.type === "text")?.text ?? "";
}

async function connectMcpSubprocess(
  centralDir: string,
  isolatedHome: string,
): Promise<{ client: Client; transport: StdioClientTransport }> {
  const transport = new StdioClientTransport({
    command: "node",
    args: [MCP_ENTRY],
    cwd: centralDir,
    env: {
      ...process.env,
      GNOSYS_HOME: centralDir,
      HOME: isolatedHome,
      USERPROFILE: isolatedHome,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "acceptance-features-client", version: "0.0.0" });
  await client.connect(transport);
  return { client, transport };
}

function makeSyncMemory(content: string): DbMemory {
  return {
    id: "accept-sync-001",
    title: "Acceptance sync memory",
    category: "decisions",
    content,
    summary: null,
    tags: '["sync","acceptance"]',
    relevance: "acceptance multi-machine sync smoke",
    author: "human+ai",
    authority: "declared",
    confidence: 0.9,
    reinforcement_count: 0,
    content_hash: "accept-sync-hash",
    status: "active",
    tier: "active",
    supersedes: null,
    superseded_by: null,
    last_reinforced: null,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:00.000Z",
    embedding: null,
    source_path: null,
    source_file: null,
    source_page: null,
    source_timerange: null,
    project_id: null,
    scope: "project",
  } as DbMemory;
}

describe("Acceptance feature smokes", () => {
  describe("MCP server", () => {
    let centralDir: string;
    let isolatedHome: string;
    let projectDir: string;
    let origGnosysHome: string | undefined;
    let client: Client;

    beforeEach(() => {
      centralDir = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-acc-mcp-central-"));
      isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-acc-mcp-home-"));
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-acc-mcp-proj-"));
      origGnosysHome = process.env.GNOSYS_HOME;
      process.env.GNOSYS_HOME = centralDir;
    });

    afterEach(async () => {
      try {
        await client?.close();
      } catch {
        /* ignore */
      }
      if (origGnosysHome === undefined) delete process.env.GNOSYS_HOME;
      else process.env.GNOSYS_HOME = origGnosysHome;
      await fsp.rm(centralDir, { recursive: true, force: true });
      await fsp.rm(isolatedHome, { recursive: true, force: true });
      await fsp.rm(projectDir, { recursive: true, force: true });
    });

    it("lists gnosys tools and round-trips init + add + search", async () => {
      ({ client } = await connectMcpSubprocess(centralDir, isolatedHome));
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);
      expect(names.some((name) => name.startsWith("gnosys_"))).toBe(true);
      expect(names).toContain("gnosys_add_structured");
      expect(names).toContain("gnosys_search");

      const initResult = await client.callTool({
        name: "gnosys_init",
        arguments: { directory: projectDir },
      });
      expect(initResult.isError).not.toBe(true);

      const addResult = await client.callTool({
        name: "gnosys_add_structured",
        arguments: {
          title: "Acceptance MCP Memory",
          category: "decisions",
          tags: { domain: ["acceptance"] },
          relevance: "acceptance mcp smoke test",
          content: "MCP server acceptance smoke memory.",
          projectRoot: projectDir,
        },
      });
      expect(addResult.isError).not.toBe(true);
      expect(toolText(addResult as { content?: unknown; isError?: boolean | null })).toContain("Acceptance MCP Memory");

      const searchResult = await client.callTool({
        name: "gnosys_search",
        arguments: {
          query: "acceptance mcp smoke",
          limit: 5,
          projectRoot: projectDir,
        },
      });
      expect(searchResult.isError).not.toBe(true);
      expect(toolText(searchResult as { content?: unknown; isError?: boolean | null })).toContain("Acceptance MCP Memory");
    }, 60_000);
  });

  describe("Web Knowledge Base", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-acc-web-"));
      clearIndexCache();
    });

    afterEach(async () => {
      clearIndexCache();
      await fsp.rm(tmpDir, { recursive: true, force: true });
    });

    it("builds an index from docs and returns search hits", () => {
      const knowledgeDir = path.join(tmpDir, "knowledge");
      fs.mkdirSync(knowledgeDir, { recursive: true });
      const srcDir = path.join(WEB_FIXTURES, "sample-knowledge");
      for (const file of fs.readdirSync(srcDir)) {
        fs.copyFileSync(path.join(srcDir, file), path.join(knowledgeDir, file));
      }

      const index = buildIndexSync(knowledgeDir);
      const indexPath = path.join(knowledgeDir, "gnosys-index.json");
      fs.writeFileSync(indexPath, JSON.stringify(index));

      const loaded = loadIndex(indexPath);
      const results = search(loaded, "automation agents workflow");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].document.title).toContain("Agentic");
    });
  });

  describe("Multi-machine sync", () => {
    let dirA: string;
    let dirB: string;
    let nasDir: string;
    let dbA: GnosysDB;
    let dbB: GnosysDB;
    let syncA: RemoteSync;
    let syncB: RemoteSync;

    beforeEach(() => {
      dirA = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-acc-sync-a-"));
      dirB = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-acc-sync-b-"));
      nasDir = fs.mkdtempSync(path.join(os.tmpdir(), "gnosys-acc-sync-nas-"));
      dbA = new GnosysDB(dirA);
      dbB = new GnosysDB(dirB);
      syncA = new RemoteSync(dbA, nasDir);
      syncB = new RemoteSync(dbB, nasDir);
    });

    afterEach(async () => {
      syncA.closeRemote();
      syncB.closeRemote();
      dbA.close();
      dbB.close();
      await fsp.rm(dirA, { recursive: true, force: true });
      await fsp.rm(dirB, { recursive: true, force: true });
      await fsp.rm(nasDir, { recursive: true, force: true });
    });

    it("propagates a memory from machine A to machine B via remote dir", async () => {
      dbA.insertMemory(makeSyncMemory("pushed-from-machine-a"));
      const push = await syncA.push();
      expect(push.errors).toEqual([]);
      expect(push.pushed).toBe(1);

      const pull = await syncB.pull();
      expect(pull.errors).toEqual([]);
      expect(pull.pulled).toBe(1);
      expect(dbB.getMemory("accept-sync-001")?.content).toContain("pushed-from-machine-a");
    });
  });
});

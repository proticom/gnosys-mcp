#!/usr/bin/env node
/**
 * Gnosys MCP Server — The core of Gnosys.
 * Exposes memory operations as MCP tools that any agent can call.
 * Supports layered stores: project (auto-discovered), personal, global, optional.
 */

// Load API keys from ~/.config/gnosys/.env before anything else
import dotenv from "dotenv";
import path from "path";
const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
dotenv.config({ path: path.join(home, ".config", "gnosys", ".env") });

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "fs/promises";
import { MemoryFrontmatter } from "./lib/store.js";
import { GnosysSearch } from "./lib/search.js";
import { GnosysTagRegistry } from "./lib/tags.js";
import { performImport, formatImportSummary, estimateDuration } from "./lib/import.js";
import { GnosysIngestion } from "./lib/ingest.js";
import { GnosysResolver } from "./lib/resolver.js";
import { applyLens, applyCompoundLens, LensFilter, CompoundLens } from "./lib/lensing.js";
import { getFileHistory, getFileAtCommit, rollbackToCommit, hasGitHistory, getFileDiff } from "./lib/history.js";
import { groupByPeriod, computeStats, TimePeriod } from "./lib/timeline.js";
import { buildLinkGraph, getBacklinks, getOutgoingLinks, formatGraphSummary } from "./lib/wikilinks.js";
import { bootstrap, discoverFiles } from "./lib/bootstrap.js";
import { loadConfig, GnosysConfig, DEFAULT_CONFIG } from "./lib/config.js";
import { GnosysEmbeddings } from "./lib/embeddings.js";
import { GnosysHybridSearch } from "./lib/hybridSearch.js";
import { GnosysAsk } from "./lib/ask.js";

// Initialize resolver (discovers all layered stores)
const resolver = new GnosysResolver();
let config: GnosysConfig = DEFAULT_CONFIG;

// Create MCP server
const server = new McpServer({
  name: "gnosys",
  version: "0.5.0",
});

// These are initialized in main() after resolver runs
let search: GnosysSearch | null = null;
let tagRegistry: GnosysTagRegistry | null = null;
let ingestion: GnosysIngestion | null = null;
let hybridSearch: GnosysHybridSearch | null = null;
let askEngine: GnosysAsk | null = null;

// ─── Tool: gnosys_discover ──────────────────────────────────────────────
server.tool(
  "gnosys_discover",
  "Discover relevant memories by describing what you're working on. Searches relevance keyword clouds across all stores. Returns lightweight metadata (title, path, relevance keywords) — NO file contents. Use gnosys_read to load specific memories you need. Call this FIRST when starting a task to find what Gnosys knows.",
  {
    query: z
      .string()
      .describe(
        "Describe what you're working on or looking for. Use keywords, not sentences. Example: 'auth JWT session tokens' or 'deployment CI/CD pipeline'"
      ),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ query, limit }) => {
    if (!search) {
      return {
        content: [{ type: "text", text: "Search index not initialized." }],
        isError: true,
      };
    }

    const results = search.discover(query, limit || 20);
    if (results.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No memories found for "${query}". Try different keywords or use gnosys_search for full-text search.`,
          },
        ],
      };
    }

    const formatted = results
      .map(
        (r) =>
          `**${r.title}**\n  Path: ${r.relative_path}${r.relevance ? `\n  Relevance: ${r.relevance}` : ""}`
      )
      .join("\n\n");

    return {
      content: [
        {
          type: "text",
          text: `Found ${results.length} relevant memories for "${query}":\n\n${formatted}\n\nUse gnosys_read to load any of these.`,
        },
      ],
    };
  }
);

// ─── Tool: gnosys_read ───────────────────────────────────────────────────
server.tool(
  "gnosys_read",
  "Read a specific memory file. Use layer-prefixed paths (e.g., 'project:decisions/why-not-rag.md'). Without a prefix, searches all stores in precedence order.",
  { path: z.string().describe("Path to memory, optionally prefixed with store layer") },
  async ({ path: memPath }) => {
    const memory = await resolver.readMemory(memPath);
    if (!memory) {
      return {
        content: [{ type: "text", text: `Memory not found: ${memPath}` }],
        isError: true,
      };
    }

    const raw = await fs.readFile(memory.filePath, "utf-8");
    return {
      content: [
        {
          type: "text",
          text: `[Source: ${memory.sourceLabel}]\n\n${raw}`,
        },
      ],
    };
  }
);

// ─── Tool: gnosys_search ─────────────────────────────────────────────────
server.tool(
  "gnosys_search",
  "Search memories by keyword across all stores. Returns matching file paths with relevance snippets.",
  {
    query: z.string().describe("Search query (keywords)"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ query, limit }) => {
    if (!search) {
      return {
        content: [{ type: "text", text: "Search index not initialized." }],
        isError: true,
      };
    }

    const results = search.search(query, limit || 20);
    if (results.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No results for "${query}". Try different keywords or use gnosys_discover.`,
          },
        ],
      };
    }

    const formatted = results
      .map(
        (r) =>
          `**${r.title}** (${r.relative_path})\n${r.snippet.replace(/>>>/g, "**").replace(/<<</g, "**")}`
      )
      .join("\n\n");

    return {
      content: [
        {
          type: "text",
          text: `Found ${results.length} results for "${query}":\n\n${formatted}`,
        },
      ],
    };
  }
);

// ─── Tool: gnosys_list ───────────────────────────────────────────────────
server.tool(
  "gnosys_list",
  "List memories across all stores, optionally filtered by category, tag, or store layer.",
  {
    category: z.string().optional().describe("Filter by category"),
    tag: z.string().optional().describe("Filter by tag"),
    store: z.string().optional().describe("Filter by store layer (project/personal/global/optional)"),
    status: z.string().optional().describe("Filter by status (active/archived/superseded)"),
  },
  async ({ category, tag, store: storeFilter, status }) => {
    let memories = await resolver.getAllMemories();

    if (storeFilter) {
      memories = memories.filter((m) => m.sourceLayer === storeFilter || m.sourceLabel === storeFilter);
    }
    if (category) {
      memories = memories.filter((m) => m.frontmatter.category === category);
    }
    if (tag) {
      memories = memories.filter((m) => {
        const tags = Array.isArray(m.frontmatter.tags)
          ? m.frontmatter.tags
          : Object.values(m.frontmatter.tags).flat();
        return tags.includes(tag);
      });
    }
    if (status) {
      memories = memories.filter((m) => m.frontmatter.status === status);
    }

    const lines = memories.map(
      (m) =>
        `- [${m.sourceLabel}] **${m.frontmatter.title}** (${m.relativePath}) [${m.frontmatter.status}]`
    );

    return {
      content: [
        {
          type: "text",
          text:
            lines.length > 0
              ? `${lines.length} memories:\n\n${lines.join("\n")}`
              : "No memories match the filter.",
        },
      ],
    };
  }
);

// ─── Tool: gnosys_add ────────────────────────────────────────────────────
server.tool(
  "gnosys_add",
  "Add a new memory. Accepts raw text — an LLM structures it into an atomic memory. Writes to the project store by default. Use store='personal' for cross-project knowledge, or store='global' to explicitly write to shared org knowledge.",
  {
    input: z
      .string()
      .describe(
        "Raw text input. Can be a decision, concept, fact, observation, or any knowledge."
      ),
    store: z
      .enum(["project", "personal", "global"])
      .optional()
      .describe("Which store to write to (default: project). Global requires explicit intent."),
    author: z
      .enum(["human", "ai", "human+ai"])
      .optional()
      .describe("Who is adding this memory"),
    authority: z
      .enum(["declared", "observed", "imported", "inferred"])
      .optional()
      .describe("Epistemic trust level"),
  },
  async ({ input, store: targetStore, author, authority }) => {
    const writeTarget = resolver.getWriteTarget(
      (targetStore as "project" | "personal" | "global") || undefined
    );
    if (!writeTarget) {
      return {
        content: [
          {
            type: "text",
            text: "No writable store found. Create a .gnosys/ directory in your project root or set GNOSYS_PERSONAL.",
          },
        ],
        isError: true,
      };
    }

    if (!ingestion) {
      return {
        content: [
          { type: "text", text: "Ingestion module not initialized." },
        ],
        isError: true,
      };
    }

    try {
      const result = await ingestion.ingest(input);
      const id = await writeTarget.store.generateId(result.category);

      const today = new Date().toISOString().split("T")[0];
      const frontmatter = {
        id,
        title: result.title,
        category: result.category,
        tags: result.tags,
        relevance: result.relevance,
        author: author || "ai",
        authority: authority || "observed",
        confidence: result.confidence,
        created: today,
        modified: today,
        last_reviewed: today,
        status: "active" as const,
        supersedes: null,
      };

      const filename = `${result.filename}.md`;
      const content = `# ${result.title}\n\n${result.content}`;
      const relativePath = await writeTarget.store.writeMemory(
        result.category,
        filename,
        frontmatter,
        content
      );

      // Rebuild search index across all stores
      if (search) {
        await reindexAllStores();
      }

      let response = `Memory added to [${writeTarget.label}]: **${result.title}**\nPath: ${writeTarget.label}:${relativePath}\nCategory: ${result.category}\nConfidence: ${result.confidence}`;

      if (result.proposedNewTags && result.proposedNewTags.length > 0) {
        const proposed = result.proposedNewTags
          .map((t) => `${t.category}:${t.tag}`)
          .join(", ");
        response += `\n\nProposed new tags (not yet in registry): ${proposed}\nUse gnosys_tags_add to approve them.`;
      }

      // Contradiction / overlap detection: search for closely related memories
      if (search && result.relevance) {
        const related = search.discover(result.relevance.split(" ").slice(0, 5).join(" "), 5);
        // Filter out the memory we just added
        const overlaps = related.filter(
          (r) => !r.relative_path.endsWith(filename)
        );
        if (overlaps.length > 0) {
          response += `\n\n⚠️ Potential overlaps detected — review these for contradictions:`;
          for (const o of overlaps.slice(0, 3)) {
            response += `\n  - ${o.title} (${o.relative_path})`;
          }
          response += `\nUse gnosys_read to compare, then gnosys_update with supersedes/superseded_by if needed.`;
        }
      }

      return { content: [{ type: "text", text: response }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Error adding memory: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ─── Tool: gnosys_add_structured ─────────────────────────────────────────
server.tool(
  "gnosys_add_structured",
  "Add a memory with structured input (no LLM needed). Writes to the project store by default. Use store='global' to explicitly write to shared org knowledge.",
  {
    title: z.string().describe("Memory title"),
    category: z.string().describe("Category directory name"),
    tags: z
      .record(z.string(), z.array(z.string()))
      .describe("Tags object, e.g. { domain: ['auth'], type: ['decision'] }"),
    relevance: z
      .string()
      .optional()
      .describe("Keyword cloud for discovery search. Space-separated terms describing contexts where this memory is useful."),
    content: z.string().describe("Memory content as markdown"),
    store: z.enum(["project", "personal", "global"]).optional().describe("Target store (default: project). Global requires explicit intent."),
    author: z.enum(["human", "ai", "human+ai"]).optional(),
    authority: z
      .enum(["declared", "observed", "imported", "inferred"])
      .optional(),
    confidence: z.number().min(0).max(1).optional(),
  },
  async ({ title, category, tags, relevance, content, store: targetStore, author, authority, confidence }) => {
    const writeTarget = resolver.getWriteTarget(
      (targetStore as "project" | "personal" | "global") || undefined
    );
    if (!writeTarget) {
      return {
        content: [{ type: "text", text: "No writable store found." }],
        isError: true,
      };
    }

    const id = await writeTarget.store.generateId(category);
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .substring(0, 60);

    const today = new Date().toISOString().split("T")[0];
    const frontmatter: MemoryFrontmatter = {
      id,
      title,
      category,
      tags: tags as Record<string, string[]>,
      relevance: relevance || "",
      author: author || "ai",
      authority: authority || "observed",
      confidence: confidence || 0.8,
      created: today,
      modified: today,
      last_reviewed: today,
      status: "active" as const,
      supersedes: null,
    };

    const fullContent = `# ${title}\n\n${content}`;
    const relativePath = await writeTarget.store.writeMemory(
      category,
      `${slug}.md`,
      frontmatter,
      fullContent
    );

    if (search) await reindexAllStores();

    return {
      content: [
        {
          type: "text",
          text: `Memory added to [${writeTarget.label}]: **${title}**\nPath: ${writeTarget.label}:${relativePath}`,
        },
      ],
    };
  }
);

// ─── Tool: gnosys_tags ───────────────────────────────────────────────────
server.tool(
  "gnosys_tags",
  "List all tags in the registry, grouped by category.",
  {},
  async () => {
    if (!tagRegistry) {
      return { content: [{ type: "text", text: "Tag registry not loaded." }], isError: true };
    }
    const registry = tagRegistry.getRegistry();
    const lines: string[] = ["# Gnosys Tag Registry\n"];

    for (const [category, tags] of Object.entries(registry)) {
      lines.push(`## ${category}`);
      lines.push(tags.sort().join(", "));
      lines.push("");
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ─── Tool: gnosys_tags_add ───────────────────────────────────────────────
server.tool(
  "gnosys_tags_add",
  "Add a new tag to the registry.",
  {
    category: z.string().describe("Tag category (domain, type, concern, status_tag)"),
    tag: z.string().describe("The new tag to add"),
  },
  async ({ category, tag }) => {
    if (!tagRegistry) {
      return { content: [{ type: "text", text: "Tag registry not loaded." }], isError: true };
    }
    const added = await tagRegistry.addTag(category, tag);
    if (added) {
      return {
        content: [{ type: "text", text: `Tag '${tag}' added to category '${category}'.` }],
      };
    }
    return {
      content: [{ type: "text", text: `Tag '${tag}' already exists in '${category}'.` }],
    };
  }
);

// ─── Tool: gnosys_reinforce ──────────────────────────────────────────────
server.tool(
  "gnosys_reinforce",
  "Signal whether a memory was useful. 'useful' reinforces it (resets decay). 'not_relevant' means routing was wrong, not the memory (memory unchanged). 'outdated' flags for review.",
  {
    memory_id: z.string().describe("The memory ID (from frontmatter)"),
    signal: z
      .enum(["useful", "not_relevant", "outdated"])
      .describe("The reinforcement signal"),
    context: z.string().optional().describe("Why this signal was given"),
  },
  async ({ memory_id, signal, context }) => {
    // Log to the first writable store's .config directory
    const writeTarget = resolver.getWriteTarget();
    if (writeTarget) {
      const logPath = path.join(
        writeTarget.store.getStorePath(),
        ".config",
        "reinforcement.log"
      );
      const entry = JSON.stringify({
        memory_id,
        signal,
        context,
        timestamp: new Date().toISOString(),
      });
      await fs.appendFile(logPath, entry + "\n", "utf-8");
    }

    // If 'useful', find the memory across all stores and update if writable
    if (signal === "useful") {
      const allMemories = await resolver.getAllMemories();
      const memory = allMemories.find((m) => m.frontmatter.id === memory_id);
      if (memory) {
        const sourceStore = resolver
          .getStores()
          .find((s) => s.label === memory.sourceLabel);
        if (sourceStore?.writable) {
          await sourceStore.store.updateMemory(memory.relativePath, {
            modified: new Date().toISOString().split("T")[0],
          } as any);
        }
      }
    }

    const messages: Record<string, string> = {
      useful: `Memory ${memory_id} reinforced. Decay clock reset.`,
      not_relevant: `Routing feedback logged for ${memory_id}. Memory unchanged — consider reviewing its relevance keywords or tags.`,
      outdated: `Memory ${memory_id} flagged for review as outdated.`,
    };

    return { content: [{ type: "text", text: messages[signal] }] };
  }
);

// ─── Tool: gnosys_init ───────────────────────────────────────────────────
server.tool(
  "gnosys_init",
  "Initialize a new .gnosys store in the given directory. Creates the directory structure, default tag registry, and git repo. You MUST pass the 'directory' parameter with the full absolute path to the project root.",
  {
    directory: z
      .string()
      .describe(
        "Absolute path to the project directory to create .gnosys/ in. Required."
      ),
  },
  async ({ directory }) => {
    const targetDir = path.resolve(directory);
    const storePath = path.join(targetDir, ".gnosys");

    // Check if already exists
    try {
      await fs.stat(storePath);
      return {
        content: [
          {
            type: "text",
            text: `A .gnosys store already exists at ${storePath}.`,
          },
        ],
        isError: true,
      };
    } catch {
      // Good — doesn't exist yet
    }

    // Create directory structure
    await fs.mkdir(storePath, { recursive: true });
    await fs.mkdir(path.join(storePath, ".config"), { recursive: true });

    // Seed default tag registry
    const defaultRegistry = {
      domain: [
        "architecture",
        "api",
        "auth",
        "database",
        "devops",
        "frontend",
        "backend",
        "testing",
        "security",
        "performance",
      ],
      type: [
        "decision",
        "concept",
        "convention",
        "requirement",
        "observation",
        "fact",
        "question",
      ],
      concern: ["dx", "scalability", "maintainability", "reliability"],
      status_tag: ["draft", "stable", "deprecated", "experimental"],
    };
    await fs.writeFile(
      path.join(storePath, ".config", "tags.json"),
      JSON.stringify(defaultRegistry, null, 2),
      "utf-8"
    );

    // Seed changelog
    const changelog = `# Gnosys Changelog\n\n## ${new Date().toISOString().split("T")[0]}\n\n- Store initialized\n`;
    await fs.writeFile(
      path.join(storePath, "CHANGELOG.md"),
      changelog,
      "utf-8"
    );

    // Init git
    try {
      const { execSync } = await import("child_process");
      execSync("git init", { cwd: storePath, stdio: "pipe" });
      execSync("git add -A", { cwd: storePath, stdio: "pipe" });
      execSync('git commit -m "Initialize Gnosys store"', {
        cwd: storePath,
        stdio: "pipe",
      });
    } catch {
      // Git not available — that's fine
    }

    // Register this project so the resolver finds it on future restarts
    // (MCP server cwd may not match the editor's project directory).
    await resolver.registerProject(targetDir);

    // Directly add the new store to the resolver (no re-resolve from cwd needed)
    await resolver.addProjectStore(storePath);

    // Initialize search, tags, and ingestion if this is the first store
    const writeTarget = resolver.getWriteTarget();
    if (writeTarget && !search) {
      search = new GnosysSearch(writeTarget.store.getStorePath());
      tagRegistry = new GnosysTagRegistry(writeTarget.store.getStorePath());
      await tagRegistry.load();
      ingestion = new GnosysIngestion(writeTarget.store, tagRegistry);
      await reindexAllStores();
    }

    return {
      content: [
        {
          type: "text",
          text: `Gnosys store initialized at ${storePath}\n\nCreated:\n- .config/ (internal config)\n- tags.json (tag registry)\n- CHANGELOG.md\n- git repo initialized\n\nThe store is ready. Use gnosys_discover to find existing memories or gnosys_add to create new ones.`,
        },
      ],
    };
  }
);

// ─── Tool: gnosys_update ─────────────────────────────────────────────────
server.tool(
  "gnosys_update",
  "Update an existing memory's frontmatter and/or content. Specify the memory path and the fields to change.",
  {
    path: z
      .string()
      .describe(
        "Path to memory, optionally prefixed with store layer (e.g., 'project:decisions/auth.md')"
      ),
    title: z.string().optional().describe("New title"),
    tags: z
      .record(z.string(), z.array(z.string()))
      .optional()
      .describe("New tags object"),
    status: z
      .enum(["active", "archived", "superseded"])
      .optional()
      .describe("New status"),
    confidence: z.number().min(0).max(1).optional().describe("New confidence"),
    supersedes: z
      .string()
      .optional()
      .describe("ID of memory this supersedes"),
    relevance: z
      .string()
      .optional()
      .describe("Updated relevance keyword cloud for discovery"),
    superseded_by: z
      .string()
      .optional()
      .describe("ID of memory that supersedes this one"),
    content: z
      .string()
      .optional()
      .describe("New markdown content (replaces existing body)"),
  },
  async ({
    path: memPath,
    title,
    tags,
    status,
    confidence,
    relevance,
    supersedes,
    superseded_by,
    content: newContent,
  }) => {
    const memory = await resolver.readMemory(memPath);
    if (!memory) {
      return {
        content: [{ type: "text", text: `Memory not found: ${memPath}` }],
        isError: true,
      };
    }

    // Find the source store and check if writable
    const sourceStore = resolver
      .getStores()
      .find((s) => s.label === memory.sourceLabel);
    if (!sourceStore?.writable) {
      return {
        content: [
          {
            type: "text",
            text: `Cannot update: store [${memory.sourceLabel}] is read-only.`,
          },
        ],
        isError: true,
      };
    }

    // Build updates object — only include defined fields
    const updates: Partial<MemoryFrontmatter> = {};
    if (title !== undefined) updates.title = title;
    if (tags !== undefined) updates.tags = tags as Record<string, string[]>;
    if (status !== undefined) updates.status = status;
    if (confidence !== undefined) updates.confidence = confidence;
    if (relevance !== undefined) updates.relevance = relevance;
    if (supersedes !== undefined) updates.supersedes = supersedes;
    if (superseded_by !== undefined) updates.superseded_by = superseded_by;

    const fullContent = newContent ? `# ${title || memory.frontmatter.title}\n\n${newContent}` : undefined;

    const updated = await sourceStore.store.updateMemory(
      memory.relativePath,
      updates,
      fullContent
    );

    if (!updated) {
      return {
        content: [{ type: "text", text: `Failed to update: ${memPath}` }],
        isError: true,
      };
    }

    // Supersession cross-linking: if A supersedes B, mark B as superseded_by A
    if (supersedes && updated.frontmatter.id) {
      const allMemories = await resolver.getAllMemories();
      const supersededMemory = allMemories.find(
        (m) => m.frontmatter.id === supersedes
      );
      if (supersededMemory) {
        const supersededStore = resolver
          .getStores()
          .find((s) => s.label === supersededMemory.sourceLabel);
        if (supersededStore?.writable) {
          await supersededStore.store.updateMemory(
            supersededMemory.relativePath,
            {
              superseded_by: updated.frontmatter.id,
              status: "superseded",
            } as Partial<MemoryFrontmatter>
          );
        }
      }
    }

    // Rebuild search index
    if (search) await reindexAllStores();

    const changedFields = Object.keys(updates);
    if (newContent) changedFields.push("content");

    return {
      content: [
        {
          type: "text",
          text: `Memory updated: **${updated.frontmatter.title}**\nPath: ${memory.sourceLabel}:${memory.relativePath}\nChanged: ${changedFields.join(", ")}`,
        },
      ],
    };
  }
);

// ─── Tool: gnosys_stale ─────────────────────────────────────────────────
server.tool(
  "gnosys_stale",
  "Find memories that haven't been modified or reviewed within a given number of days. Useful for identifying knowledge that may be outdated.",
  {
    days: z
      .number()
      .optional()
      .describe("Number of days since last modification to consider stale (default: 90)"),
    limit: z.number().optional().describe("Max results (default 20)"),
  },
  async ({ days, limit }) => {
    const threshold = days || 90;
    const maxResults = limit || 20;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - threshold);
    const cutoffStr = cutoff.toISOString().split("T")[0];

    const allMemories = await resolver.getAllMemories();
    const stale = allMemories
      .filter((m) => {
        const lastTouched = m.frontmatter.last_reviewed || m.frontmatter.modified;
        return lastTouched && lastTouched < cutoffStr;
      })
      .sort((a, b) => {
        const aDate = a.frontmatter.last_reviewed || a.frontmatter.modified;
        const bDate = b.frontmatter.last_reviewed || b.frontmatter.modified;
        return (aDate || "").localeCompare(bDate || "");
      })
      .slice(0, maxResults);

    if (stale.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No memories older than ${threshold} days found. Everything is fresh.`,
          },
        ],
      };
    }

    const lines = stale.map(
      (m) =>
        `- **${m.frontmatter.title}** (${m.sourceLabel}:${m.relativePath})\n  Last modified: ${m.frontmatter.modified}${m.frontmatter.last_reviewed ? `, Last reviewed: ${m.frontmatter.last_reviewed}` : ""}`
    );

    return {
      content: [
        {
          type: "text",
          text: `Found ${stale.length} memories not touched in ${threshold}+ days:\n\n${lines.join("\n\n")}\n\nUse gnosys_read to review, then gnosys_update or gnosys_reinforce as needed.`,
        },
      ],
    };
  }
);

// ─── Tool: gnosys_commit_context ────────────────────────────────────────
server.tool(
  "gnosys_commit_context",
  "Pre-compaction memory sweep. Call this before context is lost (e.g., before a long conversation compacts). Extracts important decisions, facts, and insights from the conversation and commits novel ones to memory. Checks existing memories to avoid duplicates — only adds what's genuinely new or augments what's changed.",
  {
    context: z
      .string()
      .describe(
        "Summary of the conversation or context to extract memories from. Include key decisions, facts, insights, and observations."
      ),
    dry_run: z
      .boolean()
      .optional()
      .describe(
        "If true, show what would be committed without actually writing. Default: false."
      ),
  },
  async ({ context, dry_run }) => {
    if (!ingestion || !ingestion.isLLMAvailable) {
      return {
        content: [
          {
            type: "text",
            text: "Commit context requires LLM (ANTHROPIC_API_KEY). Set the key and restart.",
          },
        ],
        isError: true,
      };
    }

    const writeTarget = resolver.getWriteTarget();
    if (!writeTarget) {
      return {
        content: [{ type: "text", text: "No writable store found." }],
        isError: true,
      };
    }

    // Step 1: Use LLM to extract candidate memories from the context
    const Anthropic = (await import("@anthropic-ai/sdk")).default;
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      return {
        content: [{ type: "text", text: "ANTHROPIC_API_KEY not set." }],
        isError: true,
      };
    }
    const client = new Anthropic({ apiKey });

    const extractResponse = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 4000,
      system: `You extract atomic knowledge items from conversations. Each item should be ONE decision, fact, insight, or observation — not compound.

Output a JSON array of objects, each with:
- summary: One-sentence description of the knowledge
- type: "decision" | "insight" | "fact" | "observation" | "requirement"
- search_terms: 3-5 keywords someone would search for to find if this already exists

Be selective. Only extract things worth remembering long-term. Skip small talk, debugging steps, and transient details. Focus on decisions made, architecture choices, requirements established, and insights gained.

Output ONLY the JSON array, no markdown fences.`,
      messages: [
        {
          role: "user",
          content: `Extract atomic knowledge items from this context:\n\n${context}`,
        },
      ],
    });

    const extractText =
      extractResponse.content[0].type === "text"
        ? extractResponse.content[0].text
        : "[]";

    let candidates: Array<{
      summary: string;
      type: string;
      search_terms: string[];
    }>;
    try {
      const jsonMatch =
        extractText.match(/```json\s*([\s\S]*?)```/) ||
        extractText.match(/```\s*([\s\S]*?)```/) || [null, extractText];
      candidates = JSON.parse(jsonMatch[1] || extractText);
    } catch {
      return {
        content: [
          {
            type: "text",
            text: `Failed to extract candidates from context. LLM output was not valid JSON.`,
          },
        ],
        isError: true,
      };
    }

    if (!Array.isArray(candidates) || candidates.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No extractable knowledge found in the provided context.",
          },
        ],
      };
    }

    // Step 2: For each candidate, check if it's novel by searching existing memories
    const results: string[] = [];
    let added = 0;
    let skipped = 0;

    for (const candidate of candidates) {
      const searchTerms = candidate.search_terms.join(" ");

      // Check existing memories via discover
      const existing = search
        ? search.discover(searchTerms, 3)
        : [];

      const hasOverlap = existing.length > 0;

      if (hasOverlap) {
        const topMatch = existing[0];
        results.push(
          `⏭ SKIP: "${candidate.summary}"\n  Overlaps with: ${topMatch.title} (${topMatch.relative_path})`
        );
        skipped++;
      } else {
        if (dry_run) {
          results.push(`➕ WOULD ADD: "${candidate.summary}" [${candidate.type}]`);
          added++;
        } else {
          // Actually add via ingestion
          try {
            const result = await ingestion.ingest(candidate.summary);
            const id = await writeTarget.store.generateId(result.category);
            const today = new Date().toISOString().split("T")[0];

            const frontmatter = {
              id,
              title: result.title,
              category: result.category,
              tags: result.tags,
              relevance: result.relevance,
              author: "ai" as const,
              authority: "observed" as const,
              confidence: result.confidence,
              created: today,
              modified: today,
              last_reviewed: today,
              status: "active" as const,
              supersedes: null,
            };

            const filename = `${result.filename}.md`;
            const content = `# ${result.title}\n\n${result.content}`;
            const relPath = await writeTarget.store.writeMemory(
              result.category,
              filename,
              frontmatter,
              content
            );

            results.push(
              `➕ ADDED: "${result.title}"\n  Path: ${writeTarget.label}:${relPath}`
            );
            added++;
          } catch (err) {
            results.push(
              `❌ FAILED: "${candidate.summary}": ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }
      }
    }

    // Rebuild search index after all writes
    if (!dry_run && search && added > 0) {
      await reindexAllStores();
    }

    const header = dry_run
      ? `DRY RUN — ${candidates.length} candidates extracted, ${added} would be added, ${skipped} duplicates skipped:`
      : `Context committed — ${candidates.length} candidates extracted, ${added} added, ${skipped} duplicates skipped:`;

    return {
      content: [
        {
          type: "text",
          text: `${header}\n\n${results.join("\n\n")}`,
        },
      ],
    };
  }
);

// ─── Tool: gnosys_history ────────────────────────────────────────────────
server.tool(
  "gnosys_history",
  "View version history for a memory. Shows what changed and when. Every memory write/update creates a git commit, so the full evolution is available.",
  {
    path: z.string().describe("Path to memory, optionally layer-prefixed"),
    limit: z.number().optional().describe("Max history entries (default 20)"),
  },
  async ({ path: memPath, limit }) => {
    const memory = await resolver.readMemory(memPath);
    if (!memory) {
      return { content: [{ type: "text", text: `Memory not found: ${memPath}` }], isError: true };
    }

    const sourceStore = resolver.getStores().find((s) => s.label === memory.sourceLabel);
    if (!sourceStore || !hasGitHistory(sourceStore.path)) {
      return { content: [{ type: "text", text: "No git history available for this store." }], isError: true };
    }

    const history = getFileHistory(sourceStore.path, memory.relativePath, limit || 20);
    if (history.length === 0) {
      return { content: [{ type: "text", text: "No history found for this memory." }] };
    }

    const lines = history.map(
      (e) => `- \`${e.commitHash.substring(0, 7)}\` ${e.date} — ${e.message}`
    );

    return {
      content: [{
        type: "text",
        text: `History for **${memory.frontmatter.title}** (${history.length} entries):\n\n${lines.join("\n")}\n\nUse gnosys_rollback with a commit hash to revert to a prior version.`,
      }],
    };
  }
);

// ─── Tool: gnosys_rollback ──────────────────────────────────────────────
server.tool(
  "gnosys_rollback",
  "Rollback a memory to its state at a specific commit. Non-destructive: creates a new commit with the reverted content. Use gnosys_history first to find the target commit hash.",
  {
    path: z.string().describe("Path to memory, optionally layer-prefixed"),
    commitHash: z.string().describe("Git commit hash to revert to (full or abbreviated)"),
  },
  async ({ path: memPath, commitHash }) => {
    const memory = await resolver.readMemory(memPath);
    if (!memory) {
      return { content: [{ type: "text", text: `Memory not found: ${memPath}` }], isError: true };
    }

    const sourceStore = resolver.getStores().find((s) => s.label === memory.sourceLabel);
    if (!sourceStore?.writable) {
      return { content: [{ type: "text", text: "Cannot rollback: store is read-only." }], isError: true };
    }

    const success = rollbackToCommit(sourceStore.path, memory.relativePath, commitHash);
    if (!success) {
      return { content: [{ type: "text", text: `Rollback failed. Verify the commit hash with gnosys_history.` }], isError: true };
    }

    // Reindex after rollback
    if (search) await reindexAllStores();

    // Read the reverted memory
    const reverted = await resolver.readMemory(memPath);
    return {
      content: [{
        type: "text",
        text: `Rolled back **${memory.frontmatter.title}** to commit ${commitHash.substring(0, 7)}.\n\nCurrent state: ${reverted?.frontmatter.title} [${reverted?.frontmatter.status}] (confidence: ${reverted?.frontmatter.confidence})`,
      }],
    };
  }
);

// ─── Tool: gnosys_lens ──────────────────────────────────────────────────
server.tool(
  "gnosys_lens",
  "Filtered view of memories. Combine criteria to focus on specific subsets — e.g., 'active decisions about auth with confidence > 0.8'. Use AND (default) to require all criteria, or OR to match any.",
  {
    category: z.string().optional().describe("Filter by category"),
    tags: z.array(z.string()).optional().describe("Filter by tags"),
    tagMatchMode: z.enum(["any", "all"]).optional().describe("'any' = has any listed tag (default), 'all' = must have every listed tag"),
    status: z.array(z.enum(["active", "archived", "superseded"])).optional().describe("Filter by status"),
    author: z.array(z.enum(["human", "ai", "human+ai"])).optional().describe("Filter by author"),
    authority: z.array(z.enum(["declared", "observed", "imported", "inferred"])).optional().describe("Filter by authority"),
    minConfidence: z.number().min(0).max(1).optional().describe("Minimum confidence"),
    maxConfidence: z.number().min(0).max(1).optional().describe("Maximum confidence"),
    createdAfter: z.string().optional().describe("Created after ISO date"),
    createdBefore: z.string().optional().describe("Created before ISO date"),
    modifiedAfter: z.string().optional().describe("Modified after ISO date"),
    modifiedBefore: z.string().optional().describe("Modified before ISO date"),
    operator: z.enum(["AND", "OR"]).optional().describe("Compound operator when multiple filter groups are provided (default: AND)"),
  },
  async ({ category, tags, tagMatchMode, status, author, authority, minConfidence, maxConfidence, createdAfter, createdBefore, modifiedAfter, modifiedBefore }) => {
    const allMemories = await resolver.getAllMemories();

    const lens: LensFilter = {};
    if (category) lens.category = category;
    if (tags) { lens.tags = tags; lens.tagMatchMode = tagMatchMode || "any"; }
    if (status) lens.status = status;
    if (author) lens.author = author;
    if (authority) lens.authority = authority;
    if (minConfidence !== undefined) lens.minConfidence = minConfidence;
    if (maxConfidence !== undefined) lens.maxConfidence = maxConfidence;
    if (createdAfter) lens.createdAfter = createdAfter;
    if (createdBefore) lens.createdBefore = createdBefore;
    if (modifiedAfter) lens.modifiedAfter = modifiedAfter;
    if (modifiedBefore) lens.modifiedBefore = modifiedBefore;

    const result = applyLens(allMemories, lens);

    if (result.length === 0) {
      return { content: [{ type: "text", text: "No memories match the lens filter." }] };
    }

    const lines = result.map(
      (m) => `- **${m.frontmatter.title}** [${m.frontmatter.status}] (${m.frontmatter.confidence})\n  ${(m as any).sourceLabel ? (m as any).sourceLabel + ":" : ""}${m.relativePath}`
    );

    return {
      content: [{ type: "text", text: `${result.length} memories match:\n\n${lines.join("\n\n")}` }],
    };
  }
);

// ─── Tool: gnosys_timeline ───────────────────────────────────────────────
server.tool(
  "gnosys_timeline",
  "View memory creation and modification activity over time. Shows how knowledge evolves by grouping memories into time periods.",
  {
    period: z.enum(["day", "week", "month", "year"]).optional().describe("Grouping period (default: month)"),
  },
  async ({ period }) => {
    const allMemories = await resolver.getAllMemories();
    const entries = groupByPeriod(allMemories, (period as TimePeriod) || "month");

    if (entries.length === 0) {
      return { content: [{ type: "text", text: "No memories found for timeline." }] };
    }

    const lines = entries.map(
      (e) => `**${e.period}** — ${e.created} created, ${e.modified} modified\n  ${e.titles.slice(0, 5).join(", ")}${e.titles.length > 5 ? ` (+${e.titles.length - 5} more)` : ""}`
    );

    return {
      content: [{ type: "text", text: `Knowledge Timeline (by ${period || "month"}):\n\n${lines.join("\n\n")}` }],
    };
  }
);

// ─── Tool: gnosys_stats ─────────────────────────────────────────────────
server.tool(
  "gnosys_stats",
  "Summary statistics across all memories — totals by category, status, author, authority, average confidence, and date ranges.",
  {},
  async () => {
    const allMemories = await resolver.getAllMemories();
    const stats = computeStats(allMemories);

    if (stats.totalCount === 0) {
      return { content: [{ type: "text", text: "No memories found." }] };
    }

    const catLines = Object.entries(stats.byCategory).map(([k, v]) => `  ${k}: ${v}`).join("\n");
    const statusLines = Object.entries(stats.byStatus).map(([k, v]) => `  ${k}: ${v}`).join("\n");
    const authorLines = Object.entries(stats.byAuthor).map(([k, v]) => `  ${k}: ${v}`).join("\n");
    const authLines = Object.entries(stats.byAuthority).map(([k, v]) => `  ${k}: ${v}`).join("\n");

    const text = `Gnosys Memory Statistics
Total: ${stats.totalCount} memories

By Category:
${catLines}

By Status:
${statusLines}

By Author:
${authorLines}

By Authority:
${authLines}

Average Confidence: ${stats.averageConfidence.toFixed(2)}
Oldest: ${stats.oldestCreated || "—"}
Newest: ${stats.newestCreated || "—"}
Last Modified: ${stats.lastModified || "—"}`;

    return { content: [{ type: "text", text }] };
  }
);

// ─── Tool: gnosys_links ─────────────────────────────────────────────────
server.tool(
  "gnosys_links",
  "Show wikilinks for a specific memory — outgoing [[links]] and backlinks from other memories. Obsidian-compatible [[Title]] and [[path|display]] syntax.",
  {
    path: z.string().describe("Path to memory, optionally layer-prefixed"),
  },
  async ({ path: memPath }) => {
    const memory = await resolver.readMemory(memPath);
    if (!memory) {
      return { content: [{ type: "text", text: `Memory not found: ${memPath}` }], isError: true };
    }

    const allMemories = await resolver.getAllMemories();
    const outgoing = getOutgoingLinks(allMemories, memory.relativePath);
    const backlinks = getBacklinks(allMemories, memory.relativePath);

    const parts: string[] = [`Links for **${memory.frontmatter.title}**:\n`];

    if (outgoing.length > 0) {
      parts.push(`Outgoing (${outgoing.length}):`);
      for (const link of outgoing) {
        const display = link.displayText ? ` (${link.displayText})` : "";
        parts.push(`  → [[${link.target}]]${display}`);
      }
    } else {
      parts.push("No outgoing links.");
    }

    parts.push("");

    if (backlinks.length > 0) {
      parts.push(`Backlinks (${backlinks.length}):`);
      for (const link of backlinks) {
        parts.push(`  ← ${link.sourceTitle} (${link.sourcePath})`);
      }
    } else {
      parts.push("No backlinks.");
    }

    return { content: [{ type: "text", text: parts.join("\n") }] };
  }
);

// ─── Tool: gnosys_graph ─────────────────────────────────────────────────
server.tool(
  "gnosys_graph",
  "Show the full cross-reference graph across all memories. Reveals clusters, orphaned links, and the most-connected memories.",
  {},
  async () => {
    const allMemories = await resolver.getAllMemories();

    if (allMemories.length === 0) {
      return { content: [{ type: "text", text: "No memories found." }] };
    }

    const graph = buildLinkGraph(allMemories);
    return { content: [{ type: "text", text: formatGraphSummary(graph) }] };
  }
);

// ─── Tool: gnosys_bootstrap ─────────────────────────────────────────────
server.tool(
  "gnosys_bootstrap",
  "Batch-import existing documents from a directory into the memory store. Scans for markdown files and creates memories. Use dry_run=true to preview.",
  {
    sourceDir: z.string().describe("Absolute path to directory containing documents to import"),
    patterns: z.array(z.string()).optional().describe("File glob patterns (default: ['**/*.md'])"),
    skipExisting: z.boolean().optional().describe("Skip files whose titles already exist (default: false)"),
    defaultCategory: z.string().optional().describe("Default category for imported files (default: imported)"),
    preserveFrontmatter: z.boolean().optional().describe("Preserve existing YAML frontmatter if present (default: false)"),
    dryRun: z.boolean().optional().describe("Preview what would be imported without writing (default: false)"),
    store: z.enum(["project", "personal", "global"]).optional().describe("Target store"),
  },
  async ({ sourceDir, patterns, skipExisting, defaultCategory, preserveFrontmatter, dryRun, store: targetStore }) => {
    const writeTarget = resolver.getWriteTarget(
      (targetStore as "project" | "personal" | "global") || undefined
    );
    if (!writeTarget) {
      return { content: [{ type: "text", text: "No writable store found." }], isError: true };
    }

    try {
      const result = await bootstrap(writeTarget.store, {
        sourceDir,
        patterns,
        skipExisting,
        defaultCategory,
        preserveFrontmatter,
        dryRun,
      });

      const mode = dryRun ? "DRY RUN" : "COMPLETE";
      const parts: string[] = [
        `Bootstrap ${mode}: ${result.totalScanned} scanned, ${result.imported.length} ${dryRun ? "would be" : ""} imported, ${result.skipped.length} skipped, ${result.failed.length} failed`,
      ];

      if (result.imported.length > 0) {
        parts.push(`\n${dryRun ? "Would import" : "Imported"}:`);
        for (const f of result.imported.slice(0, 20)) {
          parts.push(`  + ${f}`);
        }
        if (result.imported.length > 20) {
          parts.push(`  ... and ${result.imported.length - 20} more`);
        }
      }

      if (result.failed.length > 0) {
        parts.push("\nFailed:");
        for (const f of result.failed.slice(0, 10)) {
          parts.push(`  ✗ ${f.path}: ${f.error}`);
        }
      }

      // Reindex after import
      if (!dryRun && result.imported.length > 0 && search) {
        await reindexAllStores();
      }

      return { content: [{ type: "text", text: parts.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Bootstrap failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ─── Tool: gnosys_import ─────────────────────────────────────────────────
server.tool(
  "gnosys_import",
  "Bulk import structured data (CSV, JSON, JSONL) into Gnosys memories. Map source fields to title/category/content/tags/relevance. Use mode='llm' for smart ingestion with keyword clouds, or 'structured' for fast direct mapping. For large datasets (>100 records with LLM), the CLI is recommended: npx gnosys-mcp import <file>",
  {
    format: z.enum(["csv", "json", "jsonl"]).describe("Data format"),
    data: z.string().describe("File path, URL, or inline data"),
    mapping: z
      .record(z.string(), z.string())
      .describe(
        "Map source fields to Gnosys fields. Keys are source field names, values are: title, category, content, tags, relevance. Example: {\"name\":\"title\", \"group\":\"category\", \"description\":\"content\"}"
      ),
    mode: z
      .enum(["llm", "structured"])
      .optional()
      .describe("Processing mode. 'llm' uses AI for keyword clouds and smart tagging (slower). 'structured' maps directly (fast). Default: structured"),
    dryRun: z.boolean().optional().describe("Preview without writing"),
    skipExisting: z.boolean().optional().describe("Skip records whose titles already exist"),
    limit: z.number().optional().describe("Max records to import"),
    offset: z.number().optional().describe("Skip first N records"),
    concurrency: z.number().optional().describe("Parallel LLM calls (default: 5)"),
    store: z
      .enum(["project", "personal", "global"])
      .optional()
      .describe("Target store (default: project)"),
  },
  async ({
    format,
    data,
    mapping,
    mode,
    dryRun,
    skipExisting,
    limit,
    offset,
    concurrency,
    store: targetStore,
  }) => {
    const writeTarget = resolver.getWriteTarget(
      (targetStore as "project" | "personal" | "global") || undefined
    );
    if (!writeTarget) {
      return {
        content: [{ type: "text", text: "No writable store found." }],
        isError: true,
      };
    }

    if (!ingestion) {
      return {
        content: [{ type: "text", text: "Ingestion module not initialized." }],
        isError: true,
      };
    }

    const effectiveMode = (mode as "llm" | "structured") || "structured";

    try {
      const result = await performImport(writeTarget.store, ingestion, {
        format: format as "csv" | "json" | "jsonl",
        data,
        mapping: mapping as Record<string, string>,
        mode: effectiveMode,
        dryRun,
        skipExisting,
        limit,
        offset,
        concurrency,
        batchCommit: true,
      });

      // Reindex after import
      if (!dryRun && result.imported.length > 0 && search) {
        await reindexAllStores();
      }

      let response = formatImportSummary(result);

      // Smart threshold guidance
      if (
        effectiveMode === "llm" &&
        result.totalProcessed > 100
      ) {
        const estimate = estimateDuration(
          result.totalProcessed,
          "llm",
          concurrency || 5
        );
        response += `\n\n💡 Tip: For large LLM imports, the CLI offers progress tracking and resume:\n  npx gnosys-mcp import ${data.length < 100 ? data : "<file>"} --format ${format} --mode llm --skip-existing`;
      }

      return { content: [{ type: "text", text: response }] };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: `Import failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// ─── Tool: gnosys_hybrid_search ──────────────────────────────────────────
server.tool(
  "gnosys_hybrid_search",
  "Search memories using hybrid keyword + semantic search with Reciprocal Rank Fusion. Combines FTS5 keyword matching with embedding-based semantic similarity for best results. Run gnosys_reindex first if embeddings don't exist yet.",
  {
    query: z.string().describe("Natural language search query"),
    limit: z.number().optional().describe("Max results (default 15)"),
    mode: z.enum(["keyword", "semantic", "hybrid"]).optional().describe("Search mode (default: hybrid)"),
  },
  async ({ query, limit, mode }) => {
    if (!hybridSearch) {
      return {
        content: [{ type: "text", text: "Hybrid search not initialized. No stores found." }],
        isError: true,
      };
    }

    try {
      const results = await hybridSearch.hybridSearch(
        query,
        limit || 15,
        (mode as "keyword" | "semantic" | "hybrid") || "hybrid"
      );

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No results for "${query}". Try gnosys_reindex to build embeddings, or different keywords.` }],
        };
      }

      const formatted = results
        .map(
          (r) =>
            `**${r.title}** (score: ${r.score.toFixed(4)}, via: ${r.sources.join("+")})\n  Path: ${r.relativePath}\n  ${r.snippet.substring(0, 150)}...`
        )
        .join("\n\n");

      const embCount = hybridSearch.embeddingCount();
      return {
        content: [
          {
            type: "text",
            text: `Found ${results.length} results for "${query}" (${embCount} embeddings indexed):\n\n${formatted}`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Search failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ─── Tool: gnosys_semantic_search ────────────────────────────────────────
server.tool(
  "gnosys_semantic_search",
  "Search memories using semantic similarity only (no keyword matching). Finds conceptually related memories even without exact keyword matches. Requires embeddings — run gnosys_reindex first.",
  {
    query: z.string().describe("Natural language search query"),
    limit: z.number().optional().describe("Max results (default 15)"),
  },
  async ({ query, limit }) => {
    if (!hybridSearch) {
      return {
        content: [{ type: "text", text: "Search not initialized. No stores found." }],
        isError: true,
      };
    }

    try {
      const results = await hybridSearch.hybridSearch(query, limit || 15, "semantic");

      if (results.length === 0) {
        return {
          content: [{ type: "text", text: `No semantic results for "${query}". Run gnosys_reindex first to build embeddings.` }],
        };
      }

      const formatted = results
        .map(
          (r) =>
            `**${r.title}** (similarity: ${r.score.toFixed(4)})\n  Path: ${r.relativePath}\n  ${r.snippet.substring(0, 150)}...`
        )
        .join("\n\n");

      return {
        content: [{ type: "text", text: `Found ${results.length} semantic results for "${query}":\n\n${formatted}` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Semantic search failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ─── Tool: gnosys_reindex ────────────────────────────────────────────────
server.tool(
  "gnosys_reindex",
  "Rebuild all semantic embeddings from every memory file. Downloads the embedding model (~80 MB) on first run. Required before hybrid/semantic search can be used. Safe to re-run — fully regenerates the index.",
  {},
  async () => {
    if (!hybridSearch) {
      return {
        content: [{ type: "text", text: "No stores found. Initialize a store with gnosys_init first." }],
        isError: true,
      };
    }

    try {
      // Also rebuild FTS5 index
      await reindexAllStores();

      const count = await hybridSearch.reindex();
      return {
        content: [
          {
            type: "text",
            text: `Reindex complete: ${count} memories embedded. Hybrid search is now available.`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Reindex failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ─── Tool: gnosys_ask ────────────────────────────────────────────────────
server.tool(
  "gnosys_ask",
  "Ask a natural-language question and get a synthesized answer with citations from the entire vault. Uses hybrid search to find relevant memories, then LLM to synthesize a cited response. Citations are Obsidian wikilinks [[filename.md]]. Requires ANTHROPIC_API_KEY and embeddings (run gnosys_reindex first).",
  {
    question: z.string().describe("Natural language question to answer from the vault"),
    limit: z.number().optional().describe("Max memories to retrieve (default 15)"),
    mode: z.enum(["keyword", "semantic", "hybrid"]).optional().describe("Search mode (default: hybrid)"),
  },
  async ({ question, limit, mode }) => {
    if (!askEngine) {
      return {
        content: [{ type: "text", text: "Ask engine not initialized. Ensure stores exist and ANTHROPIC_API_KEY is set." }],
        isError: true,
      };
    }

    try {
      const result = await askEngine.ask(question, {
        limit: limit || 15,
        mode: (mode as "keyword" | "semantic" | "hybrid") || "hybrid",
      });

      const sourcesText = result.sources.length > 0
        ? "\n\n---\n**Sources:**\n" +
          result.sources
            .map((s) => `- [[${s.relativePath.split("/").pop()}]] — ${s.title}`)
            .join("\n")
        : "";

      const meta = [
        `Search mode: ${result.searchMode}`,
        result.deepQueryUsed ? "Deep query: yes (follow-up search performed)" : null,
        `Sources: ${result.sources.length}`,
      ]
        .filter(Boolean)
        .join(" | ");

      return {
        content: [
          {
            type: "text",
            text: `${result.answer}${sourcesText}\n\n_${meta}_`,
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Ask failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ─── Tool: gnosys_stores ─────────────────────────────────────────────────
server.tool(
  "gnosys_stores",
  "Show all active Gnosys stores — their layers, paths, and write permissions.",
  {},
  async () => {
    const summary = resolver.getSummary();
    return { content: [{ type: "text", text: summary }] };
  }
);

// ─── Helper: reindex search across all stores ────────────────────────────
async function reindexAllStores(): Promise<void> {
  if (!search) return;
  search.clearIndex();
  const allStores = resolver.getStores();
  for (const s of allStores) {
    await search.addStoreMemories(s.store, s.label);
  }
}

// ─── Start the server ────────────────────────────────────────────────────
async function main() {
  // Discover and initialize all layered stores
  const stores = await resolver.resolve();

  if (stores.length === 0) {
    console.error(
      "Warning: No Gnosys stores found. Create a .gnosys/ directory or set GNOSYS_PERSONAL / GNOSYS_GLOBAL."
    );
  }

  console.error("Gnosys MCP server starting.");
  console.error("Active stores:");
  console.error(resolver.getSummary());

  // Initialize search from the first writable store
  const writeTarget = resolver.getWriteTarget();
  if (writeTarget) {
    search = new GnosysSearch(writeTarget.store.getStorePath());
    tagRegistry = new GnosysTagRegistry(writeTarget.store.getStorePath());
    await tagRegistry.load();
    // Load config from the primary store
    try {
      config = await loadConfig(writeTarget.store.getStorePath());
    } catch (err) {
      console.error(`Warning: Failed to load gnosys.json: ${err instanceof Error ? err.message : err}`);
    }
    ingestion = new GnosysIngestion(writeTarget.store, tagRegistry, config);

    // Build search index across all stores
    await reindexAllStores();

    // Initialize hybrid search + ask engine (embeddings loaded lazily)
    const embeddings = new GnosysEmbeddings(writeTarget.store.getStorePath());
    hybridSearch = new GnosysHybridSearch(search, embeddings, resolver, writeTarget.store.getStorePath());
    askEngine = new GnosysAsk(hybridSearch, config);

    const embCount = embeddings.hasEmbeddings() ? embeddings.count() : 0;
    console.error(
      `LLM ingestion: ${ingestion.isLLMAvailable ? "enabled" : "disabled (set ANTHROPIC_API_KEY)"}`
    );
    console.error(
      `Hybrid search: ${embCount > 0 ? `ready (${embCount} embeddings)` : "available (run gnosys_reindex to build embeddings)"}`
    );
    console.error(
      `Ask engine: ${askEngine.isLLMAvailable ? "ready" : "disabled (set ANTHROPIC_API_KEY)"}`
    );
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

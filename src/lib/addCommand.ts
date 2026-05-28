import path from "path";
import { existsSync } from "fs";
import type { GnosysResolver } from "./resolver.js";
import { GnosysTagRegistry } from "./tags.js";
import { GnosysDB } from "./db.js";

type GetResolver = () => Promise<GnosysResolver>;
type ResolveProjectId = (dir?: string) => Promise<string | null>;

export async function runAddCommand(
  getResolver: GetResolver,
  input: string,
  opts: { author: string; authority: string; store?: string },
  resolveProjectId: ResolveProjectId,
): Promise<void> {
        const resolver = await getResolver();
        const writeTarget = resolver.getWriteTarget(
          (opts.store as any) || undefined
        );
        if (!writeTarget) {
          console.error(
            "No writable store found. Create a .gnosys/ directory or set GNOSYS_PERSONAL."
          );
          process.exit(1);
        }
  
        // Check if input is a file path — if so, route through multimodal ingestion
        if (existsSync(input)) {
          const { ingestFile } = await import("./multimodalIngest.js");
          const storePath = writeTarget.store.getStorePath();
          console.log(`Detected file: ${input}`);
          console.log("Ingesting via multimodal pipeline...");
  
          const result = await ingestFile({
            filePath: path.resolve(input),
            storePath,
            mode: "llm",
            author: opts.author as "human" | "ai" | "human+ai",
            authority: opts.authority as "declared" | "observed" | "imported" | "inferred",
            onProgress: (p) => {
              console.log(`  [${p.current}/${p.total}] ${p.title || "Processing..."}`);
            },
          });
  
          console.log(`\nFile type: ${result.fileType}`);
          console.log(`Memories created: ${result.memories.length}`);
          console.log(`Duration: ${(result.duration / 1000).toFixed(1)}s`);
  
          for (const mem of result.memories) {
            console.log(`  ${mem.id}: ${mem.title}`);
          }
  
          if (result.errors.length > 0) {
            console.error(`\nErrors (${result.errors.length}):`);
            for (const err of result.errors) {
              console.error(`  Chunk ${err.chunk}: ${err.error}`);
            }
          }
  
          return;
        }
  
        const tagRegistry = new GnosysTagRegistry(
          writeTarget.store.getStorePath()
        );
        await tagRegistry.load();
        const { GnosysIngestion } = await import("./ingest.js");
        const ingestion = new GnosysIngestion(writeTarget.store, tagRegistry);
  
        if (!ingestion.isLLMAvailable) {
          console.error(
            "Error: No LLM provider available. Add an API key to ~/.config/gnosys/.env or use a local model: gnosys config set provider ollama"
          );
          process.exit(1);
        }
  
        console.log("Structuring memory via LLM...");
        const result = await ingestion.ingest(input);
  
        let centralDb: GnosysDB | null = null;
        try {
          centralDb = GnosysDB.openCentral();
          const projectId = await resolveProjectId();
          const id = centralDb.getNextId(result.category, projectId || undefined);
          const today = new Date().toISOString().split("T")[0];
          const now = new Date().toISOString();
          const content = `# ${result.title}\n\n${result.content}`;
  
          const tags = result.tags;
          const tagsJson = Array.isArray(tags)
            ? JSON.stringify(tags)
            : JSON.stringify(Object.values(tags).flat());
  
          centralDb.insertMemory({
            id,
            title: result.title,
            category: result.category,
            content,
            summary: null,
            tags: tagsJson,
            relevance: result.relevance,
            author: opts.author,
            authority: opts.authority,
            confidence: result.confidence,
            reinforcement_count: 0,
            content_hash: "",
            status: "active",
            tier: "active",
            supersedes: null,
            superseded_by: null,
            last_reinforced: null,
            created: now,
            modified: now,
            embedding: null,
            source_path: null,
            project_id: projectId,
            scope: "project",
          });
  
          console.log(`\nMemory added to [${writeTarget.label}]: ${result.title}`);
          console.log(`ID: ${id}`);
          console.log(`Category: ${result.category}`);
          console.log(`Confidence: ${result.confidence}`);
        } finally {
          centralDb?.close();
        }
  
        if (result.proposedNewTags && result.proposedNewTags.length > 0) {
          console.log("\nProposed new tags (not yet in registry):");
          for (const t of result.proposedNewTags) {
            console.log(`  ${t.category}:${t.tag}`);
          }
        }
      }
}

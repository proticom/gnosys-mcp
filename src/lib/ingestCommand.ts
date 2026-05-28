import path from "path";
import fs from "fs/promises";
import type { GnosysResolver } from "./resolver.js";

export type IngestCommandOptions = {
  mode: string;
  store?: string;
  author: string;
  authority: string;
  dryRun?: boolean;
  listAttachments?: boolean;
  directory?: string;
};

type GetResolver = () => Promise<GnosysResolver>;

export async function runIngestCommand(
  getResolver: GetResolver,
  fileOrGlob: string,
  opts: IngestCommandOptions,
): Promise<void> {
      // List attachments mode
      if (opts.listAttachments) {
        const { listAttachments } = await import("./attachments.js");
        const resolver = await getResolver();
        const writeTarget = resolver.getWriteTarget((opts.store as any) || undefined);
        if (!writeTarget) {
          console.error("No writable store found.");
          process.exit(1);
        }
        const attachments = await listAttachments(writeTarget.store.getStorePath());
        if (attachments.length === 0) {
          console.log("No attachments found.");
          return;
        }
        console.log(`Found ${attachments.length} attachment(s):\n`);
        for (const a of attachments) {
          const sizeMb = (a.sizeBytes / (1024 * 1024)).toFixed(2);
          console.log(`  ${a.originalName} (${sizeMb}MB, ${a.extension})`);
          console.log(`    UUID: ${a.uuid}`);
          console.log(`    Hash: ${a.contentHash.slice(0, 16)}...`);
          console.log(`    Memories: ${a.memoryIds.length > 0 ? a.memoryIds.join(", ") : "none"}`);
          console.log(`    Created: ${a.createdAt}\n`);
        }
        return;
      }
  
      // Resolve the file path
      const resolvedPath = path.resolve(opts.directory || process.cwd(), fileOrGlob);
  
      // Check the file exists
      try {
        await fs.access(resolvedPath);
      } catch {
        console.error(`File not found: ${resolvedPath}`);
        process.exit(1);
      }
  
      // Resolve the store
      const resolver = await getResolver();
      const writeTarget = resolver.getWriteTarget((opts.store as any) || undefined);
      if (!writeTarget) {
        console.error("No writable store found. Create a .gnosys/ directory or set GNOSYS_PERSONAL.");
        process.exit(1);
      }
  
      const storePath = writeTarget.store.getStorePath();
  
      // Run ingestion
      const { ingestFile } = await import("./multimodalIngest.js");
      console.log(`Ingesting: ${path.basename(resolvedPath)}`);
      if (opts.dryRun) {
        console.log("(dry run — no files will be written)\n");
      }
  
      try {
        const result = await ingestFile({
          filePath: resolvedPath,
          storePath,
          mode: opts.mode as "llm" | "structured",
          store: (opts.store as any) || undefined,
          author: opts.author as "human" | "ai" | "human+ai",
          authority: opts.authority as "declared" | "observed" | "imported" | "inferred",
          dryRun: opts.dryRun,
          projectRoot: opts.directory,
          onProgress: (p) => {
            process.stdout.write(`\r  Processing chunk ${p.current}/${p.total}...`);
          },
        });
  
        // Clear the progress line
        if (result.memories.length > 0) {
          process.stdout.write("\r" + " ".repeat(60) + "\r");
        }
  
        // Print results
        console.log(`\nFile type: ${result.fileType}`);
        console.log(`Attachment: ${result.attachment.originalName} (${result.attachment.uuid.slice(0, 8)}...)`);
        console.log(`Duration: ${(result.duration / 1000).toFixed(1)}s`);
        console.log(`Memories created: ${result.memories.length}`);
  
        if (result.memories.length > 0) {
          console.log("\nMemories:");
          for (const m of result.memories) {
            const extra = m.page ? ` [page ${m.page}]` : "";
            console.log(`  ${m.id}: ${m.title}${extra}`);
            console.log(`    Path: ${m.path}`);
          }
        }
  
        if (result.errors.length > 0) {
          console.log(`\nErrors (${result.errors.length}):`);
          for (const e of result.errors) {
            console.log(`  Chunk ${e.chunk}: ${e.error}`);
          }
        }
      } catch (err) {
        console.error(`\nIngestion failed: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
}

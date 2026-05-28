import type { GnosysResolver } from "./resolver.js";
import { GnosysTagRegistry } from "./tags.js";

export type ImportCommandOptions = {
  format?: string;
  mapping?: string;
  mode: string;
  limit?: number;
  offset?: number;
  skipExisting?: boolean;
  batchCommit: boolean;
  concurrency?: number;
  dryRun?: boolean;
  store: string;
};

type GetResolver = () => Promise<GnosysResolver>;

export async function runImportCommand(
  getResolver: GetResolver,
  fileOrUrl: string | undefined,
  opts: ImportCommandOptions,
): Promise<void> {
        if (!fileOrUrl) {
          console.error("Usage:");
          console.error("  gnosys import <file> --format csv|json|jsonl --mapping '{...}'   (bulk)");
          console.error("  gnosys import project <bundle.json.gz>                            (project bundle)");
          process.exit(1);
        }
        if (!opts.format || !opts.mapping) {
          console.error("Error: --format and --mapping are required for bulk imports.");
          console.error("       For project bundles, use 'gnosys import project <bundle>'.");
          process.exit(1);
        }
        // Parse mapping JSON
        let mapping: Record<string, string>;
        try {
          mapping = JSON.parse(opts.mapping);
        } catch {
          console.error(
            "Error: --mapping must be valid JSON. Example: '{\"name\":\"title\",\"group\":\"category\"}'"
          );
          process.exit(1);
        }
  
        const resolver = await getResolver();
        const writeTarget = resolver.getWriteTarget(
          opts.store as "project" | "personal" | "global"
        );
        if (!writeTarget) {
          console.error("No writable store found.");
          process.exit(1);
        }
  
        const tagRegistry = new GnosysTagRegistry(
          writeTarget.store.getStorePath()
        );
        await tagRegistry.load();
        const { GnosysIngestion } = await import("./ingest.js");
        const { performImport, formatImportSummary } = await import("./import.js");
        const ingestion = new GnosysIngestion(writeTarget.store, tagRegistry);
  
        const format = opts.format as "csv" | "json" | "jsonl";
        const mode = opts.mode as "llm" | "structured";
        const concurrency = opts.concurrency || 5;
  
        // Show estimate for LLM mode
        if (mode === "llm") {
          console.error(
            `Mode: LLM (concurrency: ${concurrency})`
          );
        } else {
          console.error("Mode: structured (no LLM calls)");
        }
  
        if (opts.dryRun) {
          console.error("DRY RUN — no files will be written\n");
        }
  
        // Progress tracking
        let lastLine = "";
        const onProgress = (p: {
          processed: number;
          total: number;
          current: string;
          stage: string;
        }) => {
          const pct = p.total > 0 ? Math.round((p.processed / p.total) * 100) : 0;
          const bar =
            "█".repeat(Math.floor(pct / 5)) +
            "░".repeat(20 - Math.floor(pct / 5));
          const line = `[${bar}] ${p.processed}/${p.total} | ${p.current.substring(0, 40)}`;
          if (line !== lastLine) {
            process.stderr.write(`\r${line}`);
            lastLine = line;
          }
        };
  
        try {
          const result = await performImport(writeTarget.store, ingestion, {
            format,
            data: fileOrUrl,
            mapping,
            mode,
            limit: opts.limit,
            offset: opts.offset,
            dryRun: opts.dryRun,
            skipExisting: opts.skipExisting,
            batchCommit: opts.batchCommit,
            concurrency,
            onProgress,
          });
  
          // Clear progress line
          process.stderr.write("\r" + " ".repeat(80) + "\r");
  
          // Reindex search after import
          if (!opts.dryRun && result.imported.length > 0) {
            const search = new (await import("./search.js")).GnosysSearch(writeTarget.store.getStorePath());
            for (const s of resolver.getStores()) {
              await search.addStoreMemories(s.store, s.label);
            }
          }
  
          console.log(
            (opts.dryRun ? "DRY RUN — " : "✓ ") +
              formatImportSummary(result)
          );
        } catch (err) {
          console.error(
            `\nImport failed: ${err instanceof Error ? err.message : String(err)}`
          );
          process.exit(1);
        }
}

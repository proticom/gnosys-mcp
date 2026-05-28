import path from "path";
import type { GetWebStorePath } from "./webInitCommand.js";

export type WebBuildCommandOptions = {
  source?: string;
  prune?: boolean;
  llm: boolean;
  concurrency: string;
  dryRun?: boolean;
  json?: boolean;
};

export async function runWebBuildCommand(
  getWebStorePath: GetWebStorePath,
  opts: WebBuildCommandOptions,
): Promise<void> {
  try {
    const { loadConfig } = await import("./config.js");
    const { ingestSite } = await import("./webIngest.js");
    const { buildIndex, writeIndex } = await import("./webIndex.js");

    const gnosysConfig = await loadConfig(await getWebStorePath());
    const webConfig = gnosysConfig.web;
    if (!webConfig) {
      throw new Error("No web configuration found in gnosys.json. Run 'gnosys web init' first.");
    }

    // Step 1: Ingest
    const ingestResult = await ingestSite({
      source: webConfig.source,
      sitemapUrl: opts.source || webConfig.sitemapUrl,
      contentDir: opts.source || webConfig.contentDir,
      urls: webConfig.urls,
      outputDir: webConfig.outputDir,
      exclude: webConfig.exclude,
      categories: webConfig.categories,
      llmEnrich: opts.llm ? webConfig.llmEnrich : false,
      prune: opts.prune || webConfig.prune,
      concurrency: parseInt(opts.concurrency) || webConfig.concurrency,
      crawlDelayMs: webConfig.crawlDelayMs,
      dryRun: opts.dryRun,
    }, gnosysConfig);

    // Step 2: Build index (skip if dry run)
    let indexStats = { documentCount: 0, tokenCount: 0 };
    if (!opts.dryRun) {
      const index = await buildIndex(webConfig.outputDir);
      const indexPath = path.join(webConfig.outputDir, "gnosys-index.json");
      await writeIndex(index, indexPath);
      indexStats = {
        documentCount: index.documentCount,
        tokenCount: Object.keys(index.invertedIndex).length,
      };
    }

    if (opts.json) {
      console.log(JSON.stringify({ ...ingestResult, index: indexStats }));
    } else {
      console.log(`Web build complete (${ingestResult.duration}ms):`);
      console.log(`  Added:     ${ingestResult.added.length}`);
      console.log(`  Updated:   ${ingestResult.updated.length}`);
      console.log(`  Unchanged: ${ingestResult.unchanged.length}`);
      console.log(`  Removed:   ${ingestResult.removed.length}`);
      console.log(`  Index:     ${indexStats.documentCount} docs, ${indexStats.tokenCount} tokens`);
      if (ingestResult.errors.length > 0) {
        console.log(`  Errors:    ${ingestResult.errors.length}`);
        for (const e of ingestResult.errors) {
          console.log(`    ${e.url}: ${e.error}`);
        }
      }
    }
  } catch (err) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    } else {
      console.error(`Web build failed: ${err instanceof Error ? err.message : err}`);
    }
    process.exit(1);
  }
}

import type { GetWebStorePath } from "./webInitCommand.js";

export type WebIngestCommandOptions = {
  source?: string;
  prune?: boolean;
  llm: boolean;
  concurrency: string;
  dryRun?: boolean;
  verbose?: boolean;
  json?: boolean;
};

export async function runWebIngestCommand(
  getWebStorePath: GetWebStorePath,
  opts: WebIngestCommandOptions,
): Promise<void> {
  try {
    const { loadConfig } = await import("./config.js");
    const { ingestSite } = await import("./webIngest.js");

    const gnosysConfig = await loadConfig(await getWebStorePath());
    const webConfig = gnosysConfig.web;
    if (!webConfig) {
      throw new Error("No web configuration found in gnosys.json. Run 'gnosys web init' first.");
    }

    const result = await ingestSite({
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
      verbose: opts.verbose,
    }, gnosysConfig);

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`Ingestion complete (${result.duration}ms):`);
      console.log(`  Added:     ${result.added.length}`);
      console.log(`  Updated:   ${result.updated.length}`);
      console.log(`  Unchanged: ${result.unchanged.length}`);
      console.log(`  Removed:   ${result.removed.length}`);
      if (result.errors.length > 0) {
        console.log(`  Errors:    ${result.errors.length}`);
        for (const e of result.errors) {
          console.log(`    ${e.url}: ${e.error}`);
        }
      }
    }
  } catch (err) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    } else {
      console.error(`Ingest failed: ${err instanceof Error ? err.message : err}`);
    }
    process.exit(1);
  }
}

import path from "path";
import type { GetWebStorePath } from "./webInitCommand.js";

export type WebAddCommandOptions = {
  category?: string;
  llm: boolean;
  reindex: boolean;
  json?: boolean;
};

export async function runWebAddCommand(
  getWebStorePath: GetWebStorePath,
  url: string,
  opts: WebAddCommandOptions,
): Promise<void> {
  try {
    const { loadConfig } = await import("./config.js");
    const { ingestUrl } = await import("./webIngest.js");
    const { buildIndex, writeIndex } = await import("./webIndex.js");

    const gnosysConfig = await loadConfig(await getWebStorePath());
    const webConfig = gnosysConfig.web;
    if (!webConfig) {
      throw new Error("No web configuration found in gnosys.json. Run 'gnosys web init' first.");
    }

    const categories = opts.category
      ? { ...webConfig.categories, "/*": opts.category }
      : webConfig.categories;

    const result = await ingestUrl(url, {
      source: "urls",
      outputDir: webConfig.outputDir,
      categories,
      llmEnrich: opts.llm ? webConfig.llmEnrich : false,
      concurrency: 1,
      crawlDelayMs: 0,
    }, gnosysConfig);

    // Rebuild index unless --no-reindex
    if (opts.reindex && result.added.length + result.updated.length > 0) {
      const index = await buildIndex(webConfig.outputDir);
      await writeIndex(index, path.join(webConfig.outputDir, "gnosys-index.json"));
    }

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      if (result.added.length > 0) {
        console.log(`Added: ${result.added[0]}`);
      } else if (result.updated.length > 0) {
        console.log(`Updated: ${result.updated[0]}`);
      } else if (result.unchanged.length > 0) {
        console.log(`Unchanged (content identical)`);
      }
      if (result.errors.length > 0) {
        console.error(`Error: ${result.errors[0].error}`);
      }
    }
  } catch (err) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    } else {
      console.error(`Web add failed: ${err instanceof Error ? err.message : err}`);
    }
    process.exit(1);
  }
}

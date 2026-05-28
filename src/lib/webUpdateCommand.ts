import { existsSync } from "fs";
import path from "path";
import type { GetWebStorePath } from "./webInitCommand.js";

export type WebUpdateCommandOptions = {
  llm: boolean;
  category?: string;
  json?: boolean;
};

export async function runWebUpdateCommand(
  getWebStorePath: GetWebStorePath,
  urlOrPath: string,
  opts: WebUpdateCommandOptions,
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

    const knowledgeDir = webConfig.outputDir || "./knowledge";
    const knowledgeRoot = path.resolve(knowledgeDir);
    const isUrl = urlOrPath.startsWith("http://") || urlOrPath.startsWith("https://");

    if (isUrl) {
      // Re-ingest the URL
      const categories = opts.category
        ? { "/*": opts.category }
        : webConfig.categories;

      const result = await ingestUrl(urlOrPath, {
        source: "urls",
        outputDir: knowledgeDir,
        categories,
        llmEnrich: opts.llm ? webConfig.llmEnrich : false,
        prune: false,
        concurrency: 1,
        crawlDelayMs: 0,
      }, gnosysConfig);

      // Rebuild index
      const index = await buildIndex(knowledgeRoot);
      await writeIndex(index, path.join(knowledgeRoot, "gnosys-index.json"));

      if (opts.json) {
        console.log(JSON.stringify({ ok: true, ...result, documentCount: index.documentCount }));
      } else {
        console.log(`Updated: ${urlOrPath}`);
        console.log(`  Added: ${result.added.length}, Updated: ${result.updated.length}`);
        console.log(`Index rebuilt: ${index.documentCount} documents`);
      }
    } else {
      // Refresh a local knowledge file — rebuild index
      const fullPath = path.resolve(knowledgeRoot, urlOrPath);
      const relativePath = path.relative(knowledgeRoot, fullPath);

      if (path.isAbsolute(urlOrPath) || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
        throw new Error(`Refusing to refresh file outside knowledge directory: ${urlOrPath}`);
      }

      if (!existsSync(fullPath)) {
        throw new Error(`File not found: ${fullPath}`);
      }

      const index = await buildIndex(knowledgeRoot);
      await writeIndex(index, path.join(knowledgeRoot, "gnosys-index.json"));

      if (opts.json) {
        console.log(JSON.stringify({ ok: true, refreshed: urlOrPath, documentCount: index.documentCount }));
      } else {
        console.log(`Refreshed: ${urlOrPath}`);
        console.log(`Index rebuilt: ${index.documentCount} documents`);
      }
    }
  } catch (err) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    } else {
      console.error(`Web update failed: ${err instanceof Error ? err.message : err}`);
    }
    process.exit(1);
  }
}

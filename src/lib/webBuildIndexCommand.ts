import path from "path";
import type { GetWebStorePath } from "./webInitCommand.js";

export type WebBuildIndexCommandOptions = {
  input?: string;
  output?: string;
  stopWords: boolean;
  json?: boolean;
};

export async function runWebBuildIndexCommand(
  getWebStorePath: GetWebStorePath,
  opts: WebBuildIndexCommandOptions,
): Promise<void> {
  try {
    const { loadConfig } = await import("./config.js");
    const { buildIndex, writeIndex } = await import("./webIndex.js");

    const gnosysConfig = await loadConfig(await getWebStorePath());
    const knowledgeDir = opts.input || gnosysConfig.web?.outputDir || "./knowledge";
    const outputPath = opts.output || path.join(knowledgeDir, "gnosys-index.json");

    const index = await buildIndex(knowledgeDir, {
      stopWords: opts.stopWords,
    });

    await writeIndex(index, outputPath);

    if (opts.json) {
      console.log(JSON.stringify({
        ok: true,
        documentCount: index.documentCount,
        tokenCount: Object.keys(index.invertedIndex).length,
        outputPath,
      }));
    } else {
      console.log(`Search index built:`);
      console.log(`  Documents: ${index.documentCount}`);
      console.log(`  Tokens:    ${Object.keys(index.invertedIndex).length}`);
      console.log(`  Output:    ${outputPath}`);
    }
  } catch (err) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    } else {
      console.error(`Build index failed: ${err instanceof Error ? err.message : err}`);
    }
    process.exit(1);
  }
}

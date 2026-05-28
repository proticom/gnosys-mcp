import { existsSync } from "fs";
import path from "path";
import type { GetWebStorePath } from "./webInitCommand.js";

export type WebRemoveCommandOptions = {
  json?: boolean;
};

export async function runWebRemoveCommand(
  getWebStorePath: GetWebStorePath,
  filepath: string,
  opts: WebRemoveCommandOptions,
): Promise<void> {
  try {
    const { loadConfig } = await import("./config.js");
    const { buildIndex, writeIndex } = await import("./webIndex.js");
    const fsp = await import("fs/promises");

    const gnosysConfig = await loadConfig(await getWebStorePath());
    const webConfig = gnosysConfig.web;
    const knowledgeDir = webConfig?.outputDir || "./knowledge";
    const knowledgeRoot = path.resolve(knowledgeDir);
    const fullPath = path.resolve(knowledgeRoot, filepath);
    const relativePath = path.relative(knowledgeRoot, fullPath);

    if (path.isAbsolute(filepath) || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      throw new Error(`Refusing to remove file outside knowledge directory: ${filepath}`);
    }

    if (!existsSync(fullPath)) {
      throw new Error(`File not found: ${fullPath}`);
    }

    await fsp.unlink(fullPath);

    // Rebuild index
    const index = await buildIndex(knowledgeRoot);
    await writeIndex(index, path.join(knowledgeRoot, "gnosys-index.json"));

    if (opts.json) {
      console.log(JSON.stringify({ ok: true, removed: filepath, documentCount: index.documentCount }));
    } else {
      console.log(`Removed: ${filepath}`);
      console.log(`Index rebuilt: ${index.documentCount} documents`);
    }
  } catch (err) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    } else {
      console.error(`Web remove failed: ${err instanceof Error ? err.message : err}`);
    }
    process.exit(1);
  }
}

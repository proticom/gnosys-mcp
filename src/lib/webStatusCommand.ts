import { existsSync, readFileSync } from "fs";
import path from "path";
import type { GetWebStorePath } from "./webInitCommand.js";

export type WebStatusCommandOptions = {
  json?: boolean;
};

export async function runWebStatusCommand(
  getWebStorePath: GetWebStorePath,
  opts: WebStatusCommandOptions,
): Promise<void> {
  try {
    const { loadConfig } = await import("./config.js");
    const { readdirSync, statSync } = await import("fs");

    const gnosysConfig = await loadConfig(await getWebStorePath());
    const webConfig = gnosysConfig.web;
    const knowledgeDir = webConfig?.outputDir || "./knowledge";
    const resolvedDir = path.resolve(knowledgeDir);

    if (!existsSync(resolvedDir)) {
      if (opts.json) {
        console.log(JSON.stringify({ ok: true, exists: false, message: "Knowledge directory not found" }));
      } else {
        console.log(`Knowledge directory not found: ${resolvedDir}`);
        console.log(`Run 'gnosys web init' to get started.`);
      }
      return;
    }

    const categoryCounts: Record<string, number> = {};
    let totalFiles = 0;

    function countFiles(dir: string): void {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          countFiles(fullPath);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          const category = path.relative(resolvedDir, dir) || "root";
          categoryCounts[category] = (categoryCounts[category] || 0) + 1;
          totalFiles++;
        }
      }
    }
    countFiles(resolvedDir);

    const indexPath = path.join(resolvedDir, "gnosys-index.json");
    let indexInfo: { exists: boolean; documentCount?: number; size?: number; generated?: string } = { exists: false };
    if (existsSync(indexPath)) {
      const stat = statSync(indexPath);
      try {
        const indexData = JSON.parse(readFileSync(indexPath, "utf-8"));
        indexInfo = {
          exists: true,
          documentCount: indexData.documentCount,
          size: stat.size,
          generated: indexData.generated,
        };
      } catch {
        indexInfo = { exists: true, size: stat.size };
      }
    }

    if (opts.json) {
      console.log(JSON.stringify({
        ok: true,
        knowledgeDir: resolvedDir,
        totalFiles,
        categoryCounts,
        index: indexInfo,
      }, null, 2));
    } else {
      console.log(`Web Knowledge Base Status:`);
      console.log(`  Directory: ${resolvedDir}`);
      console.log(`  Total files: ${totalFiles}`);
      if (Object.keys(categoryCounts).length > 0) {
        console.log(`  By category:`);
        for (const [cat, count] of Object.entries(categoryCounts).sort()) {
          console.log(`    ${cat}: ${count}`);
        }
      }
      if (indexInfo.exists) {
        console.log(`  Index: ${indexInfo.documentCount ?? "?"} docs, ${((indexInfo.size || 0) / 1024).toFixed(1)}KB`);
        if (indexInfo.generated) {
          console.log(`  Last built: ${indexInfo.generated}`);
        }
      } else {
        console.log(`  Index: not built (run 'gnosys web build-index')`);
      }
    }
  } catch (err) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    } else {
      console.error(`Web status failed: ${err instanceof Error ? err.message : err}`);
    }
    process.exit(1);
  }
}

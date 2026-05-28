import { loadConfig } from "./config.js";
import { GnosysDB } from "./db.js";
import { GnosysResolver } from "./resolver.js";
import { GnosysSearch } from "./search.js";

export type RecallCommandOptions = {
  limit?: string;
  aggressive?: boolean;
  traceId?: string;
  json?: boolean;
  host?: boolean;
  federated?: boolean;
  scope?: string;
  directory?: string;
};

export async function runRecallCommand(
  query: string,
  opts: RecallCommandOptions,
): Promise<void> {
      // Federated recall path — returns tier-boosted results from central DB
      if (opts.federated || opts.scope) {
        let centralDb: GnosysDB | null = null;
        try {
          centralDb = GnosysDB.openCentral();
          if (!centralDb.isAvailable()) { console.error("Central DB not available."); process.exit(1); }
  
          const { federatedSearch, detectCurrentProject } = await import("./federated.js");
          const projectId = await detectCurrentProject(centralDb, opts.directory || undefined);
          const scopeFilter = opts.scope ? opts.scope.split(",").map(s => s.trim()) as any : undefined;
          const limit = opts.limit ? parseInt(opts.limit, 10) : 10;
          const results = federatedSearch(centralDb, query, { limit, projectId, scopeFilter });
  
          // Format as recall-like output with scope info
          const recallResult = {
            query,
            projectId,
            mode: "federated",
            count: results.length,
            memories: results.map(r => ({
              id: r.id,
              title: r.title,
              category: r.category,
              scope: r.scope,
              score: r.score,
              boosts: r.boosts,
              snippet: r.snippet,
              projectName: r.projectName,
            })),
          };
  
          if (opts.json) {
            console.log(JSON.stringify(recallResult, null, 2));
          } else if (opts.host) {
            const lines = [`<gnosys-recall query="${query}" mode="federated" count="${results.length}">`];
            for (const r of results) {
              lines.push(`  <memory id="${r.id}" scope="${r.scope}" score="${r.score.toFixed(4)}">`);
              lines.push(`    ${r.title}: ${r.snippet?.substring(0, 200) || ""}`);
              lines.push(`  </memory>`);
            }
            lines.push(`</gnosys-recall>`);
            console.log(lines.join("\n"));
          } else {
            if (results.length === 0) { console.log(`No memories found for "${query}".`); }
            else {
              console.log(`Recall: ${results.length} memories for "${query}" (federated)\n`);
              for (const r of results) {
                const proj = r.projectName ? ` [${r.projectName}]` : "";
                console.log(`  ${r.title}${proj} (${r.scope}, ${r.score.toFixed(4)})`);
                if (r.snippet) console.log(`    ${r.snippet.substring(0, 100)}`);
              }
            }
          }
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : err}`);
          process.exit(1);
        } finally {
          centralDb?.close();
        }
        return;
      }
  
      // Legacy file-based recall
      const resolver = new GnosysResolver();
      await resolver.resolve();
      const stores = resolver.getStores();
      if (stores.length === 0) {
        console.error("No Gnosys stores found. Run 'gnosys init' first.");
        process.exit(1);
      }
  
      const { recall, formatRecall, formatRecallCLI } = await import("./recall.js");
      const { initAudit, closeAudit } = await import("./audit.js");
  
      const storePath = stores[0].path;
      initAudit(storePath);
  
      // Load config for recall settings
      const cfg = await loadConfig(storePath);
      const recallConfig = {
        ...cfg.recall,
        ...(opts.aggressive !== undefined ? { aggressive: opts.aggressive } : {}),
      };
  
      // Build search index
      const search = new GnosysSearch(storePath);
      await search.addStoreMemories(stores[0].store);
  
      const result = await recall(query, {
        limit: opts.limit ? parseInt(opts.limit, 10) : undefined,
        search,
        resolver,
        storePath,
        traceId: opts.traceId,
        recallConfig,
      });
  
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else if (opts.host) {
        console.log(formatRecall(result));
      } else {
        console.log(formatRecallCLI(result));
      }
  
      closeAudit();
}

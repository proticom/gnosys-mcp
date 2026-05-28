import { GnosysDB } from "./db.js";
import { GnosysSearch } from "./search.js";
import type { GnosysResolver } from "./resolver.js";

export type HybridSearchCommandOptions = {
  limit: string;
  mode: string;
  json?: boolean;
  federated?: boolean;
  scope?: string;
  directory?: string;
};

type GetResolver = () => Promise<GnosysResolver>;

function outputResult(json: boolean, data: unknown, humanFn: () => void): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    humanFn();
  }
}

export async function runHybridSearchCommand(
  getResolver: GetResolver,
  query: string,
  opts: HybridSearchCommandOptions,
): Promise<void> {
      // Federated path — uses central DB
      if (opts.federated || opts.scope) {
        let centralDb: GnosysDB | null = null;
        try {
          centralDb = GnosysDB.openCentral();
          if (!centralDb.isAvailable()) { console.error("Central DB not available."); process.exit(1); }
  
          const { federatedSearch, detectCurrentProject } = await import("./federated.js");
          const projectId = await detectCurrentProject(centralDb, opts.directory || undefined);
          const scopeFilter = opts.scope ? opts.scope.split(",").map(s => s.trim()) as any : undefined;
          const results = federatedSearch(centralDb, query, {
            limit: parseInt(opts.limit, 10),
            projectId,
            scopeFilter,
          });
  
          outputResult(!!opts.json, { query, projectId, mode: "federated", count: results.length, results }, () => {
            if (results.length === 0) { console.log(`No results for "${query}".`); return; }
            console.log(`Found ${results.length} results for "${query}" (mode: federated):\n`);
            for (const [i, r] of results.entries()) {
              const proj = r.projectName ? ` [${r.projectName}]` : "";
              console.log(`${i + 1}. ${r.title} (${r.category})${proj}`);
              console.log(`   scope: ${r.scope} | score: ${r.score.toFixed(4)} | boosts: ${r.boosts.join(", ")}`);
              if (r.snippet) console.log(`   ${r.snippet.substring(0, 120)}`);
            }
          });
        } catch (err) {
          console.error(`Error: ${err instanceof Error ? err.message : err}`);
          process.exit(1);
        } finally {
          centralDb?.close();
        }
        return;
      }
  
      // Legacy file-based hybrid search
      const resolver = await getResolver();
      const stores = resolver.getStores();
      if (stores.length === 0) {
        console.error("No stores found.");
        process.exit(1);
      }
  
      const storePath = stores[0].path;
      const search = new GnosysSearch(storePath);
      search.clearIndex();
      for (const s of stores) {
        await search.addStoreMemories(s.store, s.label);
      }
  
      const { GnosysEmbeddings } = await import("./embeddings.js");
      const { GnosysHybridSearch } = await import("./hybridSearch.js");
      const embeddings = new GnosysEmbeddings(storePath);
      const hybridSearch = new GnosysHybridSearch(search, embeddings, resolver, storePath);
  
      const mode = opts.mode as "keyword" | "semantic" | "hybrid";
      const results = await hybridSearch.hybridSearch(query, parseInt(opts.limit), mode);
  
      if (results.length === 0) {
        outputResult(!!opts.json, { query, mode, results: [] }, () => {
          console.log(`No results for "${query}". Try gnosys reindex to build embeddings.`);
        });
      } else {
        outputResult(!!opts.json, { query, mode, count: results.length, results }, () => {
          console.log(`Found ${results.length} results for "${query}" (mode: ${mode}):\n`);
          for (const r of results) {
            console.log(`  ${r.title}`);
            console.log(`    Path: ${r.relativePath}`);
            console.log(`    Score: ${r.score.toFixed(4)} (via: ${r.sources.join("+")})`);
            console.log(`    ${r.snippet.substring(0, 120)}...\n`);
          }
        });
  
        // Reinforce used memories (best-effort)
        const writeTarget = resolver.getWriteTarget();
        if (writeTarget) {
          const { GnosysMaintenanceEngine } = await import("./maintenance.js");
          await GnosysMaintenanceEngine.reinforceBatch(
            writeTarget.store,
            results.map((r) => r.relativePath)
          ).catch(() => {});
        }
      }
      search.close();
      embeddings.close();
}

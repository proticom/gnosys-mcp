import { GnosysDB } from "./db.js";

export type FsearchCommandOptions = {
  limit: string;
  directory?: string;
  global: boolean;
  scope?: string;
  json: boolean;
};

export async function runFsearchCommand(
  query: string,
  opts: FsearchCommandOptions,
): Promise<void> {
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
          includeGlobal: opts.global,
          scopeFilter,
        });
  
        if (opts.json) {
          console.log(JSON.stringify({ query, projectId, count: results.length, results }, null, 2));
        } else {
          if (results.length === 0) { console.log(`No results for "${query}".`); return; }
          const ctx = projectId ? `Context: project ${projectId}` : "No project detected";
          console.log(ctx);
          for (const [i, r] of results.entries()) {
            const proj = r.projectName ? ` [${r.projectName}]` : "";
            console.log(`\n${i + 1}. ${r.title} (${r.category})${proj}`);
            console.log(`   scope: ${r.scope} | score: ${r.score.toFixed(4)} | boosts: ${r.boosts.join(", ")}`);
            if (r.snippet) console.log(`   ${r.snippet.substring(0, 120)}`);
          }
        }
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      } finally {
        centralDb?.close();
      }
}

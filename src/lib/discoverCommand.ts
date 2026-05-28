import { GnosysDB } from "./db.js";
import { logError } from "./log.js";

export type DiscoverCommandOptions = {
  limit: string;
  json?: boolean;
  federated?: boolean;
  scope?: string;
  directory?: string;
  idFormat?: string;
};

function outputResult(json: boolean, data: unknown, humanFn: () => void): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    humanFn();
  }
}

export async function runDiscoverCommand(
  query: string,
  opts: DiscoverCommandOptions,
): Promise<void> {
      // Federated discover path
      if (opts.federated || opts.scope) {
        let centralDb: GnosysDB | null = null;
        try {
          centralDb = GnosysDB.openCentral();
          if (!centralDb.isAvailable()) { console.error("Central DB not available."); process.exit(1); }
  
          const { federatedDiscover, detectCurrentProject } = await import("./federated.js");
          const projectId = await detectCurrentProject(centralDb, opts.directory || undefined);
          const scopeFilter = opts.scope ? opts.scope.split(",").map(s => s.trim()) as any : undefined;
          const results = federatedDiscover(centralDb, query, {
            limit: parseInt(opts.limit, 10),
            projectId,
            scopeFilter,
          });
  
          outputResult(!!opts.json, { query, projectId, count: results.length, results }, () => {
            if (results.length === 0) { console.log(`No memories found for "${query}".`); return; }
            for (const [i, r] of results.entries()) {
              const proj = r.projectName ? ` [${r.projectName}]` : "";
              console.log(`${i + 1}. ${r.title} (${r.category})${proj}`);
              console.log(`   scope: ${r.scope} | score: ${r.score.toFixed(4)}`);
            }
          });
        } catch (err) {
          logError(err, { module: "cli", op: "discover" });
          process.exit(1);
        } finally {
          centralDb?.close();
        }
        return;
      }
  
      // DB-based discover path — uses central DB FTS5
      let centralDb: GnosysDB | null = null;
      try {
        centralDb = GnosysDB.openCentral();
        if (!centralDb.isAvailable()) {
          console.error("Central DB not available. Run 'gnosys init' first.");
          process.exit(1);
        }
  
        const results = centralDb.discoverFts(query, parseInt(opts.limit));
        if (results.length === 0) {
          outputResult(!!opts.json, { query, results: [] }, () => {
            console.log(`No memories found for "${query}". Try gnosys search for full-text.`);
          });
          return;
        }
  
        const { formatMemoryIdHyperlink: formatMemoryId, buildProjectNameLookup, parseIdFormat } = await import("./idFormat.js");
        const idFormat = parseIdFormat(opts.idFormat);
        const projectNames = buildProjectNameLookup(centralDb);
  
        outputResult(!!opts.json, { query, count: results.length, results }, () => {
          console.log(`Found ${results.length} relevant memories for "${query}":\n`);
          for (const r of results) {
            const projectName = r.project_id ? projectNames.get(r.project_id) || null : null;
            const displayId = formatMemoryId(r.id, projectName, idFormat);
            console.log(`  ${r.title}`);
            console.log(`    id: ${displayId}`);
            if (r.relevance) console.log(`    Relevance: ${r.relevance}`);
            console.log();
          }
        });
      } catch (err) {
        logError(err, { module: "cli", op: "discover" });
        process.exit(1);
      } finally {
        centralDb?.close();
      }
}

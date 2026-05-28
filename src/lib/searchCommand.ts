import { GnosysDB } from "./db.js";
import { logError } from "./log.js";

export type SearchCommandOptions = {
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

export async function runSearchCommand(
  query: string,
  opts: SearchCommandOptions,
): Promise<void> {
      // Federated search path — uses central DB with tier boosting
      if (opts.federated || opts.scope) {
        let centralDb: GnosysDB | null = null;
        try {
          centralDb = GnosysDB.openCentral();
          if (!centralDb.isAvailable()) { console.error("Central DB not available. Run 'gnosys migrate --to-central' first."); process.exit(1); }
  
          const { federatedSearch, detectCurrentProject } = await import("./federated.js");
          const projectId = await detectCurrentProject(centralDb, opts.directory || undefined);
          const scopeFilter = opts.scope ? opts.scope.split(",").map(s => s.trim()) as any : undefined;
          const results = federatedSearch(centralDb, query, {
            limit: parseInt(opts.limit, 10),
            projectId,
            scopeFilter,
          });
  
          outputResult(!!opts.json, { query, projectId, count: results.length, results }, () => {
            if (results.length === 0) { console.log(`No results for "${query}".`); return; }
            const ctx = projectId ? `Context: project ${projectId}` : "No project detected";
            console.log(ctx);
            for (const [i, r] of results.entries()) {
              const proj = r.projectName ? ` [${r.projectName}]` : "";
              console.log(`\n${i + 1}. ${r.title} (${r.category})${proj}`);
              console.log(`   scope: ${r.scope} | score: ${r.score.toFixed(4)} | boosts: ${r.boosts.join(", ")}`);
              if (r.snippet) console.log(`   ${r.snippet.substring(0, 120)}`);
            }
          });
        } catch (err) {
          logError(err, { module: "cli", op: "search" });
          process.exit(1);
        } finally {
          centralDb?.close();
        }
        return;
      }
  
      // DB-based search path — uses central DB FTS5
      let centralDb: GnosysDB | null = null;
      try {
        centralDb = GnosysDB.openCentral();
        if (!centralDb.isAvailable()) {
          console.error("Central DB not available. Run 'gnosys init' first.");
          process.exit(1);
        }
  
        const results = centralDb.searchFts(query, parseInt(opts.limit));
        if (results.length === 0) {
          outputResult(!!opts.json, { query, results: [] }, () => {
            console.log(`No results for "${query}".`);
          });
          return;
        }
  
        const { formatMemoryIdHyperlink: formatMemoryId, buildProjectNameLookup, parseIdFormat } = await import("./idFormat.js");
        const idFormat = parseIdFormat(opts.idFormat);
        const projectNames = buildProjectNameLookup(centralDb);
  
        outputResult(!!opts.json, { query, count: results.length, results }, () => {
          console.log(`Found ${results.length} results for "${query}":\n`);
          for (const r of results) {
            const projectName = r.project_id ? projectNames.get(r.project_id) || null : null;
            const displayId = formatMemoryId(r.id, projectName, idFormat);
            console.log(`  ${r.title}`);
            console.log(`    id: ${displayId}`);
            console.log(
              `    ${r.snippet.replace(/>>>/g, "").replace(/<<</g, "")}`
            );
            console.log();
          }
        });
      } catch (err) {
        logError(err, { module: "cli", op: "search" });
        process.exit(1);
      } finally {
        centralDb?.close();
      }
}

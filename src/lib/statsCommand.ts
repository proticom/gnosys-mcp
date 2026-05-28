import { GnosysDB } from "./db.js";
import { findProjectIdentity } from "./projectIdentity.js";
import { computeStats } from "./timeline.js";

export type StatsCommandOptions = {
  json?: boolean;
  byProject?: boolean;
  all?: boolean;
};

function outputResult(json: boolean, data: unknown, humanFn: () => void): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    humanFn();
  }
}

export async function runStatsCommand(opts: StatsCommandOptions): Promise<void> {
  let centralDb: GnosysDB | null = null;
  try {
    centralDb = GnosysDB.openCentral();
    if (!centralDb.isAvailable()) {
      console.error("Central DB not available. Run 'gnosys init' first.");
      process.exit(1);
    }

    // v5.7.0: --by-project shows a per-project breakdown across the entire
    // central DB (memories, archived, never reinforced, etc.) as a table.
    if (opts.byProject) {
      const projects = centralDb.getAllProjects();
      const all = centralDb.getAllMemories();
      const rows = projects.map((p) => {
        const ms = all.filter((m) => m.project_id === p.id);
        const active = ms.filter((m) => m.tier === "active" && m.status === "active").length;
        const archived = ms.filter((m) => m.tier === "archive").length;
        const reinforced = ms.reduce((sum, m) => sum + (m.reinforcement_count ?? 0), 0);
        const lastTouch = ms.reduce((m, x) => (x.modified > m ? x.modified : m), "0");
        return { name: p.name, id: p.id, active, archived, reinforced, lastTouch };
      });
      // User/global memories (no project_id)
      const userScope = all.filter((m) => !m.project_id && m.scope === "user");
      const globalScope = all.filter((m) => !m.project_id && m.scope === "global");
      if (userScope.length > 0) {
        rows.push({
          name: "(user)",
          id: "—",
          active: userScope.filter((m) => m.tier === "active" && m.status === "active").length,
          archived: userScope.filter((m) => m.tier === "archive").length,
          reinforced: userScope.reduce((sum, m) => sum + (m.reinforcement_count ?? 0), 0),
          lastTouch: userScope.reduce((m, x) => (x.modified > m ? x.modified : m), "0"),
        });
      }
      if (globalScope.length > 0) {
        rows.push({
          name: "(global)",
          id: "—",
          active: globalScope.filter((m) => m.tier === "active" && m.status === "active").length,
          archived: globalScope.filter((m) => m.tier === "archive").length,
          reinforced: globalScope.reduce((sum, m) => sum + (m.reinforcement_count ?? 0), 0),
          lastTouch: globalScope.reduce((m, x) => (x.modified > m ? x.modified : m), "0"),
        });
      }

      rows.sort((a, b) => b.active - a.active);

      if (opts.json) {
        console.log(JSON.stringify({ rows }, null, 2));
        return;
      }

      const nameW = Math.max(8, ...rows.map((r) => r.name.length));
      const idW = 12;
      console.log("");
      console.log(`  ${"PROJECT".padEnd(nameW)}  ${"ID".padEnd(idW)}  ${"ACTIVE".padStart(7)}  ${"ARCHIVED".padStart(8)}  ${"REINF".padStart(6)}  LAST MODIFIED`);
      console.log(`  ${"-".repeat(nameW + idW + 7 + 8 + 6 + 19 + 10)}`);
      for (const r of rows) {
        const last = r.lastTouch === "0" ? "—" : r.lastTouch.slice(0, 19);
        const idShort = r.id === "—" ? "—" : r.id.slice(0, idW);
        console.log(`  ${r.name.padEnd(nameW)}  ${idShort.padEnd(idW)}  ${String(r.active).padStart(7)}  ${String(r.archived).padStart(8)}  ${String(r.reinforced).padStart(6)}  ${last}`);
      }
      const totalActive = rows.reduce((s, r) => s + r.active, 0);
      console.log(`  ${"-".repeat(nameW + idW + 7 + 8 + 6 + 19 + 10)}`);
      console.log(`  ${"TOTAL".padEnd(nameW)}  ${" ".repeat(idW)}  ${String(totalActive).padStart(7)}`);
      console.log("");
      return;
    }

    // Default behavior: scoped stats (current project + user/global, OR --all)
    const projIdentity = await findProjectIdentity(process.cwd());
    const projectId = !opts.all && projIdentity?.identity.projectId || null;

    let dbMemories = centralDb.getActiveMemories();
    if (projectId) {
      dbMemories = dbMemories.filter(
        (m) => m.project_id === projectId || m.scope === "user" || m.scope === "global",
      );
    }

    if (dbMemories.length === 0) {
      outputResult(!!opts.json, { totalCount: 0 }, () => {
        console.log("No memories found.");
      });
      return;
    }

    // Convert DbMemory[] to Memory[] shape for computeStats
    const allMemories = dbMemories.map((m) => ({
      frontmatter: {
        id: m.id,
        title: m.title,
        category: m.category,
        tags: (() => { try { return JSON.parse(m.tags || "[]"); } catch { return []; } })(),
        relevance: m.relevance,
        author: m.author as "human" | "ai" | "human+ai",
        authority: m.authority as "declared" | "observed" | "imported" | "inferred",
        confidence: m.confidence,
        created: m.created,
        modified: m.modified,
        status: m.status as "active" | "archived" | "superseded",
      },
      content: m.content,
      filePath: "",
      relativePath: "",
    }));

    const stats = computeStats(allMemories);

    outputResult(!!opts.json, stats, () => {
      console.log(`Gnosys Store Statistics:\n`);
      console.log(`  Total memories: ${stats.totalCount}`);
      console.log(`  Average confidence: ${stats.averageConfidence}`);
      console.log(`  Date range: ${stats.oldestCreated} → ${stats.newestCreated}`);
      console.log(`  Last modified: ${stats.lastModified}`);

      console.log(`\n  By category:`);
      for (const [cat, count] of Object.entries(stats.byCategory).sort((a, b) => b[1] - a[1])) {
        console.log(`    ${cat}: ${count}`);
      }

      console.log(`\n  By status:`);
      for (const [st, count] of Object.entries(stats.byStatus)) {
        console.log(`    ${st}: ${count}`);
      }

      console.log(`\n  By author:`);
      for (const [author, count] of Object.entries(stats.byAuthor)) {
        console.log(`    ${author}: ${count}`);
      }
    });
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  } finally {
    centralDb?.close();
  }
}

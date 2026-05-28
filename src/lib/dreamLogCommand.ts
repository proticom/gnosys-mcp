import { GnosysDB } from "./db.js";

export type DreamLogOptions = {
  last: string;
  since?: string;
  failuresOnly?: boolean;
  json?: boolean;
};

export type DreamLogContext = {
  parentJson?: boolean;
};

export async function runDreamLogCommand(
  opts: DreamLogOptions,
  context: DreamLogContext = {},
): Promise<void> {
  let centralDb: GnosysDB | null = null;
  try {
    centralDb = GnosysDB.openCentral();
    if (!centralDb.isAvailable()) {
      console.error("Central DB not available.");
      process.exitCode = 1;
      return;
    }
    const limit = Math.max(1, parseInt(opts.last) || 20);
    const sinceIso = opts.since ? `${opts.since}T00:00:00Z` : undefined;
    const runs = centralDb.getRecentDreamRuns(limit, {
      failuresOnly: !!opts.failuresOnly,
      sinceIso,
    });
    const wantJson = !!opts.json || !!context.parentJson;
    // JSON path always emits a structured response — including empty runs.
    if (wantJson) {
      console.log(JSON.stringify({ count: runs.length, runs }, null, 2));
      return;
    }
    if (runs.length === 0) {
      console.log("No dream runs recorded.");
      return;
    }
    const DIM = "\x1b[2m";
    const RESET = "\x1b[0m";
    const RED = "\x1b[31m";
    const GREEN = "\x1b[32m";
    console.log(`${runs.length} dream run(s):\n`);
    for (const r of runs) {
      const d = r.details as Record<string, unknown>;
      const dur = r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : "—";
      const summaries = Number(d.summariesGenerated || 0);
      const decays = Number(d.decayUpdated || 0);
      const reviews = Number(d.reviewSuggestions || 0);
      const rels = Number(d.relationshipsDiscovered || 0);
      const errors = Number(d.errors || 0);
      const unreachable = Boolean(d.providerUnreachable);
      const status = unreachable
        ? `${RED}provider unreachable${RESET}`
        : errors > 0
          ? `${RED}${errors} error(s)${RESET}`
          : summaries + decays + rels > 0
            ? `${GREEN}did work${RESET}`
            : `${DIM}no LLM work${RESET}`;
      console.log(`  ${r.completed} ${DIM}(${dur})${RESET} ${status}`);
      console.log(`    decays=${decays} summaries=${summaries} reviews=${reviews} relations=${rels}`);
      if (d.provider) {
        console.log(`    ${DIM}provider=${d.provider}${d.model ? "/" + d.model : ""}${RESET}`);
      }
    }
  } finally {
    centralDb?.close();
  }
}

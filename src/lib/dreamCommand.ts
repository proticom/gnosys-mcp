import { GnosysResolver } from "./resolver.js";
import { GnosysDB } from "./db.js";
import { loadConfig } from "./config.js";

export type DreamCommandOptions = {
  maxRuntime?: string;
  critique?: boolean;
  summaries?: boolean;
  relationships?: boolean;
  json?: boolean;
  force?: boolean;
};

export async function runDreamCommand(opts: DreamCommandOptions): Promise<void> {
  const resolver = new GnosysResolver();
  await resolver.resolve();
  const stores = resolver.getStores();
  if (stores.length === 0) {
    console.error("No Gnosys stores found. Run 'gnosys init' first.");
    process.exit(1);
  }

  const { GnosysDB: DbClass } = await import("./db.js");
  const { GnosysDreamEngine, formatDreamReport } = await import("./dream.js");
  const { getMachineId } = await import("./remote.js");

  const storePath = stores[0].path;
  const cfg = await loadConfig(storePath);
  const db = new DbClass(storePath);

  if (!db.isAvailable() || !db.isMigrated()) {
    console.error("Dream Mode requires gnosys.db (v2.0). Run 'gnosys migrate' first.");
    process.exit(1);
  }

  // Designation gate — warn (and exit unless --force) if this isn't the
  // designated dream machine. Manual runs from non-designated machines are
  // useful for testing but shouldn't happen by accident on shared brains.
  const centralDb = GnosysDB.openCentral();
  if (centralDb.isAvailable()) {
    const designated = centralDb.getDreamMachineId();
    if (designated) {
      const localId = getMachineId(centralDb);
      if (designated !== localId && !opts.force) {
        console.error(
          `Dream is designated to machine ${designated}, but this is ${localId}.\n` +
          `Pass --force to run anyway, or run 'gnosys setup dream' to redesignate.`
        );
        centralDb.close();
        db.close();
        process.exit(1);
      }
    }
    centralDb.close();
  }

  const dreamConfig = {
    enabled: true,
    idleMinutes: 0,
    maxRuntimeMinutes: opts.maxRuntime ? parseInt(opts.maxRuntime, 10) : 30,
    selfCritique: opts.critique !== false,
    generateSummaries: opts.summaries !== false,
    discoverRelationships: opts.relationships !== false,
    minMemories: 1,
    provider: cfg.dream?.provider || ("ollama" as const),
    model: cfg.dream?.model,
  };

  console.error("Starting Dream Mode cycle...");
  const engine = new GnosysDreamEngine(db, cfg, dreamConfig);
  const report = await engine.dream((phase, detail) => {
    console.error(`  [${phase}] ${detail}`);
  });

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatDreamReport(report));
  }

  db.close();
}

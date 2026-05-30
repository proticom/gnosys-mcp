import { GnosysResolver } from "./resolver.js";
import { GnosysDB } from "./db.js";
import { loadConfig } from "./config.js";
import {
  acquireDreamLock,
  appendDreamRun,
  countChangedMemoriesSince,
  createSkipRunRecord,
  getSystemIdleMinutes,
  isInsideNightWindow,
  readDreamState,
  type DreamRunGateResult,
  type DreamTrigger,
} from "./dreamRunLog.js";

export type DreamCommandOptions = {
  maxRuntime?: string;
  critique?: boolean;
  summaries?: boolean;
  relationships?: boolean;
  json?: boolean;
  force?: boolean;
  scheduled?: boolean;
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

  const trigger: DreamTrigger = opts.scheduled ? "scheduled" : "manual";
  const gates: DreamRunGateResult[] = [];

  // Machine-level lock — only one dream may run per machine at a time.
  const lock = acquireDreamLock();
  if (!lock.acquired) {
    appendDreamRun(createSkipRunRecord({
      trigger,
      startedAt: new Date().toISOString(),
      provider: cfg.dream?.provider || "ollama",
      model: cfg.dream?.model,
      gates: [{ name: "lock", passed: false, reason: lock.reason }],
      reason: lock.reason,
    }));
    if (!opts.scheduled) console.error(lock.reason);
    db.close();
    if (!opts.scheduled) process.exit(1);
    return;
  }

  try {
    // Designation gate — warn (and exit unless --force) if this isn't the
    // designated dream machine. Manual runs from non-designated machines are
    // useful for testing but shouldn't happen by accident on shared brains.
    const centralDb = GnosysDB.openCentral();
    let localId: string | undefined;
    if (centralDb.isAvailable()) {
      const designated = centralDb.getDreamMachineId();
      localId = getMachineId(centralDb);
      if (designated) {
        if (designated !== localId && !opts.force) {
          const reason = `Dream is designated to machine ${designated}, but this is ${localId}.`;
          gates.push({ name: "designation", passed: false, reason, details: { designated, localId } });
          appendDreamRun(createSkipRunRecord({
            trigger,
            startedAt: new Date().toISOString(),
            provider: cfg.dream?.provider || "ollama",
            model: cfg.dream?.model,
            gates,
            reason,
            machineId: localId,
          }));
          if (!opts.scheduled) {
            console.error(`${reason}\nPass --force to run anyway, or run 'gnosys setup dream' to redesignate.`);
          }
          centralDb.close();
          db.close();
          if (!opts.scheduled) process.exit(1);
          return;
        }
        gates.push({ name: "designation", passed: true, details: { designated, localId } });
      } else if (opts.scheduled) {
        const reason = "No designated dream machine.";
        gates.push({ name: "designation", passed: false, reason });
        appendDreamRun(createSkipRunRecord({
          trigger,
          startedAt: new Date().toISOString(),
          provider: cfg.dream?.provider || "ollama",
          model: cfg.dream?.model,
          gates,
          reason,
          machineId: localId,
        }));
        centralDb.close();
        db.close();
        return;
      }
      centralDb.close();
    }

    // Scheduled runs apply the cheap night/idle/dreamworthiness gates before
    // touching the LLM. Manual runs skip these (explicit user intent).
    if (opts.scheduled) {
      const now = new Date();
      if (!isInsideNightWindow(now, cfg.dream.schedule)) {
        const reason = `Outside dream schedule (${cfg.dream.schedule.startHour}:00-${cfg.dream.schedule.endHour}:00).`;
        gates.push({ name: "night-window", passed: false, reason, details: { hour: now.getHours() } });
        appendDreamRun(createSkipRunRecord({ trigger, startedAt: now.toISOString(), provider: cfg.dream.provider, model: cfg.dream.model, gates, reason, machineId: localId }));
        db.close();
        return;
      }
      gates.push({ name: "night-window", passed: true, details: { hour: now.getHours() } });

      const idleMinutes = getSystemIdleMinutes();
      if (idleMinutes != null && idleMinutes < cfg.dream.systemIdleMinutes) {
        const reason = `Machine idle ${idleMinutes.toFixed(1)}min < required ${cfg.dream.systemIdleMinutes}min.`;
        gates.push({ name: "system-idle", passed: false, reason, details: { idleMinutes } });
        appendDreamRun(createSkipRunRecord({ trigger, startedAt: now.toISOString(), provider: cfg.dream.provider, model: cfg.dream.model, gates, reason, machineId: localId }));
        db.close();
        return;
      }
      gates.push({ name: "system-idle", passed: true, details: { idleMinutes } });

      const state = readDreamState();
      const memories = db.getActiveMemories();
      const changed = countChangedMemoriesSince(memories, state.lastMemoryMaxModified);
      const lastRunMs = state.lastSuccessfulRunAt ? Date.parse(state.lastSuccessfulRunAt) : 0;
      const hoursSince = lastRunMs ? (Date.now() - lastRunMs) / 3_600_000 : Infinity;
      const enoughMemories = changed >= cfg.dream.minNewMemoriesToDream;
      const enoughTime = hoursSince >= cfg.dream.minHoursBetweenRuns;
      if (!enoughMemories || !enoughTime) {
        const reason = `Not dreamworthy yet (${changed} changed memories, ${hoursSince === Infinity ? "never" : hoursSince.toFixed(1)}h since last run).`;
        gates.push({
          name: "dreamworthiness",
          passed: false,
          reason,
          details: { changed, minChanged: cfg.dream.minNewMemoriesToDream, hoursSince, minHours: cfg.dream.minHoursBetweenRuns },
        });
        appendDreamRun(createSkipRunRecord({ trigger, startedAt: now.toISOString(), provider: cfg.dream.provider, model: cfg.dream.model, gates, reason, machineId: localId }));
        db.close();
        return;
      }
      gates.push({ name: "dreamworthiness", passed: true, details: { changed, hoursSince } });
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
      schedule: cfg.dream?.schedule,
      systemIdleMinutes: cfg.dream?.systemIdleMinutes,
      minNewMemoriesToDream: cfg.dream?.minNewMemoriesToDream,
      minHoursBetweenRuns: cfg.dream?.minHoursBetweenRuns,
      maxLLMCallsPerRun: cfg.dream?.maxLLMCallsPerRun,
    };

    console.error("Starting Dream Mode cycle...");
    const engine = new GnosysDreamEngine(db, cfg, dreamConfig, { trigger, machineId: localId });
    const report = await engine.dream((phase, detail) => {
      console.error(`  [${phase}] ${detail}`);
    });
    appendDreamRun({
      ...report,
      id: report.id || `dream-${Date.now()}`,
      trigger,
      status: report.aborted ? "aborted" : report.errors.length > 0 ? "failed" : "completed",
      machine: report.machine || { hostname: "unknown", machineId: localId },
      provider: report.provider || dreamConfig.provider,
      phases: report.phases || [],
      llmCalls: report.llmCalls || [],
      totals: report.totals || {
        llmCallsMade: 0,
        llmCallsSkipped: 0,
        estimatedInputTokens: 0,
        estimatedOutputTokens: 0,
        estimatedCostUsd: 0,
      },
      effectiveness: report.effectiveness || {
        usefulOutputScore: 0,
        costPerUsefulOutput: null,
        decaysApplied: report.decayUpdated,
        summariesGenerated: report.summariesGenerated,
        summariesUpdated: report.summariesUpdated,
        reviewSuggestions: report.reviewSuggestions.length,
        relationshipsDiscovered: report.relationshipsDiscovered,
      },
      gates,
    });

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatDreamReport(report));
    }

    db.close();
  } finally {
    lock.release();
  }
}

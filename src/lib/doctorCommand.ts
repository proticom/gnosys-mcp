import path from "path";
import fs from "fs/promises";
import type { GnosysResolver } from "./resolver.js";
import { GnosysDB } from "./db.js";
import {
  loadConfig,
  DEFAULT_CONFIG,
  resolveTaskModel,
  ALL_PROVIDERS,
  getProviderModel,
} from "./config.js";
import { getLLMProvider, isProviderAvailable } from "./llm.js";

type GetResolver = () => Promise<GnosysResolver>;

/**
 * Check whether a legacy per-store gnosys.db is safe to remove.
 * Safe = the file is empty OR every memory in it is already represented
 * in the central DB (matching ID present centrally). This is conservative:
 * we don't compare hashes or content, just IDs. The legacy DB existed
 * pre-v2.0; its memories should have all migrated to central DB long ago.
 */
async function isLegacyStoreSafeToRemove(localDbPath: string): Promise<{ ok: boolean; reason?: string }> {
  try {
    const Database = (await import("better-sqlite3")).default;
    const localDb = new Database(localDbPath, { readonly: true });
    localDb.pragma("busy_timeout = 5000");
    let localIds: string[] = [];
    try {
      const rows = localDb.prepare("SELECT id FROM memories").all() as Array<{ id: string }>;
      localIds = rows.map((r) => r.id);
    } catch {
      // Table doesn't exist — file is effectively empty
      localDb.close();
      return { ok: true };
    }
    localDb.close();

    if (localIds.length === 0) return { ok: true };

    const centralDb = GnosysDB.openCentral();
    if (!centralDb.isAvailable()) {
      centralDb.close();
      return { ok: false, reason: "central DB unavailable — cannot verify migration" };
    }
    let missing = 0;
    for (const id of localIds) {
      if (!centralDb.getMemory(id)) missing++;
    }
    centralDb.close();
    if (missing > 0) {
      return { ok: false, reason: `${missing} of ${localIds.length} local memories not found in central DB` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `inspection failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function runDoctorCommand(
  getResolver: GetResolver,
  opts: { fix?: boolean },
): Promise<void> {
        const resolver = await getResolver();
        const stores = resolver.getStores();
    
        console.log("Gnosys Doctor");
        console.log("=============\n");
    
        // Check local gnosys.db (legacy — should NOT exist in DB-only architecture)
        if (stores.length > 0) {
          const localDbPath = path.join(stores[0].path, "gnosys.db");
          const localDbExists = await fs.stat(localDbPath).then(() => true).catch(() => false);
          if (localDbExists) {
            console.log("Local Store (gnosys.db):");
            console.log("  ⚠ Local gnosys.db found — this is a legacy artifact (pre-v2.0 file-based store).");
            console.log("  All memories live in the central DB now (~/.gnosys/gnosys.db).");
            console.log(`  Path: ${localDbPath}`);
    
            if (opts.fix) {
              // Interactive cleanup — verify the local DB is safe to delete
              // (no rows that aren't already in the central DB) before prompting.
              const safe = await isLegacyStoreSafeToRemove(localDbPath);
              if (!safe.ok) {
                console.log(`  ✗ NOT safe to auto-remove: ${safe.reason}`);
                console.log(`  Inspect manually with: sqlite3 ${localDbPath} "SELECT COUNT(*) FROM memories;"`);
              } else {
                const readline = await import("readline/promises");
                const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
                const answer = await rl.question(`  Remove "${localDbPath}"? [y/N] `);
                rl.close();
                if (answer.trim().toLowerCase() === "y") {
                  await fs.unlink(localDbPath).catch(() => undefined);
                  await fs.unlink(localDbPath + "-wal").catch(() => undefined);
                  await fs.unlink(localDbPath + "-shm").catch(() => undefined);
                  console.log("  ✓ Removed.");
                } else {
                  console.log("  Skipped.");
                }
              }
            } else {
              console.log("  Run 'gnosys doctor --fix' to remove safely (after verifying it's empty).");
            }
            console.log("");
          }
        }
    
        // Check central DB
        console.log("Central DB (~/.gnosys/gnosys.db):");
        try {
          const db = GnosysDB.openCentral();
          if (db.isAvailable() && db.isMigrated()) {
            const counts = db.getMemoryCount();
            console.log(`  Status: ✓ migrated (schema v${db.getSchemaVersion()})`);
            console.log(`  Active: ${counts.active} | Archived: ${counts.archived} | Total: ${counts.total}`);
          } else if (db.isAvailable()) {
            console.log("  Status: ✗ not migrated (run gnosys upgrade)");
          } else {
            console.log("  Status: — not available (better-sqlite3 not installed)");
          }
          db.close();
        } catch {
          console.log("  Status: — not initialized");
        }
        console.log("");
    
        // Check stores
        console.log("Stores:");
        if (stores.length === 0) {
          console.log("  No stores found. Run gnosys init first.");
        } else {
          for (const s of stores) {
            const memories = await s.store.getAllMemories();
            console.log(`  ${s.label}: ${memories.length} memories (${s.path})`);
          }
        }
        console.log("");
    
        // Check archive
        if (stores.length > 0) {
          console.log("Archive (Two-Tier Memory):");
          try {
            const { GnosysArchive } = await import("./archive.js");
            const archive = new GnosysArchive(stores[0].path);
            if (archive.isAvailable()) {
              const stats = archive.getStats();
              console.log(`  Archived memories: ${stats.totalArchived}`);
              if (stats.totalArchived > 0) {
                console.log(`  Archive DB size: ${stats.dbSizeMB.toFixed(2)} MB`);
                console.log(`  Oldest archived: ${stats.oldestArchived}`);
                console.log(`  Newest archived: ${stats.newestArchived}`);
              }
              archive.close();
            } else {
              console.log("  Not available (better-sqlite3 not installed)");
            }
          } catch {
            console.log("  Not initialized");
          }
          console.log("");
        }
    
        // Check config — SOC routing + recall
        const cfg = stores.length > 0 ? await loadConfig(stores[0].path) : DEFAULT_CONFIG;
    
        console.log("Recall (Automatic Memory Injection):");
        const recallMode = cfg.recall?.aggressive !== false ? "aggressive" : "filtered";
        console.log(`  Mode: ${recallMode}`);
        console.log(`  Max memories per turn: ${cfg.recall?.maxMemories ?? 8}`);
        console.log(`  Min relevance: ${cfg.recall?.minRelevance ?? 0.4}`);
        console.log("");
    
        console.log("System of Cognition (SOC):");
        console.log(`  Default provider: ${cfg.llm.defaultProvider}`);
    
        const structuring = resolveTaskModel(cfg, "structuring");
        const synthesis = resolveTaskModel(cfg, "synthesis");
        console.log(`  Structuring → ${structuring.provider}/${structuring.model}`);
        console.log(`  Synthesis   → ${synthesis.provider}/${synthesis.model}`);
        console.log("");
    
        // Check all LLM providers
        console.log("LLM Connectivity:");
    
        for (const providerName of ALL_PROVIDERS) {
          const status = isProviderAvailable(cfg, providerName);
          if (!status.available) {
            console.log(`  ${providerName}: — ${status.error}`);
            continue;
          }
          try {
            const provider = getLLMProvider({ ...cfg, llm: { ...cfg.llm, defaultProvider: providerName } });
            await provider.testConnection();
            const model = getProviderModel(cfg, providerName);
            console.log(`  ${providerName}: ✓ connected (${model})`);
          } catch (err) {
            console.log(`  ${providerName}: ✗ ${err instanceof Error ? err.message : String(err)}`);
          }
        }
    
        console.log("");
    
        // Check embeddings
        if (stores.length > 0) {
          console.log("Embeddings:");
          const { GnosysEmbeddings } = await import("./embeddings.js");
          const embeddings = new GnosysEmbeddings(stores[0].path);
          try {
            const stats = embeddings.getStats();
            if (stats.count > 0) {
              console.log(`  Index: ${stats.count} embeddings (${stats.dbSizeMB.toFixed(1)} MB)`);
            } else {
              console.log("  Index: empty (run gnosys reindex to build)");
            }
          } catch {
            console.log("  Index: not initialized (run gnosys reindex to build)");
          }
    
          // Maintenance health — v5.7.0: queries the central DB directly
          // (the prior version used GnosysMaintenanceEngine which only sees the
          // legacy file-based stores, which are empty post-DB-only).
          console.log("");
          console.log("Maintenance Health:");
          try {
            const db2 = GnosysDB.openCentral();
            if (db2.isAvailable() && db2.isMigrated()) {
              const memories = db2.getActiveMemories();
              const now = Date.now();
              const DECAY_LAMBDA = 0.005;
              const STALE_THRESHOLD = 0.3;
              let sumConfidence = 0;
              let sumDecayed = 0;
              let staleCount = 0;
              let neverReinforced = 0;
              let totalReinforcements = 0;
              for (const m of memories) {
                const baseConfidence = m.confidence ?? 0.8;
                const lastIso = m.last_reinforced || m.modified || m.created;
                const lastTs = lastIso ? new Date(lastIso).getTime() : NaN;
                // Some legacy memories have non-ISO dates that don't parse; treat
                // them as "today" rather than NaN-corrupting the average.
                const daysSince = Number.isFinite(lastTs)
                  ? Math.max(0, Math.floor((now - lastTs) / (1000 * 60 * 60 * 24)))
                  : 0;
                const decayed = baseConfidence * Math.exp(-DECAY_LAMBDA * daysSince);
                sumConfidence += baseConfidence;
                sumDecayed += decayed;
                if (decayed < STALE_THRESHOLD) staleCount++;
                const rc = m.reinforcement_count ?? 0;
                if (rc === 0) neverReinforced++;
                totalReinforcements += rc;
              }
              const n = Math.max(1, memories.length);
              console.log(`  Active memories: ${memories.length}`);
              console.log(`  Stale (decayed confidence < ${STALE_THRESHOLD}): ${staleCount}`);
              console.log(`  Average confidence: ${(sumConfidence / n).toFixed(3)} (decayed: ${(sumDecayed / n).toFixed(3)})`);
              console.log(`  Never reinforced: ${neverReinforced}`);
              console.log(`  Total reinforcements: ${totalReinforcements}`);
            } else {
              console.log("  — central DB not available");
            }
            db2.close();
          } catch (err) {
            console.log(`  Error: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
}

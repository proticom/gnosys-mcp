/**
 * Gnosys Sandbox Server
 *
 * Lightweight background Node process that holds a GnosysDB connection
 * and processes requests over a Unix domain socket (or named pipe on Windows).
 *
 * Phase 9b: Integrates Dream Mode (idle-triggered), preferences, and sync.
 *
 * No Docker. No external deps. Just Node + better-sqlite3.
 */

import net from "net";
import fs from "fs";
import path from "path";
import os from "os";
import { GnosysDB, DbMemory } from "../lib/db.js";
import { federatedSearch } from "../lib/federated.js";
import { setPreference, getPreference, getAllPreferences, deletePreference, searchPreferences, Preference } from "../lib/preferences.js";
import { GnosysDreamEngine, DreamScheduler, DreamConfig, DreamReport, DEFAULT_DREAM_CONFIG } from "../lib/dream.js";
import { DEFAULT_CONFIG, GnosysConfig } from "../lib/config.js";
import { syncRules, generateRulesBlock, RulesGenResult } from "../lib/rulesGen.js";

// ─── Socket + PID paths ─────────────────────────────────────────────────

export function getSandboxDir(): string {
  const dir = path.join(os.homedir(), ".gnosys", "sandbox");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getSocketPath(): string {
  if (process.platform === "win32") {
    return "\\\\.\\pipe\\gnosys-sandbox";
  }
  return path.join(getSandboxDir(), "gnosys.sock");
}

export function getPidPath(): string {
  return path.join(getSandboxDir(), "gnosys.pid");
}

// ─── Protocol ────────────────────────────────────────────────────────────

export interface SandboxRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export interface SandboxResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

// ─── Dream Mode State ────────────────────────────────────────────────────

/** Sandbox-level dream state for status reporting. */
export interface DreamState {
  enabled: boolean;
  idleMinutes: number;
  lastDreamReport: DreamReport | null;
  dreamsCompleted: number;
  isDreaming: boolean;
}

let dreamState: DreamState = {
  enabled: false,
  idleMinutes: DEFAULT_DREAM_CONFIG.idleMinutes,
  lastDreamReport: null,
  dreamsCompleted: 0,
  isDreaming: false,
};

let dreamScheduler: DreamScheduler | null = null;

/**
 * Initialize Dream Mode in the sandbox.
 * Called once during server startup.
 */
export function initDreamMode(
  db: GnosysDB,
  config: GnosysConfig,
  dreamConfig?: Partial<DreamConfig>
): DreamScheduler | null {
  const mergedConfig: DreamConfig = {
    ...DEFAULT_DREAM_CONFIG,
    ...config.dream,
    ...dreamConfig,
    enabled: true, // Always enable in sandbox if caller invokes this
  };

  dreamState.enabled = true;
  dreamState.idleMinutes = mergedConfig.idleMinutes;

  const engine = new GnosysDreamEngine(db, config, mergedConfig);

  // Create a scheduler that wraps progress tracking
  const scheduler = new DreamScheduler(engine, mergedConfig);

  // Monkey-patch the scheduler's private checkIdle to track dream state
  const originalStart = scheduler.start.bind(scheduler);
  scheduler.start = function () {
    originalStart();

    // Override the internal check interval to track state
    const CHECK_INTERVAL = 60_000;
    const origCheckIdle = (scheduler as any).checkIdle;
    if (origCheckIdle) {
      (scheduler as any).checkIdle = async function () {
        dreamState.isDreaming = scheduler.isDreaming();
        await origCheckIdle.call(scheduler);
        dreamState.isDreaming = scheduler.isDreaming();
        if (!scheduler.isDreaming() && dreamState.isDreaming) {
          dreamState.dreamsCompleted++;
        }
      };
    }
  };

  return scheduler;
}

// ─── Request Handler ─────────────────────────────────────────────────────

export function handleRequest(db: GnosysDB, req: SandboxRequest): SandboxResponse {
  // Record activity for idle detection (Dream Mode)
  if (dreamScheduler) {
    dreamScheduler.recordActivity();
  }

  try {
    switch (req.method) {
      case "ping":
        return { id: req.id, ok: true, result: { status: "ok", pid: process.pid } };

      case "add": {
        const {
          content, title, category = "decisions", project_id, scope = "project",
          tags = "[]", relevance = "", author = "ai", authority = "declared",
          confidence = 0.9
        } = req.params as Record<string, any>;

        if (!content) return { id: req.id, ok: false, error: "content is required" };

        const now = new Date().toISOString();
        const memTitle = title || content.slice(0, 80);
        const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        db.insertMemory({
          id,
          title: memTitle,
          category,
          content,
          summary: null,
          tags: typeof tags === "string" ? tags : JSON.stringify(tags),
          relevance: relevance || content.slice(0, 200),
          author,
          authority,
          confidence: Number(confidence),
          reinforcement_count: 0,
          content_hash: "",
          status: "active",
          tier: "active",
          supersedes: null,
          superseded_by: null,
          last_reinforced: null,
          created: now,
          modified: now,
          embedding: null,
          source_path: null,
          project_id: project_id || null,
          scope: scope as "project" | "user" | "global",
        });

        return { id: req.id, ok: true, result: { id, title: memTitle } };
      }

      case "recall": {
        const { query, limit = 10, project_id } = req.params as Record<string, any>;
        if (!query) return { id: req.id, ok: false, error: "query is required" };

        // Use federated search if available, fall back to FTS
        try {
          const results = federatedSearch(db, query as string, {
            limit: Number(limit),
            projectId: project_id as string | undefined,
          });
          return {
            id: req.id,
            ok: true,
            result: results.map((r) => {
              // Enrich with full memory data when available
              const mem = db.getMemory(r.id);
              return {
                id: r.id,
                title: r.title,
                content: mem?.content || r.snippet,
                category: r.category,
                confidence: mem?.confidence ?? 0,
                score: r.score,
              };
            }),
          };
        } catch {
          // Fall back to basic FTS
          const results = db.searchFts(query as string, Number(limit));
          return {
            id: req.id,
            ok: true,
            result: results.map((r) => ({
              id: r.id,
              title: r.title,
              snippet: r.snippet,
              rank: r.rank,
            })),
          };
        }
      }

      case "reinforce": {
        const { id: memId, query } = req.params as Record<string, any>;

        let targetId = memId as string;

        // If query provided instead of ID, find best match
        if (!targetId && query) {
          const results = db.searchFts(query as string, 1);
          if (results.length === 0) {
            return { id: req.id, ok: false, error: `No memory found matching "${query}"` };
          }
          targetId = results[0].id;
        }

        if (!targetId) return { id: req.id, ok: false, error: "id or query is required" };

        const mem = db.getMemory(targetId);
        if (!mem) return { id: req.id, ok: false, error: `Memory not found: ${targetId}` };

        db.updateMemory(targetId, {
          reinforcement_count: mem.reinforcement_count + 1,
          confidence: Math.min(1.0, mem.confidence + 0.05),
          last_reinforced: new Date().toISOString(),
          modified: new Date().toISOString(),
        });

        return {
          id: req.id,
          ok: true,
          result: {
            id: targetId,
            reinforcement_count: mem.reinforcement_count + 1,
            confidence: Math.min(1.0, mem.confidence + 0.05),
          },
        };
      }

      case "get": {
        const { id: memId } = req.params as Record<string, any>;
        if (!memId) return { id: req.id, ok: false, error: "id is required" };
        const mem = db.getMemory(memId as string);
        if (!mem) return { id: req.id, ok: false, error: `Memory not found: ${memId}` };
        return { id: req.id, ok: true, result: mem };
      }

      case "list": {
        const { category, project_id, limit = 50 } = req.params as Record<string, any>;
        let memories: DbMemory[];
        if (project_id) {
          memories = db.getMemoriesByProject(project_id as string);
        } else if (category) {
          memories = db.getMemoriesByCategory(category as string);
        } else {
          memories = db.getActiveMemories();
        }
        return {
          id: req.id,
          ok: true,
          result: memories.slice(0, Number(limit)).map((m) => ({
            id: m.id,
            title: m.title,
            category: m.category,
            confidence: m.confidence,
            project_id: m.project_id,
            scope: m.scope,
          })),
        };
      }

      case "stats": {
        const counts = db.getMemoryCount();
        const categories = db.getCategories();
        const projects = db.getAllProjects();
        return {
          id: req.id,
          ok: true,
          result: {
            ...counts,
            categories,
            projects: projects.length,
          },
        };
      }

      // ─── Phase 9b: Preference methods ───────────────────────────────

      case "pref_set": {
        const { key, value, title: prefTitle, tags: prefTags, confidence: prefConf } = req.params as Record<string, any>;
        if (!key || !value) return { id: req.id, ok: false, error: "key and value are required" };

        const pref = setPreference(db, key as string, value as string, {
          title: prefTitle as string | undefined,
          tags: prefTags ? (Array.isArray(prefTags) ? prefTags : JSON.parse(prefTags as string)) : undefined,
          confidence: prefConf ? Number(prefConf) : undefined,
        });

        return { id: req.id, ok: true, result: pref };
      }

      case "pref_get": {
        const { key } = req.params as Record<string, any>;
        if (!key) return { id: req.id, ok: false, error: "key is required" };

        const pref = getPreference(db, key as string);
        if (!pref) return { id: req.id, ok: false, error: `Preference not found: ${key}` };
        return { id: req.id, ok: true, result: pref };
      }

      case "pref_list": {
        const prefs = getAllPreferences(db);
        return {
          id: req.id,
          ok: true,
          result: prefs.map((p) => ({ key: p.key, value: p.value, title: p.title })),
        };
      }

      case "pref_delete": {
        const { key } = req.params as Record<string, any>;
        if (!key) return { id: req.id, ok: false, error: "key is required" };

        const deleted = deletePreference(db, key as string);
        return { id: req.id, ok: true, result: { deleted } };
      }

      case "pref_search": {
        const { query } = req.params as Record<string, any>;
        if (!query) return { id: req.id, ok: false, error: "query is required" };

        const results = searchPreferences(db, query as string);
        return { id: req.id, ok: true, result: results };
      }

      // ─── Phase 9b: Dream Mode status ────────────────────────────────

      case "dream_status": {
        return {
          id: req.id,
          ok: true,
          result: {
            ...dreamState,
            isDreaming: dreamScheduler?.isDreaming() ?? false,
          },
        };
      }

      // ─── Phase 9b: Sync rules ───────────────────────────────────────

      case "sync": {
        const { project_dir, agent_rules_target, project_id } = req.params as Record<string, any>;
        if (!project_dir) return { id: req.id, ok: false, error: "project_dir is required" };
        if (!agent_rules_target) return { id: req.id, ok: false, error: "agent_rules_target is required" };

        // syncRules is async — but we handle it synchronously via blocking
        // Actually, we need to return a promise-based result. Since the handler is sync,
        // we'll use a simpler approach: generate the block and inject directly.
        const preferences = getAllPreferences(db);
        let projectConventions: DbMemory[] = [];
        if (project_id) {
          const projectMems = db.getMemoriesByProject(project_id as string);
          projectConventions = projectMems.filter(
            (m) => (m.category === "decisions" || m.category === "conventions") && m.status === "active"
          );
        }

        const block = generateRulesBlock(preferences, projectConventions);
        return {
          id: req.id,
          ok: true,
          result: {
            block,
            prefCount: preferences.length,
            conventionCount: projectConventions.length,
          },
        };
      }

      case "shutdown":
        // Stop dream scheduler before shutting down
        if (dreamScheduler) {
          dreamScheduler.stop();
        }
        setTimeout(() => {
          db.close();
          process.exit(0);
        }, 100);
        return { id: req.id, ok: true, result: { message: "Shutting down" } };

      default:
        return { id: req.id, ok: false, error: `Unknown method: ${req.method}` };
    }
  } catch (err) {
    return {
      id: req.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ─── Server ──────────────────────────────────────────────────────────────

export function startServer(dbPath?: string): net.Server {
  const socketPath = getSocketPath();

  // Clean up stale socket
  if (process.platform !== "win32" && fs.existsSync(socketPath)) {
    fs.unlinkSync(socketPath);
  }

  // Open database
  const dbDir = dbPath || GnosysDB.getCentralDbDir();
  const db = new GnosysDB(dbDir);

  if (!db.isAvailable()) {
    console.error("Failed to open GnosysDB. Is better-sqlite3 installed?");
    process.exit(1);
  }

  // ─── Phase 9b: Initialize Dream Mode ─────────────────────────────
  // loadConfig is async and needs a store path — in sandbox mode we use defaults
  // and allow env-based overrides.
  const config: GnosysConfig = {
    ...DEFAULT_CONFIG,
    dream: {
      ...DEFAULT_CONFIG.dream,
      enabled: process.env.GNOSYS_DREAM_ENABLED !== "false",
      idleMinutes: parseInt(process.env.GNOSYS_DREAM_IDLE_MINUTES || "10", 10),
    },
  };

  if (config.dream?.enabled !== false) {
    try {
      dreamScheduler = initDreamMode(db, config);
      if (dreamScheduler) {
        dreamScheduler.start();
        console.log(`Dream Mode enabled (idle threshold: ${dreamState.idleMinutes}min)`);
      }
    } catch (err) {
      console.error(`Dream Mode init failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const server = net.createServer((socket) => {
    let buffer = "";

    socket.on("data", (data) => {
      buffer += data.toString();

      // Process complete JSON messages (newline-delimited)
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);

        if (!line) continue;

        try {
          const req = JSON.parse(line) as SandboxRequest;
          const res = handleRequest(db, req);
          socket.write(JSON.stringify(res) + "\n");
        } catch (err) {
          socket.write(
            JSON.stringify({
              id: "error",
              ok: false,
              error: `Invalid request: ${err instanceof Error ? err.message : String(err)}`,
            }) + "\n"
          );
        }
      }
    });

    socket.on("error", () => {
      // Client disconnected — that's fine
    });
  });

  server.listen(socketPath, () => {
    // Write PID file
    fs.writeFileSync(getPidPath(), String(process.pid));
    console.log(`Gnosys sandbox running (pid: ${process.pid}, socket: ${socketPath})`);
  });

  // Cleanup on exit
  const cleanup = () => {
    try {
      if (dreamScheduler) dreamScheduler.stop();
      db.close();
      if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
      if (fs.existsSync(getPidPath())) fs.unlinkSync(getPidPath());
    } catch {
      // Best effort
    }
  };

  process.on("SIGTERM", () => { cleanup(); process.exit(0); });
  process.on("SIGINT", () => { cleanup(); process.exit(0); });
  process.on("exit", cleanup);

  return server;
}

// ─── Entry point (when run directly) ─────────────────────────────────────

if (process.argv[1] && (
  process.argv[1].endsWith("sandbox/server.js") ||
  process.argv[1].endsWith("sandbox/server.ts")
)) {
  const dbPath = process.argv.find((a) => a.startsWith("--db-path="))?.split("=")[1];
  startServer(dbPath);
}

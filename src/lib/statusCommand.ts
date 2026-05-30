import path from "path";
import type { GnosysConfig } from "./config.js";
import { GnosysDB } from "./db.js";
import type { GnosysResolver } from "./resolver.js";
import type { RemoteStatus } from "./remote.js";

export type StatusCommandOptions = {
  directory?: string;
  project?: string;
  global?: boolean;
  projects?: boolean;
  remote?: boolean;
  web?: boolean;
  system?: boolean;
  json: boolean;
};

export type StatusCommandDeps = {
  getResolver: () => Promise<GnosysResolver>;
  loadConfig: (path: string) => Promise<GnosysConfig>;
  pkgVersion: string;
};

export async function runStatusCommand(
  opts: StatusCommandOptions,
  deps: StatusCommandDeps,
): Promise<void> {
  // v5.7.1: --projects supersedes --global (kept as alias).
  if (opts.projects) opts.global = true;

  // v5.7.1: --remote — dispatch to RemoteSync.getStatus()
  if (opts.remote) {
    let remoteCentralDb: GnosysDB | null = null;
    try {
      remoteCentralDb = GnosysDB.openLocal();
      if (!remoteCentralDb.isAvailable()) {
        console.error("Central DB not available.");
        process.exitCode = 1;
        return;
      }
      const remotePath = remoteCentralDb.getMeta("remote_path");
      if (!remotePath) {
        if (opts.json) {
          console.log(
            JSON.stringify(
              { configured: false, message: "Remote not configured. Run 'gnosys setup remote'." },
              null,
              2,
            ),
          );
        } else {
          console.log(
            "Remote sync: not configured. Run 'gnosys setup remote' to set up multi-machine sync.",
          );
        }
        return;
      }
      const { RemoteSync, formatStatus } = await import("./remote.js");
      const { withHeartbeat } = await import("./heartbeat.js");
      let sync: InstanceType<typeof RemoteSync> | null = null;
      try {
        sync = new RemoteSync(remoteCentralDb, remotePath);
        const status = await withHeartbeat<RemoteStatus>("Checking remote sync status", () => sync!.getStatus());
        if (opts.json) {
          console.log(JSON.stringify(status, null, 2));
        } else {
          console.log(formatStatus(status));
          if (status.conflicts.length > 0) {
            console.log("\nConflicts:");
            for (const c of status.conflicts) {
              console.log(`  ${c.memoryId}: ${c.title}`);
              console.log(`    local:  ${c.localModified}`);
              console.log(`    remote: ${c.remoteModified}`);
            }
            console.log("\nResolve with: gnosys setup remote resolve <memory-id> --keep <local|remote>");
          }
        }
      } finally {
        sync?.closeRemote();
      }
      return;
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
      return;
    } finally {
      remoteCentralDb?.close();
    }
  }

  // --system delegates to the dashboard formatter (formerly `gnosys dashboard`).
  if (opts.system) {
    let dashDb: GnosysDB | null = null;
    try {
      const { collectDashboardData, formatDashboard, formatDashboardJSON } =
        await import("./dashboard.js");
      const resolver = await deps.getResolver();
      const stores = resolver.getStores();
      if (stores.length === 0) {
        console.error("No Gnosys stores found. Run gnosys init first.");
        process.exitCode = 1;
        return;
      }
      const cfg = await deps.loadConfig(stores[0].path);
      try {
        dashDb = GnosysDB.openCentral();
        if (!dashDb.isAvailable() || !dashDb.isMigrated()) {
          dashDb.close();
          dashDb = null;
        }
      } catch {
        dashDb?.close();
        dashDb = null;
      }
      const data = await collectDashboardData(resolver, cfg, deps.pkgVersion, dashDb ?? undefined);
      console.log(opts.json ? formatDashboardJSON(data) : formatDashboard(data));
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
      return;
    } finally {
      dashDb?.close();
    }
    return;
  }

  let centralDb: GnosysDB | null = null;
  try {
    centralDb = GnosysDB.openCentral();
    if (!centralDb.isAvailable()) {
      console.error("Central DB not available.");
      process.exitCode = 1;
      return;
    }

    const { detectCurrentProject } = await import("./federated.js");
    const { generatePortfolio } = await import("./portfolio.js");

    const report = generatePortfolio(centralDb);

    // --web: regenerate HTML dashboard and open it
    if (opts.web) {
      const { generatePortfolioHtml } = await import("./portfolioHtml.js");
      const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
      const dashboardPath = path.join(home, "gnosys-dashboard.html");
      const { writeFileSync } = await import("fs");
      writeFileSync(dashboardPath, generatePortfolioHtml(report, dashboardPath), "utf-8");
      const { execFile } = await import("child_process");
      execFile("open", [dashboardPath]);
      console.log(`Dashboard opened: ${dashboardPath}`);
      return;
    }

    // --global: show all projects
    if (opts.global) {
      if (opts.json) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }

      console.log(`\n  Portfolio — ${report.totalProjects} projects, ${report.totalMemories} memories\n`);

      // Action items summary
      if (report.allActionItems.length > 0) {
        console.log(`  \x1b[31mACTION ITEMS (${report.allActionItems.length}):\x1b[0m`);
        for (const a of report.allActionItems.slice(0, 8)) {
          const icon =
            a.type === "question" ? "?" : a.type === "blocker" ? "!" : a.type === "manual" ? ">" : "*";
          console.log(`    [${icon}] ${a.projectName}: ${a.text.slice(0, 80)}`);
        }
        if (report.allActionItems.length > 8) {
          console.log(`    ... and ${report.allActionItems.length - 8} more`);
        }
        console.log("");
      }

      // Per-project summary
      for (const snap of report.projects) {
        const r = snap.readiness;
        const color =
          r.score >= 90 ? "\x1b[32m" : r.score >= 65 ? "\x1b[34m" : r.score >= 40 ? "\x1b[33m" : "\x1b[31m";
        const reset = "\x1b[0m";
        const blockers = snap.actionItems.length + r.blocking.length;
        const blockerStr =
          blockers > 0 ? ` — \x1b[31m${blockers} blocker${blockers !== 1 ? "s" : ""}\x1b[0m` : "";
        console.log(
          `  ${color}${String(r.score).padStart(3)}%${reset} ${r.label.padEnd(12)} ${snap.project.name}${blockerStr}`,
        );
      }

      console.log(`\n  Run 'gnosys status --web' to open the visual dashboard.`);
      return;
    }

    // Single project (default): auto-detect from cwd
    let pid = opts.project || null;
    if (!pid) pid = await detectCurrentProject(centralDb, opts.directory || undefined);
    if (!pid) {
      console.error(
        "No project detected. Run from a project directory, use --project, or use --global for all.",
      );
      process.exitCode = 1;
      return;
    }

    const project = centralDb.getProject(pid);
    if (!project) {
      console.error(`Project not found: ${pid}`);
      process.exitCode = 1;
      return;
    }

    const snap = report.projects.find((s) => s.project.id === pid);

    if (!snap) {
      console.error(`No memories found for project: ${project.name}`);
      console.log(`\nRun 'gnosys update-status' to create a status snapshot.`);
      process.exitCode = 1;
      return;
    }

    if (opts.json) {
      console.log(
        JSON.stringify(
          {
            project: project.name,
            readiness: snap.readiness,
            actionItems: snap.actionItems,
            memoryCounts: snap.memoryCounts,
            latestStatus: snap.latestStatus
              ? {
                  id: snap.latestStatus.id,
                  title: snap.latestStatus.title,
                  modified: snap.latestStatus.modified,
                }
              : null,
          },
          null,
          2,
        ),
      );
      return;
    }

    // Formatted output
    const r = snap.readiness;
    const color =
      r.score >= 90 ? "\x1b[32m" : r.score >= 65 ? "\x1b[34m" : r.score >= 40 ? "\x1b[33m" : "\x1b[31m";
    const reset = "\x1b[0m";

    console.log(`\n  ${project.name} — ${color}${r.label} (${r.score}%)${reset}`);
    console.log(
      `  ${snap.memoryCounts.total} memories across ${Object.keys(snap.memoryCounts.byCategory).length} categories\n`,
    );

    if (snap.latestStatus) {
      const age = Math.floor(
        (Date.now() - new Date(snap.latestStatus.modified).getTime()) / (1000 * 60 * 60 * 24),
      );
      const stale =
        age > 7
          ? ` \x1b[33m(${age}d old — consider running 'gnosys update-status')\x1b[0m`
          : ` (${age}d ago)`;
      console.log(`  Last status: ${snap.latestStatus.title}${stale}\n`);
    } else {
      console.log(`  \x1b[33mNo status snapshot found. Run 'gnosys update-status' to create one.\x1b[0m\n`);
    }

    // Action items
    if (snap.actionItems.length > 0) {
      console.log(`  ACTION ITEMS (${snap.actionItems.length}):`);
      for (const a of snap.actionItems) {
        const icon =
          a.type === "question" ? "?" : a.type === "blocker" ? "!" : a.type === "manual" ? ">" : "*";
        console.log(`    [${icon}] ${a.text}`);
      }
      console.log("");
    }

    // Blocking
    if (r.blocking.length > 0) {
      console.log(`  BLOCKING GO-LIVE (${r.blocking.length}):`);
      for (const b of r.blocking.slice(0, 10)) {
        console.log(`    - ${b}`);
      }
      if (r.blocking.length > 10) console.log(`    ... and ${r.blocking.length - 10} more`);
      console.log("");
    }

    // Done summary
    if (r.done.length > 0) {
      console.log(`  COMPLETED (${r.done.length} items)`);
      for (const d of r.done.slice(0, 5)) {
        console.log(`    + ${d}`);
      }
      if (r.done.length > 5) console.log(`    ... and ${r.done.length - 5} more`);
      console.log("");
    }

    // Suggest update if no status or stale
    if (!snap.latestStatus) {
      console.log(`  Tip: Run 'gnosys update-status' to generate a status snapshot.`);
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    return;
  } finally {
    centralDb?.close();
  }
}

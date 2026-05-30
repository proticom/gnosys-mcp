import path from "path";
import fs from "fs/promises";
import os from "os";
import { fileURLToPath } from "url";
import { GnosysDB } from "./db.js";
import { GnosysResolver } from "./resolver.js";
import { createProjectIdentity } from "./projectIdentity.js";

export type SetupSyncProjectsCommandOptions = {
  skipDashboard?: boolean;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function packageVersion(): Promise<string> {
  const pkgPath = path.resolve(__dirname, "..", "..", "package.json");
  const pkg = JSON.parse(await fs.readFile(pkgPath, "utf-8"));
  return pkg.version as string;
}

export async function runSetupSyncProjectsCommand(
  opts: SetupSyncProjectsCommandOptions,
): Promise<void> {
  const currentVersion = await packageVersion();
  // v5.9.3 Screen 10 — Header + leading spinner + hierarchical sections.
  const {
    renderSyncHeader,
    renderUpgradedSection,
    renderSkippedSection,
    renderFailedSection,
    renderMachinesSection,
    renderDivider,
    renderDoneLine,
    renderDashboardSummary,
  } = await import("./setup/syncProjectsRender.js");
  const { Spinner } = await import("./setup/ui/spinner.js");

  console.log("");
  console.log(renderSyncHeader(currentVersion));
  console.log("");

  // 1. Read registered projects from file registry AND central DB
  const home = process.env.HOME || process.env.USERPROFILE || "/tmp";
  const registryPath = path.join(home, ".config", "gnosys", "projects.json");
  let fileProjects: string[] = [];
  try {
    fileProjects = JSON.parse(await fs.readFile(registryPath, "utf-8"));
  } catch {
    // No file registry yet
  }

  // Also check central DB for projects not in the file registry. Also
  // capture project titles so the Screen 10 row labels can use the
  // human-readable name where available.
  let dbProjects: string[] = [];
  const titleByDir = new Map<string, string>();
  try {
    const centralDb = GnosysDB.openCentral();
    if (centralDb.isAvailable()) {
      const allProjects = centralDb.getAllProjects();
      dbProjects = allProjects.map((p) => p.working_directory);
      for (const p of allProjects) titleByDir.set(p.working_directory, p.name);
      centralDb.close();
    }
  } catch {
    // non-critical
  }

  // Merge: deduplicate by resolved path
  const seen = new Set<string>();
  const projects: string[] = [];
  for (const p of [...fileProjects, ...dbProjects]) {
    const resolved = path.resolve(p);
    if (!seen.has(resolved)) {
      seen.add(resolved);
      projects.push(resolved);
    }
  }

  if (projects.length === 0) {
    console.log(" no registered projects found");
    console.log(" run `gnosys init` in each project first");
    return;
  }

  // Lead-in spinner: shows we're churning through the registry. Resolves
  // to ✓ summary after the iteration loop completes (or fail on hard error).
  const syncSpinner = Spinner(`syncing ${projects.length} registered projects…`);

  // Sync the merged list back to file registry
  try {
    await fs.mkdir(path.dirname(registryPath), { recursive: true });
    await fs.writeFile(registryPath, JSON.stringify(projects, null, 2), "utf-8");
  } catch {
    // non-critical
  }

  // 2. Iterate and upgrade each project that exists on this machine
  const upgraded: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];

  for (const projectDir of projects) {
    // Skip test/temp directories
    if (projectDir.startsWith("/tmp/") || projectDir.startsWith("/private/tmp/") || projectDir.startsWith("/var/folders/") || projectDir.startsWith("/private/var/folders/")) {
      continue;
    }

    const storePath = path.join(projectDir, ".gnosys");
    try {
      await fs.stat(storePath);
    } catch {
      skipped.push(projectDir);
      continue;
    }

    try {
      // Re-create project identity (re-syncs with central DB)
      let centralDb: GnosysDB | null = null;
      try {
        centralDb = GnosysDB.openCentral();
        if (!centralDb.isAvailable()) centralDb = null;
      } catch {
        centralDb = null;
      }

      await createProjectIdentity(projectDir, { centralDb: centralDb || undefined });

      // Re-register in file-based registry (idempotent)
      const tempResolver = new GnosysResolver();
      await tempResolver.registerProject(projectDir);

      // Re-generate agent rules for all detected IDEs
      if (centralDb) {
        const { syncToTarget } = await import("./rulesGen.js");
        const { readProjectIdentity } = await import("./projectIdentity.js");
        const identity = await readProjectIdentity(projectDir);
        const projectId = identity?.projectId || null;

        try {
          await syncToTarget(centralDb, projectDir, "all", projectId);
        } catch {
          // Some projects may not have IDE configs — that's ok
        }

        centralDb.close();
      }

      // Configure IDE hooks for automatic memory recall
      const { configureIdeHooks } = await import("./projectIdentity.js");
      await configureIdeHooks(projectDir);

      upgraded.push(projectDir);
    } catch (err) {
      failed.push(`${projectDir} (${(err as Error).message})`);
    }
  }

  // Stop the lead-in spinner now that the iteration is done. Resolved
  // before any per-section output so the cursor is on a fresh line.
  syncSpinner.ok(
    `synced ${projects.length} registered projects`,
    `${upgraded.length} upgraded · ${skipped.length} skipped · ${failed.length} failed`,
  );

  // 3. Update global agent rules
  try {
    let centralDb: GnosysDB | null = null;
    try {
      centralDb = GnosysDB.openCentral();
      if (!centralDb.isAvailable()) centralDb = null;
    } catch {
      centralDb = null;
    }
    if (centralDb) {
      const { syncToTarget } = await import("./rulesGen.js");
      await syncToTarget(centralDb, process.cwd(), "global", null);
      centralDb.close();
      const { printStatus } = await import("./setup/ui/status.js");
      printStatus("ok", "global agent rules updated", "~/.claude/CLAUDE.md");
    }
  } catch {
    const { printStatus } = await import("./setup/ui/status.js");
    printStatus("warn", "could not update global agent rules");
  }

  // 4. Stamp the central DB with current version and machine info
  try {
    const centralDb = GnosysDB.openCentral();
    if (centralDb.isAvailable()) {
      const hostname = os.hostname();
      centralDb.setMeta("app_version", currentVersion);
      centralDb.setMeta("last_upgrade", new Date().toISOString());
      centralDb.setMeta("upgraded_by", hostname);

      // Record this machine in the connected-machines registry. Keyed by
      // hostname, but we pass machineId + any previous hostnames so a renamed
      // machine prunes its own orphaned entry instead of showing up twice.
      const { ensureMachineConfig } = await import("./machineConfig.js");
      const { recordMachine } = await import("./machineRegistry.js");
      const machine = ensureMachineConfig().config;
      recordMachine(centralDb, {
        hostname,
        version: currentVersion,
        machineId: machine.machineId,
        aliases: machine.previousHostnames,
      });

      centralDb.close();
    }
  } catch {
    // non-critical
  }

  // 5. Report — v5.9.3 Screen 10 hierarchical layout. Section helpers
  // turn the raw path arrays into ProjectRow lists (title + fullPath)
  // and emit dividers between groups.
  function rowFor(p: string): { title: string; fullPath: string } {
    const title = titleByDir.get(p) ?? titleByDir.get(path.resolve(p)) ?? path.basename(p);
    return { title, fullPath: p };
  }
  const upgradedRows = upgraded.map(rowFor);
  const skippedRows = skipped.map(rowFor);
  const failedRows = failed.map((f) => {
    // failed entries are "<path> (<err>)" — extract path for the title.
    const match = f.match(/^(.+?)\s\((.+)\)$/);
    const projectPath = match ? match[1] : f;
    return { title: titleByDir.get(projectPath) ?? path.basename(projectPath), fullPath: f };
  });

  console.log("");
  for (const line of renderUpgradedSection(upgradedRows)) console.log(line);
  if (upgradedRows.length > 0 && (skippedRows.length > 0 || failedRows.length > 0)) {
    console.log("");
  }
  for (const line of renderSkippedSection(skippedRows)) console.log(line);
  if (failedRows.length > 0) {
    console.log("");
    for (const line of renderFailedSection(failedRows)) console.log(line);
  }

  // Connected-machines callout (separate divider per design spec).
  let machineLines: string[] = [];
  try {
    const centralDb = GnosysDB.openCentral();
    if (centralDb.isAvailable()) {
      const { readMachineRegistry } = await import("./machineRegistry.js");
      const machines = readMachineRegistry(centralDb);
      const entries = Object.entries(machines);
      if (entries.length > 0) {
        const currentHost = os.hostname();
        const machineRows = entries.map(([host, info]) => ({
          hostname: host,
          version: info.version,
          lastSeen: info.lastSeen,
          isCurrent: host === currentHost,
        }));
        machineLines = renderMachinesSection(machineRows, currentVersion);
      }
      centralDb.close();
    }
  } catch {
    // non-critical
  }

  if (machineLines.length > 0) {
    console.log("");
    console.log(renderDivider());
    console.log("");
    for (const line of machineLines) console.log(line);
  }

  console.log("");
  console.log(renderDivider());
  console.log("");
  console.log(renderDoneLine(currentVersion));

  if (skippedRows.length > 0) {
    // v5.9.3 Phase H: offer one-keystroke cleanup. Stays interactive
    // by default; users on a TTY get the prompt, non-TTY runs silently
    // (sync-projects is sometimes invoked from CI).
    console.log("");
    if (process.stdout.isTTY) {
      try {
        const { cleanupRegistry } = await import("./cleanup.js");
        await cleanupRegistry({ interactive: true });
      } catch (err) {
        const { printStatus } = await import("./setup/ui/status.js");
        printStatus("warn", "cleanup skipped", err instanceof Error ? err.message : String(err));
      }
    } else {
      const { printStatus } = await import("./setup/ui/status.js");
      printStatus("progress", "tip", "run `gnosys cleanup` to remove stale entries");
    }
  }

  // 6. Regenerate portfolio dashboard
  if (!opts.skipDashboard) {
    try {
      const dashboardPath = path.join(home, "gnosys-dashboard.html");
      const dashboardMdPath = path.join(home, "gnosys-dashboard.md");
      const centralDb = GnosysDB.openCentral();
      if (centralDb.isAvailable()) {
        const { generatePortfolio, formatPortfolioMarkdown } = await import("./portfolio.js");
        const { generatePortfolioHtml } = await import("./portfolioHtml.js");
        const report = generatePortfolio(centralDb);
        await fs.writeFile(dashboardPath, generatePortfolioHtml(report, dashboardPath), "utf-8");
        await fs.writeFile(dashboardMdPath, formatPortfolioMarkdown(report), "utf-8");
        centralDb.close();
        console.log("");
        for (const line of renderDashboardSummary(dashboardPath, dashboardMdPath)) {
          console.log(line);
        }
      }
    } catch {
      const { printStatus } = await import("./setup/ui/status.js");
      console.log("");
      printStatus("warn", "could not regenerate portfolio dashboard");
    }
  }
}

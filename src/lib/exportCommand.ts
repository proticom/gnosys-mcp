import path from "path";
import { GnosysResolver } from "./resolver.js";

export type VaultExportOptions = {
  to: string;
  all?: boolean;
  overwrite?: boolean;
  summaries?: boolean;
  reviews?: boolean;
  graph?: boolean;
  json?: boolean;
};

export type ProjectExportOptions = {
  to: string;
  includeArchived?: boolean;
  audit?: boolean;
  json?: boolean;
};

export function runExportUsageCommand(): void {
  console.error("Usage: gnosys export vault --to <dir>             # Obsidian vault export");
  console.error("       gnosys export project [id] --to <bundle>   # portable .json.gz bundle");
  process.exit(1);
}

export async function runVaultExportCommand(opts: VaultExportOptions): Promise<void> {
  const resolver = new GnosysResolver();
  await resolver.resolve();
  const stores = resolver.getStores();
  if (stores.length === 0) {
    console.error("No Gnosys stores found. Run 'gnosys init' first.");
    process.exit(1);
  }

  const { GnosysDB: DbClass } = await import("./db.js");
  const { GnosysExporter, formatExportReport } = await import("./export.js");

  const storePath = stores[0].path;
  let db: InstanceType<typeof DbClass> | null = null;
  try {
    db = new DbClass(storePath);

    if (!db.isAvailable() || !db.isMigrated()) {
      console.error("Export requires gnosys.db (v2.0). Run 'gnosys migrate' first.");
      process.exitCode = 1;
      return;
    }

    const targetDir = path.resolve(opts.to);
    console.error(`Exporting to: ${targetDir}`);

    const exporter = new GnosysExporter(db);
    const report = await exporter.export({
      targetDir,
      activeOnly: !opts.all,
      includeSummaries: opts.summaries !== false,
      includeReviews: opts.reviews !== false,
      includeGraph: opts.graph !== false,
      overwrite: opts.overwrite || false,
      onProgress: (current, total, file) => {
        if (current % 10 === 0 || current === total) {
          console.error(`  [${current}/${total}] ${file}`);
        }
      },
    });

    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatExportReport(report));
    }
  } finally {
    db?.close();
  }
}

export async function runProjectExportCommand(
  projectIdArg: string | undefined,
  opts: ProjectExportOptions,
): Promise<void> {
  const { GnosysDB: DbClass } = await import("./db.js");
  const { exportProject } = await import("./exportProject.js");

  let centralDb: InstanceType<typeof DbClass> | null = null;
  try {
    centralDb = DbClass.openCentral();
    if (!centralDb.isAvailable()) {
      console.error("Central DB unavailable.");
      process.exitCode = 1;
      return;
    }

    let projectId = projectIdArg;
    if (!projectId) {
      const proj = centralDb.getProjectByDirectory(process.cwd());
      if (!proj) {
        console.error("No project ID given and current directory is not a registered project.");
        console.error("Usage: gnosys export project <projectId> --to <file>");
        process.exitCode = 1;
        return;
      }
      projectId = proj.id;
    }

    const result = exportProject(centralDb, {
      projectId,
      outputPath: path.resolve(opts.to),
      includeArchived: !!opts.includeArchived,
      includeAudit: opts.audit !== false,
    });

    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      const ratio = (result.compressedBytes / result.uncompressedBytes * 100).toFixed(1);
      console.log(`Exported project ${projectId}`);
      console.log(`  Memories:      ${result.memoryCount}`);
      if (result.archivedExcluded > 0) {
        console.log(
          `  Archived:      ${result.archivedExcluded} excluded — re-run with --include-archived for a full backup`,
        );
      }
      console.log(`  Relationships: ${result.relationshipCount}`);
      console.log(`  Audit entries: ${result.auditEntryCount}`);
      console.log(`  Bundle:        ${result.outputPath}`);
      console.log(`  Size:          ${(result.compressedBytes / 1024).toFixed(1)} KB compressed (${ratio}% of ${(result.uncompressedBytes / 1024).toFixed(1)} KB)`);
    }
  } finally {
    centralDb?.close();
  }
}

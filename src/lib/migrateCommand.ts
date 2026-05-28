import fs from "fs/promises";
import path from "path";
import { GnosysDB } from "./db.js";
import { findProjectIdentity, readProjectIdentity, migrateProject } from "./projectIdentity.js";

export type MigrateCommandOptions = {
  from?: string;
  to?: string;
  name?: string;
  yes?: boolean;
};

export async function runMigrateCommand(
  opts: MigrateCommandOptions,
): Promise<void> {
  const { createInterface } = await import("readline/promises");
  const rl = opts.yes ? null : createInterface({ input: process.stdin, output: process.stdout });
  let centralDb: GnosysDB | null = null;

  const ask = async (question: string, defaultValue?: string): Promise<string> => {
    if (!rl) return defaultValue || "";
    const suffix = defaultValue ? ` (${defaultValue})` : "";
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || defaultValue || "";
  };

  try {
    console.log("\n── Gnosys Project Migration ──\n");

    let sourceDir: string;
    if (opts.from) {
      sourceDir = path.resolve(opts.from);
    } else {
      const found = await findProjectIdentity(process.cwd());
      const defaultSource = found ? found.projectRoot : "";
      const sourceInput = await ask("Source directory (contains .gnosys/)", defaultSource);
      if (!sourceInput) {
        console.error("No source directory provided.");
        process.exit(1);
      }
      sourceDir = path.resolve(sourceInput);
    }

    const storePath = path.join(sourceDir, ".gnosys");
    try {
      await fs.stat(storePath);
    } catch {
      console.error(`No .gnosys/ directory found at ${sourceDir}`);
      process.exit(1);
    }

    const identity = await readProjectIdentity(sourceDir);

    const { glob } = await import("glob");
    const memFiles = await glob("**/*.md", {
      cwd: storePath,
      ignore: ["**/CHANGELOG.md", "**/MANIFEST.md", "**/.git/**", "**/.obsidian/**"],
    });

    console.log("\nSource project:");
    if (identity) {
      console.log(`  Name:      ${identity.projectName}`);
      console.log(`  ID:        ${identity.projectId}`);
    } else {
      console.log(`  Name:      (unregistered — pre-v3 store)`);
    }
    console.log(`  Directory: ${sourceDir}`);
    console.log(`  Memories:  ${memFiles.length} markdown files`);

    let targetDir: string;
    if (opts.to) {
      targetDir = path.resolve(opts.to);
    } else {
      const targetInput = await ask("\nTarget directory (where .gnosys/ should live)");
      if (!targetInput) {
        console.error("No target directory provided.");
        process.exit(1);
      }
      targetDir = path.resolve(targetInput);
    }

    const defaultName = opts.name || path.basename(targetDir);
    const newName = opts.yes
      ? defaultName
      : await ask("Project name", defaultName);

    let doSync = true;
    let doDelete = true;
    if (!opts.yes) {
      const syncAnswer = await ask("\nSync memories to central DB?", "Y");
      doSync = syncAnswer.toLowerCase() !== "n" && syncAnswer.toLowerCase() !== "no";

      const deleteAnswer = await ask("Delete old .gnosys/ after migration?", "Y");
      doDelete = deleteAnswer.toLowerCase() !== "n" && deleteAnswer.toLowerCase() !== "no";
    }

    console.log("\n── Migration Summary ──");
    console.log(`  From:       ${sourceDir}/.gnosys/`);
    console.log(`  To:         ${targetDir}/.gnosys/`);
    console.log(`  Name:       ${identity?.projectName || "(new)"} → ${newName}`);
    console.log(`  Memories:   ${memFiles.length} files`);
    console.log(`  Sync to DB: ${doSync ? "yes" : "no"}`);
    console.log(`  Delete old: ${doDelete ? "yes" : "no"}`);

    if (!opts.yes) {
      const confirm = await ask("\nProceed?", "Y");
      if (confirm.toLowerCase() === "n" || confirm.toLowerCase() === "no") {
        console.log("Aborted.");
        return;
      }
    }

    try {
      centralDb = GnosysDB.openCentral();
      if (!centralDb.isAvailable()) centralDb = null;
    } catch {
      centralDb = null;
    }

    console.log("\nMigrating...");
    const result = await migrateProject({
      sourcePath: sourceDir,
      targetPath: targetDir,
      newName,
      deleteSource: doDelete,
      centralDb: centralDb || undefined,
    });

    console.log(`  Copied ${result.memoryFileCount} memory files`);
    console.log(`  Project: ${result.newIdentity.projectName} (${result.newIdentity.projectId})`);
    console.log(`  Path:    ${result.newIdentity.workingDirectory}`);
    console.log(`  Central DB: ${centralDb ? "updated ✓" : "not available"}`);

    if (doSync && centralDb) {
      console.log("\nSyncing memories to central DB...");
      const matter = (await import("gray-matter")).default;
      const { syncMemoryToDb } = await import("./dbWrite.js");
      const newStorePath = path.join(targetDir, ".gnosys");

      const mdFiles = await glob("**/*.md", {
        cwd: newStorePath,
        ignore: ["**/CHANGELOG.md", "**/MANIFEST.md", "**/.git/**", "**/.obsidian/**"],
      });

      let synced = 0;
      for (const file of mdFiles) {
        try {
          const filePath = path.join(newStorePath, file);
          const raw = await fs.readFile(filePath, "utf-8");
          const parsed = matter(raw);
          if (parsed.data?.id) {
            syncMemoryToDb(
              centralDb,
              parsed.data as import("./store.js").MemoryFrontmatter,
              parsed.content,
              filePath,
              result.newIdentity.projectId,
              "project",
            );
            synced++;
          }
        } catch {
          // Skip files that fail to parse
        }
      }

      console.log(`  Synced ${synced} memories to central DB`);
    }

    if (doDelete) {
      console.log(`\nOld .gnosys/ at ${sourceDir} removed.`);
    }

    console.log(`\nMigration complete! Run 'gnosys projects' to verify.`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\nMigration failed: ${msg}`);
    process.exit(1);
  } finally {
    rl?.close();
    centralDb?.close();
  }
}

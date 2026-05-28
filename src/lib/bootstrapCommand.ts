import type { GnosysResolver } from "./resolver.js";

export type BootstrapCommandOptions = {
  pattern?: string[];
  skipExisting?: boolean;
  category: string;
  author: string;
  authority: string;
  confidence: string;
  preserveFrontmatter?: boolean;
  dryRun?: boolean;
  store?: string;
};

type GetResolver = () => Promise<GnosysResolver>;

export async function runBootstrapCommand(
  getResolver: GetResolver,
  sourceDir: string,
  opts: BootstrapCommandOptions,
): Promise<void> {
        const resolver = await getResolver();
        const writeTarget = resolver.getWriteTarget(
          (opts.store as any) || undefined
        );
        if (!writeTarget) {
          console.error("No writable store found.");
          process.exit(1);
        }
  
        // Show what we'll scan
        const { bootstrap, discoverFiles } = await import("./bootstrap.js");
        const files = await discoverFiles(sourceDir, opts.pattern);
        console.log(`Found ${files.length} files in ${sourceDir}\n`);
  
        if (files.length === 0) {
          console.log("Nothing to import.");
          return;
        }
  
        const result = await bootstrap(writeTarget.store, {
          sourceDir,
          patterns: opts.pattern,
          skipExisting: opts.skipExisting,
          defaultCategory: opts.category,
          defaultAuthor: opts.author as any,
          defaultAuthority: opts.authority as any,
          defaultConfidence: parseFloat(opts.confidence),
          preserveFrontmatter: opts.preserveFrontmatter,
          dryRun: opts.dryRun,
        });
  
        const mode = opts.dryRun ? "DRY RUN" : "COMPLETE";
        console.log(`\nBootstrap ${mode}:`);
        console.log(`  Scanned: ${result.totalScanned}`);
        console.log(`  ${opts.dryRun ? "Would import" : "Imported"}: ${result.imported.length}`);
        console.log(`  Skipped: ${result.skipped.length}`);
        console.log(`  Failed: ${result.failed.length}`);
  
        if (result.imported.length > 0) {
          console.log(`\n${opts.dryRun ? "Would import" : "Imported"}:`);
          for (const f of result.imported) {
            console.log(`  + ${f}`);
          }
        }
  
        if (result.skipped.length > 0) {
          console.log(`\nSkipped (already exist):`);
          for (const f of result.skipped) {
            console.log(`  ⏭ ${f}`);
          }
        }
  
        if (result.failed.length > 0) {
          console.log(`\nFailed:`);
          for (const f of result.failed) {
            console.log(`  ❌ ${f.path}: ${f.error}`);
          }
        }
}

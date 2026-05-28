export type HelperGenerateCommandOptions = {
  directory?: string;
  json?: boolean;
};

export async function runHelperGenerateCommand(
  opts: HelperGenerateCommandOptions,
): Promise<void> {
  try {
    const { generateHelper } = await import("../sandbox/helper-template.js");
    const targetDir = opts.directory || process.cwd();
    const outputPath = await generateHelper(targetDir);

    if (opts.json) {
      console.log(JSON.stringify({ ok: true, path: outputPath }));
    } else {
      console.log(`Generated: ${outputPath}`);
      console.log();
      console.log("Usage in your agent/script:");
      console.log('  import { gnosys } from "./gnosys-helper";');
      console.log('  await gnosys.add("We use conventional commits");');
      console.log('  const ctx = await gnosys.recall("auth decisions");');
    }
  } catch (err) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    } else {
      console.error(`Failed to generate helper: ${err instanceof Error ? err.message : err}`);
    }
    process.exit(1);
  }
}

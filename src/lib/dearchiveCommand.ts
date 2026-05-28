import type { GnosysResolver } from "./resolver.js";
import type { GnosysArchive } from "./archive.js";

type GetResolver = () => Promise<GnosysResolver>;

export type DearchiveCommandOptions = {
  limit: string;
};

export async function runDearchiveCommand(
  getResolver: GetResolver,
  query: string,
  opts: DearchiveCommandOptions,
): Promise<void> {
  let archive: GnosysArchive | undefined;

  try {
    const { GnosysArchive } = await import("./archive.js");

    const resolver = await getResolver();
    const stores = resolver.getStores();

    if (stores.length === 0) {
      console.error("No Gnosys stores found. Run gnosys init first.");
      process.exit(1);
    }

    const writeTarget = resolver.getWriteTarget();
    if (!writeTarget) {
      console.error("No writable store found.");
      process.exit(1);
    }

    archive = new GnosysArchive(writeTarget.path);
    if (!archive.isAvailable()) {
      console.error("Archive not available. Install it with: npm install better-sqlite3");
      process.exit(1);
    }

    const results = archive.searchArchive(query, parseInt(opts.limit));
    if (results.length === 0) {
      console.log(`No archived memories found matching "${query}".`);
      return;
    }

    console.log(`Found ${results.length} archived memories matching "${query}":\n`);
    for (const r of results) {
      console.log(`  • ${r.title} (${r.id})`);
    }
    console.log("");

    const ids = results.map((r) => r.id);
    const restored = await archive.dearchiveBatch(ids, writeTarget.store);

    console.log(`Dearchived ${restored.length} memories back to active:`);
    for (const rp of restored) {
      console.log(`  → ${rp}`);
    }
  } finally {
    archive?.close();
  }
}

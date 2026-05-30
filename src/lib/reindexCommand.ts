import { GnosysSearch } from "./search.js";
import type { GnosysResolver } from "./resolver.js";
import type { GnosysEmbeddings } from "./embeddings.js";

type GetResolver = () => Promise<GnosysResolver>;

export async function runReindexCommand(
  getResolver: GetResolver,
): Promise<void> {
  let search: GnosysSearch | undefined;
  let embeddings: GnosysEmbeddings | undefined;

  try {
    const resolver = await getResolver();
    const stores = resolver.getStores();
    if (stores.length === 0) {
      console.error("No stores found. Run gnosys init first.");
      process.exitCode = 1;
      return;
    }

    const storePath = stores[0].path;
    search = new GnosysSearch(storePath);
    search.clearIndex();
    for (const s of stores) {
      await search.addStoreMemories(s.store, s.label);
    }

    const { GnosysEmbeddings } = await import("./embeddings.js");
    const { GnosysHybridSearch } = await import("./hybridSearch.js");
    embeddings = new GnosysEmbeddings(storePath);
    const hybridSearch = new GnosysHybridSearch(search, embeddings, resolver, storePath);

    console.log("Building semantic embeddings (downloading model on first run)...");
    const count = await hybridSearch.reindex((current, total, filePath) => {
      process.stdout.write(`\r  Indexing: ${current}/${total} — ${filePath.substring(0, 60)}`);
    });
    console.log(`\n\nReindex complete: ${count} memories embedded.`);
    console.log("Hybrid and semantic search are now available.");
  } finally {
    search?.close();
    embeddings?.close();
  }
}

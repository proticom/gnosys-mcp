import { GnosysSearch } from "./search.js";
import type { GnosysResolver } from "./resolver.js";

export type SemanticSearchCommandOptions = {
  limit: string;
  json?: boolean;
};

type GetResolver = () => Promise<GnosysResolver>;

function outputResult(json: boolean, data: unknown, humanFn: () => void): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    humanFn();
  }
}

export async function runSemanticSearchCommand(
  getResolver: GetResolver,
  query: string,
  opts: SemanticSearchCommandOptions,
): Promise<void> {
      const resolver = await getResolver();
      const stores = resolver.getStores();
      if (stores.length === 0) {
        console.error("No stores found.");
        process.exit(1);
      }
  
      const storePath = stores[0].path;
      const search = new GnosysSearch(storePath);
      search.clearIndex();
      for (const s of stores) {
        await search.addStoreMemories(s.store, s.label);
      }
  
      const { GnosysEmbeddings } = await import("./embeddings.js");
      const { GnosysHybridSearch } = await import("./hybridSearch.js");
      const embeddings = new GnosysEmbeddings(storePath);
      const hybridSearch = new GnosysHybridSearch(search, embeddings, resolver, storePath);
  
      const results = await hybridSearch.hybridSearch(query, parseInt(opts.limit), "semantic");
  
      outputResult(
        !!opts.json,
        {
          query,
          count: results.length,
          results: results.map((r) => ({
            title: r.title,
            relativePath: r.relativePath,
            score: r.score,
            snippet: r.snippet,
          })),
        },
        () => {
          if (results.length === 0) {
            console.log(`No semantic results for "${query}". Run gnosys reindex first.`);
            return;
          }
  
          console.log(`Found ${results.length} semantic results for "${query}":\n`);
          for (const r of results) {
            console.log(`  ${r.title}`);
            console.log(`    Path: ${r.relativePath}`);
            console.log(`    Similarity: ${r.score.toFixed(4)}`);
            console.log(`    ${r.snippet.substring(0, 120)}...\n`);
          }
        },
      );
      search.close();
      embeddings.close();
}

import type { GnosysResolver } from "./resolver.js";

type GetResolver = () => Promise<GnosysResolver>;

export async function runReindexGraphCommand(
  getResolver: GetResolver,
): Promise<void> {
  const { reindexGraph, formatGraphStats } = await import("./graph.js");

  const resolver = await getResolver();
  const stores = resolver.getStores();
  if (stores.length === 0) {
    console.error("No Gnosys stores found. Run gnosys init first.");
    process.exit(1);
  }

  const stats = await reindexGraph(resolver, (msg) => console.log(msg));
  console.log("");
  console.log(formatGraphStats(stats));
}

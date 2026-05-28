import { GnosysTagRegistry } from "./tags.js";
import type { GnosysResolver } from "./resolver.js";

type GetResolver = () => Promise<GnosysResolver>;

export async function runTagsCommand(getResolver: GetResolver): Promise<void> {
  const resolver = await getResolver();
  const writeTarget = resolver.getWriteTarget();
  if (!writeTarget) {
    console.error("No store found.");
    process.exit(1);
  }
  const tagRegistry = new GnosysTagRegistry(writeTarget.store.getStorePath());
  await tagRegistry.load();
  const registry = tagRegistry.getRegistry();

  for (const [category, tags] of Object.entries(registry)) {
    console.log(`\n${category}:`);
    console.log(`  ${tags.sort().join(", ")}`);
  }
}

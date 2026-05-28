import { GnosysTagRegistry } from "./tags.js";
import type { GnosysResolver } from "./resolver.js";

export type TagsAddCommandOptions = {
  category: string;
  tag: string;
};

type GetResolver = () => Promise<GnosysResolver>;

export async function runTagsAddCommand(
  getResolver: GetResolver,
  opts: TagsAddCommandOptions,
): Promise<void> {
  const resolver = await getResolver();
  const writeTarget = resolver.getWriteTarget();
  if (!writeTarget) {
    console.error("No store found.");
    process.exit(1);
  }
  const tagRegistry = new GnosysTagRegistry(writeTarget.store.getStorePath());
  await tagRegistry.load();
  const added = await tagRegistry.addTag(opts.category, opts.tag);
  if (added) {
    console.log(`Tag '${opts.tag}' added to category '${opts.category}'.`);
  } else {
    console.log(`Tag '${opts.tag}' already exists in '${opts.category}'.`);
  }
}

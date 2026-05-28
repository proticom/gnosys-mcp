import type { GnosysResolver } from "./resolver.js";

export async function runStoresCommand(
  getResolver: () => Promise<GnosysResolver>,
): Promise<void> {
  const resolver = await getResolver();
  console.log(resolver.getSummary());
}

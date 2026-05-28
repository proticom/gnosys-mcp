import type { GnosysResolver } from "./resolver.js";

export type StaleCommandOptions = {
  days: string;
  limit: string;
};

type GetResolver = () => Promise<GnosysResolver>;

export async function runStaleCommand(
  getResolver: GetResolver,
  opts: StaleCommandOptions,
): Promise<void> {
  const resolver = await getResolver();
  const threshold = parseInt(opts.days);
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - threshold);
  const cutoffStr = cutoff.toISOString().split("T")[0];

  const allMemories = await resolver.getAllMemories();
  const stale = allMemories
    .filter((m) => {
      const lastTouched =
        (m.frontmatter as { last_reviewed?: string }).last_reviewed ||
        m.frontmatter.modified;
      return lastTouched && lastTouched < cutoffStr;
    })
    .sort((a, b) => {
      const aDate =
        (a.frontmatter as { last_reviewed?: string }).last_reviewed ||
        a.frontmatter.modified;
      const bDate =
        (b.frontmatter as { last_reviewed?: string }).last_reviewed ||
        b.frontmatter.modified;
      return (aDate || "").localeCompare(bDate || "");
    })
    .slice(0, parseInt(opts.limit));

  if (stale.length === 0) {
    console.log(`No memories older than ${threshold} days.`);
    return;
  }

  console.log(`${stale.length} memories not touched in ${threshold}+ days:\n`);
  for (const m of stale) {
    const lr = (m.frontmatter as { last_reviewed?: string }).last_reviewed;
    console.log(`  ${m.frontmatter.title}`);
    console.log(`  ${m.sourceLabel}:${m.relativePath}`);
    console.log(`  Modified: ${m.frontmatter.modified}${lr ? `, Reviewed: ${lr}` : ""}`);
    console.log();
  }
}

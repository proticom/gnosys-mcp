import { applyLens, type LensFilter } from "./lensing.js";
import type { GnosysResolver } from "./resolver.js";

export type LensCommandOptions = {
  category?: string;
  tag?: string[];
  match: string;
  status?: string[];
  author?: string[];
  authority?: string[];
  minConfidence?: string;
  maxConfidence?: string;
  createdAfter?: string;
  createdBefore?: string;
  modifiedAfter?: string;
  modifiedBefore?: string;
  or?: boolean;
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

export async function runLensCommand(
  getResolver: GetResolver,
  opts: LensCommandOptions,
): Promise<void> {
  const resolver = await getResolver();
  const allMemories = await resolver.getAllMemories();

  const lens: LensFilter = {};
  if (opts.or) lens.operator = "OR";
  if (opts.category) lens.category = opts.category;
  if (opts.tag) {
    lens.tags = opts.tag;
    lens.tagMatchMode = opts.match as "any" | "all";
  }
  if (opts.status) lens.status = opts.status as LensFilter["status"];
  if (opts.author) lens.author = opts.author as LensFilter["author"];
  if (opts.authority) lens.authority = opts.authority as LensFilter["authority"];
  if (opts.minConfidence) lens.minConfidence = parseFloat(opts.minConfidence);
  if (opts.maxConfidence) lens.maxConfidence = parseFloat(opts.maxConfidence);
  if (opts.createdAfter) lens.createdAfter = opts.createdAfter;
  if (opts.createdBefore) lens.createdBefore = opts.createdBefore;
  if (opts.modifiedAfter) lens.modifiedAfter = opts.modifiedAfter;
  if (opts.modifiedBefore) lens.modifiedBefore = opts.modifiedBefore;

  const result = applyLens(allMemories, lens);
  const items = result.map((m) => ({
    title: m.frontmatter.title,
    status: m.frontmatter.status,
    confidence: m.frontmatter.confidence,
    sourceLabel: (m as { sourceLabel?: string }).sourceLabel || "",
    relativePath: m.relativePath,
  }));

  outputResult(!!opts.json, { count: items.length, items }, () => {
    if (result.length === 0) {
      console.log("No memories match the lens filter.");
      return;
    }

    console.log(`${result.length} memories match:\n`);
    for (const m of result) {
      const src = (m as { sourceLabel?: string }).sourceLabel || "";
      console.log(
        `  [${m.frontmatter.status}] ${m.frontmatter.title} (${m.frontmatter.confidence})`,
      );
      console.log(`    ${src ? src + ":" : ""}${m.relativePath}`);
      console.log();
    }
  });
}

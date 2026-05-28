import { getBacklinks, getOutgoingLinks } from "./wikilinks.js";
import type { GnosysResolver } from "./resolver.js";

export type LinksCommandOptions = {
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

export async function runLinksCommand(
  getResolver: GetResolver,
  memoryPath: string,
  opts: LinksCommandOptions,
): Promise<void> {
  const resolver = await getResolver();
  const memory = await resolver.readMemory(memoryPath);
  if (!memory) {
    console.error(`Memory not found: ${memoryPath}`);
    process.exit(1);
  }

  const allMemories = await resolver.getAllMemories();
  const outgoing = getOutgoingLinks(allMemories, memory.relativePath);
  const backlinks = getBacklinks(allMemories, memory.relativePath);

  outputResult(!!opts.json, {
    memoryPath,
    title: memory.frontmatter.title,
    outgoing,
    backlinks,
  }, () => {
      console.log(`Links for ${memory.frontmatter.title}:\n`);

      if (outgoing.length > 0) {
        console.log(`  Outgoing (${outgoing.length}):`);
        for (const link of outgoing) {
          const display = link.displayText ? ` (${link.displayText})` : "";
          console.log(`    → [[${link.target}]]${display}`);
        }
      } else {
        console.log("  No outgoing links.");
      }

      console.log();

      if (backlinks.length > 0) {
        console.log(`  Backlinks (${backlinks.length}):`);
        for (const link of backlinks) {
          console.log(`    ← ${link.sourceTitle} (${link.sourcePath})`);
        }
      } else {
      console.log("  No backlinks.");
    }
  });
}

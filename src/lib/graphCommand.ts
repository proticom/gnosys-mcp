import { buildLinkGraph, formatGraphSummary } from "./wikilinks.js";
import { GnosysDB } from "./db.js";

export type GraphCommandOptions = {
  json?: boolean;
};

function outputResult(json: boolean, data: unknown, humanFn: () => void): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    humanFn();
  }
}

export async function runGraphCommand(opts: GraphCommandOptions): Promise<void> {
  let centralDb: GnosysDB | null = null;
  try {
    centralDb = GnosysDB.openCentral();
    if (!centralDb.isAvailable()) {
      console.error("Central DB not available.");
      process.exit(1);
    }

    const dbMemories = centralDb.getAllMemories();
    if (dbMemories.length === 0) {
      outputResult(!!opts.json, { totalLinks: 0, orphanedLinks: [], nodes: [] }, () => {
        console.log("No memories found.");
      });
      return;
    }

    const adapted = dbMemories.map((m) => {
      let parsedTags: Record<string, string[]> | string[] = [];
      try {
        parsedTags = JSON.parse(m.tags);
      } catch {
        parsedTags = [];
      }
      const relativePath = `${m.category}/${m.id}.md`;
      return {
        frontmatter: {
          id: m.id,
          title: m.title,
          category: m.category,
          tags: parsedTags,
          relevance: m.relevance,
          author: m.author as "human" | "ai" | "human+ai",
          authority: m.authority as "declared" | "observed" | "imported" | "inferred",
          confidence: m.confidence,
          created: m.created,
          modified: m.modified,
          last_reviewed: m.modified,
          status: m.status as "active" | "archived" | "superseded",
          supersedes: m.supersedes,
        },
        content: m.content,
        filePath: relativePath,
        relativePath,
      };
    });

    const graph = buildLinkGraph(adapted);
    outputResult(!!opts.json, {
      totalLinks: graph.totalLinks,
      orphanedLinks: graph.orphanedLinks,
      nodes: Array.from(graph.nodes.values()),
    }, () => {
      console.log(formatGraphSummary(graph));
    });
  } finally {
    centralDb?.close();
  }
}

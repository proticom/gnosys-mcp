import type { GnosysResolver } from "./resolver.js";
import { GnosysTagRegistry } from "./tags.js";
import { GnosysSearch } from "./search.js";
import { loadConfig } from "./config.js";
import { getLLMProvider, type LLMProvider } from "./llm.js";
import { GnosysDB } from "./db.js";

export type CommitContextOptions = {
  dryRun?: boolean;
  store?: string;
};

type GetResolver = () => Promise<GnosysResolver>;
type ResolveProjectId = (dir?: string) => Promise<string | null>;

export async function runCommitContextCommand(
  getResolver: GetResolver,
  resolveProjectId: ResolveProjectId,
  context: string,
  opts: CommitContextOptions,
): Promise<void> {
      const resolver = await getResolver();
      const writeTarget = resolver.getWriteTarget(
        (opts.store as any) || undefined
      );
      if (!writeTarget) {
        console.error("No writable store found.");
        process.exit(1);
      }
  
      const tagRegistry = new GnosysTagRegistry(writeTarget.store.getStorePath());
      await tagRegistry.load();
      const { GnosysIngestion } = await import("./ingest.js");
      const ingestion = new GnosysIngestion(writeTarget.store, tagRegistry);
  
      if (!ingestion.isLLMAvailable) {
        console.error("Error: No LLM provider available. Add an API key to ~/.config/gnosys/.env or use a local model: gnosys config set provider ollama");
        process.exit(1);
      }
  
      // Build search index
      const stores = resolver.getStores();
      const search = new GnosysSearch(stores[0].path);
      search.clearIndex();
      for (const s of stores) {
        await search.addStoreMemories(s.store, s.label);
      }
  
      // Step 1: Extract candidates via LLM abstraction
      console.log("Extracting knowledge candidates from context...");
  
      // Load config for the write target store
      const ccConfig = await loadConfig(writeTarget.store.getStorePath());
      let extractProvider: LLMProvider;
      try {
        extractProvider = getLLMProvider(ccConfig, "structuring");
      } catch (err) {
        console.error(`LLM not available: ${err instanceof Error ? err.message : String(err)}`);
        search.close();
        process.exit(1);
      }
  
      const extractText = await extractProvider.generate(
        `Extract atomic knowledge items from this context:\n\n${context}`,
        {
          system: `You extract atomic knowledge items from conversations. Each item should be ONE decision, fact, insight, or observation — not compound.
  
  Output a JSON array of objects, each with:
  - summary: One-sentence description of the knowledge
  - type: "decision" | "insight" | "fact" | "observation" | "requirement"
  - search_terms: 3-5 keywords someone would search for to find if this already exists
  
  Be selective. Only extract things worth remembering long-term. Skip small talk, debugging steps, and transient details. Focus on decisions made, architecture choices, requirements established, and insights gained.
  
  Output ONLY the JSON array, no markdown fences.`,
          maxTokens: 4000,
        }
      );
  
      let candidates: Array<{ summary: string; type: string; search_terms: string[] }>;
      try {
        const jsonMatch =
          extractText.match(/```json\s*([\s\S]*?)```/) ||
          extractText.match(/```\s*([\s\S]*?)```/) || [null, extractText];
        candidates = JSON.parse(jsonMatch[1] || extractText);
      } catch {
        console.error("Failed to extract candidates — LLM output was not valid JSON.");
        search.close();
        process.exit(1);
      }
  
      if (!Array.isArray(candidates) || candidates.length === 0) {
        console.log("No extractable knowledge found in the provided context.");
        search.close();
        return;
      }
  
      console.log(`Found ${candidates.length} candidates. Checking novelty...\n`);
  
      // Step 2: Check novelty and commit
      let added = 0;
      let skipped = 0;
  
      let centralDb: GnosysDB | null = null;
      try {
        centralDb = GnosysDB.openCentral();
        const projectId = await resolveProjectId();
  
        for (const candidate of candidates) {
          const searchTerms = candidate.search_terms.join(" ");
          const existing = search.discover(searchTerms, 3);
  
          if (existing.length > 0) {
            console.log(`  ⏭ SKIP: "${candidate.summary}"`);
            console.log(`    Overlaps with: ${existing[0].title}`);
            skipped++;
          } else if (opts.dryRun) {
            console.log(`  ➕ WOULD ADD: "${candidate.summary}" [${candidate.type}]`);
            added++;
          } else {
            try {
              const result = await ingestion.ingest(candidate.summary);
              const id = centralDb.getNextId(result.category, projectId || undefined);
              const now = new Date().toISOString();
              const content = `# ${result.title}\n\n${result.content}`;
  
              const resultTags = result.tags;
              const tagsJson = Array.isArray(resultTags)
                ? JSON.stringify(resultTags)
                : JSON.stringify(Object.values(resultTags).flat());
  
              centralDb.insertMemory({
                id,
                title: result.title,
                category: result.category,
                content,
                summary: null,
                tags: tagsJson,
                relevance: result.relevance,
                author: "ai",
                authority: "observed",
                confidence: result.confidence,
                reinforcement_count: 0,
                content_hash: "",
                status: "active",
                tier: "active",
                supersedes: null,
                superseded_by: null,
                last_reinforced: null,
                created: now,
                modified: now,
                embedding: null,
                source_path: null,
                project_id: projectId,
                scope: "project",
              });
  
              console.log(`  ➕ ADDED: "${result.title}"`);
              console.log(`    ID: ${id}`);
              added++;
            } catch (err) {
              console.error(`  ❌ FAILED: "${candidate.summary}": ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          console.log();
        }
      } finally {
        centralDb?.close();
      }
  
      search.close();
  
      const mode = opts.dryRun ? "DRY RUN" : "COMMITTED";
      console.log(`\n${mode}: ${candidates.length} candidates, ${added} ${opts.dryRun ? "would be added" : "added"}, ${skipped} duplicates skipped.`);
}

import { loadConfig, DEFAULT_CONFIG, type GnosysConfig } from "./config.js";
import { GnosysSearch } from "./search.js";
import { GnosysDB } from "./db.js";
import { getSecureStorageSetupHint } from "./platform.js";
import type { GnosysResolver } from "./resolver.js";

export type AskCommandOptions = {
  limit: string;
  mode: string;
  stream: boolean;
  federated?: boolean;
  scope?: string;
  directory?: string;
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

export async function runAskCommand(
  getResolver: GetResolver,
  question: string,
  opts: AskCommandOptions,
): Promise<void> {
      const resolver = await getResolver();
      const stores = resolver.getStores();
      if (stores.length === 0) {
        console.error("No stores found. Run gnosys init first.");
        process.exit(1);
      }
  
      const storePath = stores[0].path;
      let cliConfig: GnosysConfig;
      try {
        cliConfig = await loadConfig(storePath);
      } catch {
        cliConfig = DEFAULT_CONFIG;
      }
  
      const search = new GnosysSearch(storePath);
      search.clearIndex();
      for (const s of stores) {
        await search.addStoreMemories(s.store, s.label);
      }
  
      const { GnosysEmbeddings } = await import("./embeddings.js");
      const { GnosysHybridSearch } = await import("./hybridSearch.js");
      const { GnosysAsk } = await import("./ask.js");
      const embeddings = new GnosysEmbeddings(storePath);
      const hybridSearch = new GnosysHybridSearch(search, embeddings, resolver, storePath);
      const ask = new GnosysAsk(hybridSearch, cliConfig, resolver, storePath);
  
      if (!ask.isLLMAvailable) {
        // v5.8.0 (#8): provider-aware error instead of hardcoded ANTHROPIC_API_KEY.
        const providerName = cliConfig.llm.defaultProvider;
        const envVarMap: Record<string, string> = {
          anthropic: "ANTHROPIC_API_KEY",
          openai: "OPENAI_API_KEY",
          groq: "GROQ_API_KEY",
          xai: "XAI_API_KEY",
          mistral: "MISTRAL_API_KEY",
        };
        const envVar = envVarMap[providerName];
        if (envVar) {
          console.error(
            `No LLM provider available. Configured default is "${providerName}" but its key wasn't found. ` +
              `Set ${envVar}, run 'gnosys setup' to store one in ${getSecureStorageSetupHint()}, or add llm.${providerName}.apiKey to gnosys.json.`,
          );
        } else {
          console.error(
            `No LLM provider available. Provider "${providerName}" is not reachable. Run 'gnosys setup' to configure one.`,
          );
        }
        process.exit(1);
      }
  
      // If --federated, pre-retrieve from central DB and inject as context
      let federatedContext: string | undefined;
      if (opts.federated || opts.scope) {
        let centralDb: GnosysDB | null = null;
        try {
          centralDb = GnosysDB.openCentral();
          if (centralDb?.isAvailable()) {
            const { federatedSearch: fSearch, detectCurrentProject } = await import("./federated.js");
            const projectId = await detectCurrentProject(centralDb, opts.directory || undefined);
            const scopeFilter = opts.scope ? opts.scope.split(",").map(s => s.trim()) as any : undefined;
            const fResults = fSearch(centralDb, question, {
              limit: parseInt(opts.limit, 10),
              projectId,
              scopeFilter,
            });
            if (fResults.length > 0) {
              federatedContext = fResults.map(r => {
                const mem = centralDb!.getMemory(r.id);
                return `## ${r.title} [scope:${r.scope}, score:${r.score.toFixed(3)}]\n${mem?.content || r.snippet}`;
              }).join("\n\n");
              console.error(`[federated] Found ${fResults.length} cross-scope memories as additional context`);
            }
          }
        } catch { /* Central DB not available — fall through to normal ask */ }
        finally { centralDb?.close(); }
      }
  
      const mode = opts.mode as "keyword" | "semantic" | "hybrid";
      const useStream = opts.stream !== false && !opts.json;
  
      try {
        const result = await ask.ask(question, {
          limit: parseInt(opts.limit),
          mode,
          stream: useStream,
          additionalContext: federatedContext,
          callbacks: useStream
            ? {
                onToken: (token) => process.stdout.write(token),
                onSearchComplete: (count, searchMode) => {
                  console.log(`\n Found ${count} relevant memories (${searchMode} search)\n`);
                },
                onDeepQuery: (refined) => {
                  console.log(`\n Deep query: searching for "${refined}"...\n`);
                },
              }
            : undefined,
        });
  
        outputResult(
          !!opts.json,
          {
            question,
            answer: result.answer,
            sources: result.sources.map((s) => ({
              title: s.title,
              relativePath: s.relativePath,
            })),
            deepQueryUsed: result.deepQueryUsed ?? false,
          },
          () => {
            if (!useStream) {
              console.log(result.answer);
            }
  
            if (result.sources.length > 0) {
              console.log("\n\n--- Sources ---");
              for (const s of result.sources) {
                console.log(`  [[${s.relativePath.split("/").pop()}]] — ${s.title}`);
              }
            }
  
            if (result.deepQueryUsed) {
              console.log("\n(Deep query was used — a follow-up search expanded the context)");
            }
          },
        );
  
        if (result.sources.length > 0) {
          const writeTarget = resolver.getWriteTarget();
          if (writeTarget) {
            const { GnosysMaintenanceEngine } = await import("./maintenance.js");
            await GnosysMaintenanceEngine.reinforceBatch(
              writeTarget.store,
              result.sources.map((s) => s.relativePath)
            ).catch(() => {});
          }
        }
      } catch (err) {
        console.error(`Ask failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
  
      search.close();
      embeddings.close();
}

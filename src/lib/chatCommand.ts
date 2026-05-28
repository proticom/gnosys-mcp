import {
  DEFAULT_CONFIG,
  loadConfig,
  resolveTaskModel,
  type GnosysConfig,
} from "./config.js";
import type { GnosysResolver } from "./resolver.js";

export type ChatCommandOptions = {
  resume?: string;
  list?: boolean;
  search?: string;
  provider?: string;
  model?: string;
  limit: string;
};

type GetResolver = () => Promise<GnosysResolver>;

export async function runChatCommand(
  getResolver: GetResolver,
  opts: ChatCommandOptions,
): Promise<void> {
  const limit = parseInt(opts.limit, 10) || 20;
  const chat = await import("./chat/index.js");

  if (opts.list) {
    chat.printSessionList(limit);
    return;
  }
  if (opts.search) {
    chat.printSearchResults(opts.search, limit);
    return;
  }

  const resolver = await getResolver();
  const stores = resolver.getStores();
  const storePath = stores[0]?.path ?? process.cwd();
  let cliConfig: GnosysConfig;
  try {
    cliConfig = await loadConfig(storePath);
  } catch {
    cliConfig = DEFAULT_CONFIG;
  }

  // Fail-fast on missing API key before TUI render.
  {
    const chatTask = resolveTaskModel(cliConfig, "chat");
    const provider = opts.provider ?? chatTask.provider;
    if (provider !== "ollama" && provider !== "lmstudio") {
      const { getApiKeyForProvider } = await import("./setup.js");
      const key = await getApiKeyForProvider(provider);
      if (!key) {
        const { Status } = await import("./setup/ui/status.js");
        const envVar = `${provider.toUpperCase()}_API_KEY`;
        process.stderr.write(
          `${Status("fail", `no API key for ${provider} (the configured chat provider)`)}\n`,
        );
        process.stderr.write(
          `   fix:  gnosys setup           pick a provider with a key, or add one\n`,
        );
        process.stderr.write(`         export ${envVar}=...\n`);
        process.exit(1);
      }
    }
  }

  await chat.startChat({
    config: cliConfig,
    resume: opts.resume,
    providerName: opts.provider,
    modelName: opts.model,
  });
}

export type WebInitCommandOptions = {
  source: string;
  output: string;
  config: boolean;
  nonInteractive?: boolean;
  json?: boolean;
};

export type GetWebStorePath = () => Promise<string>;

export async function runWebInitCommand(
  getWebStorePath: GetWebStorePath,
  opts: WebInitCommandOptions,
): Promise<void> {
  try {
    const { mkdirSync } = await import("fs");
    const { loadConfig, updateConfig, resolveTaskModel } = await import("./config.js");
    const { createInterface } = await import("readline/promises");
    const storePath = await getWebStorePath();

    const DIM = "\x1b[2m";
    const BOLD = "\x1b[1m";
    const CYAN = "\x1b[36m";
    const GREEN = "\x1b[32m";
    const RESET = "\x1b[0m";
    const CHECK = `${GREEN}\u2713${RESET}`;

    let sitemapUrl = "";
    let outputDir = opts.output;
    let llmEnrich = true;
    let envVarName = "ANTHROPIC_API_KEY";

    // Detect current agent config for provider info
    let agentProvider = "anthropic";
    let agentModel = "";
    try {
      const cfg = await loadConfig(storePath);
      agentProvider = cfg.llm.defaultProvider;
      const taskModel = resolveTaskModel(cfg, "structuring");
      agentModel = taskModel.model;
    } catch { /* no config yet */ }

    // Map provider to env var name
    const providerEnvVars: Record<string, string> = {
      anthropic: "ANTHROPIC_API_KEY",
      openai: "OPENAI_API_KEY",
      groq: "GROQ_API_KEY",
      xai: "XAI_API_KEY",
      mistral: "MISTRAL_API_KEY",
      ollama: "",
      lmstudio: "",
      custom: "GNOSYS_LLM_API_KEY",
    };

    if (!opts.nonInteractive && !opts.json && process.stdout.isTTY) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });

      try {
        console.log();
        console.log(`${BOLD}Web Knowledge Base Setup${RESET}`);
        console.log();
        console.log(`${DIM}This sets up a /knowledge/ directory in your project.`);
        console.log(`Gnosys crawls your site, converts pages to markdown, and`);
        console.log(`builds a search index. Everything deploys with your app.`);
        console.log();
        console.log(`No API keys are stored in your project. The LLM key is`);
        console.log(`read from an environment variable at build time.${RESET}`);
        console.log();

        // Step 1: Sitemap URL
        console.log(`${BOLD}Step 1/3${RESET} ${DIM}\u2014${RESET} Content source`);
        console.log();
        console.log(`${DIM}  \u2022 Deployed site:  https://yoursite.com/sitemap.xml`);
        console.log(`  \u2022 Local dev:      http://localhost:3000/sitemap.xml`);
        console.log(`  \u2022 Not ready yet:  press Enter (add later in gnosys.json)${RESET}`);
        console.log();
        const urlAnswer = await rl.question("Sitemap URL: ");
        sitemapUrl = urlAnswer.trim();
        console.log();

        // Step 2: LLM enrichment
        console.log(`${BOLD}Step 2/3${RESET} ${DIM}\u2014${RESET} LLM enrichment`);
        console.log();
        console.log(`${DIM}LLM enrichment generates better tags, keyword clouds, and`);
        console.log(`frontmatter for each page. Without it, Gnosys uses TF-IDF`);
        console.log(`keyword extraction (free, no API key needed, decent quality).${RESET}`);
        console.log();

        if (agentModel && providerEnvVars[agentProvider]) {
          console.log(`${DIM}Your agent setup uses ${agentProvider}/${agentModel} for structuring.${RESET}`);
        }
        console.log();

        const enrichAnswer = await rl.question("Enable LLM enrichment? [Y/n] ");
        llmEnrich = !enrichAnswer.trim().toLowerCase().startsWith("n");
        console.log();

        // Step 3: CI/CD env var
        if (llmEnrich) {
          console.log(`${BOLD}Step 3/3${RESET} ${DIM}\u2014${RESET} CI/CD environment variable`);
          console.log();
          console.log(`${DIM}In CI/CD (GitHub Actions, Vercel, Netlify), the LLM API key`);
          console.log(`is read from an environment variable. No keys are stored in`);
          console.log(`your project or committed to git.${RESET}`);
          console.log();

          const defaultEnv = providerEnvVars[agentProvider] || "ANTHROPIC_API_KEY";
          const envAnswer = await rl.question(`Env var name for API key (${defaultEnv}): `);
          envVarName = envAnswer.trim() || defaultEnv;
        } else {
          console.log(`${DIM}Step 3/3 \u2014 Skipped (no LLM = no API key needed)${RESET}`);
          envVarName = "";
        }
        console.log();

        // Output dir
        const dirAnswer = await rl.question(`Output directory (${opts.output}): `);
        outputDir = dirAnswer.trim() || opts.output;

        rl.close();
      } catch {
        rl.close();
      }
    }

    // Create output directory
    mkdirSync(outputDir, { recursive: true });

    // Update gnosys.json with web config
    if (opts.config) {
      try {
        const config = await loadConfig(storePath);
        if (!config.web) {
          await updateConfig(storePath, {
            web: {
              source: opts.source as "sitemap" | "directory" | "urls",
              ...(sitemapUrl ? { sitemapUrl } : {}),
              outputDir,
              exclude: ["/api", "/admin", "/_next"],
              categories: {
                "/blog/*": "blog",
                "/services/*": "services",
                "/products/*": "products",
                "/about*": "company",
              },
              llmEnrich,
              prune: false,
            },
          });
        }
      } catch {
        // No gnosys.json yet — run gnosys init first
      }
    }

    if (opts.json) {
      console.log(JSON.stringify({ ok: true, outputDir, source: opts.source, sitemapUrl: sitemapUrl || null, llmEnrich, envVarName: envVarName || null }));
    } else {
      console.log(`${CHECK} Created ${outputDir}/`);
      console.log(`${CHECK} Updated gnosys.json with web config`);
      if (sitemapUrl) {
        console.log(`${CHECK} Sitemap: ${sitemapUrl}`);
      }
      console.log(`${CHECK} LLM enrichment: ${llmEnrich ? "enabled" : "disabled (TF-IDF mode)"}`);
      if (envVarName) {
        console.log(`${CHECK} CI/CD env var: ${envVarName}`);
      }
      console.log();
      console.log(`${BOLD}Next steps:${RESET}`);
      if (!sitemapUrl) {
        console.log(`  1. Add your sitemap URL to gnosys.json → web.sitemapUrl`);
      }
      if (envVarName) {
        console.log(`  ${sitemapUrl ? "1" : "2"}. Set ${CYAN}${envVarName}${RESET} in your hosting provider (Vercel, Netlify, GitHub Actions)`);
        console.log(`     ${DIM}Never commit API keys to your repo${RESET}`);
      }
      console.log(`  ${!sitemapUrl && envVarName ? "3" : envVarName || !sitemapUrl ? "2" : "1"}. Run: ${CYAN}gnosys web build${RESET}`);
      console.log(`  ${!sitemapUrl && envVarName ? "4" : envVarName || !sitemapUrl ? "3" : "2"}. Add to package.json: ${CYAN}"postbuild": "npx gnosys web build"${RESET}`);
      console.log();
      console.log(`${DIM}Every deploy will re-crawl and rebuild the search index automatically.${RESET}`);
    }
  } catch (err) {
    if (opts.json) {
      console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    } else {
      console.error(`Web init failed: ${err instanceof Error ? err.message : err}`);
    }
    process.exit(1);
  }
}

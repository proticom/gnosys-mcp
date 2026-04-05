import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "json-summary", "html"],
      reportsDirectory: "coverage",
      include: ["src/lib/**/*.ts", "src/sandbox/**/*.ts"],
      exclude: [
        "src/test/**",
        "src/**/*.test.ts",
        "dist/**",
        "node_modules/**",

        // ── Exclude modules that require external services / interactive I/O ──
        // These can't be meaningfully unit tested — they call LLM APIs, spawn
        // processes, require user input, or process binary media files.

        // LLM provider calls (Anthropic, Ollama, Groq, OpenAI, LM Studio)
        "src/lib/llm.ts",
        "src/lib/retry.ts",

        // Interactive setup wizard (1700 lines of prompts + I/O)
        "src/lib/setup.ts",

        // Media processing (requires binary files, external tools like Tesseract)
        "src/lib/multimodalIngest.ts",
        "src/lib/pdfExtract.ts",
        "src/lib/videoExtract.ts",

        // Dream mode engine (requires LLM + idle scheduler)
        "src/lib/maintenance.ts",
        "src/lib/dream.ts",

        // Recall context injection (depends on LLM for summarization)
        "src/lib/recall.ts",

        // Sandbox process management (spawns background processes)
        "src/sandbox/manager.ts",
        "src/sandbox/index.ts",

        // Large entry points tested via CLI integration, not unit tests
        "src/cli.ts",
        "src/index.ts",
      ],
      thresholds: {
        statements: 50,
        branches: 40,
        functions: 55,
        lines: 50,
      },
    },
  },
});

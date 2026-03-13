import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["dist/**", "node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "text-summary", "json-summary", "html"],
      reportsDirectory: "coverage",
      include: ["src/lib/**/*.ts", "src/sandbox/**/*.ts", "src/cli.ts", "src/index.ts"],
      exclude: [
        "src/test/**",
        "src/**/*.test.ts",
        "dist/**",
        "node_modules/**",
      ],
      thresholds: {
        // Global thresholds include cli.ts + index.ts (large entry points
        // tested via integration/CLI exec, not unit tests), so these are
        // set conservatively. The lib/ layer alone is at ~40% statements.
        statements: 20,
        branches: 18,
        functions: 30,
        lines: 20,
      },
    },
  },
});

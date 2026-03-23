# Gnosys Test Case Standard

Version: March 11, 2026

## Principles

1. **Isolation**: Every test creates its own temp directory and DB instance. No shared state.
2. **Cleanup**: `afterEach` always removes temp dirs. DB connections always closed.
3. **Determinism**: No reliance on LLM calls, network, or timing. Mock where needed.
4. **Human-Friendly Output**: Each test has a clear `describe` > `it` hierarchy matching the test plan.
5. **Factory Helpers**: Use shared `makeMemory()` / `makeFrontmatter()` from `_helpers.ts`.

## File Naming Convention

```
src/test/
  _helpers.ts                    # Shared factories, utilities, constants
  phase0-6.regression.test.ts    # Phase 0–6 regression suite
  phase7a.migration.test.ts      # Phase 7a: GnosysDB + migration
  phase7b.read-paths.test.ts     # Phase 7b: Read paths rewired
  phase7c.dual-write.test.ts     # Phase 7c: Dual-write
  phase7d.dream.test.ts          # Phase 7d: Dream Mode
  phase7e.export.test.ts         # Phase 7e: Obsidian export bridge
  phase8a.central-db.test.ts     # Phase 8a: Central DB + project identity
  phase8b.preferences.test.ts    # Phase 8b: Preferences + rules generation
  phase8c.cli-parity.test.ts     # Phase 8c: CLI parity
  phase8d.federated.test.ts      # Phase 8d: Federated search + ambiguity
  acceptance.test.ts             # Final end-to-end acceptance suite
```

## Test Structure Template

```typescript
/**
 * Phase X: <Phase Name>
 * Test Plan Reference: <section in test plan>
 *
 * Tests: <brief list of what's tested>
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestEnv, cleanupTestEnv, TestEnv } from "./_helpers.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv("phase-x");
});

afterEach(async () => {
  await cleanupTestEnv(env);
});

describe("Phase X: <Name>", () => {
  describe("TC-X.1: <Test Case Name>", () => {
    it("<specific assertion>", async () => {
      // Arrange
      // Act
      // Assert
    });
  });
});
```

## Assertion Style

- Use `expect(x).toBe(y)` for primitives
- Use `expect(x).toEqual(y)` for objects/arrays
- Use `expect(x).toContain(y)` for string/array membership
- Use `expect(x).toBeGreaterThan(y)` for numeric comparisons
- Use `expect(() => fn()).toThrow()` for error cases

## CLI Testing Pattern

```typescript
import { execSync } from "child_process";
const CLI = `node ${path.resolve("dist/cli.js")}`;

// Run with project context
const output = execSync(`${CLI} <command>`, {
  encoding: "utf-8",
  env: { ...process.env, GNOSYS_PROJECT: tmpDir },
});

// Parse JSON output
const json = JSON.parse(
  execSync(`${CLI} <command> --json`, {
    encoding: "utf-8",
    env: { ...process.env, GNOSYS_PROJECT: tmpDir },
  })
);
```

## Test IDs

Each test case has a stable ID matching the test plan:
- `TC-R.1` through `TC-R.7` = Phase 0–6 Regression
- `TC-7a.1` through `TC-7a.4` = Phase 7a
- `TC-8d.1` through `TC-8d.4` = Phase 8d
- `TC-A.1` through `TC-A.9` = Final Acceptance

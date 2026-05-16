#!/usr/bin/env node
/**
 * Coverage guardrail for newly-added source files.
 *
 * v5.8.3 (#92).
 *
 * Reads `coverage/coverage-summary.json` and the list of changed files
 * against the base ref (default `origin/master`). Fails when a file that
 * was *added* in this branch lives under `src/lib/` or `src/sandbox/`
 * and has 0% statement coverage.
 *
 * Catches the failure mode that landed v5.8.0 in CI hell:
 * a new module shipped without any test file, dragging the global
 * coverage average just under the threshold. By the time CI catches it
 * we've already published. This step trips earlier (PR / commit) and
 * with a more actionable message.
 *
 * Existing 0%-coverage files are tolerated — they're outside this
 * patch's blast radius. Only NEW ones fail.
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const BASE_REF = process.env.COVERAGE_BASE_REF || "origin/master";
const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const SUMMARY_PATH = path.join(REPO_ROOT, "coverage", "coverage-summary.json");

function loadCoverageSummary() {
  if (!fs.existsSync(SUMMARY_PATH)) {
    console.error(`! coverage summary missing at ${SUMMARY_PATH}`);
    console.error(`  Run \`npm run test:coverage\` before invoking this script.`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(SUMMARY_PATH, "utf8"));
}

function diffAddedFiles() {
  try {
    // `--diff-filter=A` returns only ADDED paths.
    const out = execSync(`git diff --name-only --diff-filter=A ${BASE_REF}...HEAD`, {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    return out.split("\n").filter(Boolean);
  } catch (err) {
    console.error(`! could not run \`git diff\` against ${BASE_REF}.`);
    console.error(`  ${err instanceof Error ? err.message : err}`);
    console.error(`  Set COVERAGE_BASE_REF if the default isn't right.`);
    // Don't fail the build for a diff failure — the global threshold
    // already gates against catastrophic regressions; this script is an
    // additional, targeted check that's worth skipping if env is wrong.
    process.exit(0);
  }
}

function isCovered(filePath, summary) {
  // coverage-summary.json keys are absolute paths.
  const absPath = path.resolve(REPO_ROOT, filePath);
  const entry = summary[absPath];
  if (!entry) return null; // not in the coverage include set
  return entry.statements?.pct ?? 0;
}

function main() {
  const added = diffAddedFiles();
  const lib = added.filter((f) => /^src\/(lib|sandbox)\/.+\.(ts|tsx)$/.test(f) && !f.endsWith(".test.ts"));

  if (lib.length === 0) {
    console.log("✓ No new src/lib or src/sandbox files in this diff.");
    return;
  }

  const summary = loadCoverageSummary();
  const offenders = [];
  const okFiles = [];

  for (const f of lib) {
    const pct = isCovered(f, summary);
    if (pct === null) {
      // File is excluded from coverage by vitest.config.ts — that's a
      // deliberate choice (e.g., LLM provider code, setup wizard, sandbox).
      // Not a regression.
      console.log(`· ${f} — excluded from coverage by config (skipping)`);
      continue;
    }
    if (pct === 0) {
      offenders.push(f);
    } else {
      okFiles.push({ f, pct });
    }
  }

  if (okFiles.length > 0) {
    console.log("✓ New files with coverage:");
    for (const { f, pct } of okFiles) {
      console.log(`  ${f} — ${pct.toFixed(1)}%`);
    }
  }

  if (offenders.length > 0) {
    console.error("");
    console.error("✗ New file(s) shipped with 0% statement coverage:");
    for (const f of offenders) console.error(`    ${f}`);
    console.error("");
    console.error("Each new module under src/lib/ or src/sandbox/ should ship");
    console.error("with at least one test file exercising its public surface.");
    console.error("If a file genuinely can't be unit-tested (LLM calls, interactive");
    console.error("wizard, native binding init), add it to the `exclude` list in");
    console.error("vitest.config.ts with a comment explaining why.");
    process.exit(1);
  }

  console.log("");
  console.log("✓ All new source files have non-zero coverage.");
}

main();

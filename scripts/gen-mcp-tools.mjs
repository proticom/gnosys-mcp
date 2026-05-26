#!/usr/bin/env node
/**
 * Generate docs/mcp-tools.md from MCP tool registrations in src/index.ts.
 * Read-only; no extra dependencies.
 */

import fs from "fs";
import path from "path";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const INDEX = path.join(REPO_ROOT, "src", "index.ts");
const OUT = path.join(REPO_ROOT, "docs", "mcp-tools.md");

/** regTool("gnosys_*", "description", { schema }) — first arg only, not audit refs. */
const REG_TOOL_RE =
  /regTool\(\s*\n\s*"(gnosys_[^"]+)"\s*,\s*\n\s*"((?:[^"\\]|\\.)*)"/g;

function collapseWhitespace(s) {
  return s.replace(/\s+/g, " ").trim();
}

function extractTools(source) {
  const tools = [];
  let match;
  while ((match = REG_TOOL_RE.exec(source)) !== null) {
    tools.push({ name: match[1], description: collapseWhitespace(match[2]) });
  }
  return tools;
}

function renderMarkdown(tools) {
  const rows = tools
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => `| \`${t.name}\` | ${t.description.replace(/\|/g, "\\|")} |`)
    .join("\n");

  return `# MCP Tools

_Generated from \`src/index.ts\` by \`scripts/gen-mcp-tools.mjs\`. Do not edit by hand._

| Tool | Description |
|------|-------------|
${rows}
`;
}

function main() {
  const source = fs.readFileSync(INDEX, "utf8");
  const tools = extractTools(source);
  if (tools.length === 0) {
    console.error("No MCP tools found in src/index.ts");
    process.exit(1);
  }

  const markdown = renderMarkdown(tools);
  const write = process.argv.includes("--write");

  if (write) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, markdown);
  } else {
    process.stdout.write(markdown);
  }
}

main();

#!/usr/bin/env node
/**
 * Generate docs/cli.md from Commander registrations in src/cli.ts.
 * Read-only; no extra dependencies.
 */

import fs from "fs";
import path from "path";

const REPO_ROOT = path.resolve(new URL(".", import.meta.url).pathname, "..");
const CLI = path.join(REPO_ROOT, "src", "cli.ts");
const OUT = path.join(REPO_ROOT, "docs", "cli.md");

function collapseWhitespace(s) {
  return s.replace(/\s+/g, " ").trim();
}

function fullPath(receiver, bindings) {
  if (receiver === "program") return [];
  const b = bindings[receiver];
  if (!b) return [receiver];
  return [...fullPath(b.receiver, bindings), b.name];
}

function extractDescription(window) {
  const match = window.match(
    /\.\s*description\(\s*[\s\n]*["'`]((?:[^"'\\]|\\.)*)["'`]/,
  );
  return match ? collapseWhitespace(match[1]) : "";
}

function extractCommands(source) {
  const bindings = {};
  const bindRe =
    /const\s+(\w+)\s*=\s*(\w+)\s*\.\s*command\(\s*["']([^"'\s]+)/g;
  for (let m; (m = bindRe.exec(source)); ) {
    bindings[m[1]] = { name: m[3], receiver: m[2] };
  }

  const commands = [];
  const cmdRe = /(\w+)\s*\.\s*command\(\s*["']([^"']+?)["']/g;
  for (let m; (m = cmdRe.exec(source)); ) {
    const receiver = m[1];
    const spec = m[2];
    const leaf = spec.split(/\s+/)[0];
    const full = [...fullPath(receiver, bindings), leaf].join(" ");
    const rest = source.slice(m.index + m[0].length);
    const nextCmd = rest.search(/\w+\s*\.\s*command\(/);
    const nextAction = rest.search(/\.\s*action\(/);
    const descEnd =
      nextAction >= 0 ? nextAction : nextCmd >= 0 ? nextCmd : rest.length;
    const description = extractDescription(rest.slice(0, descEnd));
    commands.push({ full, spec, description });
  }

  return commands;
}

function renderMarkdown(commands) {
  const sections = commands
    .map((cmd) => {
      const heading = `## \`gnosys ${cmd.spec}\``;
      return `${heading}\n\n${cmd.description}`;
    })
    .join("\n\n");

  return `# CLI Reference

_Generated from \`src/cli.ts\` by \`scripts/gen-cli-docs.mjs\`. Do not edit by hand._

${sections}
`;
}

function main() {
  const source = fs.readFileSync(CLI, "utf8");
  const commands = extractCommands(source);
  if (commands.length === 0) {
    console.error("No CLI commands found in src/cli.ts");
    process.exit(1);
  }

  const markdown = renderMarkdown(commands);
  const write = process.argv.includes("--write");

  if (write) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, markdown);
  } else {
    process.stdout.write(markdown);
  }
}

main();

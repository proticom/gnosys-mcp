# ADR-0004: TypeScript as Implementation Language

- Status: Accepted
- Date: 2026-03-04
- Memory: dec-010

## Context

Implementation language choice followed directly from MCP-first architecture. The stack needed to serve the MCP server as core, with CLI and web UI as first-class clients. Python, TypeScript, Go, and Rust were evaluated against that constraint.

## Decision

Gnosys is implemented in TypeScript, distributed via npm, with the official MCP SDK as the native integration surface.

## Consequences

- First-class access to MCP SDK features as they ship; no waiting on third-party bindings.
- `gnosys serve` and future web UI work naturally in the JavaScript ecosystem.
- Strong typing helps an open-source project with multiple contributors catch errors early.
- `npm install -g gnosys` / `npx gnosys` is a clean distribution story for agent-tooling developers.
- Accepted costs: LLM SDK ergonomics are stronger in Python; SQLite needs `better-sqlite3` (native addon); ML-heavy contributors are less common than TypeScript agent-tooling contributors — acceptable because Gnosys is agent infrastructure, not ML research code.

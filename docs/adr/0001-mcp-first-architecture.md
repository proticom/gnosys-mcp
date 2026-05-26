# ADR-0001: MCP-First Architecture

- Status: Accepted
- Date: 2026-03-04
- Memory: dec-009

## Context

Gnosys is meant to be a foundation for other tools, not a standalone terminal utility. Edward needed a programmatic interface that agents and future products could consume natively. The main options were CLI-only, CLI plus a thin MCP adapter, or MCP-first with CLI and web UI as clients of one core.

## Decision

The core of Gnosys is an MCP server. The CLI (`gnosys …`) and web UI (`gnosys serve`) are clients of that server. All interfaces share one brain — three surfaces, one implementation.

## Consequences

- MCP-compatible agents (Claude, Cursor, Codex, etc.) get typed tool calls instead of shell hacks and parsed stdout.
- Gnosys becomes a platform other tools can embed, not just a human-facing CLI.
- One codebase serves every interface; logic is not duplicated across CLI, MCP, and web layers.
- MCP protocol evolution is a risk; mitigated because data remains portable and the server is an access layer, not the data format.
- Slightly more moving parts than a pure CLI for early versions, but the long-term extensibility payoff is the point.

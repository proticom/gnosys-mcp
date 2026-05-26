# ADR-0007: Open Source from Day One

- Status: Accepted
- Date: 2026-03-04
- Memory: dec-005

## Context

Edward's goal is a simple, repeatable memory system that others can adopt, fork, and extend — not a proprietary black box tied to one vendor or workflow.

## Decision

Gnosys ships open source from the initial release. Architecture and formats must stay simple enough that a new contributor can understand, run, and modify the system quickly.

## Consequences

- Documentation and code structure are first-class product requirements, not afterthoughts.
- No proprietary runtime dependencies that block self-hosting or forking.
- CLI and MCP surfaces must work with multiple LLM providers, not a single vendor lock-in.
- Export formats (markdown + frontmatter) act as a public interchange API — third-party tools can read/write without the official CLI.
- Community adoption and scrutiny are features; simplicity is enforced because complexity does not scale in open source.

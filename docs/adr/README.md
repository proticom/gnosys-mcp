# Architecture Decision Records (ADRs)

Short, stable snapshots of load-bearing Gnosys architectural decisions. The rolling source of truth lives in Gnosys memory; these files give new contributors a fast on-ramp without opening the brain.

## Format

Each ADR uses:

- **Status** — Accepted, Superseded, or Deprecated
- **Date** — when the decision was recorded
- **Memory** — Gnosys memory id for the canonical write-up
- **Context** — problem and forces
- **Decision** — what we chose
- **Consequences** — trade-offs and implications

## Index

| ADR | Title | Memory |
|-----|-------|--------|
| [0001](0001-mcp-first-architecture.md) | MCP-First Architecture | dec-009 |
| [0002](0002-layered-multi-store-architecture.md) | Layered Multi-Store Architecture | deci-030 |
| [0003](0003-why-not-rag.md) | Why Not RAG | dec-001 |
| [0004](0004-typescript-implementation-language.md) | TypeScript as Implementation Language | dec-010 |
| [0005](0005-db-only-architecture.md) | DB-only Architecture (SQLite as Sole Source of Truth) | deci-032 |
| [0006](0006-built-in-server-obsidian-compatible.md) | Built-in Server + Obsidian-Compatible | dec-011 |
| [0007](0007-open-source-from-day-one.md) | Open Source from Day One | dec-005 |
| [0008](0008-automated-npm-publish.md) | Automated npm Publish via OIDC Trusted Publishing | deci-033 |

Additional decisions remain in Gnosys memory and may be backfilled here over time.

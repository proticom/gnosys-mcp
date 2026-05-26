# Source of Truth Map

_The single page that says **where each kind of content lives**, so we never duplicate-maintain the same information in two places._

## TL;DR

- **User-facing docs**: [gnosys.ai](https://gnosys.ai) is the source of truth.
- **In-repo docs**: stable, contributor-facing reference (ADRs, threat model, security policy, generated CLI/MCP indexes).
- **Gnosys memory** (`~/.gnosys/gnosys.db`): the rolling source of truth for decisions, requirements, and architecture in progress.

## Map

| Content | Canonical home | Notes |
|---|---|---|
| Quickstart, install, 60-second tour | [`README.md`](../README.md) | Renders on the npm package page; intentionally minimal |
| Full user guide & tutorials | [gnosys.ai](https://gnosys.ai) | "Everything else lives on gnosys.ai" — single source for end-user docs |
| CLI reference | [`docs/cli.md`](./cli.md) | **Generated** from `src/cli.ts` via `npm run docs:cli` |
| MCP tool reference (generated) | [`docs/mcp-tools.md`](./mcp-tools.md) | **Generated** from `src/index.ts` via `npm run docs:mcp-tools` |
| MCP tool reference (curated, npm page) | [`README.md`](../README.md) "MCP Tool Reference" | Curated for the npm landing page; the generated doc is the in-repo source of truth |
| Security policy (reporting, support, update integrity) | [`SECURITY.md`](../SECURITY.md) | Versions supported; private disclosure channel; npm OIDC provenance |
| Threat model (assets, threats, mitigations, accepted risks) | [`docs/threat-model.md`](./threat-model.md) | Track A synthesis |
| Architectural Decision Records (stable snapshots) | [`docs/adr/`](./adr/) | Short ADRs lifted from Gnosys memory |
| Architectural decisions (rolling source of truth) | Gnosys memory (`~/.gnosys/gnosys.db`, category `decisions`) | The ADRs are snapshots; the brain is live |
| Project conventions / repo-level CLAUDE.md guidance | `CLAUDE.md` (in workspace) | Local agent guidance; not shipped |
| Changelog | [`CHANGELOG.md`](../CHANGELOG.md) | Keep-a-Changelog; consistent from 5.2.16+ (Historical-versions note covers earlier) |
| Contributing | [`CONTRIBUTING.md`](../CONTRIBUTING.md) | How to file issues, propose changes |
| Code of Conduct | [`CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md) | Community standards |
| Configuration reference | [`docs/configuration.md`](./configuration.md) | Env vars, config file shape |
| Setup walkthrough | [`docs/setup-walkthrough.md`](./setup-walkthrough.md) | First-run interactive setup |
| Cost & limits | [`docs/cost-and-limits.md`](./cost-and-limits.md) | LLM cost guidance |
| Search modes (keyword / semantic / hybrid) | [`docs/search-modes.md`](./search-modes.md) | When to use which |
| LLM provider contract | [`docs/llm-provider-contract.md`](./llm-provider-contract.md) | Interface providers implement |
| Network MCP (HTTP transport, multi-machine) | [`docs/network-mcp.md`](./network-mcp.md) | Central-server topology |
| Public type API (`gnosys` / `gnosys/web`) | `dist/index.d.ts`, `dist/lib/staticSearch.d.ts` | Surfaced to consumers' IDEs via the `exports` map |
| Marketing site sources | `gnosys-site/` (separate repo, `proticom/gnosys-site`) | Static GitHub Pages → gnosys.ai |

## Rules of thumb

- **Adding user-facing prose?** It goes on **gnosys.ai**, not the README, unless it's load-bearing for the 60-second tour or npm landing page.
- **Adding a code-level architectural decision?** Record it in **Gnosys memory** (`decisions` category) first; promote to a `docs/adr/` snapshot once it's load-bearing for new contributors.
- **Adding/changing a CLI command or MCP tool?** Update the source in `src/cli.ts`/`src/index.ts`, then run `npm run docs:cli` / `npm run docs:mcp-tools` to regenerate the in-repo docs.
- **Adding a security-relevant change?** Update **SECURITY.md** (policy/reporting) and/or **docs/threat-model.md** (threats/mitigations) — don't bury security context in code comments.
- **Adding a published-release entry?** **CHANGELOG.md** in Keep-a-Changelog format; the Historical-versions note explains the pre-5.2.16 gap.

## Why this exists

To eliminate the "where do I document this?" question and to keep the repo and gnosys.ai from drifting into duplicated, contradictory docs.

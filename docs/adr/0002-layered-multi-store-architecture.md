# ADR-0002: Layered Multi-Store Architecture

- Status: Accepted
- Date: 2026-03-05
- Memory: deci-030

## Context

MCP clients configure servers globally, not per repository. A single Gnosys instance must serve the correct knowledge for whatever project the user is in, plus personal cross-project knowledge and optional shared org knowledge. Edward proposed distinct scopes resolved in specificity order rather than one flat store per machine.

## Decision

Gnosys supports layered stores — project (auto-discovered `.gnosys/`), personal (`GNOSYS_PERSONAL`), global (`GNOSYS_GLOBAL`), and optional read-only references (`GNOSYS_STORES`). Reads merge with precedence: project beats optional beats personal beats global. Writes default to project; global writes require an explicit target.

## Consequences

- One MCP server can serve many projects without per-repo MCP config churn.
- Project decisions override personal preferences in context, with source labels so the LLM sees both.
- Global stores enable team standards on NAS or shared drives without accidental overwrites.
- Optional stores allow cross-repo read references without mutating foreign projects.
- Filesystem permissions are the v1 access-control layer for shared global stores; richer roles can come later.

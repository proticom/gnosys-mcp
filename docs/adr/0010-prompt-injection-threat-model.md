# ADR-0010: Prompt Injection Threat Model

- Status: Accepted
- Date: 2026-05-25
- Memory: deci-01KSGSX8SJXAVAY7EV2VS9YJJP

## Context

Gnosys stores text that LLMs later consume as context. Imported or observed memories may contain adversarial instructions disguised as legitimate content. The host agent (Claude, Cursor, etc.) has its own tools and trust boundary. Gnosys must decide how much to sanitize versus accept, without stripping user-authored instruction-like content that is genuinely useful.

## Decision

Treat prompt injection as a bounded, accepted risk. Do not strip legitimate instruction-like content from user-authored memories. Defend at the Gnosys boundary with: no outbound exfiltration primitives in MCP tools, SSRF guards on ingestion (`safeFetch`, URL allowlists), API-key redaction in provider errors, explicit `authority`/`author` provenance on every memory, and ask-layer rules that treat Context Memories strictly as data. Residual risk from the host agent's own tools is explicitly outside Gnosys's trust boundary.

## Consequences

- Security investment focuses on ingestion, retrieval, and MCP surface hardening rather than content censorship.
- Operators can audit provenance via `authority` and `author` fields to judge trust.
- Ask/synthesis prompts include injection-aware framing without blocking normal memory content.
- Future hardening (e.g., sandboxed tool execution) remains the host agent's responsibility.

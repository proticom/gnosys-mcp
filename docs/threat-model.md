# Gnosys Threat Model

_Last reviewed: 2026-05-25. Scope: the `gnosys` npm package (CLI + MCP server). Companion: [SECURITY.md](../SECURITY.md)._

Gnosys is a **single-user, local-first** memory tool: a CLI and an MCP server that
read/write a central SQLite brain on the user's own machine. This document lists the
assets it protects, the threats considered, the mitigations in place, and the risks
explicitly accepted as user-owned.

## Assets

- **Provider API keys** — `~/.config/gnosys/.env` (and OS keychain entries).
- **The memory store** — `~/.gnosys/gnosys.db` (+ WAL sidecars): all memories across projects.
- **Store integrity** — correctness/authenticity of stored memories and the installed package.
- **The HTTP MCP endpoint** — when `gnosys serve --transport http` is used.

## Threats & Mitigations

| Threat | Mitigation | Ref |
|---|---|---|
| Dependency CVEs | `npm audit` in CI (`--audit-level=high`); `audit-ci --moderate` clean; 0 advisories | A.1 |
| Supply-chain tampering | Committed `package-lock.json`; all deps caret-pinned (no `*`/`latest`); optional native deps guarded (not load-bearing) | A.2 |
| Secrets committed to the repo | `secretlint` clean; git history clean; keys never hard-coded | A.3 |
| Secrets leaked in logs | `redactKey()` masks the configured key + known prefixes (`sk-ant-`,`sk-`,`gsk_`,`xai-`,`Bearer`); keys never placed in LLM context; provider-config logs show *source* not value | A.4 |
| SSRF via user-supplied URLs (import / web ingest) | `safeFetch`/`isSafeUrl` block loopback, `localhost`, RFC1918, link-local/cloud-metadata (169.254.169.254), IPv6 `::1`, `0.0.0.0`, and integer-encoded IPs; redirects re-checked per hop | A.7 |
| Path traversal on export | Memory `category`/`title` slugified before path join; `assertWithin()` resolves + verifies every write stays under the export dir (blocks prefix-confusion) | A.5 |
| SQL injection | All values bound via `?`; interpolated columns restricted to `MEMORY_COLUMNS`/`PROJECT_COLUMNS` allowlists; LIMITs integer-coerced; no string-concatenated SQL | A.6 |
| Shell injection | `child_process` calls use argv arrays (`execFileSync`/`spawn`), no `shell:true`; remaining string execs are literals or code-controlled constants | A.8 |
| Local file disclosure | `~/.config/gnosys/.env` and `~/.gnosys/gnosys.db` (+ wal/shm) created mode `0600`; parent dirs `0700` (best-effort on POSIX) | A.11 |
| Unauthorized HTTP MCP access | Binds loopback by default; non-loopback bind **requires** a token; bearer enforced (401); CORS Origin allowlist (default closed, 403); per-session isolation (random UUIDs); idle-session reaper; bounded request bodies (413/408) | A.10, 14.1–14.8 |
| Prompt injection via memory content | No exfiltration primitive in the MCP toolset; ingestion inbound + SSRF-guarded; `authority`/`author` provenance on every memory; `ask` system prompt treats memories as data and refuses embedded directives; keys never in context | A.9, 5.5 |
| Malicious/ tampered update | `gnosys upgrade` delegates to the package manager (SHA-512 SRI verification); releases carry npm OIDC **provenance attestations** (`npm audit signatures`) | A.12 |

## Accepted Risks (user-owned)

- **Self-authored memory instructions** — Gnosys does not strip instruction-like text from user-authored content (specs/decisions/prompts are legitimate). Instructing your own agent is your prerogative.
- **Host-agent tools** — Gnosys can't control what tools the surrounding agent (Claude Code, Cursor, …) exposes. If the host has fetch/shell tools, an injected memory could weaponize *those*; that is the host's trust boundary. Gnosys surfaces provenance so the host/user can judge.
- **Residual LLM-follows-context risk** — inherent to LLMs; mitigated (provenance, no exfil primitive, `ask` hardening) but not eliminable.
- **Single-user machine assumption** — the local-disclosure mitigations (0600/0700) reduce but don't eliminate risk on a shared host; full-disk encryption and OS account isolation remain the user's responsibility.
- **User-chosen file paths** — `gnosys import`/`ingest`/`bootstrap`/`migrate` read absolute paths the user points at, by design.
- **Operator-configured LLM endpoints** — `baseUrl` for Ollama/LM Studio/custom providers is intentionally not URL-filtered (local-LLM support).
- **Windows permissions** — `chmod` is best-effort on Windows/network filesystems (NTFS ACLs differ); POSIX is the verified target.

## Review cadence

Re-review on each minor release and whenever a new external-input path (network, file, or tool) is added.

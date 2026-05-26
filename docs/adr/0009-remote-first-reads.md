# ADR-0009: Remote-First Reads, Local-as-Offline-Only Cache

- Status: Accepted
- Date: 2026-05-01
- Memory: deci-037

## Context

The multi-machine sync architecture (deci-034) treated the remote NAS as canonical but routed reads through a local SQLite cache for sub-millisecond latency. In practice, that optimization caused silent divergence: stale local caches, invisible cross-machine writes, and orphan memories. Single-user multi-machine workflows do not need sub-ms reads; 10–30 ms over LAN is acceptable for CLI and MCP commands.

## Decision

Reads hit the remote database when it is reachable; the local DB is a fallback only when the remote is offline. Writes go remote-first when reachable and queue to a local `pending_sync` table when not. The local database is an offline-resilience cache, not a performance layer — users should be able to delete `~/.gnosys/gnosys.db` without data loss. New memory IDs use `catprefix-ULID` for globally unique, coordination-free identifiers.

## Consequences

- One authoritative answer to "what does Gnosys know?" across machines and concurrent agents.
- Brief network latency on reads is accepted in exchange for consistency.
- Reachability is checked once per CLI invocation; fallback surfaces a one-line warning.
- Existing prefix-N IDs remain unchanged; ULIDs are additive.
- Supersedes deci-034's "reads always hit local for speed" clause while preserving NAS-as-source-of-truth and skip-and-flag conflict resolution.

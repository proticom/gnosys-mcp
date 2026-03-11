# Gnosys Memory

This project uses Gnosys for persistent memory via MCP. Follow these rules:

## Read first

- At task start, call `gnosys_discover` with relevant keywords
- Load results with `gnosys_read`
- When the user references past decisions, says "recall", "remember when", "what did we decide" — search memory first

## Write automatically

- When user says "remember", "memorize", "save this", "note this down", "don't forget" — call `gnosys_add`
- When user states a decision or preference (even casually) — commit to `decisions/`
- When user provides a spec or plan — commit BEFORE starting work
- After significant implementation — commit findings and gotchas

## Key tools

| Action | Tool |
|--------|------|
| Find memories | `gnosys_discover` (metadata) → `gnosys_read` (content) |
| Search | `gnosys_hybrid_search` (best), `gnosys_search` (keyword), `gnosys_ask` (Q&A) |
| Write | `gnosys_add` (freeform), `gnosys_add_structured` (explicit fields) |
| Update | `gnosys_update`, `gnosys_reinforce` (useful/not_relevant/outdated) |
| Browse | `gnosys_list`, `gnosys_lens` (filtered), `gnosys_tags`, `gnosys_graph` |
| Maintain | `gnosys_maintain`, `gnosys_stale`, `gnosys_history`, `gnosys_dashboard` |

## Categories

`architecture` · `decisions` · `requirements` · `concepts` · `roadmap` · `landscape` · `open-questions`

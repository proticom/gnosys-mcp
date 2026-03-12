# Gnosys Memory

This project uses Gnosys for persistent memory via MCP. Gnosys uses a centralized brain (`~/.gnosys/gnosys.db`) shared across all projects with project, user, and global scopes. Follow these rules:

## Read first

- At task start, call `gnosys_discover` with relevant keywords
- Load results with `gnosys_read`
- When the user references past decisions, says "recall", "remember when", "what did we decide" — search memory first
- Use `gnosys_federated_search` for cross-project search with scope boosting

## Write automatically

- When user says "remember", "memorize", "save this", "note this down", "don't forget" — call `gnosys_add`
- When user states a decision or preference (even casually) — commit to `decisions/`
- When user provides a spec or plan — commit BEFORE starting work
- After significant implementation — commit findings and gotchas
- User preferences (coding style, conventions) — use `gnosys_preference_set`

## Key tools

| Action | Tool |
|--------|------|
| Find memories | `gnosys_discover` (metadata) → `gnosys_read` (content) |
| Search | `gnosys_hybrid_search` (best), `gnosys_federated_search` (cross-project), `gnosys_search` (keyword), `gnosys_ask` (Q&A) |
| Write | `gnosys_add` (freeform), `gnosys_add_structured` (explicit fields) |
| Update | `gnosys_update`, `gnosys_reinforce` (useful/not_relevant/outdated) |
| Browse | `gnosys_list`, `gnosys_lens` (filtered), `gnosys_tags`, `gnosys_graph` |
| Maintain | `gnosys_maintain`, `gnosys_stale`, `gnosys_history`, `gnosys_dashboard` |
| Preferences | `gnosys_preference_set`, `gnosys_preference_get`, `gnosys_preference_delete` |
| Projects | `gnosys_register_project`, `gnosys_list_projects`, `gnosys_briefing` |
| Context | `gnosys_federated_search`, `gnosys_working_set`, `gnosys_detect_ambiguity` |

## Workflow: Starting a new project

1. Run `gnosys init` in the project root to register it in the central project registry
2. Run `gnosys rules --target claude` to generate this rules file with project context
3. Gnosys auto-detects the project from `.git`, `package.json`, etc.

## Categories

`architecture` · `decisions` · `requirements` · `concepts` · `roadmap` · `landscape` · `open-questions`

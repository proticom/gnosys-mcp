# gnosys add-structured

Add a memory with explicit structured fields — no LLM structuring step.

## Usage

```bash
gnosys add-structured --title "Decision" --category decisions --content "Use SQLite as source of truth"
gnosys add-structured --title "Preference" --category preferences --content "Use concise reviews" --user
gnosys add-structured --title "Org policy" --category policies --content "Shared guidance" --global
gnosys add-structured --title "Tagged" --category notes --content "Tagged content" --tags '{"domain":["cli"],"type":["note"]}'
```

## Required options

| Option | Description |
|--------|-------------|
| `--title <title>` | Memory title |
| `--category <category>` | Category directory name (e.g. `decisions`, `preferences`) |
| `--content <content>` | Memory body as markdown |

## Optional options

| Option | Description |
|--------|-------------|
| `--tags <json>` | Tags as JSON object (default `{}`) |
| `--relevance <keywords>` | Keyword cloud for discovery (defaults to content snippet) |
| `-a, --author <author>` | Author (default `human`) |
| `--authority <authority>` | Authority level (default `declared`) |
| `--confidence <n>` | Confidence 0–1 (default `0.8`) |
| `-s, --store <store>` | Target store hint |
| `--user` | Store as user-scoped memory (`scope: user`) |
| `--global` | Store as global-scoped memory (`scope: global`) |

## Behavior

### User or global scope (`--user` / `--global`)

- Writes directly to the central DB.
- `--global`: `scope: global`, no project id.
- `--user`: `scope: user`, includes project id when available.
- Prints `Memory added (scope: user|global): <title>` and ID.

### Default project scope

- Parses `--tags` as JSON; exits with `Invalid --tags JSON. Example: '{"domain":["auth"],"type":["decision"]}'` on parse failure.
- Generates category-scoped ID via central DB.
- Inserts project-scoped memory (`scope: project`).
- Prints `Memory added: <title>` and ID.

## Output example

```text
Memory added: Decision: use SQLite
ID: deci-042
```

## Platform notes

### macOS / Linux / Windows

- JSON for `--tags` must be valid JSON; quote carefully in shell.
- Requires central DB available (`better-sqlite3` installed and migrated).

## Validation

```bash
cd gnosys-public
npm run cli -- add-structured --help
```

## Related commands

- `gnosys add` — add from raw text or file with LLM structuring.

# gnosys dearchive

Force-dearchive memories matching a query from `archive.db` back to the active store.

## Usage

```bash
gnosys dearchive "auth decision"
gnosys dearchive "auth decision" --limit 10
```

## Options

| Option | Description |
|--------|-------------|
| `--limit <n>` | Maximum archived memories to restore (default `5`) |

## Behavior

1. Resolves configured stores via the project resolver.
2. Requires a writable store (`getWriteTarget()`).
3. Opens `GnosysArchive` on the write-target path.
4. Searches archived memories with `searchArchive(query, limit)`.
5. Restores matches with `dearchiveBatch(ids, writeTarget.store)`.

## Output

No matches:

```text
No archived memories found matching "auth decision".
```

Matches found:

```text
Found 2 archived memories matching "auth decision":

  • Auth Token Policy (deci-012)
  ...

Dearchived 2 memories back to active:
  → project/decisions/auth-token-policy.md
```

## Errors

| Condition | Message |
|-----------|---------|
| No stores | `No Gnosys stores found. Run gnosys init first.` |
| No writable store | `No writable store found.` |
| Archive unavailable | `Archive not available. Install it with: npm install better-sqlite3` |

Error paths exit with code 1.

## Resource cleanup

Always closes the archive handle in a `finally` block, including when search or restore fails.

## Validation

```bash
cd gnosys-public
npm run cli -- dearchive --help
npx vitest run src/test/dearchive-command-handler.test.ts
```

## Related commands

- `gnosys maintain` — vault maintenance including archival workflows.
- `gnosys search` — search active memories.
- `gnosys read` — read a restored memory after dearchive.

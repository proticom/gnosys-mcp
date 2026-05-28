# gnosys tags

List all tags in the active registry.

## Usage

```bash
gnosys tags
```

## Behavior

1. Resolves the current write target/store via `getResolver()` and `getWriteTarget()`.
2. Exits with `No store found.` if no store is available.
3. Loads the tag registry from the selected store path (`GnosysTagRegistry` + `load()`).
4. Prints each registry category with sorted tag names.

## Output

Human-readable category sections:

```text
category-name:
  tag-a, tag-b, tag-c
```

## Validation

```bash
cd gnosys-public
npm run cli -- tags --help
```

## Related commands

- `gnosys list` — list memories (may filter by tag).
- `gnosys discover` — keyword discovery across memories.

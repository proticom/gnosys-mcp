# gnosys tags-add

Add a tag to the active registry.

## Usage

```bash
gnosys tags-add --category domain --tag auth
gnosys tags-add --category status_tag --tag experimental
```

## Options

| Option | Description |
|--------|-------------|
| `--category <category>` | Tag category (`domain`, `type`, `concern`, `status_tag`) |
| `--tag <tag>` | Tag name to add |

## Behavior

1. Resolves the current write target/store via `getResolver()` and `getWriteTarget()`.
2. Exits with `No store found.` if no store is available.
3. Loads the tag registry from the selected store path.
4. Calls `addTag(category, tag)`.
5. Prints success or already-exists message.

## Output

Success:

```text
Tag 'auth' added to category 'domain'.
```

Already exists:

```text
Tag 'auth' already exists in 'domain'.
```

## Validation

```bash
cd gnosys-public
npm run cli -- tags-add --help
```

## Related commands

- `gnosys tags` — list all tags in the registry.

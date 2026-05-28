# gnosys reinforce

Signal whether a memory was useful, not relevant, or outdated.

## Usage

```bash
gnosys reinforce mem-001 --signal useful
gnosys reinforce mem-001 --signal not_relevant --context "wrong project"
gnosys reinforce mem-001 --signal outdated
```

## Arguments

| Argument | Description |
|----------|-------------|
| `memoryId` | Memory ID to reinforce |

## Options

| Option | Description |
|--------|-------------|
| `--signal <signal>` | Required signal: `useful`, `not_relevant`, or `outdated` |
| `--context <context>` | Optional reason/context for the signal |

## Behavior

1. Resolves writable store via `getResolver().getWriteTarget()`.
2. Exits with `No writable store found.` when no write target exists.
3. Appends a JSON line to `.config/reinforcement.log` under the store path.
4. When `--signal useful`, updates the memory modified date via `syncUpdateToDb` (decay reset).
5. Prints a signal-specific confirmation message.

## Output

```text
Memory mem-001 reinforced. Decay clock reset.
```

Other signals:

```text
Routing feedback logged for mem-001. Memory unchanged.
Memory mem-001 flagged for review as outdated.
```

## Validation

```bash
cd gnosys-public
npm run cli -- reinforce --help
```

## Related commands

- `gnosys update` — edit memory content or metadata directly.
- `gnosys stale` — find memories not touched recently.

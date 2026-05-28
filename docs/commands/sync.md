# gnosys sync

Regenerate agent rules files from user preferences and project conventions. Injects the `GNOSYS:START` / `GNOSYS:END` block.

This documents **top-level** `gnosys sync` (rules generation). Remote two-way sync lives under `gnosys setup remote sync`.

## Usage

```bash
gnosys sync
gnosys sync --directory /path/to/project
gnosys sync --target codex
gnosys sync --target all
gnosys sync --global
```

## Options

| Option | Description |
|--------|-------------|
| `-d, --directory <dir>` | Project directory (default: cwd) |
| `-t, --target <target>` | Target: `claude`, `cursor`, `codex`, `all`, or `global` |
| `--global` | Sync to global `~/.claude/CLAUDE.md` |

## Behavior

1. Opens the central DB via `GnosysDB.openCentral()`.
2. Resolves `projectDir` from `--directory` or `process.cwd()`.
3. **`--global`**: calls `syncToTarget(centralDb, projectDir, "global", null)` without project identity.
4. **Project mode**: reads identity via `readProjectIdentity(projectDir)`, resolves target as explicit `--target`, `identity.agentRulesTarget`, or `"all"`, then calls `syncToTarget`.
5. Prints created/updated file paths and preference/convention counts.
6. Reminds that content lives inside GNOSYS markers; user content outside is preserved.

## Output

**Global:**

```text
Created global rules: /Users/me/.claude/CLAUDE.md
  Preferences injected: 5

Content is inside <!-- GNOSYS:START --> / <!-- GNOSYS:END --> markers.
User content outside these markers is preserved.
```

**Project:**

```text
Updated rules file: /path/to/project/.cursor/rules/gnosys.mdc
  Preferences injected: 5
  Project conventions:  3
```

## Errors

Central DB unavailable:

```text
Central DB not available (better-sqlite3 missing).
```

No project identity:

```text
No project identity found. Run 'gnosys init' first.
```

No targets:

```text
No targets found. Create a CLAUDE.md, .cursor/, or .codex/ directory first.
```

Failure paths set `process.exitCode = 1` and return through `finally`.

## Validation

```bash
cd gnosys-public
npm run cli -- sync --help
npx vitest run src/test/sync-command-handler.test.ts
```

## Related commands

- `gnosys pref set` — update user preferences before syncing rules
- `gnosys setup preferences` — review preferences
- `gnosys setup remote sync` — remote DB two-way sync (different command)

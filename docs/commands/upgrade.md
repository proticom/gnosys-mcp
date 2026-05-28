# gnosys upgrade

Upgrade the Gnosys CLI/MCP package itself and signal running MCP servers to restart.

## Usage

```bash
gnosys upgrade
gnosys upgrade --yes
gnosys upgrade --no-sync
```

## Options

| Option | Description |
|--------|-------------|
| `--yes` | Skip the post-upgrade `setup sync-projects` prompt and exit |
| `--no-sync` | Do not suggest running `setup sync-projects` afterward |

## Behavior

1. Prints the current CLI version.
2. Detects the package manager via `detectPackageManager()`.
3. Builds and runs the global upgrade command via `upgradeCommand(pm)` using `execSync`.
4. Best-effort reads the newly installed version from `npm ls -g gnosys`.
5. Writes the MCP restart marker via `writeUpgradeMarker()` to `~/.gnosys/last-upgrade-at`.
6. Unless `--yes` or `--no-sync`, prompts to run `gnosys setup sync-projects`.

## Npx behavior

When running under npx (no global install), the command exits early:

```text
Running under npx — there's no global install to upgrade. Use `npx gnosys@latest` to run the latest.
```

## Post-upgrade sync prompt

Interactive default:

```text
Run 'gnosys setup sync-projects' now to refresh registered projects? [Y/n]
```

If confirmed, shells out to:

```bash
gnosys setup sync-projects
```

With `--yes` or `--no-sync`, the prompt is skipped and the command reminds you that sync-projects can be run later.

## Side effects

- Upgrades the globally installed `gnosys` npm package (when not running under npx).
- Writes `~/.gnosys/last-upgrade-at` so running MCP servers restart cleanly within ~10 seconds.

## Errors

Upgrade command failure exits with code 1 and suggests running the upgrade command manually.

Sync-projects subprocess failure exits with code 1 and suggests running sync manually.

## Validation

```bash
cd gnosys-public
npm run cli -- upgrade --help
npx vitest run src/test/upgrade-command-handler.test.ts
```

## Related commands

- `gnosys setup sync-projects` — refresh registered projects after upgrading.
- `gnosys doctor` — verify stores, LLM connectivity, and embeddings.

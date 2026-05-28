# gnosys helper generate

Generate a `gnosys-helper.ts` file for direct sandbox access from agent scripts.

## Usage

```bash
gnosys helper generate
gnosys helper generate --directory ./agent
gnosys helper generate --json
```

## Options

| Option | Description |
|--------|-------------|
| `-d, --directory <dir>` | Target directory (default: current working directory) |
| `--json` | Output result as JSON |

## Behavior

1. Resolves target directory from `--directory` or `process.cwd()`.
2. Calls `generateHelper(targetDir)` to write the helper file.
3. Prints usage hints or JSON result.

## Human output

```text
Generated: /path/to/gnosys-helper.ts

Usage in your agent/script:
  import { gnosys } from "./gnosys-helper";
  await gnosys.add("We use conventional commits");
  const ctx = await gnosys.recall("auth decisions");
```

## JSON output

Success:

```json
{
  "ok": true,
  "path": "/path/to/gnosys-helper.ts"
}
```

Failure:

```json
{
  "ok": false,
  "error": "error message"
}
```

On failure without `--json`, prints `Failed to generate helper: ...` to stderr and exits with code 1.

## Validation

```bash
cd gnosys-public
npm run cli -- helper generate --help
npx vitest run src/test/helper-generate-command-handler.test.ts
```

## Related commands

- `gnosys sandbox start` — start the sandbox the helper connects to.

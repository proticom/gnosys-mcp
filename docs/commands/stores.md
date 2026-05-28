# gnosys stores

Show all active Gnosys stores, their layers, resolved paths, and whether each store is writable.

## Usage

```bash
gnosys stores
```

## Behavior

- Discovers stores using the same resolver as normal commands.
- Prints one line per active store in resolver precedence order.
- Uses `[label] path (read-write|read-only)` output from `GnosysResolver.getSummary()`.
- Prints `No stores found. Create a .gnosys/ directory or set GNOSYS_PERSONAL.` when no stores are available.
- Does not create, modify, or delete stores (read-only diagnostic).

## Output example

```text
[project] /Users/you/project/.gnosys (read-write)
[personal] /Users/you/.gnosys (read-write)
[optional] /Volumes/shared/team/.gnosys (read-only)
```

## Platform notes

### macOS

- Paths use forward slashes; personal store is typically `~/.gnosys`.
- Project store is `<project-dir>/.gnosys`.
- Optional shared stores may live on mounted volumes (NAS paths).

### Linux

- Same path conventions as macOS: `~/.gnosys` for personal, `./.gnosys` for project scope.
- Quote paths with spaces when setting `GNOSYS_PERSONAL` or similar env vars.

### Windows

- Paths may use `\`; Node resolves them correctly in output.
- Personal store is under the user profile (e.g. `C:\Users\you\.gnosys`).
- Use quoted paths in PowerShell when setting environment variables: `$env:GNOSYS_PERSONAL="D:\shared\.gnosys"`.

## Validation

```bash
cd gnosys-public
npm run cli -- stores --help
```

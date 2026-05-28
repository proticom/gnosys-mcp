# gnosys config init

Generate a blank `gnosys.json` template in the active writable store.

**Deprecated:** prefer `gnosys setup` for interactive configuration.

## Usage

```bash
gnosys config init
gnosys config init --force
```

## Behavior

- **Without `--force`:** prints a deprecation warning pointing to `gnosys setup`, then exits without writing any file.
- **With `--force`:** writes a blank config template to `<writable-store>/gnosys.json` when that file does not already exist.
- Exits with `No writable store found.` when no writable store is available.
- Exits with `gnosys.json already exists. Use 'gnosys config set' to modify.` when the target config file is already present.
- On success with `--force`, prints `Created <path>`.

## Output example (default, no `--force`)

```text
gnosys config init

  ! writing a blank template means the next run of `gnosys setup`
  ! will walk you through the same choices anyway

     try   gnosys setup        interactive walkthrough (recommended)

  re-run with --force to write the template anyway
```

## Platform notes

### macOS

- Writable store is typically project `./.gnosys` or personal `~/.gnosys`.
- Template is written as `gnosys.json` inside the store directory.

### Linux

- Same store resolution as macOS. Run `gnosys init` first if no stores exist.

### Windows

- Paths in success/error messages may use backslashes; behavior is the same as on Unix.
- Prefer `gnosys setup` on all platforms for first-time configuration.

## Validation

```bash
cd gnosys-public
npm run cli -- config init --help
npm run cli -- config init
npm run cli -- config init --force
```

## Related commands

- `gnosys setup` — recommended interactive walkthrough (replaces plain `config init`).
- `gnosys config set` — modify an existing `gnosys.json`.

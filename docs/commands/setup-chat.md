# gnosys setup chat

Show the deprecation notice for the legacy chat setup command.

## Usage

```bash
gnosys setup chat
```

## Behavior

- Prints a warning that chat settings have moved.
- Points users to `gnosys chat` and its settings panel (`Ctrl+,` in the TUI).
- Exits without writing config.
- Kept only as a compatibility command until v6.0.

## Writes and side effects

- Does not update Gnosys config.
- Does not read or write API keys.
- Does not create chat sessions.

## Platform notes

### macOS

No platform-specific setup is performed; open `gnosys chat` and use the in-TUI settings shortcut.

### Linux

No platform-specific setup is performed; open `gnosys chat` and use the in-TUI settings shortcut.

### Windows

No platform-specific setup is performed; open `gnosys chat` and use the in-TUI settings shortcut.

## Validation

```bash
cd gnosys-public
npm run cli -- setup chat --help
```

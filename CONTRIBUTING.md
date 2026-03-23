# Contributing to Gnosys

Thank you for contributing to Gnosys! This document outlines the development workflow, code standards, and testing conventions used in this project.

## Getting Started

Clone the repository and install dependencies:

```bash
git clone https://github.com/proticom/gnosys.git
cd gnosys
npm install
```

Build the project:

```bash
npm run build
```

Run the test suite:

```bash
npm test
```

## Development

### Local Development

Start the development server with live reloading:

```bash
npm run dev
```

This uses `tsx` for TypeScript execution with watch mode.

### CLI Development

Test CLI commands during development:

```bash
npm run cli [command] [args]
```

Example:

```bash
npm run cli sandbox start
npm run cli helper generate
```

### Watch Mode Testing

Run tests in watch mode while developing:

```bash
npm run test:watch
```

## Sandbox Development

The v3.0 sandbox is a persistent background process that provides a stable runtime for agent memory operations. Understanding its architecture is essential for sandbox-related work.

### Architecture

- **`src/sandbox/server.ts`** — Unix domain socket server that handles IPC requests. Listens on `~/.gnosys/sandbox/gnosys.sock` and manages message queues, streaming responses, and graceful shutdown.

- **`src/sandbox/client.ts`** — Client library for socket communication. Handles connection pooling, request serialization, error handling, and automatic reconnection logic.

- **`src/sandbox/manager.ts`** — Lifecycle management (start, stop, status, restart). Manages the PID file at `~/.gnosys/sandbox/gnosys.pid` and logs output to `~/.gnosys/sandbox/sandbox.log`.

- **`src/sandbox/helper-template.ts`** — Template for generated helper libraries. Used when creating language-specific bindings for sandbox communication.

- **`src/sandbox/index.ts`** — Main exports for the sandbox subsystem.

### Development Workflow

1. Start the sandbox in dev mode:

   ```bash
   gnosys sandbox start
   ```

   In development, this automatically uses `npx tsx` for TypeScript execution without requiring a prior build step.

2. Check sandbox status:

   ```bash
   gnosys sandbox status
   ```

3. Stop the sandbox:

   ```bash
   gnosys sandbox stop
   ```

4. View logs:

   ```bash
   tail -f ~/.gnosys/sandbox/sandbox.log
   ```

### Key Locations

- **Socket:** `~/.gnosys/sandbox/gnosys.sock`
- **PID file:** `~/.gnosys/sandbox/gnosys.pid`
- **Logs:** `~/.gnosys/sandbox/sandbox.log`

## Project Structure

```
src/
  ├── cli.ts                 # CLI entry point
  ├── lib/
  │   ├── llm.ts            # LLM provider abstractions (Anthropic, Ollama, Groq, OpenAI, LM Studio)
  │   ├── maintenance.ts     # Memory decay, deduplication, consolidation, reinforcement
  │   ├── graph.ts           # Persistent wikilink graph
  │   ├── dashboard.ts       # System status aggregation
  │   └── ...
  ├── sandbox/
  │   ├── server.ts          # Unix domain socket server
  │   ├── client.ts          # Socket client library
  │   ├── manager.ts         # Lifecycle management
  │   ├── helper-template.ts # Helper library template
  │   └── index.ts           # Exports
  ├── test/                  # Shared test utilities
  └── prompts/               # System prompts
```

## Testing

### Test Structure

Test files follow the pattern `phase*.test.ts` and are co-located with their source files or grouped in the `src/test/` directory.

### Writing Tests

Gnosys uses **Vitest** as the test framework. Write tests in ESM syntax:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { YourClass } from '../path/to/file';

describe('YourClass', () => {
  it('should do something', () => {
    const result = YourClass.method();
    expect(result).toBe(expected);
  });
});
```

### Running Tests

Run all tests:

```bash
npm test
```

Run tests matching a pattern:

```bash
npm test -- phase1
```

Run a specific file:

```bash
npm test -- src/lib/graph.test.ts
```

Run tests in watch mode:

```bash
npm run test:watch
```

Generate coverage:

```bash
npm run test:coverage
```

### Test Conventions

- Use descriptive test names: `should validate email format correctly` not `test1`
- Group related tests with `describe` blocks
- Use `beforeEach` and `afterEach` for setup/teardown
- Mock external dependencies (database, file system, network calls)
- Aim for high coverage on critical paths (memory operations, graph logic, CLI commands)

## Code Style

### Module System

Gnosys uses **ESM modules** exclusively. Configure your editor to recognize ESM imports:

- Import with explicit file extensions: `import { x } from './file.js'`
- Use named exports by default: `export const myFunction = () => {}`
- Default exports are reserved for CLI entry points and major module exports

### TypeScript

- TypeScript runs in **strict mode** (`"strict": true`)
- No `any` types—use explicit unions or generics instead
- Validate inputs with **Zod** schemas whenever processing external data

Example:

```typescript
import { z } from 'zod';

const UserSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  email: z.string().email(),
});

type User = z.infer<typeof UserSchema>;

function createUser(data: unknown): User {
  return UserSchema.parse(data);
}
```

### Imports

Import order (no blank lines between groups):

```typescript
// Standard library
import { promises as fs } from 'fs';
import { dirname } from 'path';
// Third-party packages
import { z } from 'zod';
import sqlite3 from 'better-sqlite3';
// Project modules
import { LLMProvider } from '../lib/llm.js';
import { validateInput } from '../lib/validation.js';
```

### Naming

- Files: kebab-case (`sandbox-server.ts`)
- Classes: PascalCase (`SandboxManager`)
- Constants: UPPER_SNAKE_CASE (`DEFAULT_TIMEOUT`)
- Functions & variables: camelCase (`initializeDatabase`)

## Commits

Use **conventional commits** to write clear, atomic commits:

```
feat: add sandbox helper generation CLI command
fix: correct socket reconnection retry logic
docs: update sandbox development guide
chore: update dependencies
```

Write descriptive commit messages that explain **why** the change was made:

```
feat: add memory decay engine

Implement exponential decay for infrequently accessed memories to
optimize storage and retrieval performance. Decay rates are configurable
per vault and respect user preferences.

Closes #123
```

Always include the co-author trailer:

```
Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>
```

## Pull Requests

Provide a clear description of what changed and why:

```markdown
## Description
Brief summary of the change and its purpose.

## Type of Change
- [ ] New feature
- [ ] Bug fix
- [ ] Breaking change
- [ ] Documentation update

## Testing
- [ ] Unit tests added
- [ ] Integration tests added
- [ ] Manual testing completed

## Checklist
- [ ] Code follows style guidelines
- [ ] No TypeScript errors
- [ ] All tests pass
- [ ] CHANGELOG updated (if applicable)
```

### Requirements

- **All new features** must include corresponding tests
- **All tests must pass** before merging
- **No TypeScript errors** or linting issues
- **Conventional commit message** for the squash commit

## Database

Gnosys uses **better-sqlite3** for persistent storage. When working with the database:

- Use prepared statements to prevent SQL injection
- Handle connection lifecycle properly (open/close)
- Test database operations with temporary databases in tests
- Document schema changes in the CHANGELOG

## Performance Considerations

- The sandbox server handles concurrent IPC requests—test under load
- Memory operations should use the maintenance engine for optimization
- Graph operations are O(n) in worst case—profile before committing large graph changes
- LLM provider calls are I/O-bound—use async/await, not blocking calls

## Questions?

Open an issue or discussion on GitHub. We're here to help!

Happy coding.

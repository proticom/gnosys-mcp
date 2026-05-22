<p align="center">
  <img src="docs/logo.svg" alt="Gnosys" width="200">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/gnosys"><img src="https://img.shields.io/npm/v/gnosys.svg" alt="npm version"></a>
  <a href="https://github.com/proticom/gnosys/actions"><img src="https://github.com/proticom/gnosys/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://gnosys.ai"><img src="https://img.shields.io/badge/docs-gnosys.ai-C04C4C" alt="docs"></a>
  <a href="https://gnosys.ai/guide.html"><img src="https://img.shields.io/badge/CLI%20reference-gnosys.ai%2Fguide-555560" alt="user guide"></a>
  <a href="https://github.com/proticom/gnosys/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/gnosys.svg" alt="license"></a>
</p>

<p align="center">
  A <a href="https://proticom.com">Proticom</a> product. &nbsp;·&nbsp; <b><a href="https://gnosys.ai">gnosys.ai</a></b> is the source of truth for docs.
</p>

---

# Gnosys — One Brain. Zero Context Bloat.

**Gnosys gives AI agents persistent memory that survives across sessions, projects, and machines.**

The central brain is a single SQLite database at `~/.gnosys/gnosys.db` with sub-10ms reads — no vector DBs, no black boxes, no external services. Federated search ranks results across project, user, and global scopes. It runs as a CLI and as a full MCP server that drops straight into Claude Code, Claude Desktop (Chat / Cowork / Code), Cursor, Codex, Gemini CLI, Antigravity, Grok Build, or any MCP client. When you want a human-readable view, `gnosys export` regenerates a full Obsidian vault on demand.

## Install

```bash
npm install -g gnosys
gnosys setup          # configures provider, API key, and your IDE/agent
```

## Quick start

```bash
cd your-project
gnosys init                                              # register the project
gnosys add "We chose PostgreSQL over MySQL for JSON support"
gnosys recall "database selection"                       # what's relevant right now
gnosys chat                                              # memory-aware terminal chat
```

That's the 60-second tour. **Everything else lives on [gnosys.ai](https://gnosys.ai).**

## What you get

- **Central brain** — one `~/.gnosys/gnosys.db` unifies every project (project / user / global scopes). Sub-10ms reads, SQLite as the sole source of truth.
- **Federated search** — tier-boosted hybrid (FTS5 keyword + semantic) search across scopes, with recency and reinforcement.
- **MCP server** — `gnosys serve` exposes 50+ memory tools to any MCP client. Sandbox-first runtime keeps context cost near zero.
- **Web Knowledge Base** — `gnosys web build` turns any site into a searchable index for serverless chatbots. Zero runtime deps.
- **Dream Mode** — idle-time consolidation: confidence decay, summaries, relationship discovery. Never deletes — only suggests.
- **Multi-machine sync** — share your brain across machines; conflict detection with skip-and-flag resolution.
- **Obsidian export** — `gnosys export` regenerates a full vault with frontmatter, `[[wikilinks]]`, and graph data.

## Documentation

| | |
|---|---|
| **Full docs & guides** | <https://gnosys.ai> |
| **Complete CLI + MCP reference** | <https://gnosys.ai/guide.html> |
| **Changelog** | [CHANGELOG.md](./CHANGELOG.md) |
| **Contributing** | [CONTRIBUTING.md](./CONTRIBUTING.md) |
| **Security policy** | [SECURITY.md](./SECURITY.md) |
| **Report a bug / request a feature** | [GitHub Issues](https://github.com/proticom/gnosys/issues) |

## License

MIT © [Proticom](https://proticom.com). See [LICENSE](./LICENSE).

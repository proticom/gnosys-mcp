# Security Policy

Gnosys is a local-first memory layer for AI agents. It runs on your machine,
talks to an LLM provider you configure, and stores memories in a SQLite
database you control. Most of its attack surface is local, but we take
security seriously and welcome responsible disclosure.

## Supported Versions

Gnosys ships frequent patch releases. Security fixes land on the latest
published minor and are released as a new patch.

| Version | Supported          |
| ------- | ------------------ |
| Latest `5.x` (current) | ✅ |
| Older `5.x` | ⚠️ Upgrade to latest — `gnosys upgrade` |
| `< 5.0` | ❌ |

Always run the latest version: `npm install -g gnosys@latest` (or
`gnosys upgrade`). Check your version with `gnosys --version`.

## Reporting a Vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via GitHub's security advisory flow:

1. Go to <https://github.com/proticom/gnosys/security/advisories/new>
2. Describe the issue, affected version(s), and reproduction steps.

If you cannot use GitHub advisories, you may instead open a minimal public
issue that says only "security report — please open a private channel"
(no details) and we will follow up.

### What to include

- Affected version (`gnosys --version`) and OS
- A clear description of the vulnerability and its impact
- Step-by-step reproduction, ideally with a minimal example
- Any relevant logs (redact API keys, paths, and memory content)

### Response targets

- **Acknowledgement:** within 7 days
- **Triage + severity assessment:** within 14 days
- **Fix or mitigation plan:** communicated after triage; critical issues
  are prioritized for an out-of-band patch release

We will credit reporters in the release notes unless you prefer to remain
anonymous.

## Scope

In scope:

- The `gnosys` CLI and MCP server (`gnosys serve`)
- Memory storage, search, and the SQLite data layer
- Configuration handling (API keys, provider config, remote sync)
- The Web Knowledge Base export (`gnosys/web`)

Out of scope:

- Vulnerabilities in third-party LLM providers or their SDKs
- Issues requiring a pre-compromised local machine or root access
- Social-engineering or physical-access attacks
- Denial of service from intentionally malformed local input you supply
  to your own instance

## Handling secrets

Gnosys reads API keys from `~/.config/gnosys/.env` and provider config.
When reporting issues or sharing logs, **always redact API keys, absolute
paths that reveal your username, and the contents of private memories.**

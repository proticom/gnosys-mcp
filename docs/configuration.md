# Configuration

Gnosys reads settings from layered config files, environment variables, and machine-local files. When two sources disagree, the **higher-priority source wins**.

---

## Config file locations

| File | Scope |
|------|--------|
| `<project>/.gnosys/gnosys.json` | Project config (overrides global for keys it sets) |
| `~/.gnosys/gnosys.json` | Global/home config (inherited by projects) |
| `~/.config/gnosys/.env` | API keys and env overrides (loaded at startup into `process.env`) |
| `~/.config/gnosys/machine.json` | Machine-local identity, roots, remote sync path |

Project config inherits from global config: missing keys fall through to `~/.gnosys/gnosys.json`, then schema defaults.

---

## API key resolution (per provider)

When Gnosys needs an API key (Anthropic, OpenAI, Groq, etc.), it checks sources in this order:

1. **`gnosys.json`** — `llm.<provider>.apiKey`
2. **`GNOSYS_<PROVIDER>_KEY`** environment variable (e.g. `GNOSYS_ANTHROPIC_KEY`)
3. **macOS Keychain** — secure storage from setup (macOS only)
4. **GNOME Keyring** — via `secret-tool` (Linux, when available)
5. **Legacy env var** — e.g. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GROQ_API_KEY`
6. **`~/.config/gnosys/.env`** — values here are loaded at process startup, so they appear as env vars in steps 2 and 5

On **Windows**, use setup to store keys in your user environment or `~/.config/gnosys/.env` (Keychain-style storage is macOS/Linux only).

First match wins. Keys in `.env` are never printed to stdout.

---

## Provider / model resolution

For each task (`structuring`, `synthesis`, `vision`, `transcription`, `chat`, `dream`):

1. **`taskModels.<task>`** — per-task override (`provider` + `model`)
2. **`llm.defaultProvider`** + **`llm.<provider>.model`** — default provider block in `gnosys.json`
3. **Task-specific defaults** — e.g. structuring prefers a cheaper model for Anthropic/OpenAI when no override is set
4. **Schema defaults** — built-in fallbacks when nothing is configured

Use `taskModels` when one task needs a different model than the rest (e.g. cheap model for bulk import, flagship for chat).

---

## Store layering (search & write precedence)

Memory stores are resolved in specificity order:

| Layer | How it is found | Writable? |
|-------|------------------|-----------|
| **Project** | Auto-discovered `.gnosys/` under the current project | Yes (default write target) |
| **Optional** | `GNOSYS_STORES` (comma-separated paths) | Read-only |
| **Personal** | `GNOSYS_PERSONAL` | Yes (fallback write target) |
| **Global** | `GNOSYS_GLOBAL` | Writable only when explicitly targeted |

Search typically walks project → optional → personal → global. Writes go to the project store when present; otherwise personal, unless you target global explicitly.

---

## Machine-local config (`~/.config/gnosys/machine.json`)

These settings are **per machine** and are **not synced** to the shared brain:

| Field | Purpose |
|-------|---------|
| `machineId` | Stable UUID for this machine (remote sync, dream designation) |
| `roots` | Named absolute paths on this machine (e.g. `dev` → `/Users/you/projects`) |
| `remote` | This machine's NAS/Tailscale path to the remote `gnosys.db` |

### `GNOSYS_MACHINE_ID` override

Set `GNOSYS_MACHINE_ID` to pin a fixed machine ID across hostname changes or container restarts. When set, Gnosys uses it instead of regenerating `machineId` on hostname mismatch.

Without the override, if `machine.json` was copied from another machine (hostname mismatch), Gnosys regenerates `machineId` so two machines never share an identity.

---

## Related docs

- [Setup walkthrough](./setup-walkthrough.md) — first-run `gnosys setup`
- [LLM provider contract](./llm-provider-contract.md) — timeouts and provider behavior
- [Cost and limits](./cost-and-limits.md) — usage caps

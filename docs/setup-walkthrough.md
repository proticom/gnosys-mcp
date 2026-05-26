# Setup Walkthrough (First Run)

This guide walks through the **happy path** for `gnosys setup` on a clean machine — no existing `~/.config/gnosys/` and no existing `~/.gnosys/` brain yet.

Run from your project directory (or any directory where you want Gnosys configured):

```bash
gnosys setup
```

The wizard is interactive. On the happy path you mostly press **Enter** to accept defaults, or type **`1`** to pick the first numbered option.

---

## Before you start

| Check | Why |
|-------|-----|
| Node.js installed | Gnosys runs on Node |
| Empty `~/.config/gnosys/` | First-run config + API key storage |
| Empty `~/.gnosys/` | Central brain DB is created on first write |
| API key ready (cloud provider) | Anthropic/OpenAI/etc. need a key; Ollama/LM Studio do not |

---

## Splash — Welcome

**What you see:** Gnosys version banner, short intro, and the four high-level steps.

**Happy-path keystroke:** *(none — wizard continues automatically after pricing fetch)*

**What happens:** Gnosys fetches latest model pricing from OpenRouter (or falls back to bundled tiers if offline).

---

## Step 1/5 — LLM Provider (Screen 1.1)

**Prompt:** `Choose your LLM provider`

**Options:** Anthropic, OpenAI, Ollama, Groq, xAI, Mistral, LM Studio, Custom, or **Skip (core memory works without LLM)**.

**Happy-path keystroke:** `1` → **Anthropic** (first option)

**Writes:** nothing yet

---

## Step 2/5 — Model tier (Screen 1.2)

**Prompt:** `Choose model tier`

**Options:** Tier list with a **recommended** model marked, plus **Custom (enter model name)**.

**Happy-path keystroke:** `1` → first recommended tier (e.g. Claude Sonnet)

**Writes:** nothing yet

---

## Step 3/5 — API key (Screen 1.3)

**Prompt:** How to store your API key (macOS Keychain on Mac, GNOME Keyring on Linux, env var, or `~/.config/gnosys/.env`).

**Happy-path keystrokes:**

1. `1` → recommended secure storage (Keychain/Keyring on supported OS)
2. Paste your API key when prompted → **Enter**

If a key is already in the environment, Gnosys shows `Found existing key` — press **Enter** at `Change key storage? [y/N]` to keep it.

**Then:** Gnosys runs a live model test (`Testing anthropic/...`) and prints validation latency.

**Writes:** API key to chosen storage; may create `~/.config/gnosys/.env`

---

## Step 4/5 — Task routing

**Prompt:** Routing table for structuring, synthesis, vision, transcription, and dream — then:

```
1. Keep defaults (use <provider> for everything available)
2. Customize individual tasks
3. Use same provider for ALL tasks (including dream)
```

**Happy-path keystrokes:**

1. `1` → keep defaults
2. `Enable dream mode? [Y/n]` → **Enter** (yes) or `n` to skip for now
3. If dream enabled: `Keep ollama / default? [Y/n]` → **Enter**

**Writes:** nothing yet (config is saved in the next block after IDE setup)

---

## Step 5/5 — IDE integration

**Prompt:** Detected IDEs (Cursor, Claude Code, etc.) plus **All** and **Skip**.

**Happy-path keystroke:** `1` → first detected IDE (e.g. **Cursor (detected)**), or choose **Skip** if you will wire MCP manually later.

**What happens:** Gnosys writes MCP server entries for the selected IDE(s) and syncs global rules best-effort.

**Writes:** IDE-specific MCP config (e.g. `.cursor/mcp.json`, `~/.claude/CLAUDE.md` rules)

---

## Config save + summary

After IDE setup, Gnosys writes project/global config:

```
✓ Config written to <store>/.gnosys/gnosys.json
```

On a clean machine with no project store yet, this is typically **`~/.gnosys/gnosys.json`**. The central brain DB **`~/.gnosys/gnosys.db`** is created/updated as part of normal Gnosys operation.

**Optional — Multi-machine sync**

```
Configure remote sync now? [y/N]
```

**Happy-path keystroke:** **Enter** (skip for now)

**Final screen:** `Setup Complete` box listing provider, model, API key source, task routing, dream status, and configured IDEs.

**Next step printed:** run `gnosys init` in a project to register it with the brain.

---

## Optional follow-ups (separate commands)

These are **not** part of the main `gnosys setup` flow but match dedicated setup screens in the codebase.

### `gnosys setup models` — change provider/model later (Screen 3)

1. Pick provider → model
2. Live validation spinner
3. **Diff** of config changes
4. Confirm save → `gnosys.json` updated

**Happy path:** accept defaults with numbered choices + **Enter** on confirmations.

### `gnosys setup dream` — Dream Mode wizard (Screen 7)

Three sub-screens:

| Step | Prompt | Happy-path keystroke |
|------|--------|----------------------|
| 7.0 Enable | `enable Dream Mode?` | **Enter** (yes) |
| 7.1 Machine | `designate THIS machine (...) as the dreamer?` | **Enter** (yes) |
| 7.2 Thresholds | `press enter to accept defaults, or e to edit` | **Enter** |

**Writes:** dream settings in `gnosys.json`; `dream_machine_id` in central DB meta.

---

## Files created on a clean first run

| Path | Purpose |
|------|---------|
| `~/.config/gnosys/.env` | API keys / env overrides (if you chose plaintext or env setup) |
| `~/.gnosys/gnosys.db` | Central brain (SQLite) |
| `~/.gnosys/gnosys.json` | Global config (when no project `.gnosys/` yet) |
| `<project>/.gnosys/` | Project store (after `gnosys init` in that repo) |
| IDE MCP configs | e.g. `.cursor/mcp.json`, Claude/Codex config files |

---

## Quick reference — happy-path keystrokes

```
gnosys setup
  [auto] pricing fetch
  1      → Anthropic (provider)
  1      → recommended model tier
  1      → store API key securely → paste key → Enter
  [auto] model validation
  1      → keep task routing defaults
  Enter  → enable dream (or n to skip)
  Enter  → keep dream provider defaults
  1      → configure first detected IDE (or Skip)
  Enter  → skip remote sync
  [done] Setup Complete
```

Then in your repo:

```bash
gnosys init
```

/**
 * Setup: User Preferences.
 *
 * v5.6.0 noted 4 imported user-scope memories that looked like prefs.
 * v5.8.4 reshape: this wizard now manages actual preferences (memories
 * with category=preferences, scope=user — the same shape `gnosys pref
 * set` writes). Previous version listed ALL user-scope memories
 * regardless of category, mixing imported notes with real preferences
 * and producing a "0 stored" + "no actions available" dead end even
 * when the user had user-scope memories.
 *
 * The wizard now lets you:
 *   - List existing preferences (filtered to category=preferences)
 *   - Set a new preference inline (key + value)
 *   - View / delete an existing preference
 */

import { Interface as ReadlineInterface } from "readline/promises";
import { GnosysDB, type DbMemory } from "../../db.js";
import {
  setPreference,
  deletePreference,
  KNOWN_PREFERENCE_KEYS,
} from "../../preferences.js";
import { safeQuestion } from "../ui/safePrompt.js";

const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

export interface UserPreference {
  id: string;
  key: string;
  title: string;
  value: string;
  created: string;
  modified: string;
  source: "gnosys-native" | "imported" | "unknown";
}

/** Inspect a memory ID and classify it. v5.x gnosys uses `prefix-ULID` or `pref-<key>`. */
function classifyId(id: string): UserPreference["source"] {
  if (/^pref-[a-z0-9-]+$/.test(id)) return "gnosys-native"; // explicit pref ID
  if (/^[a-z]+-[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return "gnosys-native"; // ULID format
  if (/^mem-\d+-[a-z0-9]+$/.test(id)) return "imported"; // pre-gnosys timestamp+random
  return "unknown";
}

function memoryToUserPreference(m: DbMemory): UserPreference {
  // pref-<key> id pattern → strip prefix; otherwise fall back to id as key.
  const key = m.id.startsWith("pref-") ? m.id.slice("pref-".length) : m.id;
  // Strip the leading "# Title\n\n" from content if present, leaving just the value.
  const stripped = m.content.replace(/^#\s+[^\n]+\n+/, "").trim();
  return {
    id: m.id,
    key,
    title: m.title,
    value: stripped || m.content,
    created: m.created,
    modified: m.modified,
    source: classifyId(m.id),
  };
}

/**
 * Load every user-scope memory — both native preferences (category =
 * preferences, written by `gnosys pref set`) AND imported notes
 * (other categories, brought in from a prior tool).
 *
 * v5.8.4 narrowed this to category=preferences only, which made
 * imported user-scope memories disappear from the wizard ("0 stored"
 * even when the user had legitimate imports). v5.9.1 widens it back
 * to all user-scope memories, but tags each entry's `source` so the
 * UI can distinguish.
 */
export async function listUserPreferences(): Promise<UserPreference[]> {
  const db = GnosysDB.openCentral();
  if (!db.isAvailable()) {
    db.close();
    return [];
  }
  try {
    const mems: DbMemory[] = db
      .getMemoriesByScope("user")
      .filter((m) => m.status === "active");
    return mems.map(memoryToUserPreference);
  } finally {
    db.close();
  }
}

async function setNewPreference(rl: ReadlineInterface): Promise<boolean> {
  console.log("");
  console.log(`${BOLD}New preference${RESET}`);
  console.log(
    `${DIM}Known keys: ${KNOWN_PREFERENCE_KEYS.slice(0, 5).join(", ")}, ...${RESET}`,
  );
  console.log(`${DIM}You can also use any custom key — just keep it kebab-case.${RESET}`);
  console.log("");

  const key = (await safeQuestion(rl, "Key (e.g. code-style): ")).trim();
  if (!key) {
    console.log(`${DIM}Cancelled.${RESET}`);
    return false;
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) {
    console.log(`${RED}Invalid key — use lowercase letters, digits, and dashes only.${RESET}`);
    return false;
  }

  const value = (await safeQuestion(rl, "Value (one line or short paragraph): ")).trim();
  if (!value) {
    console.log(`${DIM}Cancelled.${RESET}`);
    return false;
  }

  const db = GnosysDB.openCentral();
  try {
    setPreference(db, key, value);
    console.log(`${GREEN}✓${RESET} Set ${key}`);
    return true;
  } catch (err) {
    console.log(`${RED}✗${RESET} Failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    db.close();
  }
}

async function viewAndMaybeDelete(rl: ReadlineInterface, pref: UserPreference): Promise<boolean> {
  console.log("");
  console.log(`${BOLD}${pref.title}${RESET}`);
  console.log(`${DIM}key: ${pref.key}  id: ${pref.id}${RESET}`);
  console.log(`${DIM}source: ${pref.source}  created: ${pref.created.slice(0, 10)}${RESET}`);
  console.log("");
  console.log(pref.value);
  console.log("");

  // v5.9.1 (#99): add [E]dit action. Edits use setPreference to overwrite
  // the existing memory in place (id pref-<key> stays stable, value
  // replaced, modified bumped to now). For imported memories with
  // legacy ids (mem-<timestamp>-<rand>), edit isn't available since
  // setPreference would create a NEW pref-<key> entry rather than
  // mutating the legacy row.
  const isEditable = pref.id.startsWith("pref-");
  const menu = isEditable ? "[E]dit · [D]elete · [K]eep · [B]ack> " : "[D]elete · [K]eep · [B]ack> ";
  const action = (await safeQuestion(rl, menu)).trim().toLowerCase();

  if (isEditable && (action === "e" || action === "edit")) {
    const newValue = (await safeQuestion(rl, `New value for ${pref.key} (empty = cancel): `)).trim();
    if (!newValue) {
      console.log(`${DIM}Cancelled.${RESET}`);
      return false;
    }
    const db = GnosysDB.openCentral();
    try {
      setPreference(db, pref.key, newValue);
      console.log(`${GREEN}✓${RESET} Updated ${pref.key}`);
      return true;
    } catch (err) {
      console.log(`${RED}✗${RESET} Failed: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    } finally {
      db.close();
    }
  }

  if (action !== "d" && action !== "delete") return false;

  const confirm = (await safeQuestion(rl, `Delete "${pref.title}"? [y/N] `)).trim().toLowerCase();
  if (confirm !== "y" && confirm !== "yes") return false;

  const db = GnosysDB.openCentral();
  try {
    const ok = deletePreference(db, pref.key);
    if (ok) {
      console.log(`${GREEN}✓${RESET} Deleted ${pref.id}`);
      return true;
    }
    // Fall back to direct memory delete for non-standard ids.
    db.deleteMemory(pref.id);
    console.log(`${GREEN}✓${RESET} Deleted ${pref.id} (legacy id format)`);
    return true;
  } catch (err) {
    console.log(`${RED}✗${RESET} Failed: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  } finally {
    db.close();
  }
}

/**
 * Run the interactive preferences review. Returns true if anything was
 * changed (added, edited, or deleted).
 *
 * v5.9.3 redesign (Screen 9):
 *   - Header() + breadcrumb with `N stored` suffix.
 *   - Two source dots: ● (filled, accent) = gnosys-native, ○ (hollow,
 *     text-dim) = imported/unknown (collapsed from 3 source colors per
 *     design §9.1).
 *   - Footer atom for the action hint.
 *   - One preview line per row, no truncation marker.
 */
export async function runPreferencesReview(rl: ReadlineInterface): Promise<boolean> {
  const { Header } = await import("../ui/header.js");
  const { Footer } = await import("../ui/footer.js");
  const { Status } = await import("../ui/status.js");
  const { c, color, glyph } = await import("../ui/tokens.js");

  let anyChange = false;

  while (true) {
    const current = await listUserPreferences();

    console.log("");
    console.log(Header(["gnosys", "setup", "preferences"], { version: `${current.length} stored` }));
    console.log("");
    if (current.length === 0) {
      console.log(`   ${color(c.text, "User preferences")}`);
      console.log(`   ${color(c.textMid, "things you've told gnosys to remember about how you work")}`);
      console.log("");
      console.log(`   ${color(c.textDim, "nothing stored yet.")}`);
    } else {
      current.forEach((p, i) => {
        const isNative = p.source === "gnosys-native";
        const dot = isNative ? color(c.accent, glyph.dotFilled) : color(c.textDim, glyph.dotHollow);
        const num = color(c.textDim, String(i + 1).padStart(2, " "));
        const key = color(c.text, p.key.padEnd(14));
        // Hard-truncate at col 80 without a marker per design §9.2.
        const preview = p.value.replace(/\s+/g, " ").trim();
        const previewColored = color(c.textMid, preview);
        console.log(`   ${num}  ${dot} ${key}  ${previewColored}`);
      });
      console.log("");
      console.log(`   ${color(c.accent, glyph.dotFilled)} ${color(c.textDim, "added by you")}           ${color(c.textDim, glyph.dotHollow)} ${color(c.textDim, "imported / unknown")}`);
    }
    console.log("");
    const hint = current.length === 0
      ? "n · new    b · back"
      : `1–${current.length} · open    n · new    b · back`;
    console.log(Footer(hint));

    const answer = (await safeQuestion(rl, ` ${color(c.accent, glyph.prompt)} `)).trim().toLowerCase();
    if (!answer || answer === "b" || answer === "back") return anyChange;

    if (answer === "n" || answer === "new") {
      if (await setNewPreference(rl)) anyChange = true;
      continue;
    }

    const idx = parseInt(answer, 10) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= current.length) {
      console.log(Status("warn", `unknown choice: ${answer}`));
      continue;
    }

    if (await viewAndMaybeDelete(rl, current[idx])) anyChange = true;
  }
}

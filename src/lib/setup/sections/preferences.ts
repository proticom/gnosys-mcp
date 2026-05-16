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
  getAllPreferences,
  deletePreference,
  KNOWN_PREFERENCE_KEYS,
} from "../../preferences.js";

const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
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
 * Load every preference (memories with category=preferences AND scope=user).
 *
 * v5.8.4: now filters to category=preferences — matches what `setPreference`
 * writes and what `getAllPreferences` reads.
 */
export async function listUserPreferences(): Promise<UserPreference[]> {
  const db = GnosysDB.openCentral();
  if (!db.isAvailable()) {
    db.close();
    return [];
  }
  try {
    // getAllPreferences already filters to category=preferences + scope=user.
    // Walk to raw memories via getMemory so we can build the UserPreference
    // shape (which includes id, created/modified — fields not on Preference).
    const refs = getAllPreferences(db);
    return refs
      .map((p) => {
        const mem = db.getMemory(`pref-${p.key}`);
        return mem ? memoryToUserPreference(mem) : null;
      })
      .filter((p): p is UserPreference => p !== null);
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

  const key = (await rl.question("Key (e.g. code-style): ")).trim();
  if (!key) {
    console.log(`${DIM}Cancelled.${RESET}`);
    return false;
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(key)) {
    console.log(`${RED}Invalid key — use lowercase letters, digits, and dashes only.${RESET}`);
    return false;
  }

  const value = (await rl.question("Value (one line or short paragraph): ")).trim();
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

  const action = (await rl.question("[K]eep · [D]elete · [B]ack> ")).trim().toLowerCase();
  if (action !== "d" && action !== "delete") return false;

  const confirm = (await rl.question(`Delete "${pref.title}"? [y/N] `)).trim().toLowerCase();
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
 */
export async function runPreferencesReview(rl: ReadlineInterface): Promise<boolean> {
  let anyChange = false;

  while (true) {
    const current = await listUserPreferences();

    console.log("");
    console.log(`${BOLD}User Preferences${RESET}`);
    if (current.length === 0) {
      console.log(`${DIM}No preferences set. Pick [N] to add one.${RESET}`);
    } else {
      current.forEach((p, i) => {
        const tag =
          p.source === "imported"
            ? `${YELLOW}imported${RESET}`
            : p.source === "gnosys-native"
              ? `${GREEN}native${RESET}`
              : `${YELLOW}unknown${RESET}`;
        const preview = p.value.replace(/\s+/g, " ").trim().slice(0, 60);
        console.log(`  ${i + 1}. [${tag}] ${BOLD}${p.key}${RESET} — ${p.title}`);
        console.log(`       ${DIM}${preview}${preview.length === 60 ? "..." : ""}${RESET}`);
      });
    }
    console.log("");
    console.log(
      `  [${BOLD}N${RESET}]ew · [${BOLD}1-${current.length || "N"}${RESET}] view/delete · [${BOLD}B${RESET}]ack`,
    );

    const answer = (await rl.question("> ")).trim().toLowerCase();
    if (!answer || answer === "b" || answer === "back") return anyChange;

    if (answer === "n" || answer === "new") {
      if (await setNewPreference(rl)) anyChange = true;
      continue;
    }

    const idx = parseInt(answer, 10) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= current.length) {
      console.log(`${DIM}Unknown choice: ${answer}${RESET}`);
      continue;
    }

    if (await viewAndMaybeDelete(rl, current[idx])) anyChange = true;
  }
}

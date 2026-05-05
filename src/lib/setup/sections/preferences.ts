/**
 * Setup: User Preferences review.
 *
 * v5.6.0 dogfooding turned up 4 user preferences in the central DB the user
 * didn't recall setting. Investigation: they were imported on 2026-03-25
 * from an external source (their prior memory tool / CLAUDE.md content).
 * Their IDs use the format `mem-<timestamp>-<random>` rather than the
 * gnosys-native `prefix-ULID` pattern.
 *
 * This wizard lists every user-scope preference and lets the user
 * keep / edit / delete each one — closing the loop on those mystery prefs
 * and giving people a place to manage user-scope config going forward.
 */

import { Interface as ReadlineInterface } from "readline/promises";
import { GnosysDB, type DbMemory } from "../../db.js";

const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

export interface UserPreference {
  id: string;
  title: string;
  content: string;
  created: string;
  modified: string;
  source: "gnosys-native" | "imported" | "unknown";
}

/** Inspect a memory ID and classify it. v5.x gnosys uses `prefix-ULID` (26-char Crockford). */
function classifyId(id: string): UserPreference["source"] {
  if (/^pref-[a-z0-9-]+$/.test(id)) return "gnosys-native"; // explicit pref ID
  if (/^[a-z]+-[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return "gnosys-native"; // ULID format
  if (/^mem-\d+-[a-z0-9]+$/.test(id)) return "imported"; // pre-gnosys timestamp+random
  return "unknown";
}

/** Load every user-scope memory from the central DB (preferences are scope='user'). */
export async function listUserPreferences(): Promise<UserPreference[]> {
  const db = GnosysDB.openCentral();
  if (!db.isAvailable()) {
    db.close();
    return [];
  }
  try {
    const memories: DbMemory[] = db.getMemoriesByScope("user");
    return memories.map((m) => ({
      id: m.id,
      title: m.title,
      content: m.content,
      created: m.created,
      modified: m.modified,
      source: classifyId(m.id),
    }));
  } finally {
    db.close();
  }
}

/**
 * Run the interactive preferences review. Returns true if anything was
 * changed (deleted or edited).
 */
export async function runPreferencesReview(rl: ReadlineInterface): Promise<boolean> {
  const prefs = await listUserPreferences();
  let anyChange = false;

  if (prefs.length === 0) {
    console.log(`${DIM}No user-scope preferences stored.${RESET}`);
    console.log(`${DIM}Set one with: gnosys pref set <key> <value>${RESET}`);
    return false;
  }

  while (true) {
    // Reload each iteration since deletions change the list
    const current = await listUserPreferences();
    if (current.length === 0) return anyChange;

    console.log("");
    console.log("User-scope preferences:");
    current.forEach((p, i) => {
      const tag = p.source === "imported"
        ? `${YELLOW}imported${RESET}`
        : p.source === "gnosys-native"
          ? `${GREEN}native${RESET}`
          : `${YELLOW}unknown${RESET}`;
      const preview = p.content.replace(/\s+/g, " ").trim().slice(0, 60);
      console.log(`  ${i + 1}. [${tag}] ${p.title}`);
      console.log(`       ${DIM}${p.id}${RESET}`);
      console.log(`       ${DIM}${preview}${preview.length === 60 ? "..." : ""}${RESET}`);
    });
    console.log("");
    console.log(`  Pick a number to view/delete · ${DIM}b/back${RESET} to exit`);

    const answer = (await rl.question("> ")).trim().toLowerCase();
    if (!answer || answer === "b" || answer === "back") return anyChange;

    const idx = parseInt(answer, 10) - 1;
    if (Number.isNaN(idx) || idx < 0 || idx >= current.length) {
      console.log(`${DIM}Unknown choice: ${answer}${RESET}`);
      continue;
    }

    const pref = current[idx];

    // Show full pref + offer Keep / Delete
    console.log("");
    console.log(`${pref.title}`);
    console.log(`${DIM}id: ${pref.id}  source: ${pref.source}  created: ${pref.created.slice(0, 10)}${RESET}`);
    console.log("");
    console.log(pref.content);
    console.log("");
    const action = (await rl.question("[K]eep · [D]elete · [B]ack> ")).trim().toLowerCase();

    if (action === "d" || action === "delete") {
      const confirm = (await rl.question(`Delete "${pref.title}"? [y/N] `)).trim().toLowerCase();
      if (confirm === "y" || confirm === "yes") {
        const db = GnosysDB.openCentral();
        try {
          db.deleteMemory(pref.id);
          db.logAudit({
            timestamp: new Date().toISOString(),
            operation: "delete",
            memory_id: pref.id,
            details: JSON.stringify({ source: "setup-preferences-review" }),
            duration_ms: null,
            trace_id: null,
          });
          console.log(`${GREEN}✓${RESET} Deleted ${pref.id}`);
          anyChange = true;
        } catch (err) {
          console.log(`${RED}✗${RESET} Failed: ${err instanceof Error ? err.message : String(err)}`);
        } finally {
          db.close();
        }
      }
    }
  }
}

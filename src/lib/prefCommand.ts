import { GnosysDB } from "./db.js";
import {
  deletePreference,
  getAllPreferences,
  getPreference,
  KNOWN_PREFERENCE_KEYS,
  setPreference,
  suggestPreferenceKey,
} from "./preferences.js";

export type PrefSetCommandOptions = {
  title?: string;
  tags?: string;
};

export type PrefGetCommandOptions = {
  json?: boolean;
};

function outputPrefResult(json: boolean, data: unknown, humanFn: () => void): void {
  if (json) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    humanFn();
  }
}

export async function runPrefSetCommand(
  key: string,
  value: string,
  opts: PrefSetCommandOptions,
): Promise<void> {
  let centralDb: GnosysDB | null = null;
  try {
    centralDb = GnosysDB.openCentral();
    if (!centralDb.isAvailable()) {
      console.error("Central DB not available (better-sqlite3 missing).");
      process.exitCode = 1;
      return;
    }

    if (!(KNOWN_PREFERENCE_KEYS as readonly string[]).includes(key)) {
      const suggestion = suggestPreferenceKey(key);
      if (suggestion) {
        console.error(`Unknown preference key \`${key}\` — did you mean \`${suggestion}\`?`);
        process.exitCode = 1;
        return;
      }
    }

    const tags = opts.tags ? opts.tags.split(",").map((t) => t.trim()) : undefined;
    const pref = setPreference(centralDb, key, value, { title: opts.title, tags });
    console.log(`Preference set: ${pref.title}`);
    console.log(`  Key:   ${pref.key}`);
    console.log(`  Value: ${pref.value}`);
    console.log(`\nRun 'gnosys sync' to update agent rules files.`);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    return;
  } finally {
    centralDb?.close();
  }
}

export async function runPrefGetCommand(
  key: string | undefined,
  opts: PrefGetCommandOptions,
): Promise<void> {
  let centralDb: GnosysDB | null = null;
  try {
    centralDb = GnosysDB.openCentral();
    if (!centralDb.isAvailable()) {
      console.error("Central DB not available (better-sqlite3 missing).");
      process.exitCode = 1;
      return;
    }

    if (key) {
      const pref = getPreference(centralDb, key);
      if (!pref) {
        console.log(`No preference found for key "${key}".`);
        return;
      }
      outputPrefResult(!!opts.json, pref, () => {
        console.log(`${pref.title} (${pref.key})\n`);
        console.log(pref.value);
        console.log(`\nConfidence: ${pref.confidence}`);
        console.log(`Modified: ${pref.modified}`);
      });
    } else {
      const prefs = getAllPreferences(centralDb);
      if (prefs.length === 0) {
        outputPrefResult(!!opts.json, { preferences: [] }, () => {
          console.log("No preferences set. Use 'gnosys pref set <key> <value>' to add some.");
        });
        return;
      }
      outputPrefResult(!!opts.json, { count: prefs.length, preferences: prefs }, () => {
        console.log(`${prefs.length} user preference(s):\n`);
        for (const p of prefs) {
          console.log(`  ${p.title} (${p.key})`);
          console.log(`    ${p.value.split("\n")[0]}`);
          console.log();
        }
      });
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    return;
  } finally {
    centralDb?.close();
  }
}

export async function runPrefDeleteCommand(key: string): Promise<void> {
  let centralDb: GnosysDB | null = null;
  try {
    centralDb = GnosysDB.openCentral();
    if (!centralDb.isAvailable()) {
      console.error("Central DB not available (better-sqlite3 missing).");
      process.exitCode = 1;
      return;
    }

    const deleted = deletePreference(centralDb, key);
    if (!deleted) {
      console.log(`No preference found for key "${key}".`);
      return;
    }
    console.log(`Preference "${key}" deleted.`);
    console.log(`Run 'gnosys sync' to update agent rules files.`);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
    return;
  } finally {
    centralDb?.close();
  }
}

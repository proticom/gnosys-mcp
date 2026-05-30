/**
 * Filter for the npm output that `gnosys upgrade` streams to the user.
 *
 * `npm install -g gnosys@latest` prints two deprecation warnings that we can
 * do nothing about and that are harmless:
 *
 *   npm warn deprecated prebuild-install@7.1.3: No longer maintained ...
 *   npm warn deprecated boolean@3.2.0: Package no longer supported ...
 *
 * Both come from OPTIONAL native dependencies, and both packages are deprecated
 * at their latest published version with no non-deprecated successor:
 *   - prebuild-install  ← better-sqlite3 (the SQLite engine; even the newest
 *                         better-sqlite3 still depends on prebuild-install)
 *   - boolean           ← global-agent ← onnxruntime-node ← @huggingface/transformers
 *
 * Since there's no version we can move to, we strip exactly these two lines
 * from the upgrade output so it stays clean. We deliberately match the specific
 * package names: any OTHER deprecation (a genuinely new one we'd want to act
 * on) still passes through untouched.
 */

/** Transitive packages whose deprecation warning we knowingly suppress. */
export const SUPPRESSED_DEPRECATED_PACKAGES = ["prebuild-install", "boolean"];

/** True if `line` is one of the known-benign npm deprecation warnings. */
export function isSuppressedNpmLine(line: string): boolean {
  if (!/npm warn deprecated/i.test(line)) return false;
  return SUPPRESSED_DEPRECATED_PACKAGES.some((pkg) => line.includes(`deprecated ${pkg}@`));
}

export interface NpmStderrFilter {
  /** Feed a raw stderr chunk; complete non-suppressed lines are written out. */
  feed(chunk: string): void;
  /** Flush any trailing partial line at process end. */
  end(): void;
}

/**
 * Line-buffered stderr filter. npm streams warnings as it resolves the tree, so
 * we buffer partial lines across chunks, drop the suppressed ones, and forward
 * everything else immediately (no waiting for the whole install to finish).
 */
export function makeNpmStderrFilter(write: (text: string) => void): NpmStderrFilter {
  let leftover = "";
  return {
    feed(chunk: string): void {
      leftover += chunk;
      const lines = leftover.split("\n");
      // The last element is an incomplete line (no trailing newline yet).
      leftover = lines.pop() ?? "";
      for (const line of lines) {
        if (!isSuppressedNpmLine(line)) write(`${line}\n`);
      }
    },
    end(): void {
      if (leftover.length > 0) {
        if (!isSuppressedNpmLine(leftover)) write(leftover);
        leftover = "";
      }
    },
  };
}

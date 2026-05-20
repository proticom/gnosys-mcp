/**
 * Render helpers for `gnosys setup models` (Screen 3).
 *
 * Currently only owns the small pre-save diff-row builder. The rest of
 * the screen's chrome (Header, Title, Spinner, Diff, Status) lives in
 * `runModelsSetup` and is composed inline so we don't drag the entire
 * provider/model picker through a render layer it doesn't need.
 */

export interface ModelDiffRow {
  label: string;
  from: string;
  to: string;
}

/**
 * Build the Diff rows for the pre-save block. Always returns at least
 * two rows (`provider` + `model`) so the user can see what landed in
 * gnosys.json, even when nothing actually changed.
 *
 * - If the new provider differs from the current one, emit the row.
 * - If the new model differs from the current one, emit the row.
 * - When neither changed, emit two rows showing the (unchanged) values
 *   so the diff block isn't empty.
 */
export function buildModelsDiffRows(
  currentProvider: string | undefined,
  currentModel: string | undefined,
  newProvider: string,
  newModel: string,
): ModelDiffRow[] {
  const rows: ModelDiffRow[] = [];
  if (currentProvider && currentProvider !== newProvider) {
    rows.push({ label: "provider", from: currentProvider, to: newProvider });
  }
  if (currentModel && currentModel !== newModel) {
    rows.push({ label: "model", from: currentModel, to: newModel });
  }
  if (rows.length === 0) {
    rows.push({ label: "provider", from: currentProvider ?? "(unset)", to: newProvider });
    rows.push({ label: "model", from: currentModel ?? "(unset)", to: newModel });
  }
  return rows;
}

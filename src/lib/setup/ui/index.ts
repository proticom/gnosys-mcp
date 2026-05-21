/**
 * Public re-exports for the gnosys CLI UI atoms (v5.9.3 redesign).
 *
 * Always import from this module — never reach into individual files from
 * outside `setup/ui/`. That keeps the atom boundaries clean and lets us
 * rework internals (e.g. swap truecolor detection) without ripple.
 */

export { c, color, glyph, COLS, width, TRUECOLOR, RESET } from "./tokens.js";
export type { ColorTokens } from "./tokens.js";

export { Header, printHeader, stripAnsi } from "./header.js";
export type { HeaderOptions } from "./header.js";

export { Title, printTitle } from "./title.js";

export { Menu, printMenu } from "./menu.js";
export type { MenuItem } from "./menu.js";

export { Prompt } from "./prompt.js";
export type { PromptOptions } from "./prompt.js";

export { Status, printStatus } from "./status.js";
export type { StatusKind } from "./status.js";

export { Diff, printDiff } from "./diff.js";
export type { DiffRow } from "./diff.js";

export { Panel, printPanel } from "./panel.js";
export type { PanelOptions } from "./panel.js";

export { Spinner } from "./spinner.js";
export type { SpinnerHandle } from "./spinner.js";

export { Footer, printFooter } from "./footer.js";

export { renderTable, printTable } from "./table.js";
export type { TableColumn, TableOptions } from "./table.js";

declare module "csv-parse/sync" {
  export interface SyncParseOptions {
    columns?: boolean | string[] | ((header: string[]) => string[]);
    skip_empty_lines?: boolean;
    trim?: boolean;
    delimiter?: string | Buffer | (string | Buffer)[];
    quote?: string | boolean | Buffer | null;
    escape?: string | Buffer | null;
    comment?: string | Buffer;
    from?: number;
    to?: number;
    from_line?: number;
    to_line?: number;
    [option: string]: unknown;
  }

  export function parse(
    input: string | Buffer,
    options?: SyncParseOptions
  ): Record<string, unknown>[];
}

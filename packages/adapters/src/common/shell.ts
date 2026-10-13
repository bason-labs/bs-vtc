/** POSIX shell helpers for command strings a host runs through a shell (e.g. a statusline). */

/** `value` as one single-quoted shell word. */
export const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

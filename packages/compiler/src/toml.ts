/** The small TOML subset the Codex agent files need: string values, single- or multi-line. */

const hex4 = (code: number): string => code.toString(16).toUpperCase().padStart(4, "0");

/** Escapes everything TOML basic strings forbid; `keepNewlines` leaves `\n` raw (multi-line). */
const escapeBasic = (value: string, keepNewlines: boolean): string => {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\\") out += "\\\\";
    else if (char === '"') out += '\\"';
    else if (char === "\n") out += keepNewlines ? "\n" : "\\n";
    else if (char === "\t") out += "\\t";
    else if (char === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) out += `\\u${hex4(code)}`;
    else out += char;
  }
  return out;
};

/** A TOML basic string literal for `value`, e.g. `"say \"hi\""`. */
export const tomlString = (value: string): string => `"${escapeBasic(value, false)}"`;

/**
 * A TOML multi-line basic string for `value`. Every `"` is escaped, so no `"""` can end the
 * string early; the newline after the opening delimiter is trimmed by TOML parsers.
 */
export const tomlMultiline = (value: string): string => `"""\n${escapeBasic(value, true)}"""`;

/** A TOML array of basic strings, e.g. `["a", "b"]`. */
export const tomlStringArray = (values: readonly string[]): string =>
  `[${values.map(tomlString).join(", ")}]`;

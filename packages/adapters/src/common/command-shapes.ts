/**
 * The shapes of a role run's shell calls (D-cs, spine §5 reading 221). Pure. Each host stream
 * names the command a shell call ran: Claude's `Bash` `tool_use` input (a shell script) and
 * Codex's `command_execution` item (a command line, `bash -lc ls` in the documented sample, or an
 * argv array). This module turns one such command into `commandShapes` from `@vtc/shared` and
 * keeps nothing else: no argument value, no path, no raw text leaves it.
 *
 * A shell wrapper (`bash -lc '<script>'`, `/bin/zsh -c '<script>'`) is unwrapped first, so the
 * shapes are the script's (`git status`), not the wrapper's (`<path>` with `-lc`). An argv array is
 * joined with spaces, each element that is not a plain word single-quoted, so an argument with
 * spaces stays one word.
 */
import { commandShapes, type CommandShape } from "@vtc/shared";

/** Shells whose `-c` (alone or among other one-letter flags, `-lc`) takes a script. */
const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const SCRIPT_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/u;
const PLAIN_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/u;

const shellQuote = (word: string): string =>
  word !== "" && PLAIN_WORD.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * The first `max` words of a command line, quotes removed (single quotes literal, double quotes
 * with backslash escapes, a backslash outside quotes escapes one character); stops at the first
 * unquoted shell operator. Lenient: an unclosed quote runs to the end.
 */
const leadingWords = (line: string, max: number): string[] => {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  for (let i = 0; i < line.length && words.length < max; i += 1) {
    const c = line[i] ?? "";
    if (c === "\\" && i + 1 < line.length) {
      word += line[i + 1] ?? "";
      inWord = true;
      i += 1;
    } else if (c === "'") {
      const end = line.indexOf("'", i + 1);
      const stop = end < 0 ? line.length : end;
      word += line.slice(i + 1, stop);
      inWord = true;
      i = stop;
    } else if (c === '"') {
      inWord = true;
      for (i += 1; i < line.length && line[i] !== '"'; i += 1) {
        if (line[i] === "\\" && i + 1 < line.length && '"\\$`'.includes(line[i + 1] ?? "")) i += 1;
        word += line[i] ?? "";
      }
    } else if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else if (";&|()<>".includes(c)) {
      break;
    } else {
      word += c;
      inWord = true;
    }
  }
  if (inWord && words.length < max) words.push(word);
  return words;
};

const baseName = (program: string): string => program.slice(program.lastIndexOf("/") + 1);

/** The script a `<shell> -c <script>` wrapper runs, or null when `words` is not one. */
const wrappedScript = (words: readonly string[]): string | null => {
  const [program, flag, script] = words;
  if (program === undefined || flag === undefined || script === undefined) return null;
  return SHELLS.has(baseName(program)) && SCRIPT_FLAG.test(flag) ? script : null;
};

/** The shell text a host's command field stands for: a string, or an argv array of strings. */
const commandText = (command: unknown): string | null => {
  if (typeof command === "string") {
    return wrappedScript(leadingWords(command, 3)) ?? command;
  }
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
    const argv = command as readonly string[];
    return wrappedScript(argv) ?? argv.map(shellQuote).join(" ");
  }
  return null;
};

/**
 * Pure: the shapes of one shell call, from a host's command field (a string or an argv array);
 * none for anything else. Only `commandShapes` output is returned (D-cs).
 */
export const shellCallShapes = (command: unknown): CommandShape[] => {
  const textOf = commandText(command);
  return textOf === null || textOf.trim() === "" ? [] : commandShapes(textOf);
};

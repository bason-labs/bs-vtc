/**
 * The shapes of a role run's shell calls (D-cs, spine §5 reading 221). Pure. Each host stream
 * names the command a shell call ran: Claude's `Bash` `tool_use` input (a shell script) and
 * Codex's `command_execution` item (a command line, `bash -lc ls` in the documented sample, or an
 * argv array). This module turns one such command into `commandShapes` from `@vtc/shared` and
 * keeps nothing else of it: only what `commandShapes` keeps leaves (the program, flag names
 * hashed, and the word after the program as `subcommand` when it is a plain lower-case word,
 * which for a program without subcommands can be an argument value, `echo hunter2`; that is the
 * shared contract's rule, pinned in `command-shapes.test.ts`, not this module's to change).
 *
 * A shell wrapper (`bash -lc '<script>'`, `/bin/zsh -c '<script>'`) is unwrapped first, so the
 * shapes are the script's (`git status`), not the wrapper's (`<path>` with `-lc`); commands after
 * the wrapper on the same line are shaped too. An argv array is joined with spaces, each element
 * that is not a plain word single-quoted, so an argument with spaces stays one word. The cli's
 * in-session hook (`vtc hook pre-tool-use`, reading 221) should shape a call through this same
 * function (exported from `@vtc/adapters`), so a headless and an in-session call count alike.
 */
import { commandShapes, MAX_SHAPES_PER_COMMAND, type CommandShape } from "@vtc/shared";

/** Shells whose `-c` (alone or among other one-letter flags, `-lc`) takes a script. */
const SHELLS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const SCRIPT_FLAG = /^-[A-Za-z]*c[A-Za-z]*$/u;
const PLAIN_WORD = /^[A-Za-z0-9_@%+=:,./-]+$/u;

const shellQuote = (word: string): string =>
  word !== "" && PLAIN_WORD.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;

/**
 * The words of a line's first simple command, quotes removed (single quotes literal, double quotes
 * with backslash escapes, a backslash outside quotes escapes one character), and the rest of the
 * line from the first unquoted command separator on (`;`, `&`, `|`, parentheses, a newline, as
 * `commandShapes` splits; the `&` of a redirection such as `2>&1` is none), `""` when there is
 * none. Lenient: an unclosed quote runs to the end.
 */
const firstCommand = (line: string): { readonly words: string[]; readonly rest: string } => {
  const words: string[] = [];
  let word = "";
  let inWord = false;
  let i = 0;
  for (; i < line.length; i += 1) {
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
    } else if (c === "<" || c === ">" || (c === "&" && line[i + 1] === ">")) {
      // a redirection (`>out`, `2>&1`, `&>log`) is a word of this command, never its end; it
      // starts a word of its own unless a file descriptor number leads it
      if (inWord && !/^\d+$/u.test(word)) {
        words.push(word);
        word = "";
      }
      word += c;
      inWord = true;
      if (c !== "&" && line[i + 1] === "&") {
        word += "&";
        i += 1;
      }
    } else if (";&|()\n".includes(c)) {
      break;
    } else if (c === " " || c === "\t" || c === "\r") {
      if (inWord) words.push(word);
      word = "";
      inWord = false;
    } else {
      word += c;
      inWord = true;
    }
  }
  if (inWord) words.push(word);
  return { words, rest: line.slice(i) };
};

const baseName = (program: string): string => program.slice(program.lastIndexOf("/") + 1);

/** The script a `<shell> -c <script>` wrapper runs, or null when `words` is not one. */
const wrappedScript = (words: readonly string[]): string | null => {
  const [program, flag, script] = words;
  if (program === undefined || flag === undefined || script === undefined) return null;
  return SHELLS.has(baseName(program)) && SCRIPT_FLAG.test(flag) ? script : null;
};

/**
 * Pure: the shapes of one shell call, from a host's command field (a string or an argv array);
 * none for anything else. Only `commandShapes` output is returned (D-cs). A wrapped call's shapes
 * are its script's, then those of whatever follows the wrapper on the same line
 * (`bash -lc ls && rm -rf x` is `ls`, then `rm`); the wrapper's own trailing words (the script's
 * `$0` and arguments, redirections) name no command.
 */
export const shellCallShapes = (command: unknown): CommandShape[] => {
  if (typeof command === "string") {
    const { words, rest } = firstCommand(command);
    const script = wrappedScript(words);
    if (script === null) return command.trim() === "" ? [] : commandShapes(command);
    return [...commandShapes(script), ...commandShapes(rest)].slice(0, MAX_SHAPES_PER_COMMAND);
  }
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
    const argv = command as readonly string[];
    const text = wrappedScript(argv) ?? argv.map(shellQuote).join(" ");
    return text.trim() === "" ? [] : commandShapes(text);
  }
  return [];
};

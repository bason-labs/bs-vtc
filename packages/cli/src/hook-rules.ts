/**
 * Pure rules behind `vtc hook pre-tool-use` (`@vtc/shared` hook.ts rule 4): who is a VTC role
 * agent, which shell commands are git writes (commits, pushes, merges, rebases, resets, ref moves
 * and config changes), which files a tool call writes, and whether a path
 * is inside a dispatch's write scope. Hooks are an extra layer of defence only; the engine checks
 * every write and every submit, so these rules lean towards allowing what they cannot read.
 */
import { isAbsolute, resolve } from "node:path";
import { AGENT_NAME_PREFIX } from "@vtc/shared";

/** The compiled agent's base name: the host's namespace (`vtc:`) removed. */
export const agentBaseName = (agentType: string): string =>
  agentType.slice(agentType.lastIndexOf(":") + 1);

/** True for a compiled VTC role agent (`vtc-<role>[-<mode>]`, after the host's namespace). */
export const isVtcRoleAgent = (agentType: string | undefined): agentType is string =>
  agentType !== undefined && agentBaseName(agentType).startsWith(AGENT_NAME_PREFIX);

// ------------------------------------------------------------------ git writes

/** Git subcommands that always commit, push, merge, rebase, reset or move refs. */
const GIT_WRITE_SUBCOMMANDS = new Set([
  "commit",
  "commit-tree",
  "cherry-pick",
  "revert",
  "am",
  "push",
  "merge",
  "pull",
  "rebase",
  "reset",
  "update-ref",
]);

/** Global git options that take the next word as their value. */
const GIT_VALUE_OPTIONS = new Set([
  "-C",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--exec-path",
]);

/** Commands that run the command named in their arguments (`sudo git push`, `env X=1 git …`). */
const WRAPPERS = new Set([
  "sudo",
  "env",
  "command",
  "builtin",
  "exec",
  "time",
  "nohup",
  "nice",
  "xargs",
]);

/** Shells whose arguments are scripts (`bash -lc 'git push'`), and `eval`. */
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "eval"]);

interface Lexed {
  /** Simple commands: their words with quotes removed. */
  readonly commands: string[][];
  /** Command substitutions (`$(…)`, backticks) found anywhere, to be read as command lines. */
  readonly nested: string[];
}

/** The text of a balanced `$( … )` starting after `$(` at `i`; returns it and the index after `)`. */
const substitution = (line: string, i: number): [string, number] => {
  let depth = 1;
  let j = i;
  while (j < line.length && depth > 0) {
    const c = line.charAt(j);
    if (c === "\\") j += 1;
    else if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    j += 1;
  }
  return [line.slice(i, depth === 0 ? j - 1 : j), j];
};

/**
 * A small POSIX-shell word splitter: quotes and backslashes are removed from words, operators
 * (`; & | ( )` and newlines) end a simple command, and `$(…)` and backtick substitutions are
 * collected for a separate pass. Redirections and arithmetic are not modelled; the hook only
 * needs to know which word is in command position.
 */
const lex = (line: string): Lexed => {
  const commands: string[][] = [];
  const nested: string[] = [];
  let command: string[] = [];
  let word: string | null = null;
  const endWord = (): void => {
    if (word !== null) command.push(word);
    word = null;
  };
  const endCommand = (): void => {
    endWord();
    if (command.length > 0) commands.push(command);
    command = [];
  };
  const backtick = (i: number): number => {
    const close = line.indexOf("`", i);
    const end = close < 0 ? line.length : close;
    nested.push(line.slice(i, end));
    return end + 1;
  };
  let i = 0;
  while (i < line.length) {
    const c = line.charAt(i);
    if (c === " " || c === "\t") {
      endWord();
      i += 1;
    } else if (c === "\n" || c === ";" || c === "&" || c === "|" || c === "(" || c === ")") {
      endCommand();
      i += 1;
    } else if (c === "\\") {
      word = (word ?? "") + line.charAt(i + 1);
      i += 2;
    } else if (c === "'") {
      const close = line.indexOf("'", i + 1);
      const end = close < 0 ? line.length : close;
      word = (word ?? "") + line.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      let text = "";
      i += 1;
      while (i < line.length && line.charAt(i) !== '"') {
        const d = line.charAt(i);
        if (d === "\\" && i + 1 < line.length) {
          text += line.charAt(i + 1);
          i += 2;
        } else if (d === "$" && line.charAt(i + 1) === "(") {
          const [inner, next] = substitution(line, i + 2);
          nested.push(inner);
          text += line.slice(i, next);
          i = next;
        } else if (d === "`") {
          i = backtick(i + 1);
        } else {
          text += d;
          i += 1;
        }
      }
      word = (word ?? "") + text;
      i += 1;
    } else if (c === "$" && line.charAt(i + 1) === "(") {
      const [inner, next] = substitution(line, i + 2);
      nested.push(inner);
      word = (word ?? "") + line.slice(i, next);
      i = next;
    } else if (c === "`") {
      word = word ?? "";
      i = backtick(i + 1);
    } else {
      word = (word ?? "") + c;
      i += 1;
    }
  }
  endCommand();
  return { commands, nested };
};

const commandName = (word: string): string => {
  const base = word.slice(Math.max(word.lastIndexOf("/"), word.lastIndexOf("\\")) + 1);
  return base.toLowerCase().endsWith(".exe") ? base.slice(0, -4) : base;
};

/** Options of `git config` that take the next word as their value. */
const CONFIG_VALUE_OPTIONS = new Set([
  "-f",
  "--file",
  "--blob",
  "--type",
  "--default",
  "--comment",
]);

/** `git config` flags and verbs that only read. */
const CONFIG_READ_FLAGS =
  /^(?:--get|--get-all|--get-regexp|--get-urlmatch|--get-color|--get-colorbool|--list|-l)$/;
const CONFIG_READ_VERBS = new Set(["get", "list"]);
const CONFIG_WRITE_FLAGS =
  /^(?:--unset|--unset-all|--add|--replace-all|--rename-section|--remove-section|--edit|-e)$/;

/** True when `git config <args>` changes configuration. */
const configWrites = (args: readonly string[]): boolean => {
  const positionals: string[] = [];
  let reads = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    const option = arg.split("=")[0] ?? arg;
    if (CONFIG_WRITE_FLAGS.test(option)) return true;
    if (CONFIG_READ_FLAGS.test(option)) reads = true;
    else if (CONFIG_VALUE_OPTIONS.has(arg)) i += 1;
    else if (!arg.startsWith("-")) positionals.push(arg);
  }
  if (reads) return false;
  const [first] = positionals;
  if (first !== undefined && CONFIG_READ_VERBS.has(first)) return false;
  // `git config <key>` reads; `git config <key> <value>` and `set`/`unset`/… write
  return positionals.length >= 2 || (first !== undefined && !first.includes("."));
};

/** The ref-moving forms of `branch`, `tag`, `checkout` and `switch`. */
const refWrite = (sub: string, args: readonly string[]): boolean => {
  const flags = args.filter((a) => a.startsWith("-"));
  const has = (...names: string[]): boolean => flags.some((f) => names.includes(f));
  switch (sub) {
    case "branch":
      return has(
        "-f",
        "--force",
        "-d",
        "-D",
        "--delete",
        "-m",
        "-M",
        "--move",
        "-c",
        "-C",
        "--copy",
      );
    case "tag":
      return (
        !has("-l", "--list", "-v", "--verify") &&
        (args.some((a) => !a.startsWith("-")) || has("-d", "--delete"))
      );
    case "checkout":
      return has("-B");
    case "switch":
      return has("-C", "--force-create");
    default:
      return false;
  }
};

/** The git write of one git invocation's arguments (after `git`), or `null`. */
const gitWriteOf = (args: readonly string[]): string | null => {
  for (let i = 0; i < args.length; i += 1) {
    const word = args[i] ?? "";
    const option = word.split("=")[0] ?? word;
    if (option === "-c" || option === "--config-env") return option;
    if (GIT_VALUE_OPTIONS.has(word)) {
      i += 1;
      continue;
    }
    if (word.startsWith("-")) continue;
    const rest = args.slice(i + 1);
    if (GIT_WRITE_SUBCOMMANDS.has(word)) return word;
    if (word === "config") return configWrites(rest) ? "config" : null;
    return refWrite(word, rest) ? word : null;
  }
  return null;
};

/** The git write of one simple command, looking through wrappers and shells. */
const gitWriteOfCommand = (words: readonly string[], depth: number): string | null => {
  let i = 0;
  while (i < words.length) {
    const word = words[i] ?? "";
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word))
      i += 1; // VAR=value prefix
    else if (WRAPPERS.has(commandName(word))) {
      i += 1;
      while (i < words.length && /^-|^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i] ?? "")) i += 1;
    } else break;
  }
  const name = commandName(words[i] ?? "");
  const args = words.slice(i + 1);
  if (name === "git") return gitWriteOf(args);
  if (SHELLS.has(name) && depth < 4) {
    const scripts = name === "eval" ? [args.join(" ")] : args.filter((a) => !a.startsWith("-"));
    for (const script of scripts) {
      const found = gitWriteInLine(script, depth + 1);
      if (found !== null) return found;
    }
  }
  return null;
};

const gitWriteInLine = (commandLine: string, depth: number): string | null => {
  const { commands, nested } = lex(commandLine);
  for (const words of commands) {
    const found = gitWriteOfCommand(words, depth);
    if (found !== null) return found;
  }
  if (depth >= 4) return null;
  for (const inner of nested) {
    const found = gitWriteInLine(inner, depth + 1);
    if (found !== null) return found;
  }
  return null;
};

/**
 * The git write a shell command line performs, e.g. `push`, `config` or `-c` (a config
 * override), or `null`. `git` counts only in command position: at the start of a simple command
 * (after `VAR=value` prefixes and wrappers such as `sudo` or `env`), inside `bash -c '…'` or
 * `eval`, and inside `$(…)` or backticks. A quoted argument that merely mentions git
 * (`grep "git commit" src`) is not a git call. Read-only forms (`git config --get`, `git tag -l`,
 * `git branch`) pass.
 */
export const gitWriteIn = (commandLine: string): string | null => gitWriteInLine(commandLine, 0);

/** One argv element quoted for a POSIX shell when it needs it. */
const shellQuote = (arg: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`;

/** The shell command line of a tool call: `command` as a string, or an argv quoted and joined. */
export const shellCommandOf = (toolInput: Readonly<Record<string, unknown>>): string | null => {
  const command = toolInput.command ?? toolInput.cmd;
  if (typeof command === "string") return command;
  if (Array.isArray(command) && command.every((c) => typeof c === "string"))
    return command.map(shellQuote).join(" ");
  return null;
};

/** Claude Code's file-writing tools and the input field naming the file. */
const WRITE_TOOLS: Readonly<Record<string, string>> = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

const PATCH_FILE = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm;

const strings = (value: unknown): string[] =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.flatMap(strings)
      : typeof value === "object" && value !== null
        ? Object.values(value).flatMap(strings)
        : [];

/**
 * Absolute paths a tool call writes: the file of Claude Code's write tools, and every file named
 * by an `apply_patch` patch (Codex) anywhere in the input. Relative paths resolve against `cwd`.
 */
export const writeTargets = (
  toolName: string | undefined,
  toolInput: Readonly<Record<string, unknown>>,
  cwd: string,
): string[] => {
  const paths: string[] = [];
  const field = toolName === undefined ? undefined : WRITE_TOOLS[toolName];
  const direct = field === undefined ? undefined : toolInput[field];
  if (typeof direct === "string" && direct !== "") paths.push(direct);
  for (const text of strings(toolInput)) {
    if (!text.includes("*** Begin Patch")) continue;
    for (const m of text.matchAll(PATCH_FILE)) {
      const path = m[1]?.trim();
      if (path !== undefined && path !== "") paths.push(path);
    }
  }
  return paths.map((p) => (isAbsolute(p) ? resolve(p) : resolve(cwd, p)));
};

// ------------------------------------------------------------------ globs

const escape = (c: string): string => c.replace(/[.+^${}()|[\]\\]/g, "\\$&");

/**
 * The engine's glob dialect for `files_scope` (repo-relative POSIX; `**` any number of
 * segments, `*` within a segment, `?`, `{a,b}`), anchored.
 */
export const globToRegExp = (glob: string): RegExp => {
  let out = "";
  let inBraces = false;
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob.charAt(i);
    if (c === "*" && glob.charAt(i + 1) === "*") {
      const atStart = i === 0 || glob.charAt(i - 1) === "/";
      const atEnd = i + 2 === glob.length || glob.charAt(i + 2) === "/";
      if (atStart && atEnd) {
        if (glob.charAt(i + 2) === "/") {
          out += "(?:[^/]*/)*";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "{") {
      inBraces = true;
      out += "(?:";
    } else if (c === "}" && inBraces) {
      inBraces = false;
      out += ")";
    } else if (c === "," && inBraces) out += "|";
    else out += escape(c);
  }
  return new RegExp(`^${out}$`);
};

export const matchesAnyGlob = (globs: readonly string[], path: string): boolean =>
  globs.some((g) => globToRegExp(g).test(path));

/**
 * The `## Write scope` list of a rendered task pack (`renderTaskPack`), or `null` when the pack
 * has no such section. `(none)` is an empty scope.
 */
export const packWriteScope = (markdown: string): string[] | null => {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === "## Write scope");
  if (start < 0) return null;
  const scope: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    if (line.startsWith("- ")) scope.push(line.slice(2).trim());
  }
  return scope;
};

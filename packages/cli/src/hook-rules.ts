/**
 * Pure rules behind `vtc hook pre-tool-use` (`@vtc/shared` hook.ts rule 4): who is a VTC role
 * agent, which shell commands are git writes, which files a tool call writes, and whether a path
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

/** Git subcommands that commit, push, merge, rebase, reset or change config. */
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
  "config",
]);

/** Global git options that take the next word as their value. */
const GIT_VALUE_OPTIONS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--super-prefix",
  "--config-env",
  "--exec-path",
]);

/** `git` as a word: at the start, after whitespace, a shell operator, a quote or a path. */
const GIT_WORD = /(?:^|[\s;&|(){}`'"$/\\])git(?:\.exe)?(?=\s)/g;

const unquote = (word: string): string => word.replace(/^['"(]+/, "").replace(/['");&|]+$/, "");

/**
 * The git write a shell command line performs, e.g. `push` or `-c` (a config override), or
 * `null`. Every `git` word in the line counts, including inside `bash -c '…'` or `$(…)`.
 */
export const gitWriteIn = (commandLine: string): string | null => {
  for (const match of commandLine.matchAll(GIT_WORD)) {
    const words = commandLine
      .slice(match.index + match[0].length)
      .split(/\s+/)
      .filter((w) => w !== "");
    for (let i = 0; i < words.length; i += 1) {
      const word = unquote(words[i] ?? "");
      if (word === "") break;
      const option = word.split("=")[0] ?? word;
      if (option === "-c" || option === "--config-env") return option;
      if (GIT_VALUE_OPTIONS.has(word)) {
        i += 1;
        continue;
      }
      if (word.startsWith("-")) continue;
      if (GIT_WRITE_SUBCOMMANDS.has(word)) return word;
      break;
    }
  }
  return null;
};

/** The shell command line of a tool call: `command` as a string, or an argv joined by spaces. */
export const shellCommandOf = (toolInput: Readonly<Record<string, unknown>>): string | null => {
  const command = toolInput.command ?? toolInput.cmd;
  if (typeof command === "string") return command;
  if (Array.isArray(command) && command.every((c) => typeof c === "string"))
    return command.join(" ");
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

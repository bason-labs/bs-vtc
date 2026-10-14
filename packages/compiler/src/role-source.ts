/**
 * Neutral role sources (§5.1, AD-14): `roles/<role>/role.yaml` (the contract) and `prompt.md`
 * (locked core, then the editable section). Pure: callers pass file contents.
 */
import { parse as parseYaml, YAMLParseError } from "yaml";
import {
  editableSectionErrors,
  RESERVED_EDITABLE_HEADINGS,
  RoleContractSchema,
  splitRolePrompt,
  type RoleContract,
} from "@vtc/shared";
import type { CompileError, SourceFile } from "./types.js";

/** Longest `prompt.md` in lines (§5.1: "about 150 lines at most"). */
export const MAX_PROMPT_LINES = 150;

/**
 * Mode blocks inside `prompt.md`: lines between `<!-- vtc:mode <mode> -->` and
 * `<!-- vtc:mode-end -->` reach only that mode's agent (AD-14 rule 1: a role with modes compiles
 * to one lean agent per mode). Text outside blocks reaches every mode.
 */
export const MODE_MARKERS = {
  start: (mode: string): string => `<!-- vtc:mode ${mode} -->`,
  end: "<!-- vtc:mode-end -->",
} as const;

const MODE_START = /^<!-- vtc:mode ([a-z0-9][a-z0-9._-]*) -->$/;

export type TextCheck =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Keeps the text outside mode blocks plus the blocks of `mode`. Errors on nested, unterminated
 * or stray markers and on blocks naming an undeclared mode.
 */
export const selectMode = (
  text: string,
  mode: string | undefined,
  declared: readonly string[],
): TextCheck => {
  const errors: string[] = [];
  const kept: string[] = [];
  let open: string | undefined;
  text.split("\n").forEach((line, index) => {
    const trimmed = line.trim();
    const start = MODE_START.exec(trimmed);
    if (start?.[1] !== undefined) {
      if (open !== undefined) errors.push(`line ${String(index + 1)}: mode blocks cannot nest`);
      if (!declared.includes(start[1])) {
        errors.push(`line ${String(index + 1)}: mode ${start[1]} is not declared in role.yaml`);
      }
      open = start[1];
      return;
    }
    if (trimmed === MODE_MARKERS.end) {
      if (open === undefined) errors.push(`line ${String(index + 1)}: mode-end without a mode`);
      open = undefined;
      return;
    }
    if (open === undefined || open === mode) kept.push(line);
  });
  if (open !== undefined) errors.push(`mode block ${open} is not closed`);
  return errors.length > 0 ? { ok: false, errors } : { ok: true, text: kept.join("\n") };
};

/**
 * Replaces `{{name}}` placeholders (lower-case letters and `_`: the grammar `editableSectionErrors`
 * in `@vtc/shared` detects, so a placeholder the compiler renders is one an editable section and a
 * Lookback proposal are refused for); unknown placeholders are errors.
 */
export const renderTemplate = (text: string, vars: Readonly<Record<string, string>>): TextCheck => {
  const errors: string[] = [];
  const rendered = text.replace(/\{\{([a-z_]+)\}\}/g, (whole, name: string) => {
    const value = vars[name];
    if (value === undefined) {
      errors.push(`unknown placeholder ${whole}`);
      return whole;
    }
    return value;
  });
  return errors.length > 0 ? { ok: false, errors } : { ok: true, text: rendered };
};

/**
 * What an editable section may not contain (AD-14 rule 4, AD-21): the shared rule set, which
 * Lookback's `checkProposal` also runs on a proposed section (spine §5 reading 175). Re-exported
 * so the compiler's callers keep one import.
 */
export { editableSectionErrors, RESERVED_EDITABLE_HEADINGS };

export interface RoleSourceInput {
  /** The role's directory name under `roles/`. */
  readonly dir: string;
  readonly roleYaml: string;
  readonly promptMd: string;
}

export interface RolePrompt {
  readonly locked: string;
  readonly editable: string;
}

export type RoleSourceCheck =
  | { readonly ok: true; readonly role: RoleContract; readonly prompt: RolePrompt }
  | { readonly ok: false; readonly errors: readonly string[] };

const parseYamlDocument = (
  text: string,
): { ok: true; value: unknown } | { ok: false; error: string } => {
  try {
    return { ok: true, value: parseYaml(text) as unknown };
  } catch (error) {
    const message = error instanceof YAMLParseError ? error.message : String(error);
    return { ok: false, error: message.split("\n")[0] ?? message };
  }
};

/** Validates one role source: the contract, its id, the prompt sections and mode blocks. */
export const parseRoleSource = (input: RoleSourceInput): RoleSourceCheck => {
  const yaml = parseYamlDocument(input.roleYaml);
  if (!yaml.ok) return { ok: false, errors: [`role.yaml: ${yaml.error}`] };
  const parsed = RoleContractSchema.safeParse(yaml.value);
  const errors: string[] = [];
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`role.yaml: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
    }
  } else if (parsed.data.id !== input.dir) {
    errors.push(`role.yaml: id ${parsed.data.id} must match its directory ${input.dir}`);
  }
  const lines = input.promptMd.replace(/\n$/, "").split("\n").length;
  if (lines > MAX_PROMPT_LINES) {
    errors.push(
      `prompt.md: ${String(lines)} lines; keep it at ${String(MAX_PROMPT_LINES)} lines at most`,
    );
  }
  const split = splitRolePrompt(input.promptMd);
  if (!split.ok) errors.push(...split.errors.map((e) => `prompt.md: ${e}`));
  if (parsed.success && split.ok) {
    const declared = Object.keys(parsed.data.modes ?? {});
    for (const section of [split.locked, split.editable]) {
      const check = selectMode(section, declared[0], declared);
      if (!check.ok) errors.push(...check.errors.map((e) => `prompt.md: ${e}`));
    }
  }
  if (split.ok) errors.push(...editableSectionErrors(split.editable).map((e) => `prompt.md: ${e}`));
  if (errors.length > 0 || !parsed.success || !split.ok) return { ok: false, errors };
  return {
    ok: true,
    role: parsed.data,
    prompt: { locked: split.locked, editable: split.editable },
  };
};

export interface LoadedRole {
  readonly dir: string;
  readonly role: RoleContract;
  readonly prompt: RolePrompt;
}

export type LoadRolesResult =
  | { readonly ok: true; readonly roles: readonly LoadedRole[] }
  | {
      readonly ok: false;
      readonly roles: readonly LoadedRole[];
      readonly errors: readonly CompileError[];
    };

/** `roles/_shared/` and other `_`-prefixed directories hold fragments, not roles. */
const isRoleDir = (dir: string): boolean => !dir.startsWith("_");

const ROLE_FILES = new Set(["role.yaml", "prompt.md"]);

/** Loads every role directory under `roles/` from a source list, sorted by id. */
export const loadRoles = (files: readonly SourceFile[]): LoadRolesResult => {
  const errors: CompileError[] = [];
  const byDir = new Map<string, Map<string, string>>();
  for (const file of files) {
    const match = /^roles\/([^/]+)\/(.+)$/.exec(file.path);
    if (match?.[1] === undefined || match[2] === undefined || !isRoleDir(match[1])) continue;
    if (!ROLE_FILES.has(match[2])) {
      errors.push({ path: file.path, message: "unexpected file in a role directory" });
      continue;
    }
    const entry = byDir.get(match[1]) ?? new Map<string, string>();
    entry.set(match[2], file.text);
    byDir.set(match[1], entry);
  }
  const roles: LoadedRole[] = [];
  for (const dir of [...byDir.keys()].sort()) {
    const entry = byDir.get(dir) ?? new Map<string, string>();
    const roleYaml = entry.get("role.yaml");
    const promptMd = entry.get("prompt.md");
    if (roleYaml === undefined) errors.push({ path: `roles/${dir}`, message: "missing role.yaml" });
    if (promptMd === undefined) errors.push({ path: `roles/${dir}`, message: "missing prompt.md" });
    if (roleYaml === undefined || promptMd === undefined) continue;
    const check = parseRoleSource({ dir, roleYaml, promptMd });
    if (check.ok) roles.push({ dir, role: check.role, prompt: check.prompt });
    else errors.push(...check.errors.map((message) => ({ path: `roles/${dir}`, message })));
  }
  return errors.length > 0 ? { ok: false, roles, errors } : { ok: true, roles };
};

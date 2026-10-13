/** Contract checks shared by the compile step and its tests (AD-9, AD-14, AD-16). */
import {
  agentNameFor,
  findForbiddenInText,
  RoleContractSchema,
  splitRolePrompt,
  type HostId,
  type RoleContract,
} from "@vtc/shared";

/** Generated output directories per host (§4.4; never hand-edited). */
export const COMPILE_TARGETS: Readonly<Record<HostId, string>> = {
  "claude-code": "dist/claude-plugin",
  codex: "dist/codex-plugin",
};

/** Hand-written plugin sources the compiler merges into each target (AD-16). */
export const PLUGIN_SOURCES: Readonly<Record<HostId | "common", string>> = {
  common: "plugins/common",
  "claude-code": "plugins/claude-code",
  codex: "plugins/codex",
};

export type RoleContractCheck =
  | { readonly ok: true; readonly role: RoleContract }
  | { readonly ok: false; readonly errors: readonly string[] };

/** Validate a parsed `role.yaml` document against the frozen RoleContract. */
export const checkRoleContract = (document: unknown): RoleContractCheck => {
  const parsed = RoleContractSchema.safeParse(document);
  if (parsed.success) return { ok: true, role: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map(
      (issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`,
    ),
  };
};

export type RolePromptCheck =
  | { readonly ok: true; readonly locked: string; readonly editable: string }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Validate a `roles/<role>/prompt.md`: exactly one locked core and one editable section, in
 * that order, separated by the `PROMPT_MARKERS` lines (§5.1, §13).
 */
export const checkRolePrompt = (text: string): RolePromptCheck => splitRolePrompt(text);

/** Compiled agent names for a role: one per mode, or one for a role without modes (AD-14). */
export const compiledAgentNames = (role: RoleContract): string[] =>
  role.modes === undefined
    ? [agentNameFor(role.id)]
    : Object.keys(role.modes).map((mode) => agentNameFor(role.id, mode));

/** One AD-9 violation in an emitted or source file. */
export interface PluginFileViolation {
  readonly path: string;
  readonly line: number;
  readonly marker: string;
}

/**
 * AD-9 gate on everything the compiler emits (agent frontmatter, Codex agent TOML, hooks,
 * settings, skills): every file must be free of permission-bypass flags and credential
 * markers. The compile step fails on any violation.
 */
export const checkPluginFiles = (
  files: Iterable<{ readonly path: string; readonly text: string }>,
): PluginFileViolation[] => {
  const violations: PluginFileViolation[] = [];
  for (const file of files) {
    for (const hit of findForbiddenInText(file.text)) violations.push({ path: file.path, ...hit });
  }
  return violations;
};

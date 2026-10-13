/**
 * Builds one agent's instructions from its role source (§5.1, AD-14):
 *
 * 1. the locked core: for an engineer profile, the Engineer's locked core first (§5.2a: every
 *    specialist shares the Engineer contract); for a lens reviewer, the shared lens procedure
 *    first and its lens skill's checklist after (§5.3);
 * 2. the contract, generated from the effective role.yaml contract of the mode;
 * 3. the shared result protocol (`roles/_shared/result-protocol.md`, filled from the frozen
 *    contracts);
 * 4. the editable section(s), the part Lookback may propose changes to (AD-14 rule 4);
 * 5. the host's `prompt_append` (§12.3).
 *
 * Mode blocks are resolved per mode, so each mode's agent carries only its own rules. Every part
 * may use `{{name}}` placeholders filled from the frozen contracts (`PROTOCOL_VARS`) and from the
 * compiled skills (`InstructionSources.vars`), so prompts never restate an enum by hand.
 */
import {
  ContractKindSchema,
  DisciplineSchema,
  EscalationEffectSchema,
  EvidenceTypeSchema,
  FindingCategorySchema,
  FindingKindSchema,
  MAX_STACK_PACKS,
  resolveRoleMode,
  SUMMARY_MAX_CHARS,
  TASK_PACK_SECTIONS,
  type EffectiveRoleContract,
  type HostId,
  type RoleContract,
} from "@vtc/shared";
import { renderTemplate, selectMode } from "./role-source.js";
import type { LoadedRole } from "./role-source.js";

/** Values every prompt part may reference as `{{name}}`. */
export const PROTOCOL_VARS: Readonly<Record<string, string>> = {
  contract_kinds: ContractKindSchema.options.join(", "),
  disciplines: DisciplineSchema.options.join(", "),
  max_stack_packs: String(MAX_STACK_PACKS),
  escalation_effects: EscalationEffectSchema.options.join(", "),
  evidence_types: EvidenceTypeSchema.options.join(", "),
  task_pack_sections: TASK_PACK_SECTIONS.join(", "),
  finding_categories: FindingCategorySchema.options.join(", "),
  finding_kinds: FindingKindSchema.options.join(", "),
  summary_max_chars: String(SUMMARY_MAX_CHARS),
};

const list = (items: readonly string[]): string => (items.length === 0 ? "none" : items.join(", "));

const TOOL_LINES: Readonly<Record<EffectiveRoleContract["tools"]["profile"], string>> = {
  read_only: "read-only (no file writes, no shell)",
  write_scoped: "file reads; writes only inside the Write scope of your task pack (no shell)",
  code_sandboxed:
    "files and shell in a sandboxed worktree; writes only inside the Write scope of your task pack",
};

/** The `## Contract` section for one effective contract. */
export const renderContract = (role: RoleContract, contract: EffectiveRoleContract): string => {
  const lines = [
    "## Contract",
    "",
    "Generated from role.yaml. The engine enforces every line and rejects a result that breaks one.",
    "",
    `- Role: ${role.id}${contract.mode === undefined ? "" : `, mode ${contract.mode}`} (version ${role.version})`,
    `- Inputs (artifact types in your task pack): ${list(contract.inputs)}`,
    `- Exits: ${list(contract.exits)}`,
    `- Verdicts: ${list(contract.output.verdicts)}`,
    `- Output artifact types: ${list(contract.output.artifacts)}`,
    `- Tools: ${TOOL_LINES[contract.tools.profile]}`,
    ...(contract.tools.engine_tools.length === 0
      ? []
      : [`- Engine tools: ${list(contract.tools.engine_tools)}`]),
    `- Context budget: about ${String(role.budget.context_tokens)} tokens; summary at most ${String(role.budget.return_tokens)} tokens`,
  ];
  if (role.success_criteria.length > 0) {
    lines.push("- Checked by the engine:");
    for (const c of role.success_criteria) lines.push(`  - ${c.id}: ${c.description}`);
  }
  return lines.join("\n");
};

export interface InstructionSources {
  /** `roles/_shared/result-protocol.md`. */
  readonly protocol: string;
  /** `roles/_shared/lens-reviewer.md`, for lens roles. */
  readonly lensReviewer: string | undefined;
  /** The Engineer role, for engineer profiles. */
  readonly engineer: LoadedRole | undefined;
  /** Skill bodies (frontmatter removed) by skill name, for lens checklists. */
  readonly skillBodies: ReadonlyMap<string, string>;
  /** Placeholders known only at compile time, e.g. the available stack packs. */
  readonly vars: Readonly<Record<string, string>>;
}

export type InstructionsResult =
  | { readonly ok: true; readonly text: string; readonly contract: EffectiveRoleContract }
  | { readonly ok: false; readonly errors: readonly string[] };

/** `lens_supply_chain` → `lens-supply-chain`. */
export const lensSkillName = (roleId: string): string => roleId.replaceAll("_", "-");

const pick = (
  text: string,
  mode: string | undefined,
  role: RoleContract,
  errors: string[],
): string => {
  const check = selectMode(text, mode, Object.keys(role.modes ?? {}));
  if (!check.ok) {
    errors.push(...check.errors);
    return "";
  }
  return check.text.trim();
};

export const buildInstructions = (
  loaded: LoadedRole,
  mode: string | undefined,
  host: HostId,
  sources: InstructionSources,
): InstructionsResult => {
  const { role, prompt } = loaded;
  const resolved = resolveRoleMode(role, mode);
  if (!resolved.ok) return { ok: false, errors: [resolved.error] };
  const errors: string[] = [];
  const locked: string[] = [];
  const editable: string[] = [];
  if (role.kind === "engineer_profile") {
    if (sources.engineer === undefined) {
      errors.push("engineer profiles build on roles/engineer, which is missing");
    } else {
      locked.push(pick(sources.engineer.prompt.locked, undefined, sources.engineer.role, errors));
      editable.push(
        pick(sources.engineer.prompt.editable, undefined, sources.engineer.role, errors),
      );
    }
  }
  if (role.kind === "lens") {
    if (sources.lensReviewer === undefined) {
      errors.push("lens roles build on roles/_shared/lens-reviewer.md, which is missing");
    } else {
      locked.push(sources.lensReviewer.trim());
    }
  }
  locked.push(pick(prompt.locked, mode, role, errors));
  if (role.kind === "lens") {
    const skill = lensSkillName(role.id);
    const checklist = sources.skillBodies.get(skill);
    if (checklist === undefined) errors.push(`lens roles need the skill skills/${skill}`);
    else locked.push(checklist.trim());
  }
  editable.push(pick(prompt.editable, mode, role, errors));
  if (errors.length > 0) return { ok: false, errors };
  const append = role.host_overrides?.[host]?.prompt_append;
  const parts = [
    ...locked,
    renderContract(role, resolved.contract),
    sources.protocol.trim(),
    ...editable,
    ...(append === undefined ? [] : [append.trim()]),
  ].filter((part) => part !== "");
  const rendered = renderTemplate(`${parts.join("\n\n")}\n`, { ...PROTOCOL_VARS, ...sources.vars });
  if (!rendered.ok) return { ok: false, errors: rendered.errors };
  return { ok: true, text: rendered.text, contract: resolved.contract };
};

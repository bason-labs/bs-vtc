/**
 * Value types of the compiler's API. The files other packages read have their shapes in
 * @vtc/shared (AD-3): `PluginManifestSchema` for `vtc-manifest.json`, `RoleContractSchema` for
 * `vtc/role-contracts.json`, the `vtc hook` contract for the hook wiring.
 */
import type { Discipline, HostId, RoleHostModel, RoleKind, RoleTools } from "@vtc/shared";

/** One source file, by POSIX path relative to the product repo root (`roles/qa/role.yaml`). */
export interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/** One emitted file, by POSIX path relative to its target root (`agents/vtc-qa-judge.md`). */
export interface EmittedFile {
  readonly path: string;
  readonly text: string;
}

/** A compile error, attributed to the source path (or role directory) that caused it. */
export interface CompileError {
  readonly path: string;
  readonly message: string;
}

/** One compiled agent for one host: a role, or one mode of a role (AD-14 rule 1). */
export interface CompiledAgent {
  readonly name: string;
  readonly role: string;
  readonly mode: string | undefined;
  readonly kind: RoleKind;
  readonly discipline: Discipline | undefined;
  readonly roleVersion: string;
  /** One line used by the host to describe the agent. */
  readonly description: string;
  readonly tools: RoleTools;
  /** The effective model settings for this host. */
  readonly model: RoleHostModel;
  /** The full instructions: the agent's system prompt on this host. */
  readonly instructions: string;
  /**
   * The prompt identity the manifest records (`prompt-parts.ts`): the role's own `prompt.md`
   * sections as `splitRolePrompt` returns them, trimmed, except that an engineer profile's locked
   * section is `engineerProfileLockedSection` (spine §5 reading 172). The editable one is the
   * default section, which the agent carries verbatim and a Lookback proposal replaces.
   */
  readonly sections: { readonly locked: string; readonly editable: string };
  /** Skills the agent preloads (`role-skills.ts`), by skill name. */
  readonly skills: readonly string[];
  /**
   * The agent carries the locked part only and expects its editable section as the task pack's
   * `Role heuristics` block (`PluginManifestAgent.editable_in_pack`, reading 102).
   */
  readonly editableInPack?: boolean;
}

/** Options of the compile step; the defaults are the repo's policy. */
export interface CompileOptions {
  /** Roles whose agents carry the locked core only; default `EDITABLE_IN_PACK_ROLES`. */
  readonly editableInPack?: readonly string[];
}

export interface CompileOutput {
  readonly targets: Readonly<Record<HostId, readonly EmittedFile[]>>;
}

export type CompileResult =
  | { readonly ok: true; readonly output: CompileOutput }
  | { readonly ok: false; readonly errors: readonly CompileError[] };

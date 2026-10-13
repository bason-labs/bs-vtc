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
}

export interface CompileOutput {
  readonly targets: Readonly<Record<HostId, readonly EmittedFile[]>>;
}

export type CompileResult =
  | { readonly ok: true; readonly output: CompileOutput }
  | { readonly ok: false; readonly errors: readonly CompileError[] };

/** Value types of the compiler's API. */
import type {
  Discipline,
  Effort,
  HostId,
  ModelTier,
  RoleHostModel,
  RoleKind,
  RoleTools,
} from "@vtc/shared";

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

/** What a skill is, for the engine's pack selection (§5.2a, §5.3). */
export type SkillKind = "stack_pack" | "domain_pack" | "lens" | "plugin" | "command" | "skill";

export interface ManifestAgent {
  readonly name: string;
  readonly role: string;
  readonly mode: string | null;
  readonly kind: RoleKind;
  readonly discipline: Discipline | null;
  readonly role_version: string;
  readonly file: string;
  /** SHA-256 of the instructions as emitted (§13: every run records its prompt content SHA). */
  readonly prompt_sha256: string;
  readonly tier: ModelTier;
  readonly effort: Effort;
}

export interface ManifestSkill {
  readonly name: string;
  readonly kind: SkillKind;
  /** The pack slug a task names (`stack_packs`, discipline, lens id), or null. */
  readonly pack: string | null;
  readonly file: string;
}

/** `vtc-manifest.json` in each emitted plugin: what the plugin contains, for engine and installer. */
export interface PluginManifest {
  readonly v: 1;
  readonly host: HostId;
  readonly plugin: string;
  readonly contracts_version: string;
  readonly agents: readonly ManifestAgent[];
  readonly skills: readonly ManifestSkill[];
}

export interface CompileOutput {
  readonly targets: Readonly<Record<HostId, readonly EmittedFile[]>>;
}

export type CompileResult =
  | { readonly ok: true; readonly output: CompileOutput }
  | { readonly ok: false; readonly errors: readonly CompileError[] };

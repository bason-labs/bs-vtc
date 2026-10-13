/** @vtc/compiler: neutral role sources → host plugin formats (§4.1, §4.4). Depends on @vtc/shared only. */
import { RoleContractSchema, type HostId, type RoleContract } from "@vtc/shared";

/** Generated output directories per host (§4.4; never hand-edited). */
export const COMPILE_TARGETS: Readonly<Record<HostId, string>> = {
  "claude-code": "dist/claude-plugin",
  codex: "dist/codex-plugin",
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

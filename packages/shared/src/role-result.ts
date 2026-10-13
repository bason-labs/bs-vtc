/** Role result contract: what every role returns through `engine.submit` (§4.2, §5.1, §16). */
import { z } from "zod";
import { FindingDraftSchema } from "./finding.js";
import { estimateTokens, RETURN_CAP_TOKENS } from "./helpers/tokens.js";
import {
  ArtifactTypeSchema,
  EvidenceSchema,
  FeatureIdSchema,
  RelPathSchema,
  RequirementIdSchema,
  RoleIdSchema,
  Sha256HexSchema,
  SlugSchema,
  TaskIdSchema,
} from "./primitives.js";

/**
 * Role exits. §5.1 `done | spec_conflict | blocked(question) | unknown`, plus the Engineer's
 * `built` and guarded `out_of_scope_fault` (§6.3 step 3).
 */
export const RoleExitSchema = z.enum([
  "built",
  "done",
  "spec_conflict",
  "blocked",
  "out_of_scope_fault",
  "unknown",
]);
export type RoleExit = z.infer<typeof RoleExitSchema>;

/** Reviewer verdict (e.g. Spec-Verifier PASS/FAIL/UNKNOWN, §5.2). */
export const VerdictSchema = z.enum(["pass", "fail", "unknown"]);
export type Verdict = z.infer<typeof VerdictSchema>;

/** A claim the engine verifies against reality before accepting a result (§4.2 step 3). */
export const ClaimTypeSchema = z.enum(["file", "commit", "citation", "test", "url"]);
export const ClaimSchema = z.strictObject({
  type: ClaimTypeSchema,
  ref: z.string().min(1).max(2048),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const ArtifactRefSchema = z.strictObject({
  type: ArtifactTypeSchema,
  path: RelPathSchema,
  sha256: Sha256HexSchema.optional(),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

/** Summary capped at about 1.5k tokens (§5.1). */
export const SummarySchema = z
  .string()
  .min(1)
  .refine((text) => estimateTokens(text) <= RETURN_CAP_TOKENS, {
    message: `summary exceeds the ${RETURN_CAP_TOKENS}-token return cap`,
  });

const base = {
  role: RoleIdSchema,
  /** Role mode, e.g. QA `author` / `judge`, Security `design` / `verify`. */
  mode: SlugSchema.optional(),
  task: TaskIdSchema.optional(),
  feature: FeatureIdSchema.optional(),
  verdict: VerdictSchema.optional(),
  findings: z.array(FindingDraftSchema).default([]),
  artifacts: z.array(ArtifactRefSchema).default([]),
  claims: z.array(ClaimSchema).default([]),
  summary: SummarySchema,
};

const SimpleExitResult = z.strictObject({
  ...base,
  exit: z.enum(["built", "done", "unknown"]),
});

const BlockedResult = z.strictObject({
  ...base,
  exit: z.literal("blocked"),
  /** The single question that parks the task (§6.3 step 3). */
  question: z.string().min(1).max(1000),
});

const SpecConflictResult = z.strictObject({
  ...base,
  exit: z.literal("spec_conflict"),
  conflict: z.strictObject({
    req_ids: z.array(RequirementIdSchema).min(1),
    detail: z.string().min(1).max(2000),
  }),
});

/**
 * `out_of_scope_fault` must cite `file:line` outside the task's files_scope (§6.3 step 3).
 * The engine checks the guards (outside scope, reproduces without the diff, one per round).
 */
const OutOfScopeFaultResult = z.strictObject({
  ...base,
  exit: z.literal("out_of_scope_fault"),
  fault: z.strictObject({
    path: RelPathSchema,
    line: z.int().positive(),
    evidence: EvidenceSchema,
    detail: z.string().min(1).max(2000),
  }),
});

export const RoleResultSchema = z.discriminatedUnion("exit", [
  SimpleExitResult,
  BlockedResult,
  SpecConflictResult,
  OutOfScopeFaultResult,
]);
export type RoleResult = z.infer<typeof RoleResultSchema>;
export type RoleResultInput = z.input<typeof RoleResultSchema>;

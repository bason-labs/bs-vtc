/** Role result contract: what every role returns through `engine.submit` (§4.2, §5.1, §16). */
import { z } from "zod";
import { FindingDraftSchema } from "./finding.js";
import { CHARS_PER_TOKEN, estimateTokens, RETURN_CAP_TOKENS } from "./helpers/tokens.js";
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
  VerdictSubjectSchema,
} from "./primitives.js";
import { QuestionSchema } from "./question.js";
import { TaskDraftSchema } from "./task.js";

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

/**
 * Reviewer verdict (e.g. Spec-Verifier PASS/FAIL/UNKNOWN, §5.2). `unchecked` = a route, state or
 * screen could not be reached or rendered: "unreached is not clean" (§7.5), so it blocks a pass.
 */
export const VerdictSchema = z.enum(["pass", "fail", "unknown", "unchecked"]);
export type Verdict = z.infer<typeof VerdictSchema>;

/** Question type each Visual QA verdict names (§7.5). */
export const VerdictQuestionTypeSchema = z.enum([
  "structure_content",
  "state",
  "layout",
  "brand_design_system",
]);
export type VerdictQuestionType = z.infer<typeof VerdictQuestionTypeSchema>;

/**
 * One verdict on one subject (principle 3, §7.4, §7.5). Every verdict cites at least one piece
 * of evidence the engine resolves; a verdict whose evidence does not resolve is rejected
 * (`claim_check`). The Spec-Verifier returns one verdict on the AC it was dispatched for; a
 * Visual QA call returns one verdict per criterion `V1`–`V8` it judged, each naming its
 * question type, and the engine runs three calls and takes the 2-of-3 vote per criterion.
 */
export const RoleVerdictSchema = z
  .strictObject({
    subject: VerdictSubjectSchema,
    verdict: VerdictSchema,
    /** Required on Visual QA criteria (`V1`–`V8`), not allowed elsewhere (§7.5). */
    question_type: VerdictQuestionTypeSchema.optional(),
    evidence: z.array(EvidenceSchema).min(1),
  })
  .superRefine((entry, ctx) => {
    if (/^V[1-8]$/.test(entry.subject) !== (entry.question_type !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["question_type"],
        message: "question_type is required for, and only allowed on, Visual QA criteria V1–V8",
      });
    }
  });
export type RoleVerdict = z.infer<typeof RoleVerdictSchema>;

export const ArtifactRefSchema = z.strictObject({
  type: ArtifactTypeSchema,
  path: RelPathSchema,
  sha256: Sha256HexSchema.optional(),
});
export type ArtifactRef = z.infer<typeof ArtifactRefSchema>;

/** Longest summary in characters: the 1.5k-token cap at the estimator's 4 chars per token. */
export const SUMMARY_MAX_CHARS = RETURN_CAP_TOKENS * CHARS_PER_TOKEN;

/**
 * Summary capped at about 1.5k tokens (§5.1). `max` puts the cap into the JSON Schema hosts see;
 * the refine keeps it tied to the token estimator.
 */
export const SummarySchema = z
  .string()
  .min(1)
  .max(SUMMARY_MAX_CHARS)
  .refine((text) => estimateTokens(text) <= RETURN_CAP_TOKENS, {
    message: `summary exceeds the ${RETURN_CAP_TOKENS}-token return cap`,
  });

const base = {
  role: RoleIdSchema,
  /** Role mode, e.g. QA `author` / `judge`, Security `design` / `verify`. */
  mode: SlugSchema.optional(),
  task: TaskIdSchema.optional(),
  feature: FeatureIdSchema.optional(),
  /** Reviewer verdicts, each with cited evidence (§7.4). Which verdicts a role may return is in
   * its contract (`output.verdicts`, checked by `checkResultAgainstContract`). */
  verdicts: z.array(RoleVerdictSchema).default([]),
  findings: z.array(FindingDraftSchema).default([]),
  /**
   * Questions raised while still finishing the work, e.g. QA author-mode `spec_question` items
   * (§6.3 step 2). The engine turns each into an escalation (`escalationFromQuestion`).
   */
  questions: z.array(QuestionSchema).default([]),
  /**
   * Planner output (§5.2): task drafts the engine checks at PLAN (§6.1). Only roles whose
   * contract declares the `tasks` output artifact may send it (`checkResultAgainstContract`).
   */
  tasks: z.array(TaskDraftSchema).optional(),
  artifacts: z.array(ArtifactRefSchema).default([]),
  /** Facts the result relies on (files, commits, tests, citations), verified before acceptance
   * (§4.2 step 3). Same vocabulary as all other evidence. */
  claims: z.array(EvidenceSchema).default([]),
  summary: SummarySchema,
};

const SimpleExitResult = z.strictObject({
  ...base,
  exit: z.enum(["built", "done", "unknown"]),
});

const BlockedResult = z.strictObject({
  ...base,
  exit: z.literal("blocked"),
  /** The single question that parks the work, with 2–4 options (§6.3 step 3, §6.5). */
  question: QuestionSchema,
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

export const RoleResultSchema = z
  .discriminatedUnion("exit", [
    SimpleExitResult,
    BlockedResult,
    SpecConflictResult,
    OutOfScopeFaultResult,
  ])
  .superRefine((result, ctx) => {
    const subjects = result.verdicts.map((v) => v.subject);
    if (new Set(subjects).size !== subjects.length) {
      ctx.addIssue({
        code: "custom",
        path: ["verdicts"],
        message: "one verdict per subject",
      });
    }
  });
export type RoleResult = z.infer<typeof RoleResultSchema>;
export type RoleResultInput = z.input<typeof RoleResultSchema>;

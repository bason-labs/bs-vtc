/** Task contract (§6.3 plan file frontmatter, §6.4 states, §16 Task). */
import { z } from "zod";
import {
  DisciplineSchema,
  FeatureIdSchema,
  GitShaSchema,
  GlobSchema,
  RelPathSchema,
  RequirementIdSchema,
  RiskSchema,
  SessionRefSchema,
  Sha256HexSchema,
  SlugSchema,
  TaskIdSchema,
  type Risk,
} from "./primitives.js";

/** §6.4 main path plus side states. `fixing(n/cap)` is `fixing` + `round`/`cap`. */
export const TaskStatusSchema = z.enum([
  "draft",
  "ready",
  "tests_authored",
  "building",
  "verifying",
  "fixing",
  "built",
  "queued",
  "merged",
  "done",
  "parked",
  "waiting_dependency",
  "interrupted",
  "non_converged",
  "dropped",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

/** The §6.4 main path in order (side states excluded). */
export const TASK_MAIN_PATH = [
  "draft",
  "ready",
  "tests_authored",
  "building",
  "verifying",
  "fixing",
  "built",
  "queued",
  "merged",
  "done",
] as const satisfies readonly TaskStatus[];

/**
 * Why a task or feature is parked. Same categories as escalation reasons (§6.5), plus the
 * QA `spec_question` (§6.3 step 2) and the Engineer's `blocked(question)` exit (§6.3 step 3).
 */
export const ParkReasonSchema = z.enum([
  "risk_rule",
  "cap",
  "stuck",
  "spec_conflict",
  "budget",
  "change_request",
  "gate_infra",
  "spec_question",
  "blocked",
]);
export type ParkReason = z.infer<typeof ParkReasonSchema>;

export const TaskSizeSchema = z.enum(["S", "M", "L"]);
export type TaskSize = z.infer<typeof TaskSizeSchema>;

/** Architecture triage (§8.4): fits = 0 Architect tokens, extends = design note, changes = ADR. */
export const ArchTriageSchema = z.enum(["fits", "extends", "changes"]);
export type ArchTriage = z.infer<typeof ArchTriageSchema>;

/** Interface contract kinds that join cross-discipline tasks (§5.2a). */
export const ContractKindSchema = z.enum([
  "openapi",
  "graphql",
  "proto",
  "event_schema",
  "data_contract",
]);
export type ContractKind = z.infer<typeof ContractKindSchema>;

/** A contract this task publishes. `frozen_sha256` is set once the contract is frozen (§6.6). */
export const ProvidedContractSchema = z.strictObject({
  kind: ContractKindSchema,
  path: RelPathSchema,
  frozen_sha256: Sha256HexSchema.optional(),
});
export type ProvidedContract = z.infer<typeof ProvidedContractSchema>;

/** A contract this task builds against, published by `provider` (§6.6). */
export const ConsumedContractSchema = z.strictObject({
  provider: TaskIdSchema,
  kind: ContractKindSchema,
  path: RelPathSchema,
});
export type ConsumedContract = z.infer<typeof ConsumedContractSchema>;

/** Round cap by risk (§6.3 step 9). */
export const CAP_BY_RISK: Readonly<Record<Risk, number>> = { low: 3, med: 4, high: 5 };
export const capForRisk = (risk: Risk): number => CAP_BY_RISK[risk];

/** Maximum stack packs loaded per task (§5.2a: "at most about 3"). */
export const MAX_STACK_PACKS = 3;

export const TaskSchema = z
  .strictObject({
    id: TaskIdSchema,
    title: z.string().min(1).max(200),
    feature: FeatureIdSchema.optional(),
    covers: z.array(RequirementIdSchema).min(1),
    after: z.array(TaskIdSchema).default([]),
    files_scope: z.array(GlobSchema).min(1),
    discipline: DisciplineSchema,
    stack_packs: z.array(SlugSchema).max(MAX_STACK_PACKS).default([]),
    provides_contract: ProvidedContractSchema.optional(),
    consumes_contracts: z.array(ConsumedContractSchema).default([]),
    risk: RiskSchema,
    cap: z.int().min(3).max(5),
    size: TaskSizeSchema,
    arch_triage: ArchTriageSchema,
    budget_usd: z.number().positive(),
    spent_usd: z.number().nonnegative().default(0),
    status: TaskStatusSchema,
    park_reason: ParkReasonSchema.optional(),
    round: z.int().nonnegative().default(0),
    baseline_revision: GitShaSchema.optional(),
    /**
     * Repo-relative worktree path, inside gitignored `.vtc/state/` (e.g. `.vtc/state/worktrees/T-7`).
     * Never an absolute machine path: this record is projected into the git-tracked plan file.
     */
    worktree: RelPathSchema.optional(),
    branch: z
      .string()
      .regex(/^vtc\/T-[1-9]\d*$/, "expected branch vtc/T-n")
      .optional(),
    session_ref: SessionRefSchema.optional(),
    /** Fingerprints of findings routed `defer` (§6.3 step 8). */
    deferred: z.array(Sha256HexSchema).default([]),
  })
  .superRefine((task, ctx) => {
    if (task.round > task.cap) {
      ctx.addIssue({ code: "custom", path: ["round"], message: "round may not exceed cap" });
    }
    if (task.after.includes(task.id)) {
      ctx.addIssue({ code: "custom", path: ["after"], message: "a task cannot depend on itself" });
    }
    if (task.status === "parked" && task.park_reason === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["park_reason"],
        message: "parked requires park_reason",
      });
    }
    if (task.status !== "parked" && task.park_reason !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["park_reason"],
        message: "park_reason is only allowed when status is parked",
      });
    }
    if (task.branch !== undefined && task.branch !== `vtc/${task.id}`) {
      ctx.addIssue({ code: "custom", path: ["branch"], message: `branch must be vtc/${task.id}` });
    }
    for (const [i, consumed] of task.consumes_contracts.entries()) {
      if (consumed.provider === task.id) {
        ctx.addIssue({
          code: "custom",
          path: ["consumes_contracts", i, "provider"],
          message: "a task cannot consume its own contract",
        });
      }
    }
  });
export type Task = z.infer<typeof TaskSchema>;
export type TaskInput = z.input<typeof TaskSchema>;

// ------------------------------------------------------------ planner output

/** One row of the intent contract's I/O and edge-case matrix (§6.3 plan file). */
export const IoCaseSchema = z.strictObject({
  case: z.string().min(1).max(200),
  input: z.string().min(1).max(1000),
  expected: z.string().min(1).max(1000),
});
export type IoCase = z.infer<typeof IoCaseSchema>;

/**
 * The immutable `<intent-contract>` block of a plan file (§6.3): the intent, Always/Never
 * boundaries and the I/O and edge-case matrix. Written by the Planner, read by the Context
 * Packer, never edited after PLAN (a change is a CR).
 */
export const IntentContractSchema = z.strictObject({
  statement: z.string().min(1).max(2000),
  always: z.array(z.string().min(1).max(500)).default([]),
  never: z.array(z.string().min(1).max(500)).default([]),
  io_matrix: z.array(IoCaseSchema).min(1),
});
export type IntentContract = z.infer<typeof IntentContractSchema>;

/**
 * What the Planner submits per task (§5.2 Planner output). Strict: engine-owned fields
 * (`status`, `cap`, `budget_usd`, `round`, `spent_usd`, `worktree`, `branch`, `session_ref`,
 * `deferred`, `baseline_revision`) are rejected, so a planner can never set them (§6.4).
 * The engine derives `cap` from `risk` and `budget_usd` from `size` and project.yaml.
 */
export const TaskDraftSchema = z
  .strictObject({
    id: TaskIdSchema,
    title: z.string().min(1).max(200),
    feature: FeatureIdSchema.optional(),
    covers: z.array(RequirementIdSchema).min(1),
    after: z.array(TaskIdSchema).default([]),
    files_scope: z.array(GlobSchema).min(1),
    discipline: DisciplineSchema,
    stack_packs: z.array(SlugSchema).max(MAX_STACK_PACKS).default([]),
    provides_contract: ProvidedContractSchema.omit({ frozen_sha256: true }).optional(),
    consumes_contracts: z.array(ConsumedContractSchema).default([]),
    risk: RiskSchema,
    /** Planner risk tags (§5.2); the §7.6 risk rules still decide parking. */
    risk_tags: z.array(SlugSchema).default([]),
    size: TaskSizeSchema,
    arch_triage: ArchTriageSchema,
    intent: IntentContractSchema,
  })
  .superRefine((draft, ctx) => {
    if (draft.after.includes(draft.id)) {
      ctx.addIssue({ code: "custom", path: ["after"], message: "a task cannot depend on itself" });
    }
    for (const [i, consumed] of draft.consumes_contracts.entries()) {
      if (consumed.provider === draft.id) {
        ctx.addIssue({
          code: "custom",
          path: ["consumes_contracts", i, "provider"],
          message: "a task cannot consume its own contract",
        });
      }
    }
  });
export type TaskDraft = z.infer<typeof TaskDraftSchema>;
export type TaskDraftInput = z.input<typeof TaskDraftSchema>;

/**
 * Frontmatter of `.vtc/tasks/T-n.md` (§6.3). It is an engine-written **projection** of the task
 * state rebuilt from the event log (AD-7 rule 8): the engine regenerates it and never reads it
 * back as input, so a hand or agent edit cannot become a second source of truth.
 */
export const PlanFileFrontmatterSchema = TaskSchema;
export type PlanFileFrontmatter = Task;

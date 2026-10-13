/** Task contract (§6.3 plan file frontmatter, §6.4 states, §16 Task). */
import { z } from "zod";
import {
  DisciplineSchema,
  FeatureIdSchema,
  GitShaSchema,
  GlobSchema,
  RelPathSchema,
  RequirementIdSchema,
  RiskRuleReasonRuleSchema,
  RiskSchema,
  SessionRefSchema,
  Sha256HexSchema,
  SlugSchema,
  TaskIdSchema,
  type Risk,
} from "./primitives.js";

/**
 * §6.4 main path plus side states. `fixing(n/cap)` is `fixing` + `round`/`cap`.
 *
 * `non_converged` is **reserved**: the v1 engine never sets it. A task whose loop is stuck or
 * hits its cap parks (`parked`, reason `cap` or `stuck`, §6.3 step 9) and waits for the human.
 * §6.4 lists the state without saying when it applies; spine §5 reading 9 records this reading,
 * and giving it a meaning is a contract change (AD-3).
 */
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
 * `risk_rule` is only for §7.6 rules 1–9 (`RISK_RULE_REASON_RULES`); rules 10–13 always use
 * their own reason (`cap`/`stuck`, `spec_conflict`/`change_request`, `gate_infra`, `budget`).
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

/**
 * Cross-field rule for every record that carries `park_reason` (Task, Feature, the status-change
 * events, `StatusResult.parked`, WorkflowNode): `risk_rule` names the §7.6 rule 1–9 that fired and
 * is required for, and only allowed with, reason `risk_rule`, so a parked item says which rule
 * parked it without a join against escalations (`riskRuleForPark(park_reason, risk_rule)`).
 */
export const checkParkRiskRule = (
  value: { readonly park_reason?: ParkReason | undefined; readonly risk_rule?: unknown },
  ctx: z.RefinementCtx,
): void => {
  if ((value.park_reason === "risk_rule") !== (value.risk_rule !== undefined)) {
    ctx.addIssue({
      code: "custom",
      path: ["risk_rule"],
      message: "risk_rule is required for, and only allowed with, park_reason risk_rule",
    });
  }
};

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

/**
 * Round cap of a task by its risk (§6.3 step 9). The only source of the numbers is
 * `project.yaml` `caps` (`ProjectConfig.caps`, defaults low 3 / med 4 / high 5): pass it in.
 */
export const capForRisk = (risk: Risk, caps: Readonly<Record<Risk, number>>): number => caps[risk];

/** Maximum stack packs loaded per task (§5.2a: "at most about 3"). */
export const MAX_STACK_PACKS = 3;

/**
 * Statuses of a task listed in `after` that release its dependents: the dependency's code is on
 * the feature's integration branch, which the dependent's worktree is based on (§6.6, §6.7).
 * Until then a dependent that is otherwise ready waits as `waiting_dependency`.
 */
export const DEPENDENCY_RELEASED_STATUSES = [
  "merged",
  "done",
] as const satisfies readonly TaskStatus[];

/**
 * Where a task came from. `planner`: a Planner `TaskDraft` at PLAN. The engine creates the other
 * two from a triaged finding (`source_finding`): `integration_fix` for a Final Review finding no
 * single task owns (§6.7a), `out_of_scope` for a guarded Engineer `out_of_scope_fault` with no
 * owning task (§6.3 step 3). Only engine-created tasks may cover no REQ (a tool finding often
 * has none).
 */
export const TaskOriginSchema = z.enum(["planner", "integration_fix", "out_of_scope"]);
export type TaskOrigin = z.infer<typeof TaskOriginSchema>;

/**
 * Dependency rules shared by Task and TaskDraft (§5.2a, §6.6):
 * - `after` is satisfied when every listed task has a status in
 *   {@link DEPENDENCY_RELEASED_STATUSES} (its code is merged into the integration branch);
 * - a `consumes_contracts` provider is satisfied by that provider's `contract.frozen` event, not
 *   by its code, so it must **not** also appear in `after` (that would forbid the early,
 *   contract-first start §6.6 allows);
 * - no task depends on itself or consumes its own contract.
 */
const checkDependencies = (
  task: {
    readonly id: string;
    readonly after: readonly string[];
    readonly consumes_contracts: readonly { readonly provider: string }[];
  },
  ctx: z.RefinementCtx,
): void => {
  if (task.after.includes(task.id)) {
    ctx.addIssue({ code: "custom", path: ["after"], message: "a task cannot depend on itself" });
  }
  if (new Set(task.after).size !== task.after.length) {
    ctx.addIssue({ code: "custom", path: ["after"], message: "after must be unique" });
  }
  for (const [i, consumed] of task.consumes_contracts.entries()) {
    if (consumed.provider === task.id) {
      ctx.addIssue({
        code: "custom",
        path: ["consumes_contracts", i, "provider"],
        message: "a task cannot consume its own contract",
      });
    }
    if (task.after.includes(consumed.provider)) {
      ctx.addIssue({
        code: "custom",
        path: ["consumes_contracts", i, "provider"],
        message:
          "a contract provider is released by contract.frozen; do not also list it in after (§6.6)",
      });
    }
  }
};

export const TaskSchema = z
  .strictObject({
    id: TaskIdSchema,
    title: z.string().min(1).max(200),
    /**
     * The run's feature. The engine creates exactly one feature per run at PLAN and assigns every
     * task to it, including engine-created tasks (`FeatureSchema`).
     */
    feature: FeatureIdSchema,
    /** `planner` unless the engine created the task from a finding (`source_finding`). */
    origin: TaskOriginSchema.default("planner"),
    /** Fingerprint of the finding an `integration_fix` or `out_of_scope` task fixes. */
    source_finding: Sha256HexSchema.optional(),
    /** REQs the task covers. At least one for Planner tasks; may be empty for engine-created ones. */
    covers: z.array(RequirementIdSchema),
    /** Tasks whose code this one builds on; see {@link DEPENDENCY_RELEASED_STATUSES}. */
    after: z.array(TaskIdSchema).default([]),
    files_scope: z.array(GlobSchema).min(1),
    discipline: DisciplineSchema,
    stack_packs: z.array(SlugSchema).max(MAX_STACK_PACKS).default([]),
    provides_contract: ProvidedContractSchema.optional(),
    consumes_contracts: z.array(ConsumedContractSchema).default([]),
    risk: RiskSchema,
    /** Planner risk tags (§5.2), kept for the Risk Router and lens triggers after replay (§5.3). */
    risk_tags: z.array(SlugSchema).default([]),
    cap: z.int().min(3).max(5),
    size: TaskSizeSchema,
    arch_triage: ArchTriageSchema,
    budget_usd: z.number().positive(),
    spent_usd: z.number().nonnegative().default(0),
    status: TaskStatusSchema,
    park_reason: ParkReasonSchema.optional(),
    /** The §7.6 rule 1–9 that parked the task; only with `park_reason: risk_rule`. */
    risk_rule: RiskRuleReasonRuleSchema.optional(),
    /**
     * Fix-loop round (§6.3 step 9). 0 before the first build; the engine sets round n when the
     * task enters `building` (n = 1) or `fixing` (n + 1), and `cap` is the largest n, so cap 4
     * allows rounds 1–4. Findings record the task round they were seen in
     * (`Finding.round_first_seen`). A merged task reopened by Final Review keeps its round: those
     * fix rounds count on the feature (`Feature.round`, §6.7a), never here.
     */
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
    checkDependencies(task, ctx);
    if (task.origin === "planner" && task.covers.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["covers"],
        message: "a Planner task covers at least one REQ",
      });
    }
    if ((task.origin === "planner") !== (task.source_finding === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["source_finding"],
        message: "source_finding is required for, and only allowed on, engine-created tasks",
      });
    }
    checkParkRiskRule(task, ctx);
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
 * boundaries and the I/O and edge-case matrix. Written by the Planner, recorded once in
 * `task.created.intent` (so replay rebuilds the plan-file block and every pack from the log),
 * read by the Context Packer, never edited after PLAN (a change is a CR).
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
 * (`feature`, `origin`, `status`, `cap`, `budget_usd`, `round`, `spent_usd`, `worktree`,
 * `branch`, `session_ref`, `deferred`, `baseline_revision`) are rejected, so a planner can never
 * set them (§6.4). The engine derives `cap` from `risk`, `budget_usd` from `size` and
 * project.yaml, and assigns every task to the run's one feature.
 */
export const TaskDraftSchema = z
  .strictObject({
    id: TaskIdSchema,
    title: z.string().min(1).max(200),
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
    checkDependencies(draft, ctx);
  });
export type TaskDraft = z.infer<typeof TaskDraftSchema>;
export type TaskDraftInput = z.input<typeof TaskDraftSchema>;

/**
 * Frontmatter of `.vtc/tasks/T-n.md` (§6.3). It is an engine-written **projection** of the task
 * state rebuilt from the event log (AD-7 rule 8): the engine regenerates it and never reads it
 * back as input, so a hand or agent edit cannot become a second source of truth. The
 * `<intent-contract>` block below it is a projection too, of `task.created.intent`.
 */
export const PlanFileFrontmatterSchema = TaskSchema;
export type PlanFileFrontmatter = Task;

/**
 * Level-3 auto-merge (spec §6.4, §6.7 "Safe-to-auto-merge checklist" and guardrails, D9; spine
 * AD-23). New in contracts 4.5.0.
 *
 * Level 3 runs only when the base branch makes GitHub enforce what the checklist promises
 * ({@link level3Preflight}); otherwise the run's effective level is 2 with a recorded reason. The
 * merge is bound to the SHA the gates verified (`gh pr merge --auto --match-head-commit <sha>`)
 * and never uses an admin bypass ({@link GH_FORBIDDEN_ARGS}). After the merge a watch reads the
 * base branch's CI and looks for reverts; either downgrades the level through the git-tracked
 * ledger ({@link MERGE_LEVEL_LEDGER}), which only a human restores. `project.yaml` stays
 * human-owned: the engine never edits it.
 */
import { z } from "zod";
import type { RequiredCheck } from "./feature.js";
import { MergeLevelSchema, type MergeLevel } from "./project-config.js";
import {
  EvidenceSchema,
  FeatureIdSchema,
  GitShaSchema,
  IsoDateTimeSchema,
  RunIdSchema,
  type Evidence,
  type RiskRuleId,
} from "./primitives.js";
import type { VisualStatus } from "./visual.js";

// ------------------------------------------------------------ remote policy

export const MergeMethodSchema = z.enum(["merge", "squash", "rebase"]);
export type MergeMethod = z.infer<typeof MergeMethodSchema>;

/**
 * What the remote enforces on the base branch (rules API `GET /repos/{o}/{r}/rules/branches/{b}`,
 * then classic branch protection), read with the user's own `gh` auth. `auto_merge_allowed: null`
 * = the repo setting could not be read (the engine then tries and handles the refusal).
 */
export const RemoteMergePolicySchema = z.strictObject({
  base: z.string().min(1).max(255),
  auto_merge_allowed: z.boolean().nullable(),
  /** Names of the required status checks; empty = GitHub would merge without any CI. */
  required_checks: z.array(z.string().min(1).max(200)),
  merge_methods: z.array(MergeMethodSchema),
  merge_queue: z.boolean(),
  requires_review: z.boolean(),
  signatures_required: z.boolean(),
});
export type RemoteMergePolicy = z.infer<typeof RemoteMergePolicySchema>;

/** Why the Level-3 preflight failed (each one names what the human should configure). */
export const MergePreflightFailureSchema = z.enum([
  "not_github",
  "gh_unauthenticated",
  "auto_merge_disallowed",
  "no_required_checks",
  "no_merge_method",
  /**
   * The engine has no `RemoteMergeService` (`EngineDeps.remoteMerge` absent), so nothing can
   * read the remote's policy or enable auto-merge (AD-23 rule 1; spine §5 reading 115). New in
   * 4.6.0.
   */
  "no_merge_service",
]);
export type MergePreflightFailure = z.infer<typeof MergePreflightFailureSchema>;

/**
 * Payload of the `merge.preflight` event: the Level-3 preflight at run start (and in
 * `vtc doctor`). A failed preflight starts the run at `effective_level` 2
 * (`run.started.merge_level`), so replay needs no other record of it.
 */
export const MergePreflightSchema = z
  .strictObject({
    configured_level: MergeLevelSchema,
    effective_level: MergeLevelSchema,
    ok: z.boolean(),
    failed: z.array(MergePreflightFailureSchema).default([]),
    policy: RemoteMergePolicySchema.nullable(),
    detail: z.string().min(1).max(1000).optional(),
  })
  .refine((v) => v.ok === (v.failed.length === 0), {
    message: "failed lists the failures exactly when ok is false",
    path: ["failed"],
  });
export type MergePreflight = z.infer<typeof MergePreflightSchema>;

/**
 * Pure (AD-23 rule 1): which Level-3 requirements the remote misses. An empty list means Level 3
 * may run; any failure makes the effective level 2. A base branch with no required status check
 * fails, because GitHub would then merge the PR without waiting for any CI.
 */
export const level3Preflight = (input: {
  readonly github: boolean;
  readonly ghAuthenticated: boolean;
  readonly policy: RemoteMergePolicy | null;
}): MergePreflightFailure[] => {
  if (!input.github) return ["not_github"];
  if (!input.ghAuthenticated) return ["gh_unauthenticated"];
  const failed: MergePreflightFailure[] = [];
  const policy = input.policy;
  if (policy?.auto_merge_allowed === false) failed.push("auto_merge_disallowed");
  if (policy === null || policy.required_checks.length === 0) failed.push("no_required_checks");
  if (policy !== null && policy.merge_methods.length === 0) failed.push("no_merge_method");
  return failed;
};

// --------------------------------------------------------------- gh arguments

/**
 * Arguments the `gh`-backed services never pass (AD-23 rule 2): `--admin` bypasses the base
 * branch's requirements. The cli's implementation test asserts no argv contains one.
 */
export const GH_FORBIDDEN_ARGS = ["--admin"] as const;

/** Pure: every argument that is, or sets, a {@link GH_FORBIDDEN_ARGS} flag. */
export const findForbiddenGhArgs = (args: readonly string[]): string[] =>
  args.filter((arg) =>
    GH_FORBIDDEN_ARGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`)),
  );

// ------------------------------------------------------------------ checklist

/** The seven items of §6.7's safe-to-auto-merge checklist, in spec order. */
export const AUTO_MERGE_CHECKLIST_ITEMS = [
  "final_review",
  "reviewers",
  "coverage",
  "test_integrity",
  "risk_rules",
  "waivers",
  "remote_ci",
] as const;
export const AutoMergeChecklistItemIdSchema = z.enum(AUTO_MERGE_CHECKLIST_ITEMS);
export type AutoMergeChecklistItemId = z.infer<typeof AutoMergeChecklistItemIdSchema>;

/** The evaluated checklist (payload of `feature.checklist`; Flow Studio shows it). */
export const AutoMergeChecklistSchema = z
  .strictObject({
    ok: z.boolean(),
    items: z
      .array(
        z.strictObject({
          id: AutoMergeChecklistItemIdSchema,
          ok: z.boolean(),
          detail: z.string().min(1).max(500),
          evidence: z.array(EvidenceSchema).default([]),
        }),
      )
      .length(AUTO_MERGE_CHECKLIST_ITEMS.length),
  })
  .superRefine((list, ctx) => {
    if (list.items.some((item, i) => item.id !== AUTO_MERGE_CHECKLIST_ITEMS[i])) {
      ctx.addIssue({
        code: "custom",
        path: ["items"],
        message: "items are the seven checklist items in spec order",
      });
    }
    if (list.ok !== list.items.every((item) => item.ok)) {
      ctx.addIssue({
        code: "custom",
        path: ["ok"],
        message: "ok is true exactly when all items are",
      });
    }
  });
export type AutoMergeChecklist = z.infer<typeof AutoMergeChecklistSchema>;

/** What {@link autoMergeChecklist} reads: engine state plus the PR view, each with its evidence. */
export interface AutoMergeChecklistInput {
  readonly finalReview: {
    readonly verdict: "pending" | "pass" | "fail" | "parked";
    /** Every gate green on the combined code (§6.7a step 1). */
    readonly gatesGreen: boolean;
    /**
     * The feature's deterministic visual status (§7.5); `null` when the feature has no UI. Only
     * `pass` counts: `skipped` (no browser, D-ay), `unchecked`, `fail` and `error` block Level 3
     * (spine §5 reading 105).
     */
    readonly visual: VisualStatus | null;
    readonly evidence: readonly Evidence[];
  };
  readonly reviewers: {
    readonly allPassedWithEvidence: boolean;
    /** Open findings at or above `auto_merge.block_severity`. */
    readonly openAtOrAboveThreshold: number;
    readonly evidence: readonly Evidence[];
  };
  readonly coverage: { readonly gaps: number; readonly evidence: readonly Evidence[] };
  readonly testIntegrity: { readonly clean: boolean; readonly evidence: readonly Evidence[] };
  readonly riskRules: {
    readonly fired: readonly RiskRuleId[];
    readonly evidence: readonly Evidence[];
  };
  readonly waivers: {
    readonly waivers: number;
    readonly parkedDependencies: number;
    readonly evidence: readonly Evidence[];
  };
  readonly remoteCi: {
    /** The required checks on the PR head; every one must be `success`. */
    readonly required: readonly RequiredCheck[];
    /** The PR head GitHub reports, and the SHA the gates verified. */
    readonly headSha: string;
    readonly gatedSha: string;
    readonly evidence: readonly Evidence[];
  };
}

/** Pure (AD-23 rule 3): the §6.7 checklist from engine state and the PR view. */
export const autoMergeChecklist = (input: AutoMergeChecklistInput): AutoMergeChecklist => {
  const fr = input.finalReview;
  const visualOk = fr.visual === null || fr.visual === "pass";
  const ci = input.remoteCi;
  const ciOk =
    ci.required.length > 0 &&
    ci.required.every((c) => c.state === "success") &&
    ci.headSha === ci.gatedSha;
  const items: AutoMergeChecklist["items"] = [
    {
      id: "final_review",
      ok: fr.verdict === "pass" && fr.gatesGreen && visualOk,
      detail: `Final Review ${fr.verdict}; gates ${fr.gatesGreen ? "green" : "not green"}; visual ${fr.visual ?? "n/a"}`,
      evidence: [...fr.evidence],
    },
    {
      id: "reviewers",
      ok: input.reviewers.allPassedWithEvidence && input.reviewers.openAtOrAboveThreshold === 0,
      detail: `${String(input.reviewers.openAtOrAboveThreshold)} open findings at or above the threshold`,
      evidence: [...input.reviewers.evidence],
    },
    {
      id: "coverage",
      ok: input.coverage.gaps === 0,
      detail: `${String(input.coverage.gaps)} requirement gaps`,
      evidence: [...input.coverage.evidence],
    },
    {
      id: "test_integrity",
      ok: input.testIntegrity.clean,
      detail: input.testIntegrity.clean ? "clean" : "violations found",
      evidence: [...input.testIntegrity.evidence],
    },
    {
      id: "risk_rules",
      ok: input.riskRules.fired.length === 0,
      detail: input.riskRules.fired.length === 0 ? "none fired" : input.riskRules.fired.join(", "),
      evidence: [...input.riskRules.evidence],
    },
    {
      id: "waivers",
      ok: input.waivers.waivers === 0 && input.waivers.parkedDependencies === 0,
      detail: `${String(input.waivers.waivers)} waivers, ${String(input.waivers.parkedDependencies)} parked dependencies`,
      evidence: [...input.waivers.evidence],
    },
    {
      id: "remote_ci",
      ok: ciOk,
      detail:
        ci.required.length === 0
          ? "no required checks"
          : ci.headSha !== ci.gatedSha
            ? "the PR head is not the gated commit"
            : `${String(ci.required.filter((c) => c.state === "success").length)}/${String(ci.required.length)} required checks green`,
      evidence: [...ci.evidence],
    },
  ];
  return { ok: items.every((item) => item.ok), items };
};

// ------------------------------------------------------------ post-merge watch

/** One CI run on the base branch for the merge commit (`gh run list --branch --commit`). */
export const BaseRunSchema = z.strictObject({
  name: z.string().min(1).max(200),
  conclusion: z.enum(["success", "failure", "cancelled", "skipped", "pending", "unknown"]),
  /** A required check on the base; only red required runs downgrade. */
  required: z.boolean(),
  url: z.url().optional(),
});
export type BaseRun = z.infer<typeof BaseRunSchema>;

/** How a revert of the merge commit was found (AD-23 rule 4). */
export const RevertDetectionSchema = z.enum(["git_log", "pr_reference", "patch_id", "human"]);
export type RevertDetection = z.infer<typeof RevertDetectionSchema>;

export const RevertRefSchema = z.strictObject({
  commit: GitShaSchema,
  detected_by: RevertDetectionSchema,
});
export type RevertRef = z.infer<typeof RevertRefSchema>;

/** Default post-merge watch window (§6.7 guardrails), in hours. */
export const POST_MERGE_WATCH_HOURS = 24;

// --------------------------------------------------------- merge-level ledger

/**
 * The engine-written, git-tracked, append-only, redacted downgrade ledger (AD-23 rule 4). One
 * JSON line per entry; teammates get it through git (D8). `project.yaml` is never edited.
 */
export const MERGE_LEVEL_LEDGER = ".vtc/merge-level.jsonl";

/**
 * One ledger line. `downgrade` (engine: a revert or a red required base run; human: `vtc
 * merge-level` lowering it) caps the level at `cap`; `restore` (human only, through
 * `vtc merge-level restore`, TTY-confirmed) raises the cap again.
 */
export const MergeLevelLedgerEntrySchema = z
  .strictObject({
    v: z.literal(1),
    at: IsoDateTimeSchema,
    kind: z.enum(["downgrade", "restore"]),
    cap: MergeLevelSchema,
    reason: z.enum(["revert", "post_merge_ci_failure", "human"]),
    run: RunIdSchema.optional(),
    feature: FeatureIdSchema.optional(),
    merge_commit: GitShaSchema.optional(),
    detail: z.string().min(1).max(500),
  })
  .refine((e) => e.kind === "downgrade" || e.reason === "human", {
    message: "only a human restores the merge level",
    path: ["reason"],
  });
export type MergeLevelLedgerEntry = z.infer<typeof MergeLevelLedgerEntrySchema>;

/** The highest merge level an automatic run may use (D-bw): a draft PR for human review. */
export const AUTOMATIC_RUN_MAX_MERGE_LEVEL: MergeLevel = 2;

/**
 * Pure: the effective merge level = `min(project.yaml merge_level, ledger cap)`. Entries apply in
 * order: a downgrade lowers the cap to its `cap` (never raises it), a restore sets the cap to its
 * `cap`. No entries = no cap. An automatic run (`run.started.automation`, AD-27) is capped at 2:
 * VTC never merges what it opened on its own (D-bw; `automatic`, new in 5.0.0).
 */
export const effectiveMergeLevel = (
  configured: MergeLevel,
  entries: readonly Pick<MergeLevelLedgerEntry, "kind" | "cap">[],
  options: { readonly automatic?: boolean } = {},
): MergeLevel => {
  let cap: MergeLevel = options.automatic === true ? AUTOMATIC_RUN_MAX_MERGE_LEVEL : 3;
  for (const entry of entries) {
    cap = entry.kind === "restore" ? entry.cap : (Math.min(cap, entry.cap) as MergeLevel);
    if (options.automatic === true)
      cap = Math.min(cap, AUTOMATIC_RUN_MAX_MERGE_LEVEL) as MergeLevel;
  }
  return Math.min(configured, cap) as MergeLevel;
};

// ------------------------------------------------------------------- events

/** Payload of `feature.auto_merge_enabled`: `gh pr merge --auto --match-head-commit` accepted. */
export const AutoMergeEnabledSchema = z.strictObject({
  pr_number: z.int().positive(),
  head_sha: GitShaSchema,
  method: MergeMethodSchema,
  /** The base has a merge queue: `--auto` enqueues the PR once checks pass. */
  merge_queue: z.boolean(),
});
export type AutoMergeEnabled = z.infer<typeof AutoMergeEnabledSchema>;

/** Payload of `feature.auto_merge_disabled`. */
export const AutoMergeDisabledSchema = z.strictObject({
  reason: z.enum(["paused", "head_moved", "base_changed", "conflict", "by_host", "timeout"]),
  detail: z.string().min(1).max(1000),
});
export type AutoMergeDisabled = z.infer<typeof AutoMergeDisabledSchema>;

/** Payload of `feature.post_merge_ci`: base CI for the merge commit, once per poll that changes it. */
export const PostMergeCiSchema = z.strictObject({
  merge_commit: GitShaSchema,
  status: z.enum(["green", "red", "pending"]),
  runs: z.array(BaseRunSchema).default([]),
});
export type PostMergeCi = z.infer<typeof PostMergeCiSchema>;

/** Payload of `feature.reverted`: the merge commit was reverted on the base. */
export const FeatureRevertedSchema = z.strictObject({
  merge_commit: GitShaSchema,
  revert: RevertRefSchema.optional(),
  detail: z.string().min(1).max(1000),
});
export type FeatureReverted = z.infer<typeof FeatureRevertedSchema>;

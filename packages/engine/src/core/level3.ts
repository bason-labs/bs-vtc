/**
 * Level-3 auto-merge (spec §6.4, §6.7 checklist and guardrails, D9; spine AD-23; §5 readings 104
 * and 105). Everything remote goes through the injected `RemoteMergeService`
 * (`EngineDeps.remoteMerge`), so engine core and its tests never need the network:
 * - at run start the Level-3 preflight decides whether the run may run at Level 3 at all; a
 *   failure starts it at Level 2 with a `merge.preflight` event and an escalation naming what the
 *   human should configure (VTC never changes repo settings);
 * - at release the §6.7 checklist (`autoMergeChecklist`, `feature.checklist`) must pass on the
 *   gated SHA, and auto-merge is enabled bound to it (`--match-head-commit`), never with an admin
 *   bypass; a moved head, a host that turns auto-merge off or a timeout parks the feature, and
 *   VTC turns auto-merge off first (GitHub keeps it on after a push); a PR that merged at any
 *   head but the gated SHA is never marked shipped;
 * - after the merge a watch reads base CI for the merge commit and looks for reverts; a red
 *   required run or a revert appends a downgrade to the git-tracked ledger
 *   (`MERGE_LEVEL_LEDGER`, `effectiveMergeLevel`) and records an escaped defect for Lookback;
 * - `vtc pause` turns off every pending auto-merge VTC enabled.
 * Parks use `blocked`: no new park or merge-level reason exists (reading 104).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  autoMergeChecklist,
  effectiveMergeLevel,
  evidenceBundlePath,
  isAtLeast,
  level3Preflight,
  MERGE_LEVEL_LEDGER,
  MergeLevelLedgerEntrySchema,
  POST_MERGE_WATCH_HOURS,
  redactJson,
  riskRuleForPark,
  type AutoMergeChecklistInput,
  type BaseRun,
  type Evidence,
  type GateReport,
  type MergeLevel,
  type MergeLevelLedgerEntry,
  type MergePreflight,
  type MergePreflightFailure,
  type ProjectConfig,
  type PullRequestRef,
  type RemoteMergePolicy,
  type RequiredCheck,
  type RiskRuleId,
  type Task,
  type VisualStatus,
  type VisualSummary,
} from "@vtc/shared";
import { appendRepoFile } from "../git/index.js";
import { parkEscalation } from "./escalations.js";
import { baseBranch, openFeatureEscalation, parkFeature, setFeatureStatus } from "./jobs.js";
import type { Kernel, RunHandle } from "./kernel.js";
import { readTraceability } from "./projections.js";
import { startRetro } from "./retro.js";
import { featureHasUi } from "./ui.js";
import { nextEscalationId } from "./queries.js";
import type { RunState } from "./state.js";

/** Level-3 waits (§6.7 guardrails; research §2.2): poll interval and the two timeouts. */
export const LEVEL3_TIMING = {
  /** How often the engine re-reads the PR and its checks while it waits. */
  pollMs: 60_000,
  /** Required checks on the gated SHA still pending after this long park the feature. */
  checksTimeoutMs: 2 * 3_600_000,
  /** Auto-merge enabled but not merged after this long (e.g. awaiting a review) parks it. */
  mergeTimeoutMs: 24 * 3_600_000,
} as const;

/** Waits `ms`, or less when the engine shuts down (`Kernel.stopping`). */
const sleep = (k: Kernel, ms: number): Promise<void> => {
  const signal = k.stopping;
  if (signal.aborted) return Promise.resolve();
  let onAbort: () => void = () => undefined;
  const stopped = new Promise<void>((resolve) => {
    onAbort = resolve;
    signal.addEventListener("abort", onAbort, { once: true });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slept =
    k.deps.sleep !== undefined
      ? k.deps.sleep(ms)
      : new Promise<void>((resolve) => {
          timer = setTimeout(resolve, ms);
          timer.unref();
        });
  return Promise.race([slept, stopped]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
  });
};

const message = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 500);

// ------------------------------------------------------------------ ledger

/** The ledger's entries in order (`MERGE_LEVEL_LEDGER`); a line that does not parse is skipped. */
export const readMergeLevelLedger = (repoRoot: string): MergeLevelLedgerEntry[] => {
  const path = join(repoRoot, MERGE_LEVEL_LEDGER);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .flatMap((line) => {
      if (line.trim() === "") return [];
      try {
        const parsed = MergeLevelLedgerEntrySchema.safeParse(JSON.parse(line));
        return parsed.success ? [parsed.data] : [];
      } catch {
        return [];
      }
    });
};

/** Appends one redacted entry (append-only, git-tracked, AD-23 rule 4). */
const appendLedger = (k: Kernel, entry: MergeLevelLedgerEntry): void => {
  const valid = MergeLevelLedgerEntrySchema.parse(entry);
  appendRepoFile(
    k.deps.repoRoot,
    MERGE_LEVEL_LEDGER,
    `${JSON.stringify(redactJson(valid, k.secrets()))}\n`,
  );
};

// --------------------------------------------------------------- preflight

/** What the human configures for each preflight failure (VTC never changes repo settings). */
const FAILURE_FIX: Readonly<Record<MergePreflightFailure, string>> = {
  not_github: "Level 3 needs the push remote on GitHub (a §7 residual: it is GitHub-only)",
  gh_unauthenticated: "sign in to the GitHub CLI (gh auth login)",
  auto_merge_disallowed: "allow auto-merge in the repository settings",
  no_required_checks:
    "add at least one required status check on the base branch (branch protection or a ruleset), or GitHub would merge without waiting for CI",
  no_merge_method: "allow at least one merge method in the repository settings",
  no_merge_service:
    "run the engine through the vtc cli, which wires the gh-backed merge service (this engine has none)",
};

export interface StartLevel {
  /** The level the run starts at (`run.started.merge_level`). */
  readonly level: MergeLevel;
  /** The Level-3 preflight, when the run was configured (and not capped) for Level 3. */
  readonly preflight: MergePreflight | null;
}

/**
 * The level a run starts at (AD-23 rules 1 and 5): `project.yaml` `merge_level` capped by the
 * ledger, then, for Level 3, the preflight on the remote and the base branch's policy. Any
 * failure, or no `RemoteMergeService`, starts the run at Level 2.
 */
export const startMergeLevel = async (
  k: Kernel,
  config: ProjectConfig,
  /** An automatic run (AD-27 rule 2, D-bw): capped at Level 2, so never a Level-3 preflight. */
  automatic = false,
): Promise<StartLevel> => {
  const configured = config.merge_level;
  const capped = effectiveMergeLevel(configured, readMergeLevelLedger(k.deps.repoRoot), {
    automatic,
  });
  if (capped < 3) return { level: capped, preflight: null };
  const service = k.deps.remoteMerge;
  const fail = (failed: MergePreflightFailure[], detail: string, policy = null) => ({
    level: 2 as const,
    preflight: {
      configured_level: configured,
      effective_level: 2 as const,
      ok: false,
      failed,
      policy,
      detail: detail.slice(0, 1000),
    },
  });
  if (service === undefined)
    return fail(["no_merge_service"], "this engine has no GitHub merge service (gh) wired in");
  let remote;
  try {
    remote = await service.remote();
  } catch (error) {
    return fail(["gh_unauthenticated"], `gh could not be run: ${message(error)}`);
  }
  let policy = null;
  let policyError: string | undefined;
  if (remote.github && remote.ghAuthenticated) {
    try {
      policy = await service.policy(await baseBranch(k.deps.repoRoot));
    } catch (error) {
      policyError = `the base branch's policy could not be read: ${message(error)}`;
    }
  }
  const failed = level3Preflight({ ...remote, policy });
  const detail = [policyError, ...failed.map((f) => FAILURE_FIX[f])]
    .filter((d) => d !== undefined)
    .join("; ");
  return {
    level: failed.length === 0 ? 3 : 2,
    preflight: {
      configured_level: configured,
      effective_level: failed.length === 0 ? 3 : 2,
      ok: failed.length === 0,
      failed,
      policy,
      ...(detail === "" ? {} : { detail: detail.slice(0, 1000) }),
    },
  };
};

/** Records the preflight; a failure opens an escalation that says what to configure. */
export const recordMergePreflight = (k: Kernel, h: RunHandle, preflight: MergePreflight): void => {
  k.emit(h, { type: "merge.preflight", actor: "engine", data: preflight });
  if (preflight.ok) return;
  const escalation = parkEscalation({
    id: nextEscalationId(h.state),
    run: h.state.id,
    phase: h.state.run.phase,
    reason: "blocked",
    detail:
      `merge_level 3 cannot run here, so this run runs at Level 2 (its PR is marked ready for your review): ${preflight.detail ?? preflight.failed.join(", ")}. Answer to acknowledge; the next run checks again`.slice(
        0,
        2000,
      ),
    evidence: [{ type: "file", ref: ".vtc/project.yaml" }],
    blocks: [],
    now: k.now(),
  });
  k.emit(h, { type: "escalation.opened", actor: "engine", data: { escalation } });
};

// ---------------------------------------------------------------- checklist

const featureTasks = (h: RunHandle, featureId: string): Task[] =>
  (h.state.features.get(featureId)?.tasks ?? []).flatMap((id) => {
    const task = h.state.tasks.get(id);
    return task === undefined ? [] : [task];
  });

/** The feature's last Final Review gate run, if any. */
export const lastFinalReview = (h: RunHandle, featureId: string): GateReport | undefined =>
  h.state.gateReports
    .map((r) => r.report)
    .filter((r) => r.reason === "final_review" && r.feature === featureId)
    .at(-1);

/**
 * The visual status the Level-3 Final Review item reads (AD-23, AD-24): `null` for a feature with
 * no UI, `unchecked` for a UI feature whose Final Review ran no visual step, and `skipped` for a
 * `pass` on the project's own Playwright (spine §5 readings 124 and 137), which, like a run with
 * no browser, never satisfies the item.
 */
export const level3VisualStatus = (
  visual: VisualSummary | undefined,
  hasUi: boolean,
): VisualStatus | null => {
  if (visual === undefined) return hasUi ? "unchecked" : null;
  return visual.status === "pass" && visual.toolchain === "project" ? "skipped" : visual.status;
};

/** The engine-side inputs of the §6.7 checklist, each with its evidence (AD-23 rule 2). */
export const checklistInput = (
  k: Kernel,
  h: RunHandle,
  featureId: string,
  remote: { readonly required: readonly RequiredCheck[]; readonly headSha: string },
  gatedSha: string,
): AutoMergeChecklistInput => {
  const state = h.state;
  const feature = state.features.get(featureId);
  const tasks = featureTasks(h, featureId).filter((t) => t.status !== "dropped");
  const taskIds = new Set(tasks.map((t) => t.id));
  const report = lastFinalReview(h, featureId);
  const bundle: Evidence = { type: "file", ref: evidenceBundlePath(featureId) };
  const findings = [...state.findings.values()]
    .map((r) => r.finding)
    .filter((f) => f.feature === featureId || (f.task !== undefined && taskIds.has(f.task)));
  const threshold = k.config().auto_merge.block_severity;
  // the latest verdicts of every reviewer step of the feature's tasks
  const latest = new Map<string, string[]>();
  for (const run of state.roleRuns.values()) {
    if (run.task === undefined || !taskIds.has(run.task) || run.status !== "submitted") continue;
    if (run.verdicts.length === 0) continue;
    latest.set(
      `${run.task}/${run.role}/${run.mode ?? ""}/${run.subject ?? ""}`,
      run.verdicts.map((v) => v.verdict),
    );
  }
  // no recorded verdict at all is not a pass (an empty set would be vacuously true)
  const reviewersPassed =
    latest.size > 0 && [...latest.values()].every((v) => v.every((x) => x === "pass"));
  const traceability = readTraceability(
    k.deps.repoRoot,
    state,
    { feature: featureId },
    [...new Set(tasks.flatMap((t) => t.covers))],
    k.now(),
  );
  const fired = new Set<RiskRuleId>();
  for (const e of state.escalations.values()) {
    const ours = e.feature === featureId || (e.task !== undefined && taskIds.has(e.task));
    if (!ours) continue;
    const rule = riskRuleForPark(e.reason, e.risk_rule);
    if (rule !== null) fired.add(rule);
  }
  const visual = level3VisualStatus(report?.visual, featureHasUi(h.state, featureId));
  // a step of the last Final Review round that could not be checked never counts as a pass
  // (AD-23 rule 3): the round's steps are those logged after its gate run
  const reportSeq = h.state.gateReports
    .filter((r) => r.report.reason === "final_review" && r.report.feature === featureId)
    .at(-1)?.seq;
  const uncheckedSteps = h.state.events.filter(
    (e) =>
      e.type === "final_review.step_finished" &&
      e.feature === featureId &&
      e.seq > (reportSeq ?? Number.MAX_SAFE_INTEGER) &&
      (e.data as { status?: string }).status === "unchecked",
  ).length;
  const reportEvidence: Evidence[] =
    report === undefined ? [] : [{ type: "commit", ref: report.head }];
  return {
    finalReview: {
      verdict:
        (feature?.status === "ready_to_ship" || feature?.status === "shipped") &&
        uncheckedSteps === 0
          ? "pass"
          : "pending",
      gatesGreen: report?.verdict === "pass",
      visual,
      evidence: [bundle, ...reportEvidence],
    },
    reviewers: {
      allPassedWithEvidence: reviewersPassed,
      openAtOrAboveThreshold: findings.filter(
        (f) => f.status === "open" && isAtLeast(f.severity, threshold),
      ).length,
      evidence: [bundle],
    },
    coverage: {
      gaps: traceability.gaps.length,
      evidence: [{ type: "file", ref: `.vtc/evidence/${featureId}/traceability.json` }],
    },
    testIntegrity: {
      clean: !findings.some((f) => f.category === "test_integrity" && f.status === "open"),
      evidence: [bundle],
    },
    riskRules: { fired: [...fired], evidence: [bundle] },
    waivers: {
      waivers: findings.filter((f) => f.status === "waived").length,
      parkedDependencies: featureTasks(h, featureId).filter(
        (t) => t.status === "parked" || t.status === "dropped",
      ).length,
      evidence: [bundle],
    },
    remoteCi: {
      required: remote.required,
      headSha: remote.headSha,
      gatedSha,
      evidence: [{ type: "commit", ref: gatedSha }],
    },
  };
};

// -------------------------------------------------------------- auto-merge

const updatePr = (k: Kernel, h: RunHandle, featureId: string, pr: PullRequestRef | null): void => {
  if (pr === null) return;
  if (JSON.stringify(pr) === JSON.stringify(h.state.features.get(featureId)?.pr)) return;
  k.emit(h, { type: "feature.pr_updated", actor: "engine", feature: featureId, data: { pr } });
};

/** GitHub would merge the PR on its own: auto-merge is on, or the PR is in the merge queue. */
const isOn = (pr: PullRequestRef | null | undefined): boolean =>
  pr?.auto_merge === "enabled" || pr?.auto_merge === "queued";

/**
 * VTC enabled the feature's auto-merge and has not seen it turned off since. Read from the run's
 * events, not from `feature.pr`: on the next start after a shutdown that left it on (the shutdown
 * does not turn it off), the release's push records the PR again, and a `gh pr view` that does not
 * report `auto_merge` would otherwise hide it.
 */
const leftOnByVtc = (state: RunState, featureId: string): boolean => {
  let on = false;
  for (const e of state.events) {
    if (e.feature !== featureId) continue;
    if (e.type === "feature.auto_merge_enabled") on = true;
    else if (e.type === "feature.auto_merge_disabled") on = false;
    else if (e.type === "feature.pr_updated") {
      const pr = (e.data as { pr?: PullRequestRef }).pr;
      if (
        pr?.state !== "open" ||
        pr.auto_merge === "disabled" ||
        pr.auto_merge === "not_requested" ||
        pr.auto_merge === "merged"
      )
        on = false;
    }
  }
  return on;
};

/** Auto-merge may be on for the feature's PR: GitHub or the run's own events say so. */
const mayBeOn = (h: RunHandle, featureId: string, pr: PullRequestRef | null | undefined): boolean =>
  isOn(pr) || leftOnByVtc(h.state, featureId);

const park = (
  k: Kernel,
  h: RunHandle,
  featureId: string,
  detail: string,
  evidence: readonly Evidence[] = [],
): Promise<"parked"> =>
  k.serial(h, () => {
    const status = h.state.features.get(featureId)?.status;
    if (status === "ready_to_ship")
      parkFeature(
        k,
        h,
        featureId,
        "blocked",
        `Level 3: ${detail}. ${LEVEL3_PARK_NOTE}`,
        evidence,
        undefined,
        true,
      );
    return Promise.resolve("parked" as const);
  });

/** What every Level-3 release park tells the human (AD-23; D-bd, spine §5 reading 158). */
const LEVEL3_PARK_NOTE =
  "The PR stays open for your review; retry the auto-merge once the cause is fixed, or finish at Level 2";

/**
 * Whether a parked feature's last escalation was answered `finish_level_2` and that answer has not
 * finished yet: the feature stays parked until {@link finishAtLevel2}'s last step, so an engine
 * that stopped while it ran (the remote call in flight) leaves the answer to finish again.
 */
export const finishAtLevel2Pending = (state: RunState, featureId: string): boolean => {
  if (state.features.get(featureId)?.status !== "parked") return false;
  const last = [...state.escalations.values()]
    .filter((e) => e.feature === featureId && e.task === undefined)
    .at(-1);
  const answer = last?.answer?.option;
  return (
    answer !== undefined && last?.options.find((o) => o.id === answer)?.effect === "finish_level_2"
  );
};

/**
 * The answer `finish_level_2` to a Level-3 release park (AD-23; D-bd, spine §5 reading 158): VTC
 * turns off any auto-merge it enabled on the feature's open PR, leaves the PR open for the human's
 * review and ends the run as at Level 2 (the feature `ready_to_ship`, then RETRO and
 * `run.finished`). It changes no merge level: `.vtc/merge-level.jsonl` is for downgrades only. An
 * auto-merge that cannot be turned off parks the feature again with what the human must do, and
 * the run stays open. Runs as the feature's release job, so no release starts beside it. Callers
 * hold the run's lock; the feature is parked.
 */
export const finishAtLevel2 = (k: Kernel, h: RunHandle, featureId: string): void => {
  k.spawn(h, `release:${featureId}`, async () => {
    const service = k.deps.remoteMerge;
    const feature = h.state.features.get(featureId);
    let failure: string | null = null;
    if (
      service !== undefined &&
      feature?.pr?.state === "open" &&
      mayBeOn(h, featureId, feature.pr)
    ) {
      try {
        const off = await service.disableAutoMerge(feature.integration_branch);
        await k.serial(h, () => {
          updatePr(k, h, featureId, off === null ? null : { ...off, auto_merge: "disabled" });
          return Promise.resolve();
        });
      } catch (error) {
        failure = message(error);
      }
    }
    await k.serial(h, () => {
      if (h.state.run.finished_at !== undefined) return Promise.resolve();
      if (h.state.features.get(featureId)?.status !== "parked") return Promise.resolve();
      if (failure !== null) {
        const pr = h.state.features.get(featureId)?.pr;
        openFeatureEscalation(
          k,
          h,
          featureId,
          "blocked",
          `Level 3: you chose to finish at Level 2, but VTC could NOT turn its auto-merge off (${failure}): turn it off now (gh pr merge ${pr?.number === undefined ? (feature?.integration_branch ?? featureId) : String(pr.number)} --disable-auto), then answer again. ${LEVEL3_PARK_NOTE}`,
          [],
          undefined,
          true,
        );
        return Promise.resolve();
      }
      setFeatureStatus(k, h, featureId, "ready_to_ship");
      k.emit(h, {
        type: "run.phase_changed",
        actor: "engine",
        data: { from: h.state.run.phase, to: "retro" },
      });
      startRetro(k, h);
      return Promise.resolve();
    });
  });
};

/**
 * Level 3 at release (AD-23 rules 2 and 3): waits for the base's required checks on the gated SHA,
 * evaluates the §6.7 checklist (`feature.checklist`), enables auto-merge bound to that SHA and
 * waits for the merge (`shipped`). Returns `merged` when the feature shipped, `parked` when it
 * parked for the human, `paused` when `vtc pause` stopped it, `stopped` when the engine shut down
 * (the next start reads the PR again).
 */
export const autoMergeFeature = async (
  k: Kernel,
  h: RunHandle,
  featureId: string,
): Promise<"merged" | "parked" | "paused" | "stopped"> => {
  const service = k.deps.remoteMerge;
  const feature = h.state.features.get(featureId);
  const report = lastFinalReview(h, featureId);
  if (service === undefined || feature === undefined)
    return park(k, h, featureId, "no GitHub merge service is wired in");
  if (report?.verdict !== "pass")
    return park(k, h, featureId, "no passing Final Review gate run to merge");
  const gated = report.head;
  const branch = feature.integration_branch;
  const prs = k.deps.pullRequests;
  const started = k.now().getTime();
  const paused = (): boolean => h.state.run.paused;
  const stopped = (): boolean => k.stopping.aborted;
  let required: readonly RequiredCheck[] = [];
  let pr: PullRequestRef | null;
  let policy: RemoteMergePolicy;
  let number = feature.pr?.number;
  /**
   * Turns the PR's auto-merge off (AD-23: GitHub keeps it on when someone pushes, and a pause
   * must not leave it on) and records it; `null` once it is off, else why it could not be.
   * Without a `reason` (no `feature.auto_merge_disabled` reason fits) only the PR is recorded.
   */
  const turnOff = async (
    reason: "paused" | "head_moved" | "timeout" | null,
    detail: string,
  ): Promise<string | null> => {
    let off: PullRequestRef | null;
    try {
      off = await service.disableAutoMerge(branch);
    } catch (error) {
      return message(error);
    }
    await k.serial(h, () => {
      if (reason !== null)
        k.emit(h, {
          type: "feature.auto_merge_disabled",
          actor: "engine",
          feature: featureId,
          data: { reason, detail },
        });
      updatePr(k, h, featureId, off === null ? null : { ...off, auto_merge: "disabled" });
      return Promise.resolve();
    });
    return null;
  };
  const stillOn = (failure: string): string =>
    `; VTC could NOT turn its auto-merge off (${failure}): turn it off now (gh pr merge ${number === undefined ? branch : String(number)} --disable-auto)`;
  /**
   * Parks before VTC enabled auto-merge in this start. An auto-merge still on from an earlier
   * start (or that GitHub reports on) is turned off first: GitHub would otherwise merge a head
   * Final Review never verified once its checks pass (AD-23).
   */
  const parkOff = async (
    reason: "head_moved" | "timeout" | null,
    detail: string,
    current: PullRequestRef | null,
    evidence: readonly Evidence[],
  ): Promise<"parked"> => {
    if (current?.state !== "open" || !mayBeOn(h, featureId, current))
      return park(k, h, featureId, detail, evidence);
    const failure = await turnOff(reason, detail);
    return park(
      k,
      h,
      featureId,
      failure === null ? detail : `${detail}${stillOn(failure)}`,
      evidence,
    );
  };
  try {
    policy = await service.policy(await baseBranch(k.deps.repoRoot));
  } catch (error) {
    return park(k, h, featureId, `the base branch's policy could not be read: ${message(error)}`);
  }
  try {
    for (;;) {
      if (stopped()) return "stopped";
      if (paused()) return "paused";
      pr = await prs.view(branch);
      if (pr?.state === "merged") break;
      if (pr === null || pr.head_sha !== gated)
        return await parkOff(
          "head_moved",
          pr === null
            ? "the feature PR is gone"
            : `the PR head ${pr.head_sha.slice(0, 12)} is not the commit Final Review verified (${gated.slice(0, 12)})`,
          pr,
          [{ type: "commit", ref: gated }],
        );
      required = await service.requiredChecks(branch, gated);
      const pending = required.some((c) => c.state === "pending");
      if (!pending) break;
      if (k.now().getTime() - started >= LEVEL3_TIMING.checksTimeoutMs)
        return await parkOff(
          "timeout",
          `the required checks on ${gated.slice(0, 12)} are still pending after ${String(LEVEL3_TIMING.checksTimeoutMs / 3_600_000)} h`,
          pr,
          [{ type: "commit", ref: gated }],
        );
      const waiting = {
        ...pr,
        auto_merge: "awaiting_checks" as const,
        required_checks: [...required],
      };
      await k.serial(h, () => {
        updatePr(k, h, featureId, waiting);
        return Promise.resolve();
      });
      await sleep(k, LEVEL3_TIMING.pollMs);
    }
  } catch (error) {
    return park(k, h, featureId, `GitHub could not be read: ${message(error)}`);
  }
  if (pr.state !== "merged") {
    const checklist = autoMergeChecklist(
      checklistInput(k, h, featureId, { required, headSha: pr.head_sha }, gated),
    );
    const go = await k.serial(h, () => {
      k.emit(h, {
        type: "feature.checklist",
        actor: "engine",
        feature: featureId,
        data: checklist,
      });
      return Promise.resolve(checklist.ok);
    });
    if (!go)
      return parkOff(
        null,
        `the safe-to-auto-merge checklist failed: ${checklist.items
          .filter((i) => !i.ok)
          .map((i) => `${i.id} (${i.detail})`)
          .join("; ")}`,
        pr,
        checklist.items
          .filter((i) => !i.ok)
          .flatMap((i) => i.evidence)
          .slice(0, 10),
      );
    const method = policy.merge_methods[0] ?? "merge";
    if (stopped()) return "stopped";
    if (paused()) return "paused";
    try {
      pr = await service.enableAutoMerge({ branch, headSha: gated, method });
    } catch (error) {
      return park(k, h, featureId, `gh refused to enable auto-merge: ${message(error)}`);
    }
    number = pr.number ?? number;
    const enabled = pr;
    const prNumber = number;
    await k.serial(h, () => {
      if (prNumber !== undefined)
        k.emit(h, {
          type: "feature.auto_merge_enabled",
          actor: "engine",
          feature: featureId,
          data: {
            pr_number: prNumber,
            head_sha: gated,
            method,
            merge_queue: policy.merge_queue,
          },
        });
      updatePr(k, h, featureId, enabled);
      return Promise.resolve();
    });
    const enabledAt = k.now().getTime();
    for (;;) {
      if (stopped()) return "stopped";
      if (paused()) {
        // a pause that landed while auto-merge was being enabled: `disableAutoMerges` may not
        // have seen it enabled yet (AD-23 rule 6)
        if (h.state.features.get(featureId)?.pr?.auto_merge !== "disabled")
          await turnOff("paused", "vtc pause turned off the PR's auto-merge");
        return "paused";
      }
      if (pr.state === "merged") break;
      const disabled =
        pr.head_sha !== gated
          ? ("head_moved" as const)
          : pr.state === "closed" || pr.auto_merge === "disabled"
            ? ("by_host" as const)
            : k.now().getTime() - enabledAt >= LEVEL3_TIMING.mergeTimeoutMs
              ? ("timeout" as const)
              : null;
      if (disabled !== null) {
        const detail =
          disabled === "head_moved"
            ? `the PR head moved to ${pr.head_sha.slice(0, 12)} after auto-merge was enabled on ${gated.slice(0, 12)}`
            : disabled === "by_host"
              ? `GitHub turned auto-merge off (PR ${pr.state}${pr.merge_state_status === undefined ? "" : `, ${pr.merge_state_status}`})`
              : `the PR did not merge within ${String(LEVEL3_TIMING.mergeTimeoutMs / 3_600_000)} h${policy.requires_review ? " (the base requires an approving review)" : ""}`;
        if (disabled === "by_host") {
          await k.serial(h, () => {
            k.emit(h, {
              type: "feature.auto_merge_disabled",
              actor: "engine",
              feature: featureId,
              data: { reason: disabled, detail },
            });
            return Promise.resolve();
          });
          return park(k, h, featureId, detail, [{ type: "commit", ref: gated }]);
        }
        // a moved head or a timeout: GitHub would still merge, so VTC turns auto-merge off first
        const failure = await turnOff(disabled, detail);
        return park(k, h, featureId, failure === null ? detail : `${detail}${stillOn(failure)}`, [
          { type: "commit", ref: gated },
        ]);
      }
      await sleep(k, LEVEL3_TIMING.pollMs);
      let seen: PullRequestRef | null;
      try {
        seen = await prs.view(branch);
      } catch {
        continue; // GitHub unreachable: the next poll reads again; the merge timeout still runs
      }
      if (seen === null) return park(k, h, featureId, "the feature PR is gone");
      pr = seen;
      const current = pr;
      await k.serial(h, () => {
        updatePr(k, h, featureId, current);
        return Promise.resolve();
      });
    }
  }
  const merged = pr;
  if (merged.head_sha !== gated) {
    // GitHub merged a head Final Review never verified (it moved between two polls): never
    // reported as shipped (AD-23: "merging a commit other than the gated one")
    await k.serial(h, () => {
      updatePr(k, h, featureId, merged);
      return Promise.resolve();
    });
    return park(
      k,
      h,
      featureId,
      `GitHub merged the PR at ${merged.head_sha.slice(0, 12)}, not at the commit Final Review verified (${gated.slice(0, 12)}): VTC does not mark the feature shipped; review the merge${merged.merge_commit === undefined ? "" : ` ${merged.merge_commit.slice(0, 12)}`} on the base and revert it if needed`,
      [
        { type: "commit", ref: gated },
        ...(merged.merge_commit === undefined
          ? []
          : [{ type: "commit" as const, ref: merged.merge_commit }]),
      ],
    );
  }
  await k.serial(h, () => {
    updatePr(k, h, featureId, merged);
    if (h.state.features.get(featureId)?.status === "ready_to_ship")
      setFeatureStatus(k, h, featureId, "shipped");
    return Promise.resolve();
  });
  return "merged";
};

/** `vtc pause` (AD-23 rule 6): turns off every pending auto-merge VTC enabled in the run. */
export const disableAutoMerges = async (k: Kernel, h: RunHandle): Promise<void> => {
  const service = k.deps.remoteMerge;
  if (service === undefined) return;
  for (const feature of [...h.state.features.values()]) {
    const state = feature.pr?.auto_merge;
    if (state !== "awaiting_checks" && !mayBeOn(h, feature.id, feature.pr)) continue;
    if (feature.pr?.state !== "open") continue;
    let pr: PullRequestRef | null;
    try {
      pr = await service.disableAutoMerge(feature.integration_branch);
    } catch {
      continue; // still enabled: the next pause tries again
    }
    await k.serial(h, () => {
      k.emit(h, {
        type: "feature.auto_merge_disabled",
        actor: "human",
        feature: feature.id,
        data: { reason: "paused", detail: "vtc pause turned off the PR's auto-merge" },
      });
      updatePr(k, h, feature.id, pr === null ? null : { ...pr, auto_merge: "disabled" });
      return Promise.resolve();
    });
  }
};

// --------------------------------------------------------- post-merge watch

/** When the feature's PR was seen merged (its `feature.pr_updated` with `state: merged`). */
const mergedAt = (state: RunState, featureId: string): number | null => {
  const event = state.events.find(
    (e) =>
      e.type === "feature.pr_updated" &&
      e.feature === featureId &&
      (e.data as { pr?: PullRequestRef }).pr?.state === "merged",
  );
  return event === undefined ? null : Date.parse(event.ts);
};

const ciStatus = (runs: readonly BaseRun[]): "green" | "red" | "pending" => {
  const required = runs.filter((r) => r.required);
  if (required.some((r) => r.conclusion === "failure" || r.conclusion === "cancelled"))
    return "red";
  if (required.length > 0 && required.every((r) => r.conclusion === "success")) return "green";
  return "pending";
};

/** Features of a run whose post-merge watch is still open (merged within the window, no defect). */
export const watchedFeatures = (k: Kernel, state: RunState): string[] =>
  [...state.features.values()].flatMap((f) => {
    if (f.pr?.state !== "merged" || f.pr.merge_commit === undefined) return [];
    const at = mergedAt(state, f.id);
    if (at === null || k.now().getTime() - at > POST_MERGE_WATCH_HOURS * 3_600_000) return [];
    const concluded = state.events.some(
      (e) =>
        e.feature === f.id &&
        (e.type === "feature.reverted" ||
          (e.type === "feature.post_merge_ci" && (e.data as { status?: string }).status === "red")),
    );
    return concluded ? [] : [f.id];
  });

/**
 * One poll of a merged feature's watch (AD-23 rule 4): base CI for the merge commit
 * (`feature.post_merge_ci` when it changed) and reverts of it. A red required run or a revert
 * downgrades the level to 2 in the ledger, records `run.merge_level_changed`, the defect
 * (`feature.reverted` / `feature.post_merge_ci`) and `lookback.escaped_defect` with the feature's
 * tasks, once.
 */
export const pollMergedFeature = async (
  k: Kernel,
  h: RunHandle,
  featureId: string,
): Promise<void> => {
  const service = k.deps.remoteMerge;
  const pr = h.state.features.get(featureId)?.pr;
  if (service === undefined || pr?.merge_commit === undefined) return;
  const commit = pr.merge_commit;
  const base = await baseBranch(k.deps.repoRoot);
  let runs: readonly BaseRun[];
  let reverts;
  try {
    runs = await service.baseRuns(base, commit);
    reverts = await service.findReverts(base, commit, pr.number ?? null);
  } catch {
    return; // GitHub unreachable: the next poll (or the next daemon start) tries again
  }
  const status = ciStatus(runs);
  await k.serial(h, () => {
    if (!watchedFeatures(k, h.state).includes(featureId)) return Promise.resolve();
    const last = h.state.events.findLast(
      (e) => e.type === "feature.post_merge_ci" && e.feature === featureId,
    )?.data as { status?: string } | undefined;
    if (last?.status !== status)
      k.emit(h, {
        type: "feature.post_merge_ci",
        actor: "engine",
        feature: featureId,
        data: { merge_commit: commit, status, runs: [...runs] },
      });
    const revert = reverts[0];
    if (revert !== undefined)
      k.emit(h, {
        type: "feature.reverted",
        actor: "engine",
        feature: featureId,
        data: {
          merge_commit: commit,
          revert,
          detail: `${commit.slice(0, 12)} was reverted on ${base} by ${revert.commit.slice(0, 12)} (${revert.detected_by})`,
        },
      });
    if (revert === undefined && status !== "red") return Promise.resolve();
    const reason = revert !== undefined ? ("revert" as const) : ("post_merge_ci_failure" as const);
    const detail =
      reason === "revert"
        ? `the Level-3 merge ${commit.slice(0, 12)} of ${featureId} was reverted`
        : `a required base CI run failed for the Level-3 merge ${commit.slice(0, 12)} of ${featureId}`;
    appendLedger(k, {
      v: 1,
      at: k.now().toISOString(),
      kind: "downgrade",
      cap: 2,
      reason,
      run: h.state.id,
      feature: featureId,
      merge_commit: commit,
      detail,
    });
    const from = h.state.run.merge_level_effective;
    if (from > 2)
      k.emit(h, {
        type: "run.merge_level_changed",
        actor: "engine",
        data: { from, to: 2, reason },
      });
    k.emit(h, {
      type: "lookback.escaped_defect",
      actor: "engine",
      feature: featureId,
      data: {
        merge_commit: commit,
        kind: reason,
        tasks: featureTasks(h, featureId).map((t) => t.id),
      },
    });
    return Promise.resolve();
  });
};

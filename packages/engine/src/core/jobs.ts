/**
 * Background work of the build loop (§6.3 steps 2 and 5–6, §6.6, §6.7, §6.7a): workspaces, gate
 * runs, the merge queue (one task at a time; Levels 1–2), Final Review's deterministic gates and
 * release. Each job does its I/O (git, the Gate Runner) outside the run's lock and applies the
 * outcome inside it, re-checking that the task is still where the job left it.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  capForRisk,
  engineRepoKey,
  fingerprintFinding,
  FINAL_REVIEW_CAP,
  gateExpectationMet,
  GateRunRequestSchema,
  HIDDEN_TESTS,
  parsePersisted,
  TestInventorySchema,
  type Evidence,
  type TestInventory,
  type Finding,
  type GateReport,
  type GateRunRequestInput,
  type ParkReason,
  type Task,
  type TestMetrics,
} from "@vtc/shared";
import { createHash } from "node:crypto";
import { runGit } from "../git/index.js";
import { taskBudgetFor } from "./budget.js";
import { globMatch } from "./globs.js";
import type { Kernel, RunHandle } from "./kernel.js";
import { assertFeatureTransition } from "./machines.js";
import { parkTask, setTaskStatus } from "./parking.js";
import {
  lastBuilt,
  lastQaAuthor,
  nextEscalationId,
  nextNumberedId,
  taskFindings,
  usedTaskIds,
} from "./queries.js";
import { diffLineCounts } from "./read-model.js";
import { diffRiskHits, isTrivialDiff } from "./router.js";
import { parkEscalation } from "./escalations.js";
import {
  bundleMarkdown,
  writeFeatureEvidenceBundle,
  writeRunSummary,
  writeTaskEvidenceBundle,
} from "./projections.js";
import {
  gateFindings,
  gateSources,
  markBuilt,
  recordRoundFindings,
  settleRound,
} from "./verify.js";
import { taskDetailView } from "./views.js";

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Reads an L2 test inventory the Gate Runner wrote under `.vtc/evidence/` (AD-13 rule 9). */
const inventoryReader =
  (k: Kernel) =>
  (path: string): TestInventory | undefined => {
    try {
      const parsed = parsePersisted(
        TestInventorySchema,
        JSON.parse(readFileSync(join(k.deps.repoRoot, path), "utf8")),
      );
      return parsed.success ? parsed.data : undefined;
    } catch {
      return undefined;
    }
  };

const emitGateResult = (k: Kernel, h: RunHandle, report: GateReport): void => {
  k.emit(h, {
    type: "gate.result",
    actor: "engine",
    ...(report.task === undefined ? {} : { task: report.task }),
    ...(report.feature === undefined ? {} : { feature: report.feature }),
    data: report,
  });
};

/** Runs the Gate Runner on a clean checkout of `head` (§6.3 step 5); never throws for a failing gate. */
const runGates = async (
  k: Kernel,
  request: Omit<GateRunRequestInput, "checkout">,
): Promise<GateReport> => {
  const checkout = await k.deps.git.createCleanCheckout(request.head);
  try {
    return await k.deps.gateRunner.run(GateRunRequestSchema.parse({ ...request, checkout }));
  } finally {
    await k.deps.git.removeCheckout(checkout);
  }
};

const parkInfra = (
  k: Kernel,
  h: RunHandle,
  taskId: string,
  detail: string,
  evidence: readonly Evidence[] = [],
): void => {
  parkTask(k, h, taskId, { reason: "gate_infra", detail, evidence });
};

// ------------------------------------------------------------------ workspace

/** Creates the feature's integration branch and the task's worktree (§6.6), then records them. */
export const ensureWorkspace = (k: Kernel, h: RunHandle, taskId: string): void => {
  k.spawn(h, `ws:${taskId}`, async () => {
    const task = h.state.tasks.get(taskId);
    const feature = task === undefined ? undefined : h.state.features.get(task.feature);
    if (task === undefined || feature === undefined || task.worktree !== undefined) return;
    try {
      const ws = k.deps.workspace;
      const branch = feature.integration_branch;
      const base = (await ws.branchExists(branch))
        ? await ws.resolve(branch)
        : await ws.resolve("HEAD");
      const integration = await ws.ensureIntegration(feature.id, branch, base);
      const worktree = await ws.ensureTaskWorktree(taskId, `vtc/${taskId}`, integration.head);
      await k.serial(h, () => {
        const current = h.state.tasks.get(taskId);
        if (current?.status !== "ready" || current.worktree !== undefined) return Promise.resolve();
        k.emit(h, {
          type: "task.workspace_assigned",
          actor: "engine",
          task: taskId,
          data: {
            worktree: worktree.worktree,
            branch: `vtc/${taskId}`,
            baseline_revision: worktree.head,
          },
        });
        return Promise.resolve();
      });
    } catch (error) {
      await k.serial(h, () => {
        parkInfra(k, h, taskId, `could not create the task worktree: ${message(error)}`);
        return Promise.resolve();
      });
    }
  });
};

const message = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 500);

// -------------------------------------------------------------- protected files

/** Files QA wrote (by checksum at QA's commit) plus protected configs at the baseline (§7.3). */
export const protectedFiles = async (
  k: Kernel,
  h: RunHandle,
  task: Task,
): Promise<{ path: string; sha256: string }[]> => {
  const out = new Map<string, string>();
  const qa = lastQaAuthor(h.state, task.id);
  if (qa?.head !== undefined) {
    const submitted = h.state.events.find(
      (e) =>
        e.type === "role.submitted" &&
        (e.data as { action_id?: string }).action_id === qa.action_id,
    );
    const artifacts =
      (submitted?.data as { artifacts?: { type: string; path: string }[] } | undefined)
        ?.artifacts ?? [];
    for (const a of artifacts) {
      if (a.type !== "acceptance_test") continue;
      const bytes = await k.deps.git.readFileAtCommit(qa.head, a.path);
      if (bytes !== undefined) out.set(a.path, sha256(bytes));
    }
  }
  const globs = k.gatesConfig()?.tests.protected_configs ?? [];
  if (globs.length > 0 && task.baseline_revision !== undefined) {
    const listed = await runGit(k.deps.repoRoot, [
      "ls-tree",
      "-r",
      "--name-only",
      "-z",
      task.baseline_revision,
    ]);
    for (const path of listed.stdout.toString("utf8").split("\0")) {
      if (path === "" || !globs.some((g) => globMatch(g, path))) continue;
      const bytes = await k.deps.git.readFileAtCommit(task.baseline_revision, path);
      if (bytes !== undefined) out.set(path, sha256(bytes));
    }
  }
  return [...out.entries()].map(([path, sum]) => ({ path, sha256: sum }));
};

// ------------------------------------------------------------- QA base check

/** Moves QA's hidden tests out of the repo, to `~/.vtc/hidden/<repo-key>/<task>/` (§7.3). */
const moveHiddenTests = (k: Kernel, taskId: string): void => {
  const staged = join(k.deps.repoRoot, HIDDEN_TESTS.stagingDir, taskId);
  if (!existsSync(staged)) return;
  const target = join(k.deps.vtcHome, HIDDEN_TESTS.homeDir, engineRepoKey(k.deps.repoRoot), taskId);
  mkdirSync(target, { recursive: true });
  cpSync(staged, target, { recursive: true });
  rmSync(staged, { recursive: true, force: true });
};

/** QA's new acceptance tests must fail on the base commit before the Engineer starts (§6.3 step 2). */
export const startBaseCheck = (
  k: Kernel,
  h: RunHandle,
  taskId: string,
  head: string,
  tests: readonly string[],
): void => {
  k.spawn(h, `gates:${taskId}`, async () => {
    const task = h.state.tasks.get(taskId);
    if (task?.baseline_revision === undefined) return;
    let report: GateReport;
    try {
      report = await runGates(k, {
        run: h.state.id,
        task: taskId,
        reason: "base_fail_check",
        scope: "affected",
        base: task.baseline_revision,
        head,
        files_scope: task.files_scope,
        req_tags: task.covers,
        tests: [...tests],
        expect: "fail",
      });
    } catch (error) {
      await k.serial(h, () => {
        parkInfra(k, h, taskId, `the base-fail check could not run: ${message(error)}`);
        return Promise.resolve();
      });
      return;
    }
    await k.serial(h, () => {
      emitGateResult(k, h, report);
      if (h.state.tasks.get(taskId)?.status !== "ready") return Promise.resolve();
      const met = gateExpectationMet(report);
      if (met === null) {
        parkInfra(
          k,
          h,
          taskId,
          "the gates could not run the base-fail check",
          report.results.flatMap((r) => r.evidence).slice(0, 5),
        );
      } else if (met) {
        moveHiddenTests(k, taskId);
        setTaskStatus(k, h, taskId, "tests_authored");
      } else {
        const misses = h.state.gateReports.filter(
          (r) =>
            r.report.task === taskId &&
            r.report.reason === "base_fail_check" &&
            gateExpectationMet(r.report) === false,
        ).length;
        if (misses >= 3) {
          parkTask(k, h, taskId, {
            reason: "stuck",
            detail: "QA's acceptance tests did not fail on the base commit in 3 attempts",
            evidence: [{ type: "commit", ref: head }],
          });
        }
      }
      return Promise.resolve();
    });
  });
};

// --------------------------------------------------------------- round gates

/** The task's previous L2 metrics at the same scope (§7.3 monotonic metrics). */
const previousMetrics = (h: RunHandle, taskId: string): TestMetrics | undefined =>
  h.state.gateReports
    .filter(
      (r) =>
        r.report.task === taskId && r.report.reason === "round" && r.report.scope === "affected",
    )
    .flatMap((r) =>
      r.report.results.flatMap((g) => (g.layer === "L2" && g.tests !== undefined ? [g.tests] : [])),
    )
    .at(-1);

/** Dependencies a diff adds to any `package.json` that are not on the allowlist (§7.6 rule 4). */
const newDependencies = async (
  k: Kernel,
  base: string,
  head: string,
  paths: readonly string[],
): Promise<string[]> => {
  const allow = new Set(k.config().allowlists.dependencies);
  const names = (bytes: Uint8Array | undefined): Set<string> => {
    if (bytes === undefined) return new Set();
    try {
      const pkg = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
      return new Set(
        ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"].flatMap(
          (field) => {
            const deps = pkg[field];
            return deps !== null && typeof deps === "object" ? Object.keys(deps) : [];
          },
        ),
      );
    } catch {
      return new Set();
    }
  };
  const added: string[] = [];
  for (const path of paths.filter((p) => p === "package.json" || p.endsWith("/package.json"))) {
    const before = names(await k.deps.git.readFileAtCommit(base, path));
    for (const name of names(await k.deps.git.readFileAtCommit(head, path))) {
      if (!before.has(name) && !allow.has(name)) added.push(name);
    }
  }
  return [...new Set(added)];
};

/** Whether the human accepted a risk rule on this task after `sinceSeq` (no re-park on the same head). */
const riskWaived = (h: RunHandle, taskId: string, sinceSeq: number): boolean =>
  [...h.state.escalations.values()].some((e) => {
    if (e.task !== taskId || e.reason !== "risk_rule" || e.answer === undefined) return false;
    const opened = h.state.events.find(
      (ev) =>
        ev.type === "escalation.opened" &&
        (ev.data as { escalation: { id: string } }).escalation.id === e.id,
    );
    return (
      (opened?.seq ?? 0) > sinceSeq &&
      e.options.find((o) => o.id === e.answer?.option)?.effect === "waive"
    );
  });

/** Gates for a built head (§6.3 step 5), then the risk router (step 6). */
export const startRoundGates = (k: Kernel, h: RunHandle, taskId: string, head: string): void => {
  k.spawn(h, `gates:${taskId}`, async () => {
    const task = h.state.tasks.get(taskId);
    if (task?.baseline_revision === undefined) return;
    const base = task.baseline_revision;
    let report: GateReport;
    let router: { hits: ReturnType<typeof diffRiskHits>; trivial: boolean } | null = null;
    try {
      const protectedList = await protectedFiles(k, h, task);
      const compare = previousMetrics(h, taskId);
      report = await runGates(k, {
        run: h.state.id,
        task: taskId,
        reason: "round",
        scope: "affected",
        base,
        head,
        files_scope: task.files_scope,
        protected: protectedList,
        req_tags: task.covers,
        ...(compare === undefined ? {} : { compare_to: compare }),
        include_hidden: true,
      });
      if (report.verdict === "pass") {
        const files = await k.deps.git.changedFiles(base, head);
        const counts = diffLineCounts(await k.deps.git.diff(base, head));
        let changedLines = 0;
        for (const c of counts.values()) changedLines += c.additions + c.deletions;
        router = {
          hits: diffRiskHits({
            files,
            changedLines,
            riskRules: k.config().risk_rules,
            newDependencies: await newDependencies(
              k,
              base,
              head,
              files.map((f) => f.path),
            ),
          }),
          // Only the Engineer's own diff decides triviality: QA's tests sit between base and head.
          trivial: isTrivialDiff(
            await k.deps.git.changedFiles(lastQaAuthor(h.state, taskId)?.head ?? base, head),
          ),
        };
      }
    } catch (error) {
      await k.serial(h, () => {
        parkInfra(k, h, taskId, `the gates could not run: ${message(error)}`);
        return Promise.resolve();
      });
      return;
    }
    await k.serial(h, () => {
      emitGateResult(k, h, report);
      const current = h.state.tasks.get(taskId);
      if (current?.status !== "verifying" || lastBuilt(h.state, taskId)?.head !== head)
        return Promise.resolve();
      applyRoundGates(k, h, current, report, router);
      return Promise.resolve();
    });
  });
};

const applyRoundGates = (
  k: Kernel,
  h: RunHandle,
  task: Task,
  report: GateReport,
  router: { hits: ReturnType<typeof diffRiskHits>; trivial: boolean } | null,
): void => {
  if (report.verdict === "infra_error") {
    parkInfra(
      k,
      h,
      task.id,
      "a blocking gate failed for infrastructure or environment reasons",
      report.results.flatMap((r) => r.evidence).slice(0, 5),
    );
    return;
  }
  const fresh = gateFindings(report, task.id, Math.max(1, task.round), inventoryReader(k));
  const merge = recordRoundFindings(k, h, task.id, fresh, gateSources(h, task.id, fresh));
  if (report.verdict === "fail") {
    settleRound(k, h, task.id, merge);
    return;
  }
  const built = lastBuilt(h.state, task.id);
  const hit = router?.hits[0];
  if (hit !== undefined && !riskWaived(h, task.id, built?.closedSeq ?? 0)) {
    parkTask(k, h, task.id, {
      reason: "risk_rule",
      riskRule: hit.rule,
      detail: hit.detail,
      evidence:
        hit.paths.length > 0
          ? hit.paths.slice(0, 5).map((p) => ({ type: "file" as const, ref: p }))
          : [{ type: "diff", ref: `${report.base}..${report.head}` }],
    });
    return;
  }
  const open = taskFindings(h.state, task.id).filter((f) => f.status === "open");
  if (router?.trivial === true && open.length === 0) markBuilt(k, h, task.id);
};

// ---------------------------------------------------------------- merge queue

const conflictFinding = (task: Task, detail: string, round: number): Finding => {
  const rule = "merge.conflict";
  return {
    fingerprint: fingerprintFinding({ rule_id: rule, path: `branches/vtc/${task.id}` }),
    source: "tool",
    source_name: "merge_queue",
    rule_id: rule,
    category: "correctness",
    title: `vtc/${task.id} does not rebase cleanly onto the integration branch`,
    message: detail.slice(0, 4000),
    severity: "medium",
    confidence: 1,
    location: { path: task.files_scope[0]?.replace(/\*.*$/, "") || "." },
    evidence: { type: "file", ref: `.vtc/tasks/${task.id}.md` },
    req_ids: [],
    route: "patch",
    task: task.id,
    round_first_seen: Math.max(1, round),
    status: "open",
  };
};

/** The branch PRs target: the repo's current branch, or `main` when HEAD is detached. */
const baseBranch = async (repoRoot: string): Promise<string> => {
  const out = (
    await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true })
  ).stdout
    .toString("utf8")
    .trim();
  return out === "" || out === "HEAD" || out.startsWith("vtc/") ? "main" : out;
};

/** Pushes the integration branch and keeps the draft PR current (Level 2, §6.7). */
const pushFeature = async (
  k: Kernel,
  h: RunHandle,
  featureId: string,
  ready: boolean,
  body?: string,
): Promise<void> => {
  const feature = h.state.features.get(featureId);
  if (feature === undefined || h.state.run.merge_level_effective < 2) return;
  const ws = k.deps.workspace;
  if ((await ws.remoteUrl(k.deps.remote)) === null) {
    await k.serial(h, () => {
      k.emit(h, {
        type: "branch.push_skipped",
        actor: "engine",
        feature: featureId,
        data: { branch: feature.integration_branch, detail: `no remote ${k.deps.remote}` },
      });
      return Promise.resolve();
    });
    return;
  }
  const commit = await ws.resolve(feature.integration_branch);
  const pushed = await ws.push(k.deps.remote, feature.integration_branch);
  if (!pushed.ok) {
    await k.serial(h, () => {
      k.emit(h, {
        type: "branch.push_failed",
        actor: "engine",
        feature: featureId,
        data: { branch: feature.integration_branch, detail: pushed.detail },
      });
      return Promise.resolve();
    });
    return;
  }
  let pr = feature.pr;
  try {
    const request = {
      branch: feature.integration_branch,
      base: await baseBranch(k.deps.repoRoot),
      title: feature.title,
      body:
        body ??
        `Draft: VTC integration of ${feature.id} (${feature.title}). Ready for review after Final Review.`,
    };
    pr = await k.deps.pullRequests.upsertDraft(request);
    if (ready) pr = await k.deps.pullRequests.markReady(feature.integration_branch);
  } catch (error) {
    await k.serial(h, () => {
      k.emit(h, {
        type: "feature.pr_failed",
        actor: "engine",
        feature: featureId,
        data: { detail: message(error) },
      });
      return Promise.resolve();
    });
  }
  const merges = [...h.state.merges];
  const included = new Set<string>();
  for (const m of merges) if (await ws.isAncestor(m.commit, commit)) included.add(m.task);
  await k.serial(h, () => {
    k.emit(h, {
      type: "branch.pushed",
      actor: "engine",
      feature: featureId,
      data: { branch: feature.integration_branch, commit },
    });
    if (
      pr !== undefined &&
      JSON.stringify(pr) !== JSON.stringify(h.state.features.get(featureId)?.pr)
    ) {
      k.emit(h, { type: "feature.pr_updated", actor: "engine", feature: featureId, data: { pr } });
    }
    const open = h.state.features.get(featureId)?.pr?.state === "open";
    if (open) {
      for (const id of included) {
        if (h.state.tasks.get(id)?.status === "merged") setTaskStatus(k, h, id, "done");
      }
    }
    return Promise.resolve();
  });
};

/** One queued task: rebase, full gates on the combined code, merge (§6.7). */
const mergeOne = async (k: Kernel, h: RunHandle, taskId: string): Promise<void> => {
  const task = h.state.tasks.get(taskId);
  const feature = task === undefined ? undefined : h.state.features.get(task.feature);
  if (task?.worktree === undefined || feature === undefined) return;
  const ws = k.deps.workspace;
  const branch = feature.integration_branch;
  const sendBack = (detail: string): Promise<void> =>
    k.serial(h, () => {
      if (h.state.tasks.get(taskId)?.status !== "queued") return Promise.resolve();
      const merge = recordRoundFindings(
        k,
        h,
        taskId,
        [conflictFinding(task, detail, task.round)],
        new Set(["merge_queue"]),
      );
      settleRound(k, h, taskId, merge);
      return Promise.resolve();
    });
  const rebased = await ws.rebase(task.worktree, branch);
  if (!rebased.ok) return sendBack(rebased.detail);
  const integrationHead = await ws.resolve(branch);
  const report = await runGates(k, {
    run: h.state.id,
    task: taskId,
    feature: feature.id,
    reason: "merge_queue",
    scope: "full",
    base: integrationHead,
    head: rebased.commit,
    files_scope: task.files_scope,
    protected: await protectedFiles(k, h, task),
    req_tags: task.covers,
    include_hidden: true,
  });
  const verdict = await k.serial(h, () => {
    emitGateResult(k, h, report);
    if (h.state.tasks.get(taskId)?.status !== "queued") return Promise.resolve("gone" as const);
    if (report.verdict === "infra_error") {
      parkInfra(k, h, taskId, "the merge-queue gates failed for infrastructure reasons");
      return Promise.resolve("gone" as const);
    }
    if (report.verdict === "fail") {
      const fresh = gateFindings(report, taskId, Math.max(1, task.round), inventoryReader(k));
      settleRound(
        k,
        h,
        taskId,
        recordRoundFindings(k, h, taskId, fresh, gateSources(h, taskId, fresh)),
      );
      return Promise.resolve("gone" as const);
    }
    return Promise.resolve(h.state.run.paused ? ("paused" as const) : ("merge" as const));
  });
  if (verdict !== "merge") return;
  const integration = await ws.ensureIntegration(feature.id, branch, integrationHead);
  const merged = await ws.merge(
    integration.worktree,
    `vtc/${taskId}`,
    `vtc: merge ${taskId} ${task.title}`,
  );
  if (!merged.ok) return sendBack(merged.detail);
  await k.serial(h, () => {
    k.emit(h, {
      type: "merge.completed",
      actor: "engine",
      task: taskId,
      feature: feature.id,
      data: { into: branch, commit: merged.commit, level: h.state.run.merge_level_effective },
    });
    setTaskStatus(k, h, taskId, "merged");
    writeTaskEvidenceBundle(k.deps.repoRoot, h.state, taskId, k.now(), k.secrets());
    if (h.state.run.merge_level_effective === 1) setTaskStatus(k, h, taskId, "done");
    return Promise.resolve();
  });
  await pushFeature(k, h, feature.id, false);
};

/** The merge queue: one task at a time, in plan order, never while paused (§6.7, §15 kill switch). */
export const startMergeQueue = (k: Kernel, h: RunHandle): void => {
  k.spawn(h, `merge:${h.state.id}`, async () => {
    for (;;) {
      if (h.state.run.paused) return;
      const next = [...h.state.tasks.values()].find((t) => t.status === "queued");
      if (next === undefined) return;
      try {
        await mergeOne(k, h, next.id);
      } catch (error) {
        await k.serial(h, () => {
          parkInfra(k, h, next.id, `the merge queue failed: ${message(error)}`);
          return Promise.resolve();
        });
      }
    }
  });
};

// --------------------------------------------------------------- final review

const setFeatureStatus = (
  k: Kernel,
  h: RunHandle,
  featureId: string,
  to:
    "building" | "integrating" | "final_review" | "fixing" | "ready_to_ship" | "shipped" | "parked",
  options: { round?: number; parkReason?: ParkReason } = {},
): void => {
  const feature = h.state.features.get(featureId);
  if (feature === undefined || feature.status === to) return;
  assertFeatureTransition(featureId, feature.status, to);
  k.emit(h, {
    type: "feature.status_changed",
    actor: "engine",
    feature: featureId,
    data: {
      from: feature.status,
      to,
      round: options.round ?? feature.round,
      ...(options.parkReason === undefined ? {} : { park_reason: options.parkReason }),
    },
  });
};

export { setFeatureStatus };

const parkFeature = (
  k: Kernel,
  h: RunHandle,
  featureId: string,
  reason: ParkReason,
  detail: string,
  evidence: readonly Evidence[],
): void => {
  setFeatureStatus(k, h, featureId, "parked", { parkReason: reason });
  const feature = h.state.features.get(featureId);
  const escalation = parkEscalation({
    id: nextEscalationId(h.state),
    run: h.state.id,
    feature: featureId,
    reason,
    detail,
    evidence,
    blocks: feature?.tasks ?? [],
    now: k.now(),
  });
  k.emit(h, {
    type: "escalation.opened",
    actor: "engine",
    feature: featureId,
    data: { escalation },
  });
};

/** An engine-created task for Final Review findings no single task owns (§6.7a, AD-8 rule 11). */
const createIntegrationFix = (
  k: Kernel,
  h: RunHandle,
  featureId: string,
  findings: readonly Finding[],
): void => {
  const feature = h.state.features.get(featureId);
  const first = findings[0];
  if (feature === undefined || first === undefined) return;
  const id = nextNumberedId("T", usedTaskIds([h.state]));
  const config = k.config();
  const owners = feature.tasks
    .map((t) => h.state.tasks.get(t))
    .filter((t): t is Task => t !== undefined);
  const disciplines = owners.map((t) => t.discipline);
  const discipline =
    disciplines.sort(
      (a, b) =>
        disciplines.filter((d) => d === b).length - disciplines.filter((d) => d === a).length,
    )[0] ?? "backend";
  const paths = [
    ...new Set(findings.map((f) => f.location.path).filter((p) => !p.startsWith(".vtc/"))),
  ];
  const task: Task = {
    id,
    title: `Integration fix: ${first.title}`.slice(0, 200),
    feature: featureId,
    origin: "integration_fix",
    source_finding: first.fingerprint,
    covers: [],
    after: [],
    files_scope: paths.length > 0 ? paths : ["**"],
    discipline,
    stack_packs: [],
    consumes_contracts: [],
    risk: "med",
    risk_tags: [],
    cap: capForRisk("med", config.caps),
    size: "S",
    arch_triage: "fits",
    budget_usd: taskBudgetFor("S", config),
    spent_usd: 0,
    status: "draft",
    round: 0,
    deferred: [],
  };
  k.emit(h, { type: "task.created", actor: "engine", task: id, data: { task } });
  k.emit(h, {
    type: "feature.task_added",
    actor: "engine",
    feature: featureId,
    data: { task: id },
  });
  for (const finding of findings) {
    k.emit(h, {
      type: "finding.recorded",
      actor: "engine",
      task: id,
      data: { finding: { ...finding, task: id } },
    });
  }
};

/** Final Review step 1 (§6.7a): full gates on the integrated branch; fixes become new tasks. */
export const startFinalReview = (k: Kernel, h: RunHandle, featureId: string): void => {
  k.spawn(h, `final:${featureId}`, async () => {
    const feature = h.state.features.get(featureId);
    if (feature === undefined) return;
    const ws = k.deps.workspace;
    let report: GateReport;
    try {
      const head = await ws.resolve(feature.integration_branch);
      const base =
        (
          await runGit(k.deps.repoRoot, ["merge-base", await baseBranch(k.deps.repoRoot), head], {
            allowFailure: true,
          })
        ).stdout
          .toString("utf8")
          .trim() || head;
      const covers = [...new Set(feature.tasks.flatMap((t) => h.state.tasks.get(t)?.covers ?? []))];
      report = await runGates(k, {
        run: h.state.id,
        feature: featureId,
        reason: "final_review",
        scope: "full",
        base,
        head,
        req_tags: covers,
        include_hidden: true,
      });
    } catch (error) {
      await k.serial(h, () => {
        parkFeature(
          k,
          h,
          featureId,
          "gate_infra",
          `Final Review gates could not run: ${message(error)}`,
          [],
        );
        return Promise.resolve();
      });
      return;
    }
    await k.serial(h, () => {
      emitGateResult(k, h, report);
      const current = h.state.features.get(featureId);
      if (current?.status !== "final_review") return Promise.resolve();
      if (report.verdict === "infra_error") {
        parkFeature(
          k,
          h,
          featureId,
          "gate_infra",
          "Final Review gates failed for infrastructure reasons",
          report.results.flatMap((r) => r.evidence).slice(0, 5),
        );
      } else if (report.verdict === "pass") {
        setFeatureStatus(k, h, featureId, "ready_to_ship");
      } else if (current.round + 1 > FINAL_REVIEW_CAP) {
        parkFeature(
          k,
          h,
          featureId,
          "cap",
          `Final Review reached its ${String(FINAL_REVIEW_CAP)}-round cap`,
          report.results.flatMap((r) => r.evidence).slice(0, 5),
        );
      } else {
        const findings = gateFindings(report, undefined, current.round + 1, inventoryReader(k)).map(
          (f) => ({ ...f, feature: featureId }),
        );
        setFeatureStatus(k, h, featureId, "fixing", { round: current.round + 1 });
        createIntegrationFix(k, h, featureId, findings);
        if (h.state.run.phase !== "build") {
          k.emit(h, {
            type: "run.phase_changed",
            actor: "engine",
            data: { from: h.state.run.phase, to: "build" },
          });
        }
      }
      return Promise.resolve();
    });
  });
};

// -------------------------------------------------------------------- release

/** RELEASE and RETRO (§6.1, §6.7): feature evidence bundle, PR ready (Level 2), run summary. */
export const startRelease = (k: Kernel, h: RunHandle, featureId: string): void => {
  k.spawn(h, `release:${featureId}`, async () => {
    const written = await k.serial(h, () =>
      Promise.resolve(
        writeFeatureEvidenceBundle(
          k.deps.repoRoot,
          h.state,
          featureId,
          "pass",
          k.now(),
          k.secrets(),
        ),
      ),
    );
    await pushFeature(
      k,
      h,
      featureId,
      true,
      written === null ? undefined : bundleMarkdown(written.bundle),
    );
    await k.serial(h, () => {
      if (h.state.run.finished_at !== undefined) return Promise.resolve();
      k.emit(h, {
        type: "run.phase_changed",
        actor: "engine",
        data: { from: h.state.run.phase, to: "retro" },
      });
      const roleRuns = [...h.state.tasks.keys()].flatMap(
        (t) => taskDetailView(h.state, t)?.role_runs ?? [],
      );
      const summary = writeRunSummary(k.deps.repoRoot, h.state, roleRuns, k.secrets());
      k.emit(h, { type: "run.finished", actor: "engine", data: { outcome: "done", summary } });
      return Promise.resolve();
    });
  });
};

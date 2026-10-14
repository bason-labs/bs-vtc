/**
 * Background work of the build loop (§6.3 steps 2 and 5–6, §6.6, §6.7, §6.7a): workspaces, gate
 * runs, the merge queue (one task at a time; Levels 1–2), Final Review's deterministic gates and
 * release. Each job does its I/O (git, the Gate Runner) outside the run's lock and applies the
 * outcome inside it, re-checking that the task is still where the job left it.
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  capForRisk,
  engineRepoKey,
  fingerprintFinding,
  GATE_SANDBOX,
  gateExpectationMet,
  GateRunRequestSchema,
  HIDDEN_TESTS,
  hiddenTestsDir,
  parsePersisted,
  redactSecrets,
  TestInventorySchema,
  type Evidence,
  type TestInventory,
  type Finding,
  type GateReport,
  type GateRunRequestInput,
  type ParkReason,
  type RiskRuleReasonRule,
  type Task,
  type TestMetrics,
} from "@vtc/shared";
import { createHash } from "node:crypto";
import { assertNoSymlinks, runGit } from "../git/index.js";
import { taskBudgetFor } from "./budget.js";
import {
  committedGatesConfig,
  GATES_CONFIG_PATH,
  pipelineConfigHash,
  type CommittedGates,
} from "./config.js";
import { globMatch, matchesAny } from "./globs.js";
import type { Kernel, RunHandle } from "./kernel.js";
import { effectiveVerdict } from "./gate-verdict.js";
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
import { guardGateRun } from "./dispatch-guard.js";
import { diffLineCounts } from "./read-model.js";
import { diffRiskHits, isTrivialDiff } from "./router.js";
import { screensFor, taskHasUi } from "./ui.js";
import { parkEscalation } from "./escalations.js";
import { writeTaskEvidenceBundle } from "./projections.js";
import {
  gateFindings,
  gateSources,
  markBuilt,
  recordRoundFindings,
  settleRound,
} from "./verify.js";

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

/** Logs a gate run's report (`gate.result`). */
export const emitGateResult = (k: Kernel, h: RunHandle, report: GateReport): void => {
  k.emit(h, {
    type: "gate.result",
    actor: "engine",
    ...(report.task === undefined ? {} : { task: report.task }),
    ...(report.feature === undefined ? {} : { feature: report.feature }),
    data: report,
  });
};

/**
 * A gate run whose commands ran with no OS sandbox (`sandbox: "none"`, only under the user-level
 * `gates.allow_unsandboxed`) is an `unsandboxed_gate` incident, every time (D-al, spine §5
 * reading 69; the §7 Accepted residuals row "Unsandboxed gates by user opt-in"). Recorded where
 * the gate is known to have run, whether or not its report is used afterwards: a run whose
 * unconfined code changed git config has its report dropped, and is the run that most needs it.
 */
export const recordUnsandboxedGate = (k: Kernel, h: RunHandle, report: GateReport): void => {
  if (report.sandbox !== "none") return;
  k.emit(h, {
    type: "incident.recorded",
    actor: "engine",
    ...(report.task === undefined ? {} : { task: report.task }),
    ...(report.feature === undefined ? {} : { feature: report.feature }),
    data: {
      kind: "unsandboxed_gate",
      detail:
        `the ${report.reason} gate run of ${report.task ?? report.feature ?? report.run} at ${report.head.slice(0, 12)} ran its commands with no OS sandbox (${GATE_SANDBOX.noSandboxReason}): ~/.vtc/config.yaml sets gates.allow_unsandboxed`.slice(
          0,
          2000,
        ),
    },
  });
};

/**
 * What the Gate Runner wrote under `.vtc/evidence/` through its own file calls (reports,
 * inventories) is the engine's: recorded as such, so a role working in the checkout at the same
 * time is not blamed for it, and a later change to it is (AD-7 rule 7).
 */
export const adoptGateOutput = (k: Kernel, report: GateReport): void => {
  const owner = report.task ?? report.feature;
  if (owner !== undefined) k.writes.adopt(`.vtc/evidence/${owner}`);
};

/** Commits never change, so a commit's `gates.yml` is read once (per repo, bounded). */
const gatesAtCommit = new Map<string, Promise<CommittedGates | null>>();
const GATES_CACHE_MAX = 64;

/** `.vtc/gates.yml` committed at `commit` (`committedGatesConfig`), cached by commit. */
export const gatesAt = (k: Kernel, commit: string): Promise<CommittedGates | null> => {
  const key = `${k.deps.repoRoot}\0${commit}`;
  const hit = gatesAtCommit.get(key);
  if (hit !== undefined) return hit;
  const read = committedGatesConfig(k.deps.git, commit);
  read.catch(() => gatesAtCommit.delete(key));
  if (gatesAtCommit.size >= GATES_CACHE_MAX) {
    const oldest = gatesAtCommit.keys().next().value;
    if (oldest !== undefined) gatesAtCommit.delete(oldest);
  }
  gatesAtCommit.set(key, read);
  return read;
};

/**
 * The `gates.yml` committed at a gate run's base (spine §5 reading 46f), checked against the one
 * the run started with (reading 20): the Gate Runner reads the same file at `base`. A run always
 * starts with one (`start` refuses otherwise, reading 78). Throws with the reason the task or
 * feature parks on (`gate_infra`): no committed file at the base, or a different one. When the hash of the
 * run's file is unknown (a restart whose kept copy an older engine wrote, or with no kept copy),
 * the base's file must give the run's `pipeline_config_hash`: the working tree never stands in.
 */
export const baselineGates = async (
  k: Kernel,
  h: RunHandle,
  base: string,
): Promise<CommittedGates> => {
  const committed = await gatesAt(k, base);
  if (committed === null)
    throw new Error(
      `the baseline ${base.slice(0, 12)} has no committed ${GATES_CONFIG_PATH}, though a run starts only with one; a task's baseline is fixed, so drop the task or start a new run`,
    );
  const frozen = k.gatesConfigHash();
  const same =
    frozen === null
      ? pipelineConfigHash(k.config(), committed.config) === h.state.run.pipeline_config_hash
      : frozen === committed.sha256;
  if (!same)
    throw new Error(
      `${GATES_CONFIG_PATH} at the baseline ${base.slice(0, 12)} (${committed.sha256.slice(0, 12)}) is not the one this run started with${frozen === null ? "" : ` (${frozen.slice(0, 12)})`}; a run verifies only with the config it started with`,
    );
  return committed;
};

/**
 * Runs the Gate Runner on a clean checkout of `head` (§6.3 step 5); never throws for a failing
 * gate. Every request carries `gates_config_hash`, the run's `gates.yml` (reading 46b), and
 * throws, before anything runs, when the base's committed `gates.yml` is missing or another
 * ({@link baselineGates}). The gate run is guarded like a role's dispatch (`guardGateRun`): a git
 * config or hook change it made is reported and held, and its results are not used.
 */
const runGates = async (
  k: Kernel,
  h: RunHandle,
  input: Omit<GateRunRequestInput, "checkout" | "gates_config_hash">,
): Promise<GateReport> => {
  const gates = await baselineGates(k, h, input.base);
  const request = { ...input, gates_config_hash: gates.sha256 };
  const label = `${request.reason} ${request.task ?? request.feature ?? request.run}`;
  let ran: GateReport | undefined;
  let report: GateReport;
  try {
    report = await guardGateRun(k, h, label, async () => {
      const checkout = await k.deps.git.createCleanCheckout(request.head);
      try {
        ran = await k.deps.gateRunner.run(GateRunRequestSchema.parse({ ...request, checkout }));
        return ran;
      } finally {
        await k.deps.git.removeCheckout(checkout);
      }
    });
  } finally {
    // the gate ran, adopted or not ({@link recordUnsandboxedGate})
    const done = ran;
    if (done !== undefined)
      await k.serial(h, () => {
        recordUnsandboxedGate(k, h, done);
        return Promise.resolve();
      });
  }
  adoptGateOutput(k, report);
  return report;
};

/** A failed report whose every failing blocking gate the Gate Runner classified `flaky`. */
export const onlyFlaky = (report: GateReport): boolean => {
  const failing = report.results.filter(
    (r) => r.blocking && (r.status === "fail" || r.status === "error"),
  );
  return (
    report.verdict === "fail" &&
    failing.length > 0 &&
    failing.every((r) => r.failure_class === "flaky")
  );
};

/**
 * §6.3 step 8: a flaky result gets one re-run. Returns every report in order (each is logged);
 * the last one decides. A second flaky failure routes like any failure.
 */
export const runGatesRetryingFlaky = async (
  k: Kernel,
  h: RunHandle,
  request: Omit<GateRunRequestInput, "checkout" | "gates_config_hash">,
): Promise<GateReport[]> => {
  const first = await runGates(k, h, request);
  return onlyFlaky(first) ? [first, await runGates(k, h, request)] : [first];
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

/**
 * The protected configs at `base` (§7.3), path → SHA-256: the files matching the
 * `protected_configs` of the `gates.yml` committed at `base` (reading 46f), never the working
 * tree's.
 */
export const protectedConfigsAt = async (k: Kernel, base: string): Promise<Map<string, string>> => {
  const out = new Map<string, string>();
  const globs = (await gatesAt(k, base))?.config.tests.protected_configs ?? [];
  if (globs.length === 0) return out;
  const listed = await runGit(k.deps.repoRoot, ["ls-tree", "-r", "--name-only", "-z", base]);
  for (const path of listed.stdout.toString("utf8").split("\0")) {
    if (path === "" || !globs.some((g) => globMatch(g, path))) continue;
    const bytes = await k.deps.git.readFileAtCommit(base, path);
    if (bytes !== undefined) out.set(path, sha256(bytes));
  }
  return out;
};

/**
 * Files QA wrote (by checksum at QA's commit) plus protected configs at the baseline (§7.3): the
 * `protected_configs` of the `gates.yml` committed at the baseline (reading 46f), never the
 * working tree's.
 */
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
  if (task.baseline_revision !== undefined)
    for (const [path, sum] of await protectedConfigsAt(k, task.baseline_revision))
      out.set(path, sum);
  return [...out.entries()].map(([path, sum]) => ({ path, sha256: sum }));
};

// ------------------------------------------------------------- QA base check

/** True for a plain file or directory (symlinks, devices and sockets are not copied). */
const plainEntry = (path: string): boolean => {
  try {
    const stat = lstatSync(path);
    return stat.isFile() || stat.isDirectory();
  } catch {
    return false;
  }
};

/**
 * Moves QA's hidden tests out of the repo, to `~/.vtc/hidden/<repo-key>/<run>/<task>/` (§7.3;
 * keyed by run since contracts 5.0.0, D-ck, spine §5 reading 205: task ids repeat across runs, so
 * a later run's task or a replay trial never gets another run's tests). The path is built only
 * with `hiddenTestsDir`, as the Gate Runner reads it. QA writes the staging dir, so symlinks there
 * are skipped: a copy never reads a file outside it.
 */
const moveHiddenTests = (k: Kernel, runId: string, taskId: string): void => {
  const rel = `${HIDDEN_TESTS.stagingDir}/${taskId}`;
  try {
    assertNoSymlinks(k.deps.repoRoot, HIDDEN_TESTS.stagingDir);
  } catch {
    return; // a planted symlink above the staging dir: neither copy nor delete through it
  }
  const staged = join(k.deps.repoRoot, rel);
  if (!existsSync(staged) || !plainEntry(staged)) {
    rmSync(staged, { recursive: true, force: true });
    return;
  }
  const target = join(k.deps.vtcHome, hiddenTestsDir(engineRepoKey(k.deps.repoRoot), runId, taskId));
  mkdirSync(target, { recursive: true });
  cpSync(staged, target, { recursive: true, filter: (source) => plainEntry(source) });
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
      report = await runGates(k, h, {
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
        moveHiddenTests(k, h.state.id, taskId);
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
            stuckRole: "qa",
          });
        }
      }
      return Promise.resolve();
    });
  });
};

// --------------------------------------------------------------- round gates

/**
 * The task's previous L2 metrics at the same scope (§7.3 monotonic metrics): the last L2 result's
 * `tests`, which with several L2 gates are the run's combined L2 metrics (reading 46d).
 */
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
    let reports: GateReport[];
    let router: { hits: ReturnType<typeof diffRiskHits>; trivial: boolean } | null = null;
    // AD-24: a UI task's screens get the deterministic visual step
    const screens = taskHasUi(h.state, task) ? screensFor(k.deps.repoRoot, task) : [];
    try {
      const protectedList = await protectedFiles(k, h, task);
      const compare = previousMetrics(h, taskId);
      reports = await runGatesRetryingFlaky(k, h, {
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
        ...(screens.length === 0 ? {} : { visual: { screens } }),
      });
      const last = reports.at(-1);
      if (last !== undefined && effectiveVerdict(last) === "pass") {
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
      for (const r of reports) emitGateResult(k, h, r);
      const report = reports.at(-1);
      const current = h.state.tasks.get(taskId);
      if (
        report === undefined ||
        current?.status !== "verifying" ||
        lastBuilt(h.state, taskId)?.head !== head
      )
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
  const verdict = effectiveVerdict(report);
  if (verdict === "infra_error") {
    parkInfra(
      k,
      h,
      task.id,
      report.verdict === "infra_error"
        ? "a blocking gate failed for infrastructure or environment reasons"
        : "the visual step failed for infrastructure reasons (a browser that does not match its pin, or a crash)",
      report.results.flatMap((r) => r.evidence).slice(0, 5),
    );
    return;
  }
  const fresh = gateFindings(report, task.id, Math.max(1, task.round), inventoryReader(k));
  const merge = recordRoundFindings(k, h, task.id, fresh, gateSources(h, task.id, fresh));
  if (verdict === "fail") {
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
export const baseBranch = async (repoRoot: string): Promise<string> => {
  const out = (
    await runGit(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true })
  ).stdout
    .toString("utf8")
    .trim();
  return out === "" || out === "HEAD" || out.startsWith("vtc/") ? "main" : out;
};

/**
 * A git or `gh` failure for the log (`branch.push_failed`, `feature.pr_failed`): redacted before
 * it is cut to the 2000 characters the payload allows (a marker can be longer than a secret).
 */
export const failureDetail = (text: string, secrets: readonly string[]): string =>
  redactSecrets(text.trim(), secrets).slice(0, 2000) || "no detail";

/**
 * Merge Level 2 or 3 in a repo without the push remote (spine §5 reading 18): the run drops to
 * Level 1 (`run.merge_level_changed`, reason `no_remote`) and its merged tasks reach `done` under
 * the Level-1 rule.
 */
export const downgradeNoRemote = (k: Kernel, h: RunHandle): void => {
  const from = h.state.run.merge_level_effective;
  if (from < 2) return;
  k.emit(h, {
    type: "run.merge_level_changed",
    actor: "engine",
    data: { from, to: 1, reason: "no_remote" },
  });
  for (const task of [...h.state.tasks.values()]) {
    if (task.status === "merged") setTaskStatus(k, h, task.id, "done");
  }
};

/** Pushes the integration branch and keeps the draft PR current (Level 2, §6.7). */
export const pushFeature = async (
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
      downgradeNoRemote(k, h);
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
        data: {
          branch: feature.integration_branch,
          detail: failureDetail(pushed.detail, k.secrets()),
        },
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
        data: {
          detail: failureDetail(
            error instanceof Error ? error.message : String(error),
            k.secrets(),
          ),
        },
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
  const built = lastBuilt(h.state, taskId)?.head;
  if (built === undefined) {
    await k.serial(h, () => {
      parkInfra(k, h, taskId, "the merge queue found no built head for the task");
      return Promise.resolve();
    });
    return;
  }
  // Only the head the gates and reviewers verified is merged: anything committed or left on the
  // task branch since (or a rebase an interrupted run left behind) is reset first.
  if (
    (await ws.resolve(task.branch ?? `vtc/${taskId}`)) !== built ||
    (await ws.isDirty(task.worktree))
  ) {
    await ws.discard(task.worktree, built);
  }
  const integrationHead = await ws.resolve(branch);
  const rebased = await ws.rebase(task.worktree, integrationHead);
  if (!rebased.ok) return sendBack(rebased.detail);
  const reports = await runGatesRetryingFlaky(k, h, {
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
  const report = reports.at(-1);
  if (report === undefined) return;
  const verdict = await k.serial(h, () => {
    for (const r of reports) emitGateResult(k, h, r);
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
  if (integration.head !== integrationHead) {
    await k.serial(h, () => {
      parkInfra(k, h, taskId, `${branch} moved while the merge-queue gates ran`);
      return Promise.resolve();
    });
    return;
  }
  // The exact commit the gates verified, never whatever the branch points at now.
  const merged = await ws.merge(
    integration.worktree,
    rebased.commit,
    `vtc: merge ${taskId} ${task.title}`,
  );
  if (!merged.ok) return sendBack(merged.detail);
  const parents = [
    await ws.resolve(`${merged.commit}^1`),
    await ws.resolve(`${merged.commit}^2`).catch(() => ""),
  ];
  if (parents[0] !== integrationHead || parents[1] !== rebased.commit) {
    await ws.discard(integration.worktree, integrationHead);
    await k.serial(h, () => {
      parkInfra(k, h, taskId, "the merge commit is not the gated commit on the gated base");
      return Promise.resolve();
    });
    return;
  }
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
  options: { round?: number; parkReason?: ParkReason; riskRule?: RiskRuleReasonRule } = {},
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
      ...(options.riskRule === undefined ? {} : { risk_rule: options.riskRule }),
    },
  });
};

export { setFeatureStatus };

export const parkFeature = (
  k: Kernel,
  h: RunHandle,
  featureId: string,
  reason: ParkReason,
  detail: string,
  evidence: readonly Evidence[],
  riskRule?: RiskRuleReasonRule,
  /** A Level-3 release park: retry or finish at Level 2 (D-bd). */
  level3Release?: boolean,
): void => {
  setFeatureStatus(k, h, featureId, "parked", {
    parkReason: reason,
    ...(riskRule === undefined ? {} : { riskRule }),
  });
  openFeatureEscalation(k, h, featureId, reason, detail, evidence, riskRule, level3Release);
};

/** The escalation of a parked feature (its park reason's options, or a Level-3 release's). */
export const openFeatureEscalation = (
  k: Kernel,
  h: RunHandle,
  featureId: string,
  reason: ParkReason,
  detail: string,
  evidence: readonly Evidence[],
  riskRule?: RiskRuleReasonRule,
  level3Release?: boolean,
): void => {
  const feature = h.state.features.get(featureId);
  const escalation = parkEscalation({
    id: nextEscalationId(h.state),
    run: h.state.id,
    feature: featureId,
    reason,
    ...(riskRule === undefined ? {} : { riskRule }),
    detail,
    evidence,
    blocks: feature?.tasks ?? [],
    now: k.now(),
    ...(level3Release === true ? { level3Release } : {}),
  });
  k.emit(h, {
    type: "escalation.opened",
    actor: "engine",
    feature: featureId,
    data: { escalation },
  });
};

/**
 * The feature task that owns every one of `paths`: a planner task (not an earlier fix) whose
 * `files_scope` matches them all, when exactly one does. `undefined` otherwise (no path, or the
 * paths span tasks: a cross-task finding no single task owns, AD-8 rule 11).
 */
const owningTask = (tasks: readonly Task[], paths: readonly string[]): Task | undefined => {
  if (paths.length === 0) return undefined;
  const candidates = tasks.filter(
    (t) =>
      t.origin === "planner" &&
      t.status !== "dropped" &&
      paths.every((p) => matchesAny(t.files_scope, p)),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
};

/**
 * A Final Review finding risky enough to park the feature for the human instead of a fix round
 * (§6.7a, §7.6; spine §5 reading 91): a secret, or a high or critical security or supply-chain
 * finding.
 */
export const riskyFinding = (
  findings: readonly Finding[],
): { readonly finding: Finding; readonly rule: RiskRuleReasonRule } | undefined => {
  const secret = findings.find((f) => f.category === "secret");
  if (secret !== undefined) return { finding: secret, rule: "committed_secret" };
  const high = findings.find(
    (f) =>
      (f.category === "security" || f.category === "supply_chain") &&
      (f.severity === "high" || f.severity === "critical"),
  );
  return high === undefined ? undefined : { finding: high, rule: "open_high_finding" };
};

/**
 * §6.7a routing, spine §5 readings 139 and 150: every finding one merged planner task owns (its
 * `files_scope` holds the finding's path) while that task is not yet `done` reopens that task
 * (`merged` → `fixing`, keeping its round: these fix rounds count on the feature) with the
 * finding recorded on it. Its own specialist runs the fix round (the task's session, resumed as
 * in any fix round) in its preserved worktree, which `rebaseReopened` first moves onto the
 * integrated head. Returns the findings left for an integration-fix task: those no single task
 * owns, and those on a `done` task (`done` stays terminal, §6.4).
 */
export const reopenOwningTasks = (
  k: Kernel,
  h: RunHandle,
  featureId: string,
  findings: readonly Finding[],
): Finding[] => {
  const feature = h.state.features.get(featureId);
  if (feature === undefined) return [...findings];
  const tasks = feature.tasks
    .map((t) => h.state.tasks.get(t))
    .filter((t): t is Task => t !== undefined);
  const byOwner = new Map<string, Finding[]>();
  const rest: Finding[] = [];
  for (const finding of findings) {
    const path = finding.location.path;
    const owner = path.startsWith(".vtc/") ? undefined : owningTask(tasks, [path]);
    if (owner?.status !== "merged" || owner.worktree === undefined) {
      rest.push(finding);
      continue;
    }
    byOwner.set(owner.id, [...(byOwner.get(owner.id) ?? []), finding]);
  }
  for (const [taskId, owned] of byOwner) {
    setTaskStatus(k, h, taskId, "fixing");
    for (const finding of owned) {
      k.emit(h, {
        type: "finding.recorded",
        actor: "engine",
        task: taskId,
        data: { finding: { ...finding, task: taskId } },
      });
    }
    rebaseReopened(k, h, taskId);
  }
  return rest;
};

/**
 * A reopened task's preserved worktree onto the feature's integrated head (§6.7a "rebased"): its
 * own work is already merged there, so the branch moves to that head, which becomes the task's
 * baseline (`task.workspace_assigned`), so its next round's diff is the fix alone. Runs again after
 * a restart while the task still awaits it (`awaitingReopenRebase`); a failure parks the task as
 * gate infrastructure.
 */
export const rebaseReopened = (k: Kernel, h: RunHandle, taskId: string): void => {
  k.spawn(h, `reopen:${taskId}`, async () => {
    const task = h.state.tasks.get(taskId);
    const feature = task === undefined ? undefined : h.state.features.get(task.feature);
    if (task === undefined || feature === undefined) return;
    const branch = task.branch ?? `vtc/${taskId}`;
    try {
      const ws = k.deps.workspace;
      const head = await ws.resolve(feature.integration_branch);
      const { worktree } = await ws.ensureTaskWorktree(taskId, branch, head);
      await ws.discard(worktree, head);
      await k.serial(h, () => {
        if (h.state.tasks.get(taskId)?.status !== "fixing") return Promise.resolve();
        k.emit(h, {
          type: "task.workspace_assigned",
          actor: "engine",
          task: taskId,
          data: { worktree, branch, baseline_revision: head },
        });
        return Promise.resolve();
      });
    } catch (error) {
      await k.serial(h, () => {
        parkInfra(
          k,
          h,
          taskId,
          `could not move the reopened task's worktree onto ${feature.integration_branch}: ${message(error)}`,
        );
        return Promise.resolve();
      });
    }
  });
};

/** An engine-created task for Final Review findings (§6.7a, AD-8 rule 11). */
export const createIntegrationFix = (
  k: Kernel,
  h: RunHandle,
  featureId: string,
  findings: readonly Finding[],
): void => {
  const feature = h.state.features.get(featureId);
  const first = findings[0];
  if (feature === undefined || first === undefined) return;
  const id = nextNumberedId("T", new Set([...usedTaskIds(k.allStates()), ...k.sharedTaskIds]));
  const config = k.config();
  const owners = feature.tasks
    .map((t) => h.state.tasks.get(t))
    .filter((t): t is Task => t !== undefined);
  const disciplines = owners.map((t) => t.discipline);
  const paths = [
    ...new Set(findings.map((f) => f.location.path).filter((p) => !p.startsWith(".vtc/"))),
  ];
  // The owning task (§6.7a routing; spine §5 readings 91, 139): the one planner task whose
  // files_scope holds every finding's path. A merged owner that is not yet done was reopened
  // instead (`reopenOwningTasks`); a done one stays done, so the fix is a new task that names it
  // and gets its discipline and scope.
  const owner = owningTask(owners, paths);
  const discipline =
    owner?.discipline ??
    disciplines.sort(
      (a, b) =>
        disciplines.filter((d) => d === b).length - disciplines.filter((d) => d === a).length,
    )[0] ??
    "backend";
  const task: Task = {
    id,
    title: (owner === undefined
      ? `Integration fix: ${first.title}`
      : `Final Review fix for ${owner.id}: ${first.title}`
    ).slice(0, 200),
    feature: featureId,
    origin: "integration_fix",
    source_finding: first.fingerprint,
    covers: [],
    after: [],
    files_scope: owner !== undefined ? [...owner.files_scope] : paths.length > 0 ? paths : ["**"],
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

/**
 * The Final Review gate request (§6.7a steps 1, 2 and 6): full scope, every layer, and every
 * hidden acceptance test of the feature's tasks (`hidden_tasks`, reading 46c). The evidence bundle
 * reads the steps it covered from this shape (`finalReviewStepsCovered`, reading 46e).
 */
export const finalReviewRequest = (
  h: RunHandle,
  featureId: string,
  at: { readonly base: string; readonly head: string; readonly req_tags: readonly string[] },
): Omit<GateRunRequestInput, "checkout" | "gates_config_hash"> => {
  const tasks = (h.state.features.get(featureId)?.tasks ?? []).filter(
    (t) => h.state.tasks.get(t)?.status !== "dropped",
  );
  return {
    run: h.state.id,
    feature: featureId,
    reason: "final_review",
    scope: "full",
    base: at.base,
    head: at.head,
    req_tags: [...at.req_tags],
    include_hidden: true,
    hidden_tasks: [...new Set(tasks)],
  };
};

/** A failed Final Review report's findings for the feature's next round (inventories read). */
export const gateReportFindings = (k: Kernel, report: GateReport, round: number): Finding[] =>
  gateFindings(report, undefined, round, inventoryReader(k));

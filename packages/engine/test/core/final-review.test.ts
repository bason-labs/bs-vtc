/**
 * Final Review steps 3–5 and 7 (spec §6.7a; wave 3) and the visual step's status (spine AD-24
 * rule 5, §5 reading 105): the AI reviewers once per feature at the integrated head, release
 * readiness from the diff, `final_review.step_finished` and the bundle's `final_review_steps` /
 * `release_readiness`; a failed or unchecked visual step fails a round, an errored one is gate
 * infrastructure, a skipped one is a note; a design-slop finding routes to the Designer.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EvidenceBundleSchema,
  VISUAL_SKIPPED_NO_BROWSER,
  type GateReport,
  type GitChangedFile,
  type LeadAction,
  type VisualSummary,
} from "@vtc/shared";
import { effectiveVerdict, visualFindings } from "../../src/core/gate-verdict.js";
import { fixAffectedSteps, releaseReadiness, visualStep } from "../../src/core/final-review.js";
import { cleanupDirs, writeFile } from "../helpers/repo.js";
import {
  authorTests,
  build,
  CLAUDE,
  createHarness,
  draft,
  only,
  SPEC_ONE,
  spawns,
  submitResult,
  throughPlan,
  toolFinding,
  verdictPass,
  workdir,
  type Harness,
  type SpawnAction,
} from "../helpers/engine-harness.js";

vi.setConfig({ testTimeout: 30_000 });
afterEach(cleanupDirs);

interface Line {
  type: string;
  feature?: string;
  role?: string;
  data: Record<string, unknown>;
}
const events = (h: Harness): Line[] =>
  readFileSync(join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/events.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Line);
const steps = (h: Harness): Record<string, unknown>[] =>
  events(h)
    .filter((e) => e.type === "final_review.step_finished")
    .map((e) => e.data);

const summary = (over: Partial<VisualSummary>): VisualSummary => ({
  status: "pass",
  report: ".vtc/evidence/F-1/visual.json",
  counts: {
    renders: 6,
    unreached: 0,
    axe_violations: 0,
    axe_incomplete: 0,
    style_mismatches: 0,
    diffs_over_budget: 0,
    token_lint: 0,
    detector: 0,
  },
  findings: [],
  ...over,
});

/** One task merged; Final Review's gates ran; returns the reviewers it hands out. */
const toFinalReview = async (h: Harness): Promise<SpawnAction[]> => {
  const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
  await authorTests(h, only(actions, "qa"));
  await build(h, only((await h.engine.next({}, CLAUDE)).actions, "engineer"));
  await verdictPass(
    h,
    only((await h.engine.next({}, CLAUDE)).actions, "spec_verifier"),
    "src/t-1/impl.ts",
  );
  await h.engine.settle();
  return spawns((await h.engine.next({}, CLAUDE)).actions);
};

const review = (
  h: Harness,
  action: SpawnAction,
  verdict: "pass" | "fail",
  cite = "src/t-1/impl.ts:1",
) =>
  submitResult(h, action, {
    exit: "done",
    feature: action.feature,
    verdicts: [
      { subject: action.subject ?? "F-1", verdict, evidence: [{ type: "file_line", ref: cite }] },
    ],
  });

describe("Final Review steps 3–5 and 7 (§6.7a)", () => {
  it("records the gate steps, hands out the AI reviewers at the integrated head, then steps 3, 4 and 7", async () => {
    const h = createHarness({ project: { merge_level: 1 } });
    const reviewers = await toFinalReview(h);
    expect(reviewers.map((r) => [r.role, r.mode, r.feature, r.subject, r.task])).toEqual([
      ["spec_verifier", undefined, "F-1", "F-1", undefined],
      ["security", "verify", "F-1", "F-1", undefined],
    ]);
    // read-only at the integrated head: the merged task's code is there
    for (const r of reviewers) {
      expect(existsSync(join(workdir(r), "src/t-1/impl.ts"))).toBe(true);
      expect(r.prompt).toContain('feature "F-1"');
    }
    expect(steps(h)).toEqual([
      { step: 1, status: "pass", evidence: [expect.objectContaining({ type: "commit" })] },
      expect.objectContaining({ step: 2, status: "not_run" }),
      expect.objectContaining({ step: 5, status: "not_run", reason: "the feature has no UI" }),
      expect.objectContaining({ step: 6, status: "not_run" }),
    ]);
    expect(h.engine.status({}).features[0]?.status).toBe("final_review");
    for (const r of reviewers) expect((await review(h, r, "pass")).accepted).toBe(true);
    await h.engine.settle();
    expect(steps(h).slice(4)).toEqual([
      expect.objectContaining({ step: 3, status: "pass" }),
      expect.objectContaining({ step: 4, status: "pass" }),
      expect.objectContaining({ step: 7, status: "pass" }),
    ]);
    const status = h.engine.status({});
    expect(status.features[0]?.status).toBe("ready_to_ship");
    expect(status.run.finished_at).toBeDefined();
    const bundle = EvidenceBundleSchema.parse(
      JSON.parse(readFileSync(join(h.repo, ".vtc/evidence/F-1/bundle.json"), "utf8")),
    );
    if (bundle.kind !== "feature") throw new Error("feature bundle expected");
    expect(bundle.final_review_steps?.map((s) => [s.step, s.status])).toEqual([
      [1, "pass"],
      [2, "not_run"],
      [3, "pass"],
      [4, "pass"],
      [5, "not_run"],
      [6, "not_run"],
      [7, "pass"],
    ]);
    expect(bundle.release_readiness?.ok).toBe(true);
    await h.release();
  });

  it("a failing Spec-Verifier sends the feature to a fix round with an integration-fix task", async () => {
    const h = createHarness({ project: { merge_level: 1 } });
    const [verifier, security] = await toFinalReview(h);
    await review(h, verifier!, "fail");
    await review(h, security!, "pass");
    await h.engine.settle();
    expect(steps(h).find((s) => s.step === 3)).toMatchObject({ status: "fail" });
    const status = h.engine.status({});
    expect(status.features[0]).toMatchObject({ status: "fixing", round: 1 });
    expect(
      events(h).some(
        (e) => e.type === "task.created" && JSON.stringify(e.data).includes("integration_fix"),
      ),
    ).toBe(true);
    await h.release();
  });

  it("a reviewer whose result is lost leaves its step unchecked, which parks the feature: never ready to ship", async () => {
    const h = createHarness({ project: { merge_level: 1 } });
    const [verifier, security] = await toFinalReview(h);
    await review(h, verifier!, "pass");
    rmSync(join(h.repo, `.vtc/state/results/${verifier!.action_id}.json`));
    await review(h, security!, "pass");
    await h.engine.settle();
    expect(steps(h).find((s) => s.step === 3)).toMatchObject({ status: "unchecked" });
    expect(h.engine.status({}).features[0]).toMatchObject({
      status: "parked",
      park_reason: "blocked",
    });
    const escalation = events(h)
      .filter((e) => e.type === "escalation.opened")
      .at(-1)?.data.escalation as { detail: string };
    expect(escalation.detail).toContain("step(s) 3 could not be checked");
    await h.release();
  });

  it("a failing Security verdict is risky: the feature parks for the human", async () => {
    const h = createHarness({ project: { merge_level: 1 } });
    const [verifier, security] = await toFinalReview(h);
    await review(h, verifier!, "pass");
    await review(h, security!, "fail");
    await h.engine.settle();
    expect(steps(h).find((s) => s.step === 4)).toMatchObject({ status: "fail" });
    expect(h.engine.status({}).features[0]).toMatchObject({
      status: "parked",
      park_reason: "risk_rule",
    });
    await h.release();
  });

  it("a reviewer that writes in its worktree is rejected, and three failures park the feature", async () => {
    const h = createHarness({ project: { merge_level: 1 } });
    const [verifier] = await toFinalReview(h);
    writeFile(workdir(verifier!), "src/t-1/impl.ts", "export const x = 2;\n");
    let out = await review(h, verifier!, "pass");
    expect(out.accepted).toBe(false);
    expect(out.rejection?.reason).toBe("write_scope");
    for (let i = 0; i < 2; i += 1) {
      const again = spawns(out.actions).find((a) => a.role === "spec_verifier");
      expect(again?.prompt).toContain("was rejected");
      // a done result with no verdict on its subject is rejected too
      out = await submitResult(h, again!, { exit: "done", feature: "F-1", verdicts: [] });
      expect(out.accepted).toBe(false);
    }
    await h.engine.next({}, CLAUDE);
    expect(h.engine.status({}).features[0]).toMatchObject({ status: "parked" });
    await h.release();
  });

  it("a reviewer's finding that cites nothing at the integrated head is rejected", async () => {
    const h = createHarness({ project: { merge_level: 1 } });
    const [verifier] = await toFinalReview(h);
    const out = await submitResult(h, verifier!, {
      exit: "done",
      feature: "F-1",
      verdicts: [
        {
          subject: "F-1",
          verdict: "pass",
          evidence: [{ type: "file_line", ref: "src/t-1/impl.ts:1" }],
        },
      ],
      findings: [
        {
          rule_id: "made-up",
          category: "correctness",
          kind: "implementation_deviation",
          title: "an invented bug",
          confidence: 0.9,
          location: { path: "src/nowhere.ts" },
          evidence: { type: "file_line", ref: "src/nowhere.ts:3" },
          req_ids: [],
        },
      ],
    });
    expect(out.accepted).toBe(false);
    expect(out.rejection?.reason).toBe("claim_check");
    await h.release();
  });

  it("a spec gap at step 3 parks the feature for the human: no engineer fix round, nothing merged", async () => {
    const h = createHarness({ project: { merge_level: 1 } });
    const [verifier, security] = await toFinalReview(h);
    const out = await submitResult(h, verifier!, {
      exit: "done",
      feature: "F-1",
      verdicts: [
        {
          subject: "F-1",
          verdict: "fail",
          evidence: [{ type: "file_line", ref: "src/t-1/impl.ts:1" }],
        },
      ],
      findings: [
        {
          rule_id: "spec-ambiguity",
          category: "correctness",
          kind: "spec_ambiguity",
          title: "REQ-1 does not say what an expired link shows",
          confidence: 0.9,
          location: { path: "src/t-1/impl.ts" },
          evidence: { type: "file_line", ref: "src/t-1/impl.ts:1" },
          req_ids: [],
        },
      ],
    });
    expect(out.accepted).toBe(true);
    await review(h, security!, "pass");
    await h.engine.settle();
    expect(h.engine.status({}).features[0]).toMatchObject({
      status: "parked",
      park_reason: "spec_conflict",
    });
    expect(
      events(h).some(
        (e) => e.type === "task.created" && JSON.stringify(e.data).includes("integration_fix"),
      ),
    ).toBe(false);
    await h.release();
  });

  it("a changelog the repo keeps but the feature did not update fails step 7 into a fix round", async () => {
    const h = createHarness({
      project: { merge_level: 1 },
      files: { "CHANGELOG.md": "# Changelog\n" },
    });
    const reviewers = await toFinalReview(h);
    for (const r of reviewers) await review(h, r, "pass");
    await h.engine.settle();
    expect(steps(h).find((s) => s.step === 7)).toMatchObject({
      status: "fail",
      reason: expect.stringContaining("changelog") as unknown,
    });
    expect(h.engine.status({}).features[0]?.status).toBe("fixing");
    await h.release();
  });
});

describe("a fix round re-runs only the AI steps the fix affected (§6.7a routing)", () => {
  const nextActions = async (h: Harness) => (await h.engine.next({}, CLAUDE)).actions;
  const reviewersOf = (actions: readonly LeadAction[]) =>
    spawns(actions).filter((a) => a.feature === "F-1" && a.task === undefined);

  it("a fix that only touched the changelog (and added a test) carries steps 3 and 4 over", async () => {
    const h = createHarness({
      project: { merge_level: 1 },
      files: { "CHANGELOG.md": "# Changelog\n" },
    });
    const reviewers = await toFinalReview(h);
    for (const r of reviewers) await review(h, r, "pass");
    await h.engine.settle();
    expect(h.engine.status({}).features[0]).toMatchObject({ status: "fixing", round: 1 });
    await authorTests(h, only(await nextActions(h), "qa"));
    await build(
      h,
      only(await nextActions(h), "engineer"),
      "# Changelog\n\n- Password reset\n",
      "CHANGELOG.md",
    );
    await h.engine.settle();
    const after = await nextActions(h);
    expect(reviewersOf(after)).toEqual([]);
    const round2 = steps(h).slice(-7);
    expect(round2.map((s) => [s.step, s.status])).toEqual([
      [1, "pass"],
      [2, "not_run"],
      [5, "not_run"],
      [6, "not_run"],
      [3, "pass"],
      [4, "pass"],
      [7, "pass"],
    ]);
    expect(round2[4]?.reason).toMatch(/carried over from round 1/);
    expect(round2[5]?.reason).toMatch(/carried over from round 1/);
    expect(h.engine.status({}).features[0]?.status).toBe("ready_to_ship");
    await h.release();
  });

  it("step 3 is never carried over this round's traceability gap: its reviewer runs again", async () => {
    const h = createHarness({
      project: { merge_level: 1 },
      files: { "CHANGELOG.md": "# Changelog\n" },
    });
    const reviewers = await toFinalReview(h);
    for (const r of reviewers) await review(h, r, "pass");
    await h.engine.settle();
    expect(h.engine.status({}).features[0]).toMatchObject({ status: "fixing", round: 1 });
    // from round 2 on, the gates report a requirement with no passing test
    h.gates.reshape((request, report) => {
      if (request.reason !== "final_review" || request.feature === undefined) return report;
      const path = `.vtc/evidence/${request.feature}/traceability.json`;
      writeFile(
        h.repo,
        path,
        `${JSON.stringify({
          run: request.run,
          feature: request.feature,
          rows: [{ req: "REQ-1", tests: [], covered: false }],
          gaps: ["REQ-1"],
          built_at: h.clock.toISOString(),
        })}\n`,
      );
      return { ...report, traceability: path };
    });
    await authorTests(h, only(await nextActions(h), "qa"));
    await build(
      h,
      only(await nextActions(h), "engineer"),
      "# Changelog\n\n- Password reset\n",
      "CHANGELOG.md",
    );
    await h.engine.settle();
    expect(reviewersOf(await nextActions(h)).map((r) => r.role)).toEqual(["spec_verifier"]);
    expect(steps(h).at(-1)).toMatchObject({ step: 4, status: "pass" });
    await h.release();
  });

  it("a fix that changed code re-runs both reviewers; the step that failed always re-runs", async () => {
    const h = createHarness({ project: { merge_level: 1 } });
    const [verifier, security] = await toFinalReview(h);
    await review(h, verifier!, "fail");
    await review(h, security!, "pass");
    await h.engine.settle();
    expect(h.engine.status({}).features[0]).toMatchObject({ status: "fixing", round: 1 });
    await authorTests(h, only(await nextActions(h), "qa"));
    await build(
      h,
      only(await nextActions(h), "engineer"),
      "export const y = 2;\n",
      "src/t-1/fix.ts",
    );
    await h.engine.settle();
    const nxt = await nextActions(h);
    // the reviewer's finding on the fix task waits for Final Review, not for a task reviewer
    // the fix task never had: the task merged after one round
    expect(
      events(h).filter((e) => e.type === "role.dispatched" && e.role === "engineer"),
    ).toHaveLength(2);
    const again = reviewersOf(nxt);
    expect(again.map((r) => r.role)).toEqual(["spec_verifier", "security"]);
    for (const r of again) await review(h, r, "pass");
    await h.engine.settle();
    expect(h.engine.status({}).features[0]?.status).toBe("ready_to_ship");
    await h.release();
  });

  it("which steps a fix affects, from its diff", () => {
    const changed = (
      path: string,
      status: GitChangedFile["status"] = "modified",
    ): GitChangedFile => ({ path, status });
    expect(fixAffectedSteps([changed("CHANGELOG.md"), changed("docs/x.md")])).toEqual([]);
    expect(fixAffectedSteps([changed(".vtc/evidence/F-1/bundle.json")])).toEqual([]);
    expect(fixAffectedSteps([changed("tests/acceptance/t-2.test.ts", "added")])).toEqual([]);
    expect(fixAffectedSteps([changed("tests/acceptance/t-1.test.ts")])).toEqual([3]);
    expect(fixAffectedSteps([changed("src/a.spec.ts", "deleted")])).toEqual([3]);
    expect(fixAffectedSteps([changed("src/t-1/impl.ts")])).toEqual([3, 4]);
    expect(fixAffectedSteps([changed("package.json")])).toEqual([3, 4]);
    // a directory named spec or test is not a test: production code and config live there too
    expect(fixAffectedSteps([changed("api/specs/openapi.yaml")])).toEqual([3, 4]);
    expect(fixAffectedSteps([changed("src/spec/auth.ts")])).toEqual([3, 4]);
    expect(fixAffectedSteps([changed("test/fixtures/secrets.json")])).toEqual([3, 4]);
    expect(fixAffectedSteps([changed("pkg/auth_test.go")])).toEqual([3]);
    expect(fixAffectedSteps([changed("tests/test_auth.py")])).toEqual([3]);
    // a test-like name on data, config, CI or a production module is not a test either
    for (const path of [
      ".github/workflows/e2e-test.yml",
      "api/openapi.spec.yaml",
      "api/openapi-spec.yaml",
      "api/swagger.spec.json",
      "api/auth-spec.json",
      "config/appsettings.test.json",
      "deploy/docker-compose.test.yml",
      "docker-compose.test.yml",
      "src/auth/policy-spec.ts",
      "src/auth/policy-spec.rego",
      "test_settings.py",
      "tests/test_config.py",
      "ci/smoke.test.ts",
      "tests/acceptance/helpers.ts",
      "tests/acceptance/fixtures/secrets.json",
    ]) {
      expect(fixAffectedSteps([changed(path)]), path).toEqual([3, 4]);
      expect(fixAffectedSteps([changed(path, "added")]), path).toEqual([3, 4]);
    }
    // the spec, architecture and design under .vtc/ are what step 3 verifies against
    expect(fixAffectedSteps([changed(".vtc/spec/spec.md")])).toEqual([3]);
    expect(fixAffectedSteps([changed(".vtc/architecture/notes.md")])).toEqual([3]);
    expect(fixAffectedSteps([changed(".vtc/runs/r-1/events.jsonl")])).toEqual([]);
    expect(fixAffectedSteps([changed(".vtc/tasks/T-2.md", "added")])).toEqual([]);
  });
});

describe("release readiness from the diff (§6.7a step 7)", () => {
  const added = (path: string): GitChangedFile => ({ path, status: "added" });
  it("passes or does not apply on an ordinary change, with rollback notes", () => {
    const r = releaseReadiness([added("src/a.ts")], ["src/b.ts"]);
    expect(r.ok).toBe(true);
    expect(r.items.map((i) => [i.id, i.status])).toEqual([
      ["migration_order", "not_applicable"],
      ["config_changes", "not_applicable"],
      ["rollback_notes", "pass"],
      ["docs", "not_applicable"],
      ["changelog", "not_applicable"],
      ["feature_flags", "not_applicable"],
    ]);
  });
  it("fails a new migration that sorts before one the base has", () => {
    const r = releaseReadiness(
      [added("db/migrations/0002_add.sql")],
      ["db/migrations/0001_init.sql", "db/migrations/0003_later.sql"],
    );
    expect(r.ok).toBe(false);
    expect(r.items[0]).toMatchObject({ id: "migration_order", status: "fail" });
    const ordered = releaseReadiness(
      [added("db/migrations/0004_add.sql")],
      ["db/migrations/0003_x.sql"],
    );
    expect(ordered.items[0]).toMatchObject({ status: "pass" });
    expect(ordered.items[2]?.note).toContain("roll back the migrations");
  });
  it("lists config, docs, changelog and flag changes", () => {
    const r = releaseReadiness(
      [
        added(".env.example"),
        added("docs/reset.md"),
        { path: "CHANGELOG.md", status: "modified" },
        added("src/feature-flags.ts"),
      ],
      ["CHANGELOG.md"],
    );
    expect(r.ok).toBe(true);
    expect(r.items.map((i) => i.status)).toEqual([
      "not_applicable",
      "pass",
      "pass",
      "pass",
      "pass",
      "pass",
    ]);
  });
});

describe("the visual step's status (AD-24 rule 5, reading 105)", () => {
  const base = { verdict: "pass" as const };
  it("fail and unchecked fail the run, error is infrastructure, skipped and pass pass", () => {
    expect(effectiveVerdict({ ...base, visual: summary({ status: "fail" }) })).toBe("fail");
    expect(effectiveVerdict({ ...base, visual: summary({ status: "unchecked" }) })).toBe("fail");
    expect(effectiveVerdict({ ...base, visual: summary({ status: "error" }) })).toBe("infra_error");
    expect(
      effectiveVerdict({
        ...base,
        visual: summary({ status: "skipped", skipped_reason: VISUAL_SKIPPED_NO_BROWSER }),
      }),
    ).toBe("pass");
    expect(effectiveVerdict({ verdict: "fail", visual: summary({ status: "pass" }) })).toBe("fail");
  });
  it("an unchecked step with no finding still yields one", () => {
    expect(visualFindings({ visual: summary({ status: "unchecked" }) })).toEqual([
      expect.objectContaining({ rule_id: "vtc-visual/unreached", category: "design" }),
    ]);
    expect(visualFindings({ visual: summary({ status: "skipped", skipped_reason: "x" }) })).toEqual(
      [],
    );
  });
  it("step 5 says skipped with the reason, and unchecked when a UI feature had no visual step", () => {
    expect(
      visualStep(
        { visual: summary({ status: "skipped", skipped_reason: VISUAL_SKIPPED_NO_BROWSER }) },
        true,
      ),
    ).toMatchObject({ step: 5, status: "skipped", reason: VISUAL_SKIPPED_NO_BROWSER });
    expect(visualStep({}, true)).toMatchObject({ step: 5, status: "unchecked" });
    expect(visualStep({}, false)).toMatchObject({ step: 5, status: "not_run" });
  });

  const withVisual =
    (visual: VisualSummary) =>
    (request: { reason: string }, report: GateReport): GateReport =>
      request.reason === "round" ? { ...report, visual } : report;

  it("a round whose visual step failed goes back to the Engineer with its findings", async () => {
    const h = createHarness({ project: { merge_level: 1 } });
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    await authorTests(h, only(actions, "qa"));
    h.gates.reshape(
      withVisual(
        summary({
          status: "fail",
          findings: [
            {
              ...toolFinding("axe/color-contrast", "serious", "src/t-1/impl.ts"),
              tool: "axe",
              category: "accessibility",
            },
          ],
        }),
      ),
    );
    await build(h, only((await h.engine.next({}, CLAUDE)).actions, "engineer"));
    expect(h.engine.status({}).tasks_by_status).toMatchObject({ fixing: 1 });
    expect(JSON.stringify(events(h).filter((e) => e.type === "finding.recorded"))).toContain(
      "axe/color-contrast",
    );
    await h.release();
  });

  it("a design-slop detector finding routes to the Designer: the task parks for the human", async () => {
    const h = createHarness({ project: { merge_level: 1 } });
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    await authorTests(h, only(actions, "qa"));
    h.gates.reshape(
      withVisual(
        summary({
          status: "fail",
          findings: [
            {
              ...toolFinding("vtc-design/gradient-text", "medium", "src/t-1/impl.ts"),
              tool: "vtc-design",
              category: "design",
            },
          ],
        }),
      ),
    );
    await build(h, only((await h.engine.next({}, CLAUDE)).actions, "engineer"));
    const recorded = events(h).find((e) => e.type === "finding.recorded")?.data.finding as {
      route: string;
    };
    expect(recorded.route).toBe("design_gap");
    expect(h.engine.status({}).parked).toEqual([
      expect.objectContaining({ task: "T-1", reason: "spec_conflict" }),
    ]);
    await h.release();
  });

  it("an errored visual step parks the task as gate infrastructure", async () => {
    const h = createHarness({ project: { merge_level: 1 } });
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    await authorTests(h, only(actions, "qa"));
    h.gates.reshape(withVisual(summary({ status: "error" })));
    await build(h, only((await h.engine.next({}, CLAUDE)).actions, "engineer"));
    expect(h.engine.status({}).parked).toEqual([
      expect.objectContaining({ task: "T-1", reason: "gate_infra" }),
    ]);
    await h.release();
  });

  it("a skipped visual step is a note: the task goes on to its reviewers", async () => {
    const h = createHarness({ project: { merge_level: 1 } });
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    await authorTests(h, only(actions, "qa"));
    h.gates.reshape(
      withVisual(summary({ status: "skipped", skipped_reason: VISUAL_SKIPPED_NO_BROWSER })),
    );
    await build(h, only((await h.engine.next({}, CLAUDE)).actions, "engineer"));
    expect(only((await h.engine.next({}, CLAUDE)).actions, "spec_verifier").task).toBe("T-1");
    await h.release();
  });

  it("a UI task's round asks for its screens, Final Review for all; a skipped step 5 is a note at Level 1", async () => {
    const h = createHarness({ project: { merge_level: 1 } });
    const screens = [
      "version: 1",
      "screens:",
      "  - id: reset-request",
      "    route: /reset",
      "    states: [empty]",
      "    reqs: [REQ-1]",
      "  - id: other",
      "    route: /other",
      "    reqs: [REQ-9]",
      "",
    ].join("\n");
    h.gates.reshape((request, report) =>
      request.reason === "final_review"
        ? {
            ...report,
            visual: summary({
              status: "skipped",
              skipped_reason: VISUAL_SKIPPED_NO_BROWSER,
              report: null,
            }),
          }
        : report,
    );
    const actions = await throughPlan(h, [draft("T-1", { discipline: "frontend" })], SPEC_ONE, {
      screens,
    });
    await authorTests(h, only(actions, "qa"));
    await build(h, only((await h.engine.next({}, CLAUDE)).actions, "engineer"));
    expect(h.gates.requests.find((r) => r.reason === "round")?.visual).toEqual({
      screens: ["reset-request"],
    });
    await verdictPass(
      h,
      only((await h.engine.next({}, CLAUDE)).actions, "spec_verifier"),
      "src/t-1/impl.ts",
    );
    await h.engine.settle();
    expect(h.gates.requests.find((r) => r.reason === "final_review")?.visual).toEqual({
      screens: [],
    });
    expect(steps(h).find((x) => x.step === 5)).toEqual({
      step: 5,
      status: "skipped",
      reason: VISUAL_SKIPPED_NO_BROWSER,
      evidence: [],
    });
    for (const r of spawns((await h.engine.next({}, CLAUDE)).actions)) await review(h, r, "pass");
    await h.engine.settle();
    expect(h.engine.status({}).features[0]?.status).toBe("ready_to_ship");
    await h.release();
  });
});

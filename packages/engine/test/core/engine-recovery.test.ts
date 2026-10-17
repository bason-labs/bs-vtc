/**
 * Restart recovery (AD-7 rule 5, AD-12), out-of-scope faults (§6.3 step 3), contract-first starts
 * (§6.6), spec questions (§6.3 step 2), PLAN rejections (§6.1), the UI design phase, redaction of
 * git-tracked projections (AD-18) and plugin-only dispatch (AD-17).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvidenceBundleSchema, type LeadAction } from "@vtc/shared";
import { cleanupDirs, writeFile } from "../helpers/repo.js";
import {
  authorTests,
  build,
  CLAUDE,
  createHarness,
  draft,
  only,
  SPEC,
  SPEC_ONE,
  spawns,
  submitResult,
  threatModel,
  throughPlan,
  toPlanner,
  verdictPass,
  workdir,
  worktreeOf,
  type Harness,
} from "../helpers/engine-harness.js";

// Whole engine flows on a real repo spawn a few hundred git processes per test: under turbo's
// parallel load the 5 s default is too tight, so they get room on a loaded machine. A real hang
// still fails, and no assertion changes.
vi.setConfig({ testTimeout: 20_000 });

afterEach(cleanupDirs);

const next = async (h: Harness): Promise<LeadAction[]> => (await h.engine.next({}, CLAUDE)).actions;
const log = (h: Harness, run?: string): string =>
  readFileSync(join(h.repo, `.vtc/runs/${run ?? h.engine.status({}).run.id}/events.jsonl`), "utf8");

describe("restart recovery (AD-7 rule 5, AD-12)", () => {
  it("a new engine re-runs gates that were in flight; the old one, without its lock, appends nothing", async () => {
    const h = createHarness();
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    await authorTests(h, only(actions, "qa"));
    const engineer = only(await next(h), "engineer");
    const release = h.gates.hold();
    writeFile(worktreeOf(h, "T-1"), "src/t-1/impl.ts", "x\n");
    expect((await submitResult(h, engineer, { exit: "built" })).accepted).toBe(true);
    const run = h.engine.status({}).run.id;
    const before = log(h, run).length;
    const old = h.engine;
    const engine = h.reopen();
    expect(engine.status({ run }).tasks_by_status).toEqual({ verifying: 1 });
    release();
    await old.settle();
    await engine.settle();
    const rounds = h.gates.requests.filter((r) => r.reason === "round");
    expect(rounds).toHaveLength(2);
    const after = log(h, run);
    expect(after.length).toBeGreaterThan(before);
    expect(after.match(/"type":"gate\.result"/g)?.length).toBe(2); // base check + one round report
    const verifier = spawns((await engine.next({}, CLAUDE)).actions).find(
      (a) => a.role === "spec_verifier",
    );
    expect(verifier?.subject).toBe("REQ-1.AC-1");
    await engine.settle();
    await h.release();
  });
  it("restarts a base-fail check that never concluded, from QA's saved result", async () => {
    const h = createHarness();
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    const release = h.gates.hold();
    const qa = only(actions, "qa");
    writeFile(worktreeOf(h, "T-1"), "tests/acceptance/t-1.test.ts", "test\n");
    await submitResult(h, qa, {
      exit: "done",
      acceptance_tests: ["[REQ-1.AC-1] works"],
      artifacts: [{ type: "acceptance_test", path: "tests/acceptance/t-1.test.ts" }],
    });
    const old = h.engine;
    const engine = h.reopen();
    release();
    await old.settle();
    await engine.settle();
    expect(
      h.gates.requests.filter((r) => r.reason === "base_fail_check").map((r) => r.tests),
    ).toEqual([["[REQ-1.AC-1] works"], ["[REQ-1.AC-1] works"]]);
    expect(engine.status({}).tasks_by_status).toEqual({ tests_authored: 1 });
    expect(spawns((await engine.next({}, CLAUDE)).actions).map((a) => a.role)).toEqual([
      "engineer",
    ]);
    await engine.settle();
    await h.release();
  });
  it("a gate_infra park retried by the human runs the gates again", async () => {
    const h = createHarness();
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    await authorTests(h, only(actions, "qa"));
    h.gates.queue("round", "infra");
    await build(h, only(await next(h), "engineer"));
    expect(h.engine.status({}).parked).toEqual([{ task: "T-1", reason: "gate_infra" }]);
    await h.engine.answer(
      { escalation: "E-1", answer: { option: "retry", who_should_have_caught: "none" } },
      CLAUDE,
    );
    await h.engine.settle();
    expect(only(await next(h), "spec_verifier").subject).toBe("REQ-1.AC-1");
    await h.release();
  });
});

describe("out-of-scope faults (§6.3 step 3)", () => {
  it("guards a claim (outside scope, reproduces on the base, one per round) and opens a task for it", async () => {
    const h = createHarness({ files: { "lib/shared.ts": "export const broken = true;\n" } });
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    await authorTests(h, only(actions, "qa"));
    const engineer = only(await next(h), "engineer");
    const inside = await submitResult(h, engineer, {
      exit: "out_of_scope_fault",
      fault: {
        path: "src/t-1/impl.ts",
        line: 1,
        evidence: { type: "file_line", ref: "src/t-1/impl.ts:1" },
        detail: "x",
      },
    });
    expect(inside).toMatchObject({ accepted: false, rejection: { reason: "claim_check" } });
    const again = only(inside.actions, "engineer");
    h.gates.queue("fault_repro", "fail");
    const claim = await submitResult(h, again, {
      exit: "out_of_scope_fault",
      fault: {
        path: "lib/shared.ts",
        line: 1,
        evidence: { type: "file_line", ref: "lib/shared.ts:1" },
        detail: "the shared helper is broken",
      },
    });
    expect(claim.accepted).toBe(true);
    const status = h.engine.status({});
    expect(status.features[0]?.tasks).toEqual(["T-1", "T-2"]);
    const created = JSON.parse(
      log(h)
        .split("\n")
        .filter((l) => l.includes('"task.created"'))
        .at(-1) ?? "{}",
    ) as { data: { task: { origin: string; files_scope: string[]; source_finding?: string } } };
    expect(created.data.task).toMatchObject({ origin: "out_of_scope", files_scope: ["lib/**"] });
    expect(h.gates.requests.find((r) => r.reason === "fault_repro")).toMatchObject({
      head: h.gates.requests.find((r) => r.reason === "fault_repro")?.base,
    });
    expect(log(h)).toContain('"route":"out_of_scope"');
    await h.release();
  });
});

describe("contract-first starts (§6.6)", () => {
  it("a consumer waits for the provider's contract.frozen, not its merge", async () => {
    const h = createHarness();
    const actions = await throughPlan(h, [
      draft("T-1", {
        files_scope: ["api/**", "src/t-1/**"],
        provides_contract: { kind: "openapi", path: "api/openapi.yaml" },
      }),
      draft("T-2", {
        covers: ["REQ-2"],
        files_scope: ["web/**"],
        consumes_contracts: [{ provider: "T-1", kind: "openapi", path: "api/openapi.yaml" }],
      }),
    ]);
    expect(spawns(actions).map((a) => a.task)).toEqual(["T-1"]);
    expect(h.engine.status({}).tasks_by_status).toMatchObject({ waiting_dependency: 1 });
    await authorTests(h, only(actions, "qa"));
    const engineer = only(await next(h), "engineer");
    writeFile(worktreeOf(h, "T-1"), "api/openapi.yaml", "openapi: 3.1.0\n");
    await build(h, engineer);
    expect(log(h)).toContain('"type":"contract.frozen"');
    const status = h.engine.status({});
    expect(status.tasks_by_status).toMatchObject({ verifying: 1, ready: 1 });
    const later = await next(h);
    expect(
      spawns(later)
        .map((a) => `${a.role}:${a.task ?? ""}`)
        .sort(),
    ).toEqual(["qa:T-2", "spec_verifier:T-1"]);
    await h.release();
  });
});

describe("questions, plans and the design phase", () => {
  it("QA's spec question becomes a non-blocking spec_question escalation", async () => {
    const h = createHarness();
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    const qa = only(actions, "qa");
    writeFile(worktreeOf(h, "T-1"), "tests/acceptance/t-1.test.ts", "test\n");
    await submitResult(h, qa, {
      exit: "done",
      acceptance_tests: ["t"],
      artifacts: [{ type: "acceptance_test", path: "tests/acceptance/t-1.test.ts" }],
      questions: [
        {
          question: "Hash with salt?",
          options: [
            { id: "yes", label: "Yes", effect: "clarify" },
            { id: "no", label: "No", effect: "clarify" },
          ],
          recommended: "yes",
          evidence: [{ type: "spec_ref", ref: "REQ-1.AC-1" }],
        },
      ],
    });
    await h.engine.settle();
    const [question] = h.engine.escalations({}).escalations;
    expect(question).toMatchObject({
      reason: "spec_question",
      raised_by: "qa",
      blocks: [],
      task: "T-1",
    });
    expect(spawns(await next(h)).map((a) => a.role)).toEqual(["engineer"]);
    await h.engine.answer(
      { escalation: question?.id ?? "", answer: { option: "yes", who_should_have_caught: "ba" } },
      CLAUDE,
    );
    expect(h.engine.escalations({}).escalations).toEqual([]);
    await h.release();
  });
  it("rejects a plan that leaves a REQ uncovered and re-dispatches the Planner with the issues", async () => {
    const h = createHarness();
    const planner = await toPlanner(h, SPEC);
    const rejected = await submitResult(h, planner, {
      exit: "done",
      tasks: [draft("T-1")] as never,
    });
    expect(rejected).toMatchObject({
      accepted: false,
      rejection: { reason: "claim_check", issues: ["REQ-2 is not covered by any task"] },
    });
    expect(only(rejected.actions, "planner").prompt).toContain("REQ-2 is not covered by any task");
    expect(h.engine.status({}).run.phase).toBe("plan");
    await h.release();
  });
  it("adds the SEC-n requirements of the threat model G2 froze: the plan must cover them (§6.1)", async () => {
    const h = createHarness();
    const threats = [
      "# Threat model",
      "",
      "| Threat | Mitigation |",
      "| --- | --- |",
      "| token replay | SEC-1 |",
      "",
      "## SEC-n",
      "",
      "- SEC-1: A reset token expires 15 minutes after it is issued.",
      "- SEC-1.AC-1: Given a token issued 16 minutes ago When it is submitted Then the reset is refused.",
      "",
    ].join("\n");
    const planner = await toPlanner(h, SPEC_ONE, { threats });
    const rejected = await submitResult(h, planner, {
      exit: "done",
      tasks: [draft("T-1")] as never,
    });
    expect(rejected).toMatchObject({
      accepted: false,
      rejection: { reason: "claim_check", issues: ["SEC-1 is not covered by any task"] },
    });
    const again = only(rejected.actions, "planner");
    const accepted = await submitResult(h, again, {
      exit: "done",
      tasks: [draft("T-1", { covers: ["REQ-1", "SEC-1"] })] as never,
    });
    expect(accepted.accepted).toBe(true);
    await h.release();
  });
  it("a run with UI dispatches the Architect and the Designer and shows both at G2", async () => {
    const h = createHarness();
    await h.engine.start(
      {
        request: "Signup page",
        track: "quick_fix",
        repo: "existing",
        has_ui: true,
        risk_hints: [],
      },
      CLAUDE,
    );
    const ba = only(await next(h), "ba");
    writeFile(workdir(ba), ".vtc/spec/spec.md", SPEC_ONE);
    const design = await submitResult(h, ba, {
      exit: "done",
      artifacts: [{ type: "spec", path: ".vtc/spec/spec.md" }],
    });
    // §6.1 DESIGN: the Architect, Security's threat model and the Designer, in parallel (two at
    // a time: the default concurrency)
    expect(spawns(design.actions).map((a) => a.role)).toEqual(["architect", "security"]);
    const [architect, security] = spawns(design.actions);
    expect(security?.mode).toBe("design");
    const designer = only(await threatModel(h, security!), "designer");
    writeFile(workdir(architect!), ".vtc/architecture/spine.md", "# spine\n");
    writeFile(workdir(designer), ".vtc/design/flows.mmd", "flowchart LR\n");
    // a UI design needs its screens: without them the coverage loop sends the Designer back (H-13)
    writeFile(
      workdir(designer),
      ".vtc/design/screens.yaml",
      "version: 1\nscreens:\n  - id: signup\n    route: /signup\n    states: [empty]\n    reqs: [REQ-1]\n",
    );
    // the Designer's pack carries its dealt constraints (§9.1 step 2), the Architect's its depth
    expect(readFileSync(join(h.repo, designer.pack), "utf8")).toContain("design constraints:");
    expect(readFileSync(join(h.repo, architect!.pack), "utf8")).toContain("architect depth: S");
    await submitResult(h, architect!, {
      exit: "done",
      artifacts: [{ type: "architecture", path: ".vtc/architecture/spine.md" }],
    });
    const gate = (
      await submitResult(h, designer, {
        exit: "done",
        artifacts: [
          { type: "design_flows", path: ".vtc/design/flows.mmd" },
          { type: "screens", path: ".vtc/design/screens.yaml" },
        ],
      })
    ).actions.find((a) => a.type === "approve_gate");
    expect(gate).toMatchObject({ gates: ["G1", "G2"] });
    if (gate?.type === "approve_gate")
      expect(gate.artifacts.map((a) => a.path).sort()).toEqual([
        ".vtc/architecture/spine.md",
        ".vtc/architecture/threat-model/model.md",
        ".vtc/design/flows.mmd",
        ".vtc/design/screens.yaml",
        ".vtc/spec/spec.md",
      ]);
    await h.release();
  });
});

describe("redaction of git-tracked projections (AD-18) and plugin-only dispatch (AD-17)", () => {
  it("redacts the request, plan files and evidence bundles; never starts a HeadlessRun", async () => {
    const h = createHarness({ files: { ".env": "STRIPE_SECRET=sk_live_abcdefghijklmnop1234\n" } });
    const token = `ghp_${"a1B2".repeat(9)}`;
    await h.engine.start(
      {
        request: `Fix login\n\nToken ${token} and sk_live_abcdefghijklmnop1234 leaked`,
        track: "feature",
        repo: "existing",
        has_ui: false,
        risk_hints: [],
      },
      CLAUDE,
    );
    const run = h.engine.status({}).run.id;
    const request = readFileSync(join(h.repo, `.vtc/runs/${run}/request.md`), "utf8");
    expect(request).not.toContain(token);
    expect(request).not.toContain("sk_live_abcdefghijklmnop1234");
    expect(log(h, run)).not.toContain(token);
    await h.engine.settle();
    await h.release();

    const g = createHarness();
    const actions = await throughPlan(g, [draft("T-1")], SPEC_ONE);
    await authorTests(g, only(actions, "qa"));
    await build(g, only(await next(g), "engineer"));
    await verdictPass(g, only(await next(g), "spec_verifier"), "src/t-1/impl.ts");
    await g.engine.settle();
    const bundle = EvidenceBundleSchema.parse(
      JSON.parse(readFileSync(join(g.repo, ".vtc/evidence/T-1/bundle.json"), "utf8")),
    );
    expect(bundle).toMatchObject({
      kind: "task",
      task: "T-1",
      rounds: 1,
      cap: 4,
      traceability: { gaps: ["REQ-1"] },
    });
    const plan = readFileSync(join(g.repo, ".vtc/tasks/T-1.md"), "utf8");
    expect(plan).toMatch(/^---\nid: T-1\n/);
    expect(plan).toContain("## Change log");
    expect(g.spawned).toEqual([]);
    writeFileSync(join(g.repo, ".vtc/tasks/T-1.md"), "tampered");
    expect(g.reopen().status({ run: g.engine.status({}).run.id }).tasks_by_status).toEqual(
      g.engine.status({}).tasks_by_status,
    );
    await g.release();
  });
});

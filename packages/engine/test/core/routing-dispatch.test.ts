/**
 * D-cm wired into dispatch (H-9; spine §5 reading 218): the Engineer, QA author and the reviewers
 * start on the routed tier, escalate and drop from it, and every `role.dispatched` records the tier
 * and why; the task view repeats it (`RoleRunSummary`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EVENT_PAYLOAD_SCHEMAS, type HostOutcome, type LeadAction } from "@vtc/shared";
import { loadRuns, resolveModel, taskDetailView } from "../../src/core/index.js";
import { ALL_FIXTURE_ROLES } from "../fixtures/roles.js";
import { cleanupDirs, writeFile } from "../helpers/repo.js";
import {
  authorTests,
  build,
  CLAUDE,
  createHarness,
  draft,
  only,
  submitResult,
  throughPlan,
  toolFinding,
  worktreeOf,
  spawns,
  SPEC_ONE,
  type Harness,
  type HarnessOptions,
  type HeadlessScript,
  type SpawnAction,
} from "../helpers/engine-harness.js";

// whole engine flows on a real repo: room on a loaded machine, as the other flow tests have
vi.setConfig({ testTimeout: 60_000 });
afterEach(cleanupDirs);

const next = async (h: Harness): Promise<LeadAction[]> => (await h.engine.next({}, CLAUDE)).actions;

interface Dispatched {
  role: string;
  task?: string;
  model: string;
  data: { tier?: string; tier_reason?: string; tier_clamped?: boolean; mode?: string };
}
const dispatched = (h: Harness): Dispatched[] =>
  readFileSync(join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/events.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Dispatched & { type: string })
    .filter((e) => e.type === "role.dispatched");
const tierOf = (d: Dispatched) => ({
  model: d.model,
  tier: d.data.tier,
  reason: d.data.tier_reason,
  clamped: d.data.tier_clamped,
});

const toQa = async (
  drafts: ReturnType<typeof draft>[],
  options: HarnessOptions = {},
): Promise<{ h: Harness; qa: SpawnAction }> => {
  const h = createHarness(options);
  const actions = await throughPlan(h, drafts, SPEC_ONE);
  return { h, qa: only(actions, "qa") };
};

describe("the routed start tier on dispatch (D-cm)", () => {
  it("starts an S task's Engineer on Low and keeps QA author on Mid", async () => {
    const { h, qa } = await toQa([draft("T-1", { size: "S", risk: "low" })]);
    await authorTests(h, qa);
    const engineer = only(await next(h), "engineer");
    expect(engineer.model).toBe("haiku");
    const [ba] = dispatched(h).filter((d) => d.role === "ba");
    const qaRun = dispatched(h).find((d) => d.role === "qa");
    const eng = dispatched(h).find((d) => d.role === "engineer");
    // a role the rule does not route keeps its role.yaml tier
    expect(tierOf(ba!)).toEqual({ model: "opus", tier: "top", reason: "role", clamped: false });
    expect(tierOf(qaRun!)).toEqual({ model: "sonnet", tier: "mid", reason: "rule", clamped: true });
    expect(tierOf(eng!)).toEqual({ model: "haiku", tier: "low", reason: "rule", clamped: false });
    // every dispatch logs both tier fields, and the log parses
    for (const d of dispatched(h)) {
      expect(d.data.tier).toBeDefined();
      expect(EVENT_PAYLOAD_SCHEMAS["role.dispatched"].safeParse(d.data).success).toBe(true);
    }
    // the task view repeats them
    const [run] = loadRuns(h.repo);
    const detail = taskDetailView(run!.state, "T-1");
    expect(detail?.role_runs.find((r) => r.role === "engineer")).toMatchObject({
      tier: "low",
      tier_reason: "rule",
      tier_clamped: false,
    });
    await h.release();
  });

  it("lets the Planner's hint replace the rule: an L task hinted Mid starts on Mid", async () => {
    const { h, qa } = await toQa([
      draft("T-1", {
        size: "L",
        risk: "low",
        tier_hint: { tier: "mid", reason: "well_specified" },
      }),
    ]);
    await authorTests(h, qa);
    only(await next(h), "engineer");
    expect(tierOf(dispatched(h).find((d) => d.role === "engineer")!)).toEqual({
      model: "sonnet",
      tier: "mid",
      reason: "planner_hint",
      clamped: false,
    });
    await h.release();
  });

  it("never lets a hint start a high-risk task's Engineer or Security reviewer below Top", async () => {
    const { h, qa } = await toQa([
      draft("T-1", {
        size: "S",
        risk: "low",
        risk_tags: ["auth"],
        tier_hint: { tier: "low", reason: "mechanical" },
      }),
    ]);
    await authorTests(h, qa);
    await build(h, only(await next(h), "engineer"));
    only(await next(h), "security");
    const top = { model: "opus", tier: "top", reason: "planner_hint", clamped: true };
    expect(tierOf(dispatched(h).find((d) => d.role === "engineer")!)).toEqual(top);
    const security = dispatched(h).find((d) => d.role === "security" && d.data.mode === "verify");
    expect(tierOf(security!)).toEqual(top);
    await h.release();
  });

  it("starts a task with a high-risk tag on Top, whatever its size", async () => {
    const { h, qa } = await toQa([draft("T-1", { size: "S", risk: "low", risk_tags: ["auth"] })]);
    await authorTests(h, qa);
    expect(only(await next(h), "engineer").model).toBe("opus");
    expect(tierOf(dispatched(h).find((d) => d.role === "engineer")!)).toEqual({
      model: "opus",
      tier: "top",
      reason: "rule",
      clamped: false,
    });
    await h.release();
  });

  it("holds every tier inside routing.min_tier / max_tier and says so", async () => {
    const { h, qa } = await toQa([draft("T-1", { size: "L", risk: "low" })], {
      project: { routing: { max_tier: "mid" } },
    });
    await authorTests(h, qa);
    only(await next(h), "engineer");
    expect(tierOf(dispatched(h).find((d) => d.role === "engineer")!)).toEqual({
      model: "sonnet",
      tier: "mid",
      reason: "rule",
      clamped: true,
    });
    // the BA (role tier top) is clamped too
    expect(tierOf(dispatched(h).find((d) => d.role === "ba")!)).toMatchObject({
      tier: "mid",
      reason: "role",
      clamped: true,
    });
    await h.release();
  });

  it("uses each role's own tier under routing.start: role", async () => {
    const { h, qa } = await toQa([draft("T-1", { size: "S", risk: "low" })], {
      project: { routing: { start: "role" } },
    });
    await authorTests(h, qa);
    only(await next(h), "engineer");
    expect(tierOf(dispatched(h).find((d) => d.role === "engineer")!)).toEqual({
      model: "sonnet",
      tier: "mid",
      reason: "role",
      clamped: false,
    });
    await h.release();
  });

  /** `failed` (default 2) failed rounds of an S task, then the Engineer's next dispatch. */
  const escalated = async (project: Record<string, unknown>, failed = 2): Promise<Dispatched[]> => {
    const { h, qa } = await toQa([draft("T-1", { size: "S", risk: "low" })], { project });
    await authorTests(h, qa);
    let engineer = only(await next(h), "engineer");
    // each round fixes some findings and keeps one fewer open, so the task is never stuck
    const rounds = Array.from({ length: failed }, (_v, i) => ({
      fail: Array.from({ length: failed - i }, (_w, j) =>
        toolFinding(`f${String(i)}-${String(j)}`, "medium"),
      ),
    }));
    h.gates.queue("round", ...rounds);
    for (let round = 1; round <= failed; round++) {
      writeFile(worktreeOf(h, "T-1"), `src/t-1/r${String(round)}.ts`, `export const r = 1;\n`);
      expect((await submitResult(h, engineer, { exit: "built" })).accepted).toBe(true);
      await h.engine.settle();
      engineer = only(await next(h), "engineer");
    }
    const engineers = dispatched(h).filter((d) => d.role === "engineer");
    await h.release();
    return engineers;
  };

  it("escalates a Low start to Mid after 2 failed rounds", async () => {
    const engineers = await escalated({});
    expect(engineers.slice(0, 2).map((d) => d.data.tier_reason)).toEqual(["rule", "rule"]);
    expect(tierOf(engineers.at(-1)!)).toEqual({
      model: "sonnet",
      tier: "mid",
      reason: "escalation",
      clamped: false,
    });
  });

  it("escalates a Low start to Mid, then Top after 2 further failed rounds", async () => {
    const engineers = await escalated({ caps: { low: 5 } }, 4);
    expect(engineers.map((d) => [d.data.tier, d.data.tier_reason])).toEqual([
      ["low", "rule"],
      ["low", "rule"],
      ["mid", "escalation"],
      ["mid", "escalation"],
      ["top", "escalation"],
    ]);
    expect(tierOf(engineers.at(-1)!)).toEqual({
      model: "opus",
      tier: "top",
      reason: "escalation",
      clamped: false,
    });
  });

  it("clamps the escalation to routing.max_tier", async () => {
    const engineers = await escalated({ routing: { max_tier: "low" } });
    expect(tierOf(engineers.at(-1)!)).toEqual({
      model: "haiku",
      tier: "low",
      reason: "escalation",
      clamped: true,
    });
  });

  it("drops a reviewer one tier from its routed tier past the reviewers' share", async () => {
    const spec = [
      "# Password reset",
      "",
      "## REQ-1 Reset token store",
      "",
      "- REQ-1.AC-1: Given a reset request When a token is issued Then only its hash is stored.",
      "- REQ-1.AC-2: Given a stored token When it is read Then it is never logged.",
      "",
    ].join("\n");
    const h = createHarness({
      project: { concurrency: 1, budgets: { task_usd: { S: 1, M: 1, L: 1 } } },
    });
    const actions = await throughPlan(h, [draft("T-1", { size: "L", risk: "low" })], spec);
    await authorTests(h, only(actions, "qa"));
    await build(h, only(await next(h), "engineer"));
    const first = only(await next(h), "spec_verifier");
    const out = await submitResult(
      h,
      first,
      {
        exit: "done",
        verdicts: [
          {
            subject: first.subject ?? "",
            verdict: "pass",
            evidence: [{ type: "file_line", ref: "src/t-1/impl.ts:1" }],
          },
        ],
      },
      0.3,
    );
    expect(only(out.actions, "spec_verifier").subject).not.toBe(first.subject);
    const reviewers = dispatched(h).filter((d) => d.role === "spec_verifier");
    expect(reviewers.map(tierOf)).toEqual([
      { model: "opus", tier: "top", reason: "rule", clamped: false },
      { model: "sonnet", tier: "mid", reason: "budget_drop", clamped: false },
    ]);
    await h.release();
  });
});

describe("the reviewers' routed tiers in a whole flow (D-cm)", () => {
  /** The cross-family QA judge's headless run: it passes the task. */
  const crossJudge: HeadlessScript = (request): HostOutcome => ({
    kind: "done",
    session_ref: null,
    output: {
      role: "qa",
      mode: "judge",
      task: "T-1",
      summary: "reviewed",
      exit: "done",
      verdicts: [
        {
          subject: "T-1",
          verdict: "pass",
          evidence: [{ type: "file_line", ref: "src/t-1/impl.ts:1" }],
        },
      ],
    },
    model: request.model.model ?? null,
    tokens: null,
    cost_usd: 0.2,
  });

  it("routes the QA judge and the cross-family reviewer of a high-risk task on Top by the rule, the latter on its own host", async () => {
    const h = createHarness({
      project: {
        merge_level: 1,
        concurrency: 3,
        hosts: { dispatch: "headless_allowed", cross_family_review: true },
      },
      codex: { headless: crossJudge },
    });
    const actions = await throughPlan(h, [draft("T-1", { risk: "high" })], SPEC_ONE);
    await authorTests(h, only(actions, "qa"));
    await build(h, only(await next(h), "engineer"));
    const reviews = spawns(await next(h));
    expect(reviews.map((r) => `${r.role}/${r.mode ?? ""}`)).toContain("qa/judge");
    // the cross-family reviewer is the other family's, launched headless on Codex
    expect(h.launched.map((l) => [l.host, l.request.role, l.request.mode])).toEqual([
      ["codex", "qa", "judge"],
    ]);
    const judges = dispatched(h).filter((d) => d.role === "qa" && d.data.mode === "judge");
    expect(judges).toHaveLength(2);
    for (const d of judges)
      expect(d.data).toMatchObject({ tier: "top", tier_reason: "rule", tier_clamped: false });
    // and the model is each host's own for Top
    expect(h.launched[0]?.request.model.tier).toBe("top");
    await h.engine.settle();
    await h.release();
  });

  it("drops a reviewer one tier at 70% of the task budget, inside its share", async () => {
    const h = createHarness({
      project: { concurrency: 1, budgets: { task_usd: { S: 1, M: 1, L: 1 } } },
    });
    const actions = await throughPlan(h, [draft("T-1", { size: "L", risk: "low" })], SPEC_ONE);
    await authorTests(h, only(actions, "qa"));
    // QA author $0.10 and the Engineer $0.65: 75% of the $1 budget, no reviewer spend yet
    const engineer = only(await next(h), "engineer");
    writeFile(worktreeOf(h, "T-1"), "src/t-1/impl.ts", "export const x = 1;\n");
    expect((await submitResult(h, engineer, { exit: "built" }, 0.65)).accepted).toBe(true);
    await h.engine.settle();
    only(await next(h), "spec_verifier");
    const [reviewer] = dispatched(h).filter((d) => d.role === "spec_verifier");
    // the L task's rule tier is Top: the drop takes it to Mid
    expect(tierOf(reviewer!)).toEqual({
      model: "sonnet",
      tier: "mid",
      reason: "budget_drop",
      clamped: false,
    });
    await h.release();
  });
});

describe("a tier with a model id keeps the role's effort (D-co, reading 228)", () => {
  it("since the docs' Codex ids, every tier of both hosts names a model and the role's effort holds", () => {
    const engineer = ALL_FIXTURE_ROLES.find((r) => r.id === "engineer")!;
    const config = { hosts: { dispatch: "plugin_only" } } as never;
    expect(resolveModel(engineer, "codex", config, { tier: "top" })).toEqual({
      tier: "top",
      effort: engineer.models.codex.effort,
      model: "gpt-6-astra",
    });
    expect(resolveModel(engineer, "codex", config, { tier: "low" })).toEqual({
      tier: "low",
      effort: engineer.models.codex.effort,
      model: "gpt-6-luna",
    });
    expect(resolveModel(engineer, "claude-code", config, { tier: "top" })).toEqual({
      tier: "top",
      effort: engineer.models["claude-code"].effort,
      model: "opus",
    });
  });
});

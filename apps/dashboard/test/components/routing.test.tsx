import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { LOOKBACK_REPO, TaskDetailSchema, type RoleRunSummary } from "@vtc/shared";
import { TIER_HINT_REASON_LABELS, TIER_REASON_LABELS } from "@/lib/routing";
import { readFixture } from "../fixtures";
import { jsonArtifact, ROUTING_SCORECARD } from "../dev-samples";
import { renderApp, screen, waitFor, within } from "./render";

/**
 * Round 5 (contracts 5.4.0): the tier each role run started on and why on the task view (H-9,
 * D-cm; spine §5 reading 218(6)), and the routing scorecard on the Lookback view (D-cn; reading
 * 219), which routing PRs capture as chart evidence in `?evidence=upstream`.
 */
const TASK_ROUTE = "/api/runs/golden-1/tasks/T-2";
const ARTIFACTS_ROUTE = "/api/runs/golden-1/artifacts";

const notFound = () =>
  Response.json({ error: { code: "not_found", message: "no artifact" } }, { status: 404 });

/** The golden T-2 with role runs (from the golden T-1's) and a Planner hint, as 5.4.0 serves it. */
const routedTask = () => {
  const t2 = TaskDetailSchema.parse(readFixture("task-T-2"));
  // the golden run is routed since engine core's 5.4.0 log; drop its tier so each case sets its own
  const [golden] = TaskDetailSchema.parse(readFixture("task-T-1")).role_runs;
  const { tier: _tier, tier_reason: _reason, tier_clamped: _clamped, ...run } = golden!;
  const runs: Partial<RoleRunSummary>[] = [
    { action_id: "a-1", tier: "low", tier_reason: "planner_hint" },
    { action_id: "a-2", tier: "mid", tier_reason: "escalation", tier_clamped: true },
    { action_id: "a-3" },
    { action_id: "a-4", role: "spec_verifier", tier: "mid", tier_reason: "budget_drop" },
    {
      action_id: "a-5",
      role: "qa",
      mode: "author",
      tier: "mid",
      tier_reason: "rule",
      tier_clamped: true,
    },
  ];
  return TaskDetailSchema.parse({
    ...t2,
    task: {
      ...t2.task,
      tier_hint: {
        tier: "low",
        reason: "well_specified",
        detail: "The endpoint and its tests are spelled out in the plan.",
      },
    },
    role_runs: runs.map((r, i) => ({
      ...run,
      dispatched_at: `2026-10-13T09:1${String(i)}:00.000Z`,
      ...r,
    })),
  });
};

describe("task view: the starting tier of each role run (H-9, D-cm)", () => {
  it("shows each routed run's tier and why, the clamp, and the Planner's hint", async () => {
    renderApp("/task/?run=golden-1&task=T-2", {
      [TASK_ROUTE]: () => Response.json(routedTask()),
    });
    const routing = await screen.findByRole("region", { name: "Model routing" });
    const hint = within(routing).getByTestId("tier-hint");
    expect(hint).toHaveTextContent("Low");
    expect(hint).toHaveTextContent("well_specified");
    expect(hint).toHaveTextContent(TIER_HINT_REASON_LABELS.well_specified);
    expect(hint).toHaveTextContent("The endpoint and its tests are spelled out in the plan.");
    const runs = within(routing).getByRole("list", { name: "Role runs and their tier" });
    const items = within(runs).getAllByRole("listitem");
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent("a-1");
    expect(items[0]).toHaveTextContent(TIER_REASON_LABELS.planner_hint);
    expect(items[0]).not.toHaveTextContent("clamped");
    expect(items[1]).toHaveTextContent("Mid");
    expect(items[1]).toHaveTextContent(TIER_REASON_LABELS.escalation);
    expect(items[1]).toHaveTextContent("clamped by project routing (min_tier / max_tier)");
    expect(items[2]).toHaveTextContent("spec_verifier");
    expect(items[2]).toHaveTextContent(TIER_REASON_LABELS.budget_drop);
    expect(items[2]).not.toHaveTextContent("clamped");
    // QA author lifted to its Mid floor: the floor is named, not only project routing
    expect(items[3]).toHaveTextContent("qa (author)");
    expect(items[3]).toHaveTextContent("held at QA author's Mid floor (or by project routing)");
    // a-3 was logged before 5.4.0: no tier, so it is not listed
    expect(runs).not.toHaveTextContent("a-3");
  });

  it("shows the tier in the node drawer's role runs, and nothing for a run without one", async () => {
    const user = userEvent.setup();
    renderApp("/task/?run=golden-1&task=T-2", {
      [TASK_ROUTE]: () => Response.json(routedTask()),
    });
    await screen.findByRole("region", { name: "Model routing" });
    const nodes = await screen.findByRole("list", { name: "Nodes" });
    await user.click(within(nodes).getByRole("button", { name: /^Engineer/ }));
    const drawer = await screen.findByTestId("node-drawer");
    const runs = await within(drawer).findAllByTestId(/^role-run-/);
    expect(runs.map((r) => r.dataset.testid)).toEqual([
      "role-run-a-1",
      "role-run-a-2",
      "role-run-a-3",
    ]);
    expect(runs[0]).toHaveTextContent(`Started on Low: ${TIER_REASON_LABELS.planner_hint}`);
    expect(runs[1]).toHaveTextContent("clamped by project routing (min_tier / max_tier)");
    expect(runs[2]).not.toHaveTextContent("Started on");
  });

  it("shows no routing section for a task with no hint and no routed run", async () => {
    renderApp("/task/?run=golden-1&task=T-2");
    await screen.findByRole("list", { name: "Nodes" });
    await screen.findByRole("heading", { name: /T-2/ });
    expect(screen.queryByRole("region", { name: "Model routing" })).toBeNull();
  });
});

describe("Lookback view: the routing scorecard (D-cn)", () => {
  it("shows quality with intervals, tokens per success, escalated share and cost per cell", async () => {
    renderApp("/lookback/?run=golden-1");
    const card = await screen.findByTestId("routing-scorecard");
    const table = within(card).getByRole("table", {
      name: "Routing cells of engineer · claude-code",
    });
    const cheap = within(table).getByTestId("routing-cell-S-none-low-rule");
    expect(cheap).toHaveTextContent("71%");
    expect(cheap).toHaveTextContent("45–88%");
    expect(cheap).toHaveTextContent("182,000 tokens");
    expect(cheap).toHaveTextContent("21%");
    expect(cheap).toHaveTextContent("$0.42");
    expect(cheap).toHaveTextContent("14 tasks");
    const large = within(table).getByTestId("routing-cell-L-high-top-rule");
    expect(large).toHaveTextContent("insufficient data");
    expect(large).toHaveTextContent(/not read yet/);
    expect(
      within(card).getByRole("table", { name: "Routing cells of qa (author) · codex" }),
    ).toHaveTextContent("unpriced");
    expect(screen.getByRole("link", { name: /routing\.json/ })).toHaveAttribute(
      "href",
      `/artifact/?run=golden-1&path=${encodeURIComponent(LOOKBACK_REPO.routingScorecard)}`,
    );
  });

  it("says when RETRO has not written one yet", async () => {
    renderApp("/lookback/?run=golden-1", { [ARTIFACTS_ROUTE]: notFound });
    expect(await screen.findByText("No routing scorecard yet")).toBeInTheDocument();
  });

  it("refuses one that breaks its contract", async () => {
    renderApp("/lookback/?run=golden-1", {
      [ARTIFACTS_ROUTE]: (_init, url) =>
        new URL(url, "http://127.0.0.1").searchParams.get("path") === LOOKBACK_REPO.routingScorecard
          ? Response.json(
              jsonArtifact(LOOKBACK_REPO.routingScorecard, { ...ROUTING_SCORECARD, v: 3 }),
            )
          : notFound(),
    });
    expect(await screen.findByText(/routing scorecard breaks its contract/)).toBeInTheDocument();
    expect(screen.queryByTestId("routing-scorecard")).toBeNull();
  });

  it("is capturable in upstream evidence mode: the marker shows, and no path", async () => {
    renderApp("/lookback/?run=golden-1&evidence=upstream");
    const card = await screen.findByTestId("routing-scorecard");
    expect(within(card).getByTestId("routing-cell-S-none-low-rule")).toHaveTextContent("71%");
    expect(screen.queryByRole("link", { name: /routing/ })).toBeNull();
    const page = document.body.textContent;
    for (const leak of [".vtc/", "routing.json", "golden-1"])
      expect(page, leak).not.toContain(leak);
  });

  it("shows nothing in upstream evidence mode when there is none", async () => {
    renderApp("/lookback/?run=golden-1&evidence=upstream", { [ARTIFACTS_ROUTE]: notFound });
    await screen.findByRole("heading", { name: "Lookback" });
    await waitFor(() => {
      expect(screen.queryByRole("status", { name: "Loading" })).toBeNull();
    });
    expect(screen.queryByText("No routing scorecard yet")).toBeNull();
    expect(screen.queryByTestId("routing-scorecard")).toBeNull();
  });

  it("renders the routing scorecard in the artifact view", async () => {
    renderApp(`/artifact/?run=golden-1&path=${encodeURIComponent(LOOKBACK_REPO.routingScorecard)}`);
    const card = await screen.findByTestId("routing-scorecard");
    expect(within(card).getByTestId("routing-cell-M-tagged-mid-rule")).toHaveTextContent(
      "11 tasks",
    );
    expect(screen.getByText("Raw JSON")).toBeInTheDocument();
  });
});

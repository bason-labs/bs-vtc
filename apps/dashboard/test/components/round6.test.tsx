import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  AutomationReportSchema,
  DESIGN_COVERAGE_LOOP,
  TaskDetailSchema,
  type VtcEvent,
} from "@vtc/shared";
import { PARTIAL_EVIDENCE_REASONS } from "@/lib/automation";
import { readFixture } from "../fixtures";
import {
  firstSample,
  goldenPageWithSamples,
  HEADLESS_VARIANTS,
  SAMPLE_RUN,
  sampleEvent,
  samplePage,
  variant,
} from "../golden-samples";
import { renderApp, screen, within } from "./render";

/**
 * Round 6 (contracts 5.7.0): the G2 coverage loop before G2 (H-13; spine §5 reading 237), why an
 * automatic PR's evidence is partial (D-ct), an unpriced run's cost (H-12; reading 236) and a
 * dispatch that fell back to the host's default model (D-cx; reading 244).
 */
const MAX = DESIGN_COVERAGE_LOOP.maxRounds;
const SAMPLE_EVENTS_ROUTE = `/api/runs/${SAMPLE_RUN}/events`;
const sampleEvents = (events: readonly VtcEvent[]) => ({
  [SAMPLE_EVENTS_ROUTE]: () => Response.json(samplePage(events)),
});

const complete = {
  reqs_without_component: [],
  reqs_without_screen: [],
  screens_without_req: [],
  components_unregistered: [],
  ok: true,
};
const gaps = {
  ...complete,
  reqs_without_component: ["REQ-5"],
  reqs_without_screen: ["REQ-4"],
  ok: false,
};
const check = (seq: number, data: Record<string, unknown>) =>
  sampleEvent(seq, "design.coverage_checked", { max_rounds: MAX, ...data });
const fixing = check(40, {
  check: 1,
  report: gaps,
  outcome: "fixing",
  redispatched: ["architect", "designer"],
});
const parked = check(41, {
  check: 2,
  report: { ...gaps, reqs_without_screen: [] },
  outcome: "parked",
  park_reason: "stuck",
  escalation: "E-4",
});
const done = check(42, { check: 2, report: complete, outcome: "complete" });
const started = firstSample("run.started");

describe("Gates view: the G2 coverage loop (H-13)", () => {
  it("shows a fixing check with its round, the roles re-dispatched and the gaps", async () => {
    renderApp(`/gates/?run=${SAMPLE_RUN}`, sampleEvents([started, fixing]));
    const card = await screen.findByTestId("coverage-loop");
    expect(within(card).getByRole("heading", { name: "Design coverage before G2" })).toBeVisible();
    expect(card).toHaveTextContent(`Check 1 found gaps: fix round 1 of ${String(MAX)} is running`);
    expect(card).toHaveTextContent("Fixing gaps");
    expect(card).toHaveTextContent("Architect, Designer");
    expect(
      within(card).getByRole("list", { name: "Requirements no AD or component names" }),
    ).toHaveTextContent("REQ-5");
    expect(
      within(card).getByRole("list", { name: "UI requirements with no screen" }),
    ).toHaveTextContent("REQ-4");
    // No G2 yet, and nothing to approve.
    expect(screen.getByText("No gate requested yet")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /approve/i })).toBeNull();
  });

  it("names the park reason, the uncovered REQs and links the escalation when it parks", async () => {
    renderApp(`/gates/?run=${SAMPLE_RUN}`, sampleEvents([started, fixing, parked]));
    const card = await screen.findByTestId("coverage-loop");
    const alert = within(card).getByRole("alert");
    expect(alert).toHaveTextContent(
      "The run parked before G2: stuck: the same gaps remained after a fix round",
    );
    expect(alert).toHaveTextContent("Uncovered: REQ-5");
    expect(alert).toHaveTextContent("change the spec (the run goes back to G1)");
    expect(alert).toHaveTextContent("tell the Architect what to do");
    expect(within(alert).getByRole("link", { name: "Escalation E-4" })).toHaveAttribute(
      "href",
      `/escalations/?run=${SAMPLE_RUN}`,
    );
    const history = within(card).getByRole("list", { name: "Coverage checks" });
    expect(within(history).getAllByRole("listitem")).toHaveLength(2);
  });

  it("shows G2 after a complete check", async () => {
    const g2 = variant(firstSample("gate.requested"), 50);
    renderApp(`/gates/?run=${SAMPLE_RUN}`, sampleEvents([started, fixing, done, g2]));
    const card = await screen.findByTestId("coverage-loop");
    expect(card).toHaveTextContent("Check 2: every requirement is covered, so G2 follows");
    expect(card).toHaveTextContent("Complete");
    expect(await screen.findByTestId("gate-request-50")).toHaveTextContent(
      "Waiting for approval in the Lead chat",
    );
  });
});

describe("Run view: the coverage loop until it completes (H-13)", () => {
  it("shows the loop above the graph while it fixes or parks, and no G2 waiting", async () => {
    renderApp("/run/?run=golden-1", {
      "/api/runs/golden-1/events": () => Response.json(goldenPageWithSamples([], [fixing, parked])),
    });
    const loop = await screen.findByRole("status", { name: "Design coverage loop" });
    expect(loop).toHaveTextContent("Parked");
    expect(within(loop).getByRole("link", { name: "See the coverage check" })).toHaveAttribute(
      "href",
      "/gates/?run=golden-1",
    );
    expect(within(loop).getByRole("link", { name: "Escalation E-4" })).toBeInTheDocument();
    expect(screen.queryByRole("status", { name: "Gate waiting" })).toBeNull();
  });

  it("stops showing a parked loop once the human answered its escalation", async () => {
    const answered = sampleEvent(43, "escalation.answered", {
      escalation: "E-4",
      answer: {
        option: "instruct_architect",
        text: "Map REQ-5 to AD-3",
        who_should_have_caught: "architect",
      },
    });
    renderApp("/run/?run=golden-1", {
      "/api/runs/golden-1/events": () =>
        Response.json(goldenPageWithSamples([], [fixing, parked, answered, ...HEADLESS_VARIANTS])),
    });
    await screen.findByRole("list", { name: "Headless runs" });
    expect(screen.queryByRole("status", { name: "Design coverage loop" })).toBeNull();
  });

  it("shows nothing once coverage is complete", async () => {
    renderApp("/run/?run=golden-1", {
      "/api/runs/golden-1/events": () =>
        Response.json(goldenPageWithSamples([], [fixing, done, ...HEADLESS_VARIANTS])),
    });
    await screen.findByRole("list", { name: "Headless runs" });
    expect(screen.queryByRole("status", { name: "Design coverage loop" })).toBeNull();
  });
});

describe("Automation view: why a PR's evidence is partial (D-ct)", () => {
  it("shows AutomationItem.pr.partial_reason on the PR row", async () => {
    const report = AutomationReportSchema.parse(readFixture("automation"));
    const item = report.items.find((i) => i.pr !== null)!;
    renderApp("/automation/", {
      "/api/automation": () =>
        Response.json({
          ...report,
          items: [
            {
              ...item,
              pr: { ...item.pr!, evidence: "partial", partial_reason: "no_ffmpeg" },
            },
          ],
        }),
    });
    const row = await screen.findByTestId(`automation-item-${item.fingerprint}`);
    expect(row).toHaveTextContent("evidence partial");
    expect(within(row).getByTestId("partial-reason")).toHaveTextContent(
      `Evidence partial: ${PARTIAL_EVIDENCE_REASONS.no_ffmpeg}`,
    );
  });
});

describe("Role runs: an unpriced model's cost (H-12) and a model fallback (D-cx)", () => {
  const ROLE = {
    actor: "role" as const,
    role: "engineer" as const,
    task: "T-2",
    prompt_sha: "4".repeat(64),
    host: "codex" as const,
    model: "gpt-6.1-sol",
  };
  const fallback = sampleEvent(
    60,
    "role.dispatched",
    {
      action_id: "a-2",
      dispatch: "headless",
      agent: "vtc-engineer",
      pack: ".vtc/state/packs/a-2.md",
      resume: null,
      model_fallback: { requested: "gpt-6-astra", reason: "model_refused" },
    },
    { ...ROLE, actor: "engine" },
  );
  const unpriced = sampleEvent(
    61,
    "role.submitted",
    {
      action_id: "a-2",
      exit: "built",
      findings: 0,
      questions: 0,
      session_ref: null,
      head: "b".repeat(40),
      budget_usd: 0.84,
    },
    { ...ROLE, tokens: { in: 9000, out: 800, cache_r: 0, cache_w: 0 }, cost_usd: null },
  );

  it("shows them in the task's node drawer", async () => {
    const user = userEvent.setup();
    const t2 = TaskDetailSchema.parse(readFixture("task-T-2"));
    const [golden] = TaskDetailSchema.parse(readFixture("task-T-1")).role_runs;
    renderApp("/task/?run=golden-1&task=T-2", {
      "/api/runs/golden-1/tasks/T-2": () =>
        Response.json({
          ...t2,
          role_runs: [golden, { ...golden!, action_id: "a-2", host: "codex", model: "codex" }],
        }),
      "/api/runs/golden-1/events": () =>
        Response.json(goldenPageWithSamples([], [fallback, unpriced])),
    });
    const nodes = await screen.findByRole("list", { name: "Nodes" });
    await user.click(within(nodes).getByRole("button", { name: /^Engineer/ }));
    const drawer = await screen.findByTestId("node-drawer");
    const priced = await within(drawer).findByTestId("role-run-a-1");
    expect(await within(priced).findByTestId("run-cost")).toHaveTextContent("$1.20");
    const run = within(drawer).getByTestId("role-run-a-2");
    expect(within(run).getByTestId("run-cost")).toHaveTextContent(
      "Cost unknown · counted as $0.84 toward the budget",
    );
    expect(within(run).getByTestId("run-fallback")).toHaveTextContent(
      "The host refused gpt-6-astra; ran on the host default",
    );
  });

  it("shows them on the engine-launched runs, and a refused model is no failure", async () => {
    const start = variant(firstSample("headless.started"), 62, { action_id: "a-2" });
    const refused = variant(firstSample("headless.ended"), 63, {
      action_id: "a-1",
      outcome: "error",
      cause: "model_refused",
      exit_code: 1,
      duration_ms: 2_000,
    });
    const refusedStart = variant(firstSample("headless.started"), 59, { action_id: "a-1" });
    renderApp("/run/?run=golden-1", {
      "/api/runs/golden-1/events": () =>
        Response.json(
          goldenPageWithSamples([], [refusedStart, fallback, unpriced, start, refused]),
        ),
    });
    const runs = await screen.findByRole("list", { name: "Headless runs" });
    const row = within(runs).getByTestId("headless-a-2");
    expect(row).toHaveTextContent("Cost unknown · counted as $0.84 toward the budget");
    expect(row).toHaveTextContent("The host refused gpt-6-astra; ran on the host default");
    expect(within(runs).getByTestId("headless-a-1")).toHaveTextContent(
      "Model refused: dispatched again on the host default",
    );
  });
});

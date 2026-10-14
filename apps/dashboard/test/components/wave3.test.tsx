import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { readFixture } from "../fixtures";
import {
  eventPageWithWave3,
  FACTS_JSONL,
  jsonArtifact,
  pngArtifact,
  SCORECARD_INDEX,
  SHA,
  VISUAL_REPORT_PATH,
  w3Event,
} from "../wave3-fixtures";
import { artifactContent } from "../../scripts/dev-fixtures.ts";
import { renderApp, screen, within } from "./render";

const withEvents = {
  "/api/runs/golden-1/events": () => Response.json(eventPageWithWave3()),
};

const notFound = () =>
  Response.json({ error: { code: "not_found", message: "no artifact" } }, { status: 404 });

/** Answers the artifacts route from `files` (by `?path=`), 404 for anything else. */
const artifacts =
  (files: Record<string, unknown>) =>
  (_init: RequestInit | undefined, url: string): Response => {
    const path = new URL(url, "http://127.0.0.1").searchParams.get("path") ?? "";
    const file = files[path];
    return file === undefined ? notFound() : Response.json(file);
  };

describe("Gates view (gate.requested: G2 directions, unverified facts, design coverage)", () => {
  it("shows what G2 asked and what the human decided", async () => {
    const firstViewport = ".vtc/design/prototype/calm-ledger/first-viewport.png";
    renderApp("/gates/?run=golden-1", {
      ...withEvents,
      "/api/runs/golden-1/artifacts": artifacts({ [firstViewport]: pngArtifact(firstViewport) }),
    });
    const card = await screen.findByTestId("gate-request-60");
    expect(within(card).getByRole("heading", { name: "G2" })).toBeInTheDocument();
    expect(within(card).getByText("Approved")).toBeInTheDocument();
    const chosen = within(card).getByTestId("direction-calm-ledger");
    expect(within(chosen).getByText("Chosen")).toBeInTheDocument();
    expect(within(chosen).getByText("Novel")).toBeInTheDocument();
    const img = await within(chosen).findByRole("img", { name: "First viewport of Calm ledger" });
    expect(img.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
    const other = within(card).getByTestId("direction-night-shift");
    expect(within(other).getByText("Too similar to a past direction")).toBeInTheDocument();
    // No prototype origin in snapshot mode: the path is shown, not a link.
    expect(
      within(other).getByText(".vtc/design/prototype/night-shift/index.html"),
    ).toBeInTheDocument();
    const fact = within(card).getByTestId("fact-f-fedcba9876543210");
    expect(fact).toHaveTextContent("nodejs@22 · eol_date");
    expect(fact).toHaveTextContent("Stale");
    expect(fact).toHaveTextContent("Waived: EOL date checked by hand");
    expect(within(card).getByText("REQ-4 has no screen")).toBeInTheDocument();
    expect(within(card).getByText("Component date-picker is not registered")).toBeInTheDocument();
  });

  it("shows a direction's prototype only in the sandboxed frame, never in a tab of its own", async () => {
    const user = userEvent.setup();
    renderApp("/gates/?run=golden-1", {
      ...withEvents,
      "/api/health": () =>
        Response.json({
          ...(readFixture("health") as object),
          mode: "live",
          prototype_url: "http://127.0.0.1:4311/",
        }),
    });
    const other = await screen.findByTestId("direction-night-shift");
    expect(within(other).queryByRole("link")).toBeNull();
    await user.click(await within(other).findByRole("button", { name: "Show the prototype" }));
    const iframe = within(other).getByTitle<HTMLIFrameElement>("Prototype of Night shift");
    expect(iframe.getAttribute("sandbox")).toBe("allow-scripts");
    expect(iframe.getAttribute("src")).toBe("http://127.0.0.1:4311/night-shift/index.html");
    expect(iframe).toHaveAttribute("referrerpolicy", "no-referrer");
  });

  it("says so when no gate was requested", async () => {
    renderApp("/gates/?run=golden-1");
    expect(await screen.findByText("No gate requested yet")).toBeInTheDocument();
  });
});

describe("Run view (pending gate, engine-launched runs)", () => {
  it("shows a gate waiting in the Lead chat and the headless runs", async () => {
    const page = eventPageWithWave3() as { events: { type: string }[] };
    // Drop the decision so G2 is still pending.
    const pending = {
      ...page,
      events: page.events.filter((e) => e.type !== "gate.approved"),
    };
    const status = readFixture("status") as Record<string, unknown>;
    renderApp("/run/?run=golden-1", {
      "/api/runs/golden-1/events": () => Response.json(pending),
      "/api/status": () =>
        Response.json({
          ...status,
          headless_runs: [
            {
              action_id: "a-20",
              role: "architect",
              host: "claude-code",
              pid: 77,
              started_at: "2026-10-13T12:00:00.000Z",
            },
            {
              action_id: "a-13",
              role: "qa",
              host: "codex",
              pid: null,
              started_at: "2026-10-13T11:15:00.000Z",
            },
          ],
        }),
    });
    const gate = await screen.findByRole("status", { name: "Gate waiting" });
    expect(gate).toHaveTextContent("G2 is waiting for approval in the Lead chat");
    expect(gate).toHaveTextContent(
      "2 design directions · 2 unverified facts to waive with a reason",
    );
    expect(within(gate).getByRole("link", { name: "See what G2 shows" })).toHaveAttribute(
      "href",
      "/gates/?run=golden-1",
    );
    const runs = await screen.findByRole("list", { name: "Headless runs" });
    expect(within(runs).getByTestId("headless-a-20")).toHaveTextContent("architect on claude-code");
    expect(within(runs).getByTestId("headless-a-12")).toHaveTextContent(
      "Error: no output (idle timeout)",
    );
    expect(within(runs).getByTestId("headless-a-13")).toHaveTextContent("Running");
    const notices = await screen.findByRole("list", { name: "Run notices" });
    expect(notices).toHaveTextContent("Level 3 is not available: this run merges at Level 2");
    expect(notices).toHaveTextContent("Auto-resume on codex did not start");
  });

  it("stops showing live states once the run finished", async () => {
    const page = eventPageWithWave3() as { events: { type: string; seq: number }[] };
    const last = page.events.reduce((n, e) => Math.max(n, e.seq), 0);
    const finished = w3Event(last + 1, "run.finished", { outcome: "aborted" });
    renderApp("/run/?run=golden-1", {
      "/api/runs/golden-1/events": () =>
        Response.json({
          ...page,
          events: [...page.events.filter((e) => e.type !== "gate.approved"), finished],
        }),
    });
    const runs = await screen.findByRole("list", { name: "Headless runs" });
    expect(within(runs).getByTestId("headless-a-13")).toHaveTextContent("Did not finish");
    expect(screen.queryByRole("status", { name: "Gate waiting" })).toBeNull();
  });

  it("says when the event log is longer than the dashboard reads", async () => {
    const page = eventPageWithWave3() as { events: { seq: number }[] };
    const limits = new Set<string | null>();
    renderApp("/run/?run=golden-1", {
      // Every page answers "more after": the reader stops at its page cap and says so.
      "/api/runs/golden-1/events": (_init: RequestInit | undefined, url: string) => {
        const query = new URL(url, "http://127.0.0.1").searchParams;
        limits.add(query.get("limit"));
        const after = Number(query.get("after"));
        return Response.json({
          ...page,
          events: after === 0 ? page.events : [],
          next_after: after + 1,
        });
      },
    });
    expect(await screen.findByTestId("event-log-truncated")).toHaveTextContent(
      "The newest events are not shown",
    );
    expect([...limits]).toEqual(["2000"]);
  });

  it("shows neither when the run has none", async () => {
    renderApp("/run/?run=golden-1");
    await screen.findByRole("list", { name: "Nodes" });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("status", { name: "Gate waiting" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Headless runs" })).toBeNull();
  });
});

describe("Feature view (Level 3 and Final Review steps)", () => {
  const features = readFixture("features") as { features: Record<string, unknown>[] };
  const withPr = {
    ...features,
    features: features.features.map((f) => ({
      ...f,
      pr: {
        url: "https://github.com/o/r/pull/7",
        draft: false,
        state: "open",
        head_sha: SHA("b"),
        ci: "pending",
        number: 7,
        auto_merge: "awaiting_checks",
        required_checks: [{ name: "ci / test", state: "pending" }],
        merge_state_status: "BLOCKED",
      },
    })),
  };

  it("shows the checklist, the auto-merge timeline, the steps and the PR's Level-3 state", async () => {
    renderApp("/feature/?run=golden-1&feature=F-1", {
      ...withEvents,
      "/api/runs/golden-1/features": () => Response.json(withPr),
    });
    const level3 = await screen.findByTestId("level3");
    expect(level3).toHaveTextContent("Configured 3, running at 2");
    expect(level3).toHaveTextContent("Add at least one required status check");
    expect(within(level3).getByTestId("check-final_review")).toHaveTextContent("does not hold");
    expect(within(level3).getByTestId("check-remote_ci")).toHaveTextContent("(holds)");
    const timeline = within(level3).getByRole("list", { name: "Auto-merge timeline" });
    expect(within(timeline).getAllByRole("listitem")[0]).toHaveTextContent(
      "Merge reverted on the base branch",
    );
    const steps = screen.getByRole("list", { name: "Final Review steps" });
    expect(within(steps).getByTestId("fr-step-5")).toHaveTextContent("Not passed: skipped");
    expect(within(steps).getByTestId("fr-step-2")).toHaveTextContent("Not passed: unchecked");
    expect(within(steps).getByTestId("fr-step-3")).toHaveTextContent("Not reported yet");
    const pr = screen.getByTestId("pull-request");
    expect(pr).toHaveTextContent("Awaiting required checks");
    expect(pr).toHaveTextContent("PR #7");
    expect(pr).toHaveTextContent("BLOCKED");
    expect(within(pr).getByRole("list", { name: "Required checks" })).toHaveTextContent(
      "ci / test",
    );
  });

  it("shows no Level-3 card for a run that never asked for Level 3", async () => {
    renderApp("/feature/?run=golden-1&feature=F-1");
    await screen.findByRole("heading", { name: "Password reset" });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId("level3")).toBeNull();
    expect(screen.queryByRole("list", { name: "Final Review steps" })).toBeNull();
  });
});

describe("Research view (facts.jsonl)", () => {
  it("lists the current facts, what needs attention first, with waivers from G2", async () => {
    renderApp("/research/?run=golden-1", withEvents);
    const list = await screen.findByRole("list", { name: "Facts" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((i) => i.dataset.testid)).toEqual([
      "fact-f-2222222222222222",
      "fact-f-fedcba9876543210",
      "fact-f-1111111111111111",
    ]);
    expect(items[0]).toHaveTextContent("No source");
    expect(items[1]).toHaveTextContent("Waived at G2: EOL date checked by hand");
    expect(within(items[2]!).getByRole("link", { name: /registry\.npmjs\.org/ })).toHaveAttribute(
      "href",
      "https://registry.npmjs.org/react",
    );
    expect(items[2]).toHaveTextContent("replaces 1 earlier row");
  });

  it("reports lines it cannot read, and says when there are no facts", async () => {
    renderApp("/research/?run=golden-1", {
      "/api/runs/golden-1/artifacts": () =>
        Response.json(
          artifactContent("golden-1", ".vtc/research/facts.jsonl", `${FACTS_JSONL}oops\n`),
        ),
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Line 5 of the file is not a fact");
  });

  it("shows an empty state when nothing was researched", async () => {
    renderApp("/research/?run=golden-1", { "/api/runs/golden-1/artifacts": notFound });
    expect(await screen.findByText("No research facts yet")).toBeInTheDocument();
  });
});

describe("Lookback view (scorecards and lookback events)", () => {
  it("shows each role's latest scorecard with n and intervals, insufficient data as such", async () => {
    renderApp("/lookback/?run=golden-1", withEvents);
    const group = await screen.findByTestId("scorecard-group-engineer|claude-code");
    const table = await within(group).findByRole("table", {
      name: "Metrics of engineer on claude-code",
    });
    const gate = within(table).getByTestId("metric-first_round_gate_pass");
    expect(gate).toHaveTextContent("63%");
    expect(gate).toHaveTextContent("40–81%");
    expect(gate).toHaveTextContent("24");
    const review = within(table).getByTestId("metric-review_pass");
    expect(review).toHaveTextContent("insufficient data");
    expect(review).toHaveTextContent("4 (needs 10)");
    const breakdown = within(group).getByRole("table", {
      name: "Metrics for frontend · nextjs · claude-code",
    });
    expect(breakdown).toHaveTextContent("insufficient data");
    // The qa scorecard the index names is missing from the dev fixtures.
    const qa = screen.getByTestId("scorecard-group-qa|codex");
    expect(await within(qa).findByText(/no such item/)).toBeInTheDocument();
    const canaries = screen.getByRole("list", { name: "Canaries" });
    expect(canaries).toHaveTextContent("Rollback");
    const events = screen.getByRole("list", { name: "Lookback events" });
    expect(events).toHaveTextContent("Replay of engineer-p1: inconclusive, not an improvement");
  });

  it("refuses an index that breaks its contract and shows an empty state without one", async () => {
    renderApp("/lookback/?run=golden-1", {
      "/api/runs/golden-1/artifacts": artifacts({
        ".vtc/lookback/scorecards/index.json": jsonArtifact(".vtc/lookback/scorecards/index.json", {
          ...SCORECARD_INDEX,
          v: 9,
        }),
      }),
    });
    expect(await screen.findByText("The scorecard index breaks its contract")).toBeInTheDocument();
  });

  it("shows an empty state when no scorecard was written", async () => {
    renderApp("/lookback/?run=golden-1", { "/api/runs/golden-1/artifacts": notFound });
    expect(await screen.findByText("No scorecards yet")).toBeInTheDocument();
  });
});

describe("Artifact view (visual QA evidence, screenshots, scorecards)", () => {
  it("renders a visual report as its render matrix, axe results and diffs", async () => {
    renderApp(`/artifact/?run=golden-1&path=${encodeURIComponent(VISUAL_REPORT_PATH)}`);
    const report = await screen.findByTestId("visual-report");
    expect(within(report).getAllByText("Not passed: unchecked").length).toBeGreaterThan(0);
    const matrix = within(report).getByRole("table", { name: "Render matrix" });
    expect(within(matrix).getByTestId("render-login:error:390:light")).toHaveTextContent(
      "Unreached",
    );
    expect(within(matrix).getByTestId("render-login:default:390:light")).toHaveTextContent(
      "1 diff over budget",
    );
    expect(
      within(within(matrix).getByTestId("render-login:default:390:light")).getByRole("link", {
        name: "screenshot",
      }),
    ).toHaveAttribute(
      "href",
      "/artifact/?run=golden-1&path=.vtc%2Fevidence%2FT-1%2Fvisual%2Flogin-default-390-light.png",
    );
    expect(within(report).getByRole("list", { name: "Axe results" })).toHaveTextContent(
      "needs review",
    );
    expect(within(report).getByText("Over budget")).toBeInTheDocument();
    expect(screen.getByText("Raw JSON")).toBeInTheDocument();
  });

  it("shows a screenshot as an image", async () => {
    renderApp(
      "/artifact/?run=golden-1&path=.vtc%2Fevidence%2FT-1%2Fvisual%2Flogin-default-390-light.png",
    );
    const img = await screen.findByRole("img");
    expect(img.getAttribute("src")).toMatch(/^data:image\/png;base64,/);
  });

  it("renders a scorecard file", async () => {
    renderApp(
      `/artifact/?run=golden-1&path=${encodeURIComponent(SCORECARD_INDEX.scorecards[0]!.path)}`,
    );
    expect(await screen.findByTestId("scorecard")).toHaveTextContent("insufficient data");
  });
});

describe("Run navigation", () => {
  it("links the run's gates, research and lookback pages", async () => {
    renderApp("/gates/?run=golden-1");
    const nav = await screen.findByRole("navigation", { name: "Run golden-1" });
    expect(within(nav).getByRole("link", { name: "Gates" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("link", { name: "Research" })).toHaveAttribute(
      "href",
      "/research/?run=golden-1",
    );
    expect(within(nav).getByRole("link", { name: "Lookback" })).toHaveAttribute(
      "href",
      "/lookback/?run=golden-1",
    );
  });
});

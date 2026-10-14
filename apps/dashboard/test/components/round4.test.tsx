import { API_KEY_BILLING_WARNING, EventSchema, PROVIDER_BILLING_NOTICE } from "@vtc/shared";
import { describe, expect, it } from "vitest";
import { readFixture } from "../fixtures";
import { firstSample, SAMPLE_RUN, SAMPLE_USAGE, sampleEvent, variant } from "../golden-samples";
import { renderApp, screen, within } from "./render";

/**
 * Round 4 (contracts 5.0.0): provider billing (D-ci), the Lookback replay's grader and the D-cb
 * promotion path.
 */
const usageWith = (billing: Record<string, unknown>) => () =>
  Response.json({
    ...SAMPLE_USAGE,
    hosts: SAMPLE_USAGE.hosts.map((h) =>
      Object.hasOwn(billing, h.host) ? { ...h, billing: billing[h.host] } : h,
    ),
  });

describe("Provider billing (D-ci, spine §5 reading 203)", () => {
  it("shows the provider notice verbatim as a neutral note, not a warning", async () => {
    renderApp("/usage/", { "/api/usage": usageWith({ "claude-code": "provider" }) });
    const claude = await screen.findByTestId("usage-claude-code");
    const note = within(claude).getByRole("note", { name: "Billing" });
    expect(note).toHaveTextContent(PROVIDER_BILLING_NOTICE);
    expect(note).toHaveAttribute("data-tone", "neutral");
    expect(note.className).not.toMatch(/warn/);
    // The golden usage sample's Codex login is an API key: that one stays a warning.
    const codex = within(screen.getByTestId("usage-codex")).getByRole("note", { name: "Billing" });
    expect(codex).toHaveTextContent(API_KEY_BILLING_WARNING);
    expect(codex).toHaveAttribute("data-tone", "warn");
  });

  it("lists it as a neutral item in the run's notices", async () => {
    renderApp("/run/?run=golden-1", { "/api/usage": usageWith({ "claude-code": "provider" }) });
    const list = await screen.findByRole("list", { name: "Run notices" });
    const item = within(list).getByTestId("billing-claude-code");
    expect(item).toHaveTextContent(PROVIDER_BILLING_NOTICE);
    expect(item).not.toHaveTextContent("API-key billing");
  });
});

describe("Lookback after round 4 (D-cb, D-cg, D-ch)", () => {
  it("shows the replay's grader and arms from the recorded replay result", async () => {
    renderApp(`/lookback/?run=${SAMPLE_RUN}`);
    const replay = await screen.findByTestId("replay");
    expect(within(replay).getByRole("note", { name: "Grader" })).toHaveTextContent(
      "Graded by the gates",
    );
    const arms = within(replay).getByRole("table", { name: "Arms per replayed task" });
    expect(arms).toHaveTextContent("golden-1:T-1");
    expect(arms).toHaveTextContent("1/3 passed");
    expect(replay).toHaveTextContent("2 of 2 discordant tasks favour the candidate (p = 0.25)");
  });

  it("no longer says a Claude-led run cannot start a canary", async () => {
    renderApp(`/lookback/?run=${SAMPLE_RUN}`);
    await screen.findByTestId("replay");
    expect(screen.queryByTestId("lookback-no-canary")).toBeNull();
    expect(screen.queryByText(/from a Claude-led run/)).toBeNull();
    expect(
      screen.getByText(/merging the pull request VTC opens to its own repo/),
    ).toBeInTheDocument();
  });

  it("renders a replay result in the artifact view with its grader", async () => {
    renderApp(`/artifact/?run=${SAMPLE_RUN}&path=.vtc/lookback/replays/p-engineer-1.json`);
    const replay = await screen.findByTestId("replay");
    expect(replay).toHaveTextContent("Graded by the gates");
    expect(screen.getByText("Raw JSON")).toBeInTheDocument();
  });
});

describe("Replay trials are not the run's work (reading 177)", () => {
  const page = readFixture("events") as { run: string; events: unknown[]; next_after: null };
  const golden = page.events.map((e) => EventSchema.parse(e));
  const dispatched = golden.find((e) => e.type === "role.dispatched")!;
  const run = { run: dispatched.run };
  const trial = [
    variant(
      dispatched,
      100,
      {
        action_id: "a-90",
        dispatch: "headless",
        purpose: "lookback_replay",
        replay: { proposal: "p-engineer-1", task: "golden-1:T-1", arm: "b", trial: 1 },
      },
      { task: undefined },
    ),
    variant(
      firstSample("headless.started"),
      101,
      { action_id: "a-90" },
      { ...run, task: undefined },
    ),
    variant(
      firstSample("headless.ended"),
      102,
      { action_id: "a-90", outcome: "error", cause: "idle" },
      { ...run, task: undefined },
    ),
  ];
  const own = variant(firstSample("headless.started"), 103, { action_id: "a-91" }, run);

  it("leaves a trial's headless run and its failure out of the run view", async () => {
    renderApp("/run/?run=golden-1", {
      "/api/runs/golden-1/events": () =>
        Response.json({ ...page, events: [...page.events, ...trial, own] }),
    });
    const list = await screen.findByRole("list", { name: "Headless runs" });
    expect(within(list).getByTestId("headless-a-91")).toBeInTheDocument();
    expect(within(list).queryByTestId("headless-a-90")).toBeNull();
    expect(screen.queryByText(/run a-90 ended/)).toBeNull();
  });
});

describe("Automation view (D-ca, AD-27 rule 7)", () => {
  it("reads GET /api/automation and shows the switches, notes, items and skips", async () => {
    const app = renderApp("/automation/");
    const items = await screen.findByRole("list", { name: "Automatic issues and PRs" });
    expect(
      app.requests.some((r) => new URL(r.url, "http://x").pathname === "/api/automation"),
    ).toBe(true);
    expect(screen.getByRole("heading", { name: "Automation is on" })).toBeInTheDocument();
    expect(screen.getByTestId("switch-upstream")).toHaveTextContent(
      "Reports to bason-labs/bs-vtc: on",
    );
    expect(screen.getByRole("list", { name: "Automation notes" })).toHaveTextContent(
      "ffmpeg is not installed",
    );
    const ci = within(items).getByTestId("automation-item-1a2b3c4d5e6f7081");
    expect(within(ci).getByRole("link", { name: /Issue #41/ })).toHaveAttribute(
      "href",
      "https://github.com/example-org/golden-app/issues/41",
    );
    expect(within(ci).getByRole("link", { name: /PR #42/ })).toHaveAttribute("target", "_blank");
    expect(ci).toHaveTextContent("draft");
    expect(ci).toHaveTextContent("evidence complete");
    const lookback = within(items).getByTestId("automation-item-9f8e7d6c5b4a3921");
    expect(lookback).toHaveTextContent("evidence partial");
    expect(lookback).toHaveTextContent("VTC · bason-labs/bs-vtc");
    const skipped = screen.getByRole("list", { name: "Skipped automatic actions" });
    expect(skipped).toHaveTextContent("a VTC rate limit was reached");
    expect(skipped).toHaveTextContent("the privacy check refused the content");
  });

  it("says when automation is off, with the note that says why", async () => {
    renderApp("/automation/", {
      "/api/automation": () =>
        Response.json({
          ...(readFixture("automation") as object),
          issues: false,
          prs: false,
          notes: ["this project has no GitHub remote, so automation is off"],
          items: [],
          skipped: [],
        }),
    });
    expect(
      await screen.findByRole("heading", { name: "Automation is off for this project" }),
    ).toBeInTheDocument();
    expect(screen.getByText(/no GitHub remote/)).toBeInTheDocument();
    expect(screen.getByText("Nothing opened yet")).toBeInTheDocument();
  });

  it("shows an older engine's missing route as such", async () => {
    renderApp("/automation/", {
      "/api/automation": () =>
        Response.json({ error: { code: "not_found", message: "no route" } }, { status: 404 }),
    });
    expect(await screen.findByText("No automation report")).toBeInTheDocument();
  });

  it("is linked from the main navigation", async () => {
    renderApp("/usage/");
    const nav = await screen.findByRole("navigation", { name: "Main" });
    expect(within(nav).getByRole("link", { name: "Automation" })).toHaveAttribute(
      "href",
      "/automation/",
    );
  });

  it("surfaces automatic issues, PRs and skips in the run's notices", async () => {
    const target = { kind: "project", repo: "example-org/golden-app" } as const;
    const ref = { target, kind: "parked", fingerprint: "aabbccddeeff0011" } as const;
    const events = [
      sampleEvent(60, "upstream.issue_opened", {
        ...ref,
        number: 38,
        url: "https://github.com/example-org/golden-app/issues/38",
      }),
      sampleEvent(61, "upstream.pr_opened", {
        ...ref,
        number: 39,
        url: "https://github.com/example-org/golden-app/pull/39",
        branch: "vtc/auto/parked/aabbccdd",
        issue: 38,
        evidence: "complete",
      }),
      sampleEvent(62, "automation.skipped", {
        reason: "gh_unavailable",
        detail: "gh auth status: not logged in",
      }),
    ];
    const page = readFixture("events") as { run: string; events: unknown[] };
    renderApp("/run/?run=golden-1", {
      "/api/runs/golden-1/events": () =>
        Response.json({
          ...page,
          events: [...page.events, ...events.map((e) => ({ ...e, run: page.run }))],
        }),
    });
    const list = await screen.findByRole("list", { name: "Run notices" });
    expect(within(list).getByRole("link", { name: /PR #39/ })).toHaveAttribute(
      "href",
      "https://github.com/example-org/golden-app/pull/39",
    );
    expect(list).toHaveTextContent("VTC opened issue #38 in example-org/golden-app");
    expect(list).toHaveTextContent("VTC never merges it");
    expect(list).toHaveTextContent("Why: gh is missing or not logged in.");
  });
});

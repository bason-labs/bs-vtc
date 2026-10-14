import { API_KEY_BILLING_WARNING } from "@vtc/shared";
import { describe, expect, it } from "vitest";
import { readFixture } from "../fixtures";
import { noticeEvent } from "../notice-fixtures";
import { eventPageWithWave3, SHA256, w3Event } from "../wave3-fixtures";
import { renderApp, screen, within } from "./render";

/**
 * The wave-3 closing round's displays (contracts 4.10.0): API-key billing (D-bq), the
 * finish-at-Level-2 answer (D-bd), too few G2 directions (D-bt), a fact's reported source (H-3)
 * and the prompt-selection incidents of spine §5 reading 176.
 */
type Usage = { hosts: Record<string, unknown>[] } & Record<string, unknown>;

const usageWith = (billing: Record<string, unknown>) => () => {
  const usage = readFixture("usage") as Usage;
  return Response.json({
    ...usage,
    hosts: usage.hosts.map((h) =>
      Object.hasOwn(billing, h.host as string) ? { ...h, billing: billing[h.host as string] } : h,
    ),
  });
};

describe("API-key billing (D-bq, spine §5 reading 171)", () => {
  it("shows the warning verbatim on the usage card of an API-key host only", async () => {
    renderApp("/usage/", { "/api/usage": usageWith({ codex: "api_key", "claude-code": null }) });
    const codex = await screen.findByTestId("usage-codex");
    expect(within(codex).getByRole("note", { name: "Billing" })).toHaveTextContent(
      API_KEY_BILLING_WARNING,
    );
    const claude = screen.getByTestId("usage-claude-code");
    expect(within(claude).queryByRole("note", { name: "Billing" })).toBeNull();
    expect(claude).not.toHaveTextContent("API-key billing");
  });

  it("shows nothing for a subscription login or when billing is not reported", async () => {
    renderApp("/usage/", { "/api/usage": usageWith({ codex: "subscription" }) });
    await screen.findByTestId("usage-codex");
    expect(screen.queryByRole("note", { name: "Billing" })).toBeNull();
    expect(screen.queryByText(/API-key billing/)).toBeNull();
  });

  it("shows the warning in the run's notices too", async () => {
    renderApp("/run/?run=golden-1", { "/api/usage": usageWith({ codex: "api_key" }) });
    const list = await screen.findByRole("list", { name: "Run notices" });
    const item = within(list).getByTestId("billing-codex");
    expect(item).toHaveTextContent("Codex");
    expect(item).toHaveTextContent(API_KEY_BILLING_WARNING);
  });

  it("adds no notice when no host uses API-key billing", async () => {
    renderApp("/run/?run=golden-1");
    await screen.findByRole("list", { name: "Nodes" });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("list", { name: "Run notices" })).toBeNull();
  });
});

describe("Prompt-selection incidents (spine §5 readings 137, 176)", () => {
  it("shows that a target could not take a pin in the run's notices", async () => {
    const page = readFixture("events") as { events: unknown[] };
    const incident = noticeEvent(
      55,
      "incident.recorded",
      {
        kind: "prompt_selection",
        detail:
          "qa on claude-code: this target cannot take a pin until its role is switched; the compiled default ran",
      },
      { task: "T-1" },
    );
    renderApp("/run/?run=golden-1", {
      "/api/runs/golden-1/events": () =>
        Response.json({ ...page, events: [...page.events, incident] }),
    });
    const list = await screen.findByRole("list", { name: "Run notices" });
    expect(list).toHaveTextContent("A pinned or canary prompt was not used");
    expect(list).toHaveTextContent("this target cannot take a pin");
  });
});

describe("Escalations: finish at Level 2 (D-bd)", () => {
  it("labels the option's effect by what it does", async () => {
    const list = readFixture("escalations") as { escalations: Record<string, unknown>[] };
    const parked = {
      ...list.escalations[0],
      task: undefined,
      feature: "F-1",
      reason: "blocked",
      question: "F-1 could not auto-merge. Retry, or finish at Level 2?",
      options: [
        { id: "retry", label: "Retry the merge", effect: "retry" },
        { id: "l2", label: "Finish at Level 2", effect: "finish_level_2" },
      ],
      recommended: "l2",
      blocks: [],
    };
    renderApp("/escalations/?run=golden-1", {
      "/api/runs/golden-1/escalations": () => Response.json({ ...list, escalations: [parked] }),
    });
    const card = await screen.findByTestId("escalation-E-1");
    const option = within(card).getByText("Finish at Level 2").closest("li")!;
    expect(option).toHaveTextContent("Finish at Level 2 (leave the PR for review)");
    expect(option).not.toHaveTextContent("finish level 2");
  });
});

describe("G2 with too few design directions (D-bt, spine §5 reading 174)", () => {
  const problem = "1 design direction after the Designer's re-dispatch; G2 needs 2 to 3";
  const request = w3Event(80, "gate.requested", {
    gates: ["G2"],
    artifacts: [{ path: ".vtc/architecture/spine.md", sha256: SHA256("3") }],
    design_coverage: {
      reqs_without_component: [],
      reqs_without_screen: [],
      screens_without_req: [],
      components_unregistered: [],
      directions_problem: problem,
      ok: false,
    },
  });
  const events = () => {
    const page = readFixture("events") as { events: unknown[] };
    return Response.json({ ...page, events: [...page.events, request] });
  };

  it("shows the problem as a blocking notice on the G2 card", async () => {
    renderApp("/gates/?run=golden-1", { "/api/runs/golden-1/events": events });
    const card = await screen.findByTestId("gate-request-80");
    const blocking = within(card).getByRole("alert");
    expect(blocking).toHaveTextContent("G2 cannot be approved");
    expect(blocking).toHaveTextContent(problem);
    // No empty coverage list and no "0 gaps".
    expect(within(card).queryByRole("list", { name: "Design coverage problems" })).toBeNull();
  });

  it("says the waiting gate is blocked in the run's banner", async () => {
    renderApp("/run/?run=golden-1", { "/api/runs/golden-1/events": events });
    const gate = await screen.findByRole("status", { name: "Gate waiting" });
    expect(gate).toHaveTextContent("approval blocked");
    expect(gate).not.toHaveTextContent("coverage gap");
  });
});

describe("Research facts: reported source (H-3, spine §5 reading 156)", () => {
  it("shows where the role found an unverified claim, with its query", async () => {
    renderApp("/research/?run=golden-1", {
      "/api/runs/golden-1/events": () => Response.json(eventPageWithWave3()),
    });
    const item = await screen.findByTestId("fact-f-2222222222222222");
    expect(item).toHaveTextContent("Reported via host search for “vendor-sdk latest version”");
    expect(within(item).getByRole("link", { name: /vendor\.example\.com/ })).toHaveAttribute(
      "href",
      "https://vendor.example.com/sdk/releases",
    );
    expect(item).toHaveTextContent("not verified");
  });
});

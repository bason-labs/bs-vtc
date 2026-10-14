import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { readFixture } from "../fixtures";
import { SAMPLE_RUN } from "../golden-samples";
import { renderApp, screen, waitFor, within, type RenderedApp } from "./render";

/**
 * Evidence mode (`?evidence=1|upstream`, AD-27 rule 6, spine §5 readings 199 and 208): what the
 * evidence recorder captures for an automatic PR.
 */
const withPrototype = () => ({
  "/api/health": () =>
    Response.json({
      ...(readFixture("health") as object),
      mode: "live",
      prototype_url: "http://127.0.0.1:4311/",
    }),
});

/** Every request went to an engine route on the page's own origin. */
const onlyOwnRoutes = (app: RenderedApp): void => {
  expect(app.requests.length).toBeGreaterThan(0);
  for (const r of app.requests) expect(r.url).toMatch(/^\/api\//);
};

const redacted = (el: HTMLElement): boolean => el.closest("[data-vtc-redact]") !== null;

describe("?evidence=1", () => {
  it("marks the page for the recorder and tags file contents for redaction", async () => {
    const app = renderApp("/artifact/?run=golden-1&path=.vtc/spec/spec.md&evidence=1");
    const text = await screen.findByTestId("artifact-text");
    expect(redacted(text)).toBe(true);
    await waitFor(() => {
      expect(document.documentElement.dataset.vtcEvidence).toBe("full");
    });
    onlyOwnRoutes(app);
  });

  it("tags diffs, logs and session ids in the task view", async () => {
    const user = userEvent.setup();
    // The golden run records T-2's pipeline only; T-1 (which has a diff) reuses its shape.
    renderApp("/task/?run=golden-1&task=T-1&evidence=1", {
      "/api/runs/golden-1/graph": () => Response.json(readFixture("graph-task-T-2")),
    });
    const nodes = await screen.findByRole("list", { name: "Nodes" });
    await user.click(within(nodes).getByRole("button", { name: /Engineer/ }));
    const drawer = await screen.findByTestId("node-drawer");
    const files = await within(drawer).findByText("src/t-1/store.ts");
    expect(redacted(files)).toBe(true);
    const patch = drawer.querySelector("pre");
    expect(patch).not.toBeNull();
    expect(redacted(patch!)).toBe(true);
    for (const el of within(drawer).queryAllByText(/^Host /)) expect(redacted(el)).toBe(true);
  });

  it("is read-only and loads nothing from another origin (no prototype, no pin)", async () => {
    const app = renderApp("/design/?run=golden-1&evidence=1", withPrototype());
    expect(await screen.findByTestId("prototype-not-loaded")).toBeInTheDocument();
    expect(document.querySelector("iframe")).toBeNull();
    expect(screen.queryByRole("button", { name: /Add comment/ })).toBeNull();
    expect(app.requests.every((r) => r.method === "GET" || r.url === "/api/session")).toBe(true);
    onlyOwnRoutes(app);
  });

  it("stays on while the recorder navigates", async () => {
    const user = userEvent.setup();
    renderApp("/run/?run=golden-1&evidence=1");
    const nav = await screen.findByRole("navigation", { name: "Run golden-1" });
    await user.click(within(nav).getByRole("link", { name: "Lookback" }));
    expect(window.location.search).toBe("?run=golden-1&evidence=1");
  });

  it("is off without the parameter", async () => {
    renderApp("/run/?run=golden-1");
    await screen.findByRole("list", { name: "Nodes" });
    expect(document.documentElement.dataset.vtcEvidence).toBeUndefined();
  });
});

describe("?evidence=upstream (the upstream-safe projection, D-by)", () => {
  it("shows the flow with role ids and task ordinals, and no title, run id or notice", async () => {
    const app = renderApp("/run/?run=golden-1&zoom=tasks&evidence=upstream");
    const nodes = await screen.findByRole("list", { name: "Nodes" });
    expect(within(nodes).getByText("task 1")).toBeInTheDocument();
    expect(within(nodes).getByText("task 2")).toBeInTheDocument();
    const main = document.getElementById("main")!;
    const page = document.body.textContent ?? "";
    for (const leak of ["golden-1", "Reset token store", "Reset endpoint", "T-1", "T-2"])
      expect(page, leak).not.toContain(leak);
    expect(main.querySelector("[aria-label*='golden-1']")).toBeNull();
    expect(screen.queryByRole("list", { name: "Run notices" })).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Main" })).toBeNull();
    expect(
      app.requests.some((r) => r.url.includes("/escalations") || r.url.includes("/tasks")),
    ).toBe(false);
    onlyOwnRoutes(app);
  });

  it("names a task pipeline's nodes by role id", async () => {
    renderApp("/run/?run=golden-1&evidence=upstream");
    const nodes = await screen.findByRole("list", { name: "Nodes" });
    expect(within(nodes).getByText("intake")).toBeInTheDocument();
    expect(within(nodes).getByText("final_review")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("§");
  });

  it("shows Lookback's scorecards and replay arms with task ordinals, and no path", async () => {
    renderApp(`/lookback/?run=${SAMPLE_RUN}&evidence=upstream`);
    const replay = await screen.findByTestId("replay");
    const arms = within(replay).getByRole("table", { name: "Arms per replayed task" });
    expect(arms).toHaveTextContent("task 1");
    expect(arms).not.toHaveTextContent("golden-1");
    await screen.findByTestId("scorecard-group-engineer|claude-code");
    const page = document.body.textContent ?? "";
    for (const leak of [".vtc/", SAMPLE_RUN, "bbbbbbbb", "scorecard.json"])
      expect(page, leak).not.toContain(leak);
  });

  it("does not show any other view", async () => {
    renderApp("/artifact/?run=golden-1&path=.vtc/spec/spec.md&evidence=upstream");
    expect(await screen.findByText("Not part of the upstream evidence")).toBeInTheDocument();
    expect(screen.queryByTestId("artifact-text")).toBeNull();
    renderApp("/automation/?evidence=upstream");
    expect(await screen.findAllByText("Not part of the upstream evidence")).not.toHaveLength(0);
  });
});

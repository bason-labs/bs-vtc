import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { act, eventLines, openStream, renderApp, screen, within } from "./render";

describe("Flow Studio against the golden run", () => {
  it("lists runs and shows the usage panel with unknown for a host without data", async () => {
    renderApp("/");
    const runs = await screen.findByRole("list", { name: "Runs" });
    expect(within(runs).getByRole("link", { name: /golden-1/ })).toHaveAttribute(
      "href",
      "/run/?run=golden-1",
    );
    const claude = await screen.findByTestId("usage-claude-code");
    expect(within(claude).getByText(/41% used/)).toBeInTheDocument();
    expect(within(claude).getByText(/59% left/)).toBeInTheDocument();
    const codex = screen.getByTestId("usage-codex");
    expect(within(codex).getAllByText("unknown")).toHaveLength(2);
    expect(within(codex).getByText("never updated")).toBeInTheDocument();
    expect(within(codex).queryByText(/0%/)).toBeNull();
    expect(await screen.findByTestId("connection")).toHaveTextContent("Snapshot");
  });

  it("navigates client-side from the runs list to the run's phases", async () => {
    const user = userEvent.setup();
    renderApp("/");
    await user.click(await screen.findByRole("link", { name: /golden-1/ }));
    expect(window.location.pathname).toBe("/run/");
    const nodes = await screen.findByRole("list", { name: "Nodes" });
    const build = within(nodes).getByRole("button", { name: /Build/ });
    expect(build).toHaveTextContent("Running");
    expect(within(nodes).getByRole("button", { name: /Retro/ })).toHaveTextContent("Waiting");
    expect(screen.getByRole("link", { name: "Project phases" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("shows the task DAG and opens the pipeline of a parked task from its drawer", async () => {
    const user = userEvent.setup();
    renderApp("/run/?run=golden-1&zoom=tasks");
    const nodes = await screen.findByRole("list", { name: "Nodes" });
    await user.click(within(nodes).getByRole("button", { name: /T-2 Reset endpoint/ }));
    const drawer = await screen.findByTestId("run-node-drawer");
    expect(within(drawer).getAllByText("Parked: round cap").length).toBeGreaterThan(0);
    expect(window.location.search).toContain("node=t-2");
    await user.click(within(drawer).getByRole("link", { name: /Open pipeline/ }));
    expect(window.location.pathname).toBe("/task/");
    expect(await screen.findByRole("heading", { name: "T-2 Reset endpoint" })).toBeInTheDocument();
  });

  it("drills into a pipeline node: round n/cap, findings, evidence and transcript location", async () => {
    const user = userEvent.setup();
    renderApp("/task/?run=golden-1&task=T-2");
    const nodes = await screen.findByRole("list", { name: "Nodes" });
    expect(within(nodes).getByRole("button", { name: /Round cap/ })).toHaveTextContent(
      "Parked: round cap",
    );
    await user.click(within(nodes).getByRole("button", { name: /Spec-Verifier/ }));
    const drawer = await screen.findByTestId("node-drawer");
    expect(within(drawer).getByText("spec_verifier")).toBeInTheDocument();
    expect(within(drawer).getByText("4/4")).toBeInTheDocument();
    expect(
      await within(drawer).findByText("Expired reset tokens are accepted"),
    ).toBeInTheDocument();
    expect(within(drawer).getByText("file_line: src/t-2/reset.ts:31")).toBeInTheDocument();
    expect(within(drawer).getByText(/does not serve them/)).toBeInTheDocument();
    expect(within(drawer).getByRole("link", { name: /Plan file/ })).toHaveAttribute(
      "href",
      "/artifact/?run=golden-1&path=.vtc%2Ftasks%2FT-2.md",
    );
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("node-drawer")).toBeNull();
    expect(window.location.search).not.toContain("node=");
  });

  it("shows a node's timeline in the drill-down", async () => {
    const user = userEvent.setup();
    renderApp("/task/?run=golden-1&task=T-2");
    const nodes = await screen.findByRole("list", { name: "Nodes" });
    await user.click(within(nodes).getByRole("button", { name: /Round cap/ }));
    const drawer = await screen.findByTestId("node-drawer");
    const timeline = await within(drawer).findByRole("list", { name: "Timeline" });
    expect(within(timeline).getByText("E-1 raised")).toBeInTheDocument();
    expect(timeline.querySelector("time")).toHaveAttribute("datetime", "2026-10-13T09:39:00.000Z");
  });

  it("lists escalations read-only with the recommended option", async () => {
    renderApp("/escalations/?run=golden-1");
    const card = await screen.findByTestId("escalation-E-1");
    expect(within(card).getByRole("heading", { name: /hit its 4-round cap/ })).toBeInTheDocument();
    expect(within(card).getByText("Give the Engineer a hint").parentElement).toHaveTextContent(
      "Recommended",
    );
    expect(within(card).getByText(/Answer it in the Lead chat/)).toBeInTheDocument();
    expect(within(card).queryByRole("button")).toBeNull();
  });

  it("shows the feature's Final Review state and that no PR exists yet", async () => {
    renderApp("/feature/?run=golden-1");
    expect(await screen.findByRole("heading", { name: "Password reset" })).toBeInTheDocument();
    const steps = screen.getByRole("list", { name: "Feature progress" });
    expect(within(steps).getByText("Building").closest("li")).toHaveAttribute(
      "aria-current",
      "step",
    );
    expect(screen.getByText(/Final Review round 0\/3/)).toBeInTheDocument();
    expect(screen.getByText(/No PR yet/)).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "T-2 Reset endpoint" })).toBeInTheDocument();
  });

  it("shows an artifact as plain text", async () => {
    renderApp("/artifact/?run=golden-1&path=.vtc%2Fspec%2Fspec.md");
    expect(await screen.findByTestId("artifact-text")).toHaveTextContent("REQ-1 Reset token store");
  });

  it("refuses to request a path outside .vtc/", async () => {
    const { requests } = renderApp("/artifact/?run=golden-1&path=.vtc%2Fstate%2Fx");
    expect(await screen.findByText("Not a run artifact")).toBeInTheDocument();
    expect(requests.some((r) => r.url.includes("/artifacts"))).toBe(false);
  });

  it("re-reads usage when the live stream reports a usage event", async () => {
    const lines = eventLines();
    let push: ((s: string) => void) | null = null;
    const { requests } = renderApp("/usage/", {
      "/api/health": () =>
        Response.json({
          ok: true,
          mode: "live",
          engine_version: "0.0.0",
          contracts_version: "4.0.0",
          prototype_url: null,
        }),
      "/api/stream": () => {
        const res = openStream();
        const reader = new TransformStream<Uint8Array, Uint8Array>();
        const writer = reader.writable.getWriter();
        push = (s) => void writer.write(new TextEncoder().encode(s));
        return new Response(reader.readable, { headers: res.headers });
      },
    });
    await screen.findByTestId("usage-claude-code");
    expect(await screen.findByTestId("connection")).toHaveTextContent("Live");
    const before = requests.filter((r) => r.url === "/api/usage").length;
    await act(async () => {
      push?.(lines.at(-1) ?? "");
      await new Promise((r) => setTimeout(r, 400));
    });
    expect(requests.filter((r) => r.url === "/api/usage").length).toBe(before + 1);
  });

  it("re-reads health when the Designer submits, so a new prototype origin shows up", async () => {
    const designer = JSON.stringify({
      v: 1,
      seq: 99,
      ts: "2026-10-13T09:20:00.000Z",
      run: "golden-1",
      type: "role.submitted",
      actor: "role",
      role: "designer",
      data: { action_id: "a-9", exit: "done", findings: 0, questions: 0, session_ref: null },
      prompt_sha: "4".repeat(64),
      host: "claude-code",
      model: "claude-sonnet-5",
      tokens: { in: 1, out: 1, cache_r: 0, cache_w: 0 },
      cost_usd: 0.1,
    });
    let push: ((s: string) => void) | null = null;
    const { requests } = renderApp("/usage/", {
      "/api/health": () =>
        Response.json({
          ok: true,
          mode: "live",
          engine_version: "0.0.0",
          contracts_version: "4.0.0",
          prototype_url: null,
        }),
      "/api/stream": () => {
        const res = openStream();
        const reader = new TransformStream<Uint8Array, Uint8Array>();
        const writer = reader.writable.getWriter();
        push = (s) => void writer.write(new TextEncoder().encode(s));
        return new Response(reader.readable, { headers: res.headers });
      },
    });
    await screen.findByTestId("usage-claude-code");
    expect(await screen.findByTestId("connection")).toHaveTextContent("Live");
    const before = requests.filter((r) => r.url === "/api/health").length;
    await act(async () => {
      push?.(`id: golden-1:99\ndata: ${designer}\n\n`);
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(requests.filter((r) => r.url === "/api/health").length).toBe(before + 1);
  });

  it("exchanges the #nonce once, strips it from the URL and sends the session as a bearer", async () => {
    const nonce = "n".repeat(43);
    const session = "s".repeat(43);
    const { requests } = renderApp(`/#nonce=${nonce}`, {
      "/api/session": () => Response.json({ session, expires_at: "2099-01-01T00:00:00.000Z" }),
    });
    await screen.findByRole("list", { name: "Runs" });
    expect(window.location.hash).toBe("");
    const exchange = requests.filter((r) => r.url === "/api/session");
    expect(exchange).toHaveLength(1);
    expect(exchange[0]?.headers.get("authorization")).toBeNull();
    const runs = requests.find((r) => r.url === "/api/runs");
    expect(runs?.headers.get("authorization")).toBe(`Bearer ${session}`);
  });

  it("keeps the exchanged session when StrictMode runs the bootstrap twice", async () => {
    const nonce = "n".repeat(43);
    const session = "s".repeat(43);
    const { requests } = renderApp(
      `/#nonce=${nonce}`,
      {
        "/api/session": () => Response.json({ session, expires_at: "2099-01-01T00:00:00.000Z" }),
      },
      { strict: true },
    );
    await screen.findByRole("list", { name: "Runs" });
    expect(requests.filter((r) => r.url === "/api/session")).toHaveLength(1);
    const runs = requests.filter((r) => r.url === "/api/runs");
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) expect(r.headers.get("authorization")).toBe(`Bearer ${session}`);
  });

  it("tells the viewer to reopen the dashboard when the session is refused, and forgets it", async () => {
    window.sessionStorage.setItem(
      "vtc.session",
      JSON.stringify({ session: "s".repeat(43), expires_at: "2099-01-01T00:00:00.000Z" }),
    );
    renderApp("/", { "/api/runs": () => new Response("{}", { status: 401 }) });
    expect(await screen.findByRole("alert")).toHaveTextContent("vtc dashboard");
    expect(screen.getByTestId("connection")).toHaveTextContent("Session expired");
    expect(window.sessionStorage.getItem("vtc.session")).toBeNull();
  });

  it("shows a not-found view for an unknown page", async () => {
    renderApp("/runs/golden-1");
    expect(await screen.findByText("No such page")).toBeInTheDocument();
  });
});

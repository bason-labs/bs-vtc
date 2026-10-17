import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LOOKBACK_REPO } from "@vtc/shared";
import { FlowStudio } from "@/components/app/FlowStudio";
import { artifactContent } from "../../scripts/dev-fixtures.ts";
import { ROUTING_SCORECARD } from "../dev-samples";
import { openStream } from "./render";

/**
 * The upstream-safe evidence page as the recorder captures it (AD-27 rule 6; spine §5 reading
 * 212(3)): the dashboard rendered against exactly the read routes the engine's evidence snapshot
 * server serves for a bs-vtc PR caused by a project run (`fixtures/upstream-evidence`, which the
 * engine's upstream tests build), at the pages the recorder opens. Every shot's `waitFor` marker
 * shows, so the capture records the scorecard and replay charts, not an empty page.
 */
interface Snapshot {
  readonly run: string;
  readonly pages: readonly string[];
  readonly waitFor: readonly string[];
  readonly routes: Readonly<Record<string, unknown>>;
  readonly events: readonly unknown[];
}

const snapshot = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, "../../../../fixtures/upstream-evidence/snapshot.json"),
    "utf8",
  ),
) as Snapshot;

/** The routing scorecard's route on the snapshot server (D-cn; upstream serves it from round 5). */
const ROUTING_ROUTE = `/api/runs/${snapshot.run}/artifacts?path=${encodeURIComponent(LOOKBACK_REPO.routingScorecard)}`;
const servesRouting = ROUTING_ROUTE in snapshot.routes;

/** The routing scorecard marker a routing PR's chart shot waits for (`RoutingScorecardDetail`). */
const ROUTING_READY = '[data-testid="routing-scorecard"]';

/** The snapshot server's lookup: as asked, then the normalised query, then the path alone. */
const snapshotFetch = (routes: Snapshot["routes"] = snapshot.routes) => {
  const requests: { url: string; status: number }[] = [];
  const impl = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const parsed = new URL(url, "http://127.0.0.1");
    if ((init?.method ?? "GET") === "POST" && parsed.pathname === "/api/session")
      return Promise.resolve(
        Response.json({ session: "s".repeat(43), expires_at: "2030-01-01T00:00:00.000Z" }),
      );
    if (parsed.pathname === "/api/stream") {
      requests.push({ url, status: 200 });
      return Promise.resolve(
        openStream(
          snapshot.events.map((e) => {
            const { run, seq } = e as { run: string; seq: number };
            return `id: ${run}:${String(seq)}\ndata: ${JSON.stringify(e)}\n\n`;
          }),
        ),
      );
    }
    const query = parsed.searchParams.toString();
    const body =
      routes[`${parsed.pathname}${parsed.search}`] ??
      (query === "" ? undefined : routes[`${parsed.pathname}?${query}`]) ??
      routes[parsed.pathname];
    requests.push({ url, status: body === undefined ? 404 : 200 });
    return Promise.resolve(
      body === undefined
        ? Response.json(
            { error: { code: "not_found", message: "not in the evidence snapshot" } },
            { status: 404 },
          )
        : Response.json(body),
    );
  };
  return { fetch: impl, requests };
};

describe("the upstream-safe evidence page against the engine's snapshot routes", () => {
  it.each(snapshot.pages)("%s shows every marker the recorder waits for", async (page) => {
    window.history.replaceState(null, "", page);
    const f = snapshotFetch();
    render(
      <FlowStudio serverPath={new URL(page, "http://127.0.0.1").pathname} fetchImpl={f.fetch} />,
    );
    const replay = await screen.findByTestId("replay");
    const arms = within(replay).getByRole("table", { name: "Arms per replayed task" });
    expect(arms).toHaveTextContent("task 1");
    for (const selector of snapshot.waitFor)
      await waitFor(() => {
        expect(document.querySelector(selector), selector).not.toBeNull();
      });
    expect(screen.queryByText("No run selected")).toBeNull();
    // the Lookback view's own data all came from the snapshot; a snapshot built before the
    // upstream module serves the routing scorecard lacks only that file, and the view shows none
    const lookback = f.requests.filter((r) => r.url.includes(`/api/runs/${snapshot.run}/`));
    expect(lookback.length).toBeGreaterThan(0);
    const routing = encodeURIComponent(LOOKBACK_REPO.routingScorecard);
    expect(
      lookback.filter((r) => r.status !== 200 && (servesRouting || !r.url.includes(routing))),
    ).toEqual([]);
    if (servesRouting) expect(await screen.findByTestId("routing-scorecard")).toBeInTheDocument();
    else expect(screen.queryByText("No routing scorecard yet")).toBeNull();
    const text = document.body.textContent;
    for (const leak of [".vtc/", "scorecard.json", "proposal.json"])
      expect(text, leak).not.toContain(leak);
  });

  it("shows the routing scorecard a routing PR captures once the snapshot serves it", async () => {
    const page = `/lookback/?run=${snapshot.run}&evidence=upstream`;
    window.history.replaceState(null, "", page);
    const routes = {
      ...snapshot.routes,
      [ROUTING_ROUTE]: artifactContent(
        snapshot.run,
        LOOKBACK_REPO.routingScorecard,
        JSON.stringify(ROUTING_SCORECARD, null, 2),
      ),
    };
    const f = snapshotFetch(routes);
    render(<FlowStudio serverPath="/lookback/" fetchImpl={f.fetch} />);
    await waitFor(() => {
      expect(document.querySelector(ROUTING_READY)).not.toBeNull();
    });
    const card = screen.getByTestId("routing-scorecard");
    expect(within(card).getByTestId("routing-cell-S-none-low-rule")).toHaveTextContent("71%");
    const text = document.body.textContent;
    for (const leak of [".vtc/", "routing.json", "scorecard.json"])
      expect(text, leak).not.toContain(leak);
  });
});

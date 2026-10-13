import { describe, expect, it } from "vitest";
import { eventPageWithNotices } from "../notice-fixtures";
import { renderApp, screen, within } from "./render";

const withNotices = {
  "/api/runs/golden-1/events": () => Response.json(eventPageWithNotices()),
};

describe("run notices (typed push, PR, incident and merge-level events)", () => {
  it("shows the run's notices above its graph, newest first", async () => {
    renderApp("/run/?run=golden-1", withNotices);
    const list = await screen.findByRole("list", { name: "Run notices" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((i) => i.dataset.type)).toEqual([
      "incident.recorded",
      "incident.recorded",
      "feature.pr_failed",
      "branch.push_failed",
      "run.merge_level_changed",
    ]);
    expect(items[0]).toHaveTextContent("Unexplained write in the checkout");
    expect(items[0]).toHaveTextContent("file: src/auth/reset.ts");
    expect(items[1]).toHaveTextContent("Config changed during the run");
    expect(items[3]).toHaveTextContent("Push of vtc/F-1 failed");
    expect(items[3]).toHaveTextContent("Resolved");
    expect(items[4]).toHaveTextContent("Merge level lowered from 2 to 1");
    expect(items[4]).toHaveTextContent("no push remote");
    expect(within(items[2]!).getByRole("link", { name: "F-1" })).toHaveAttribute(
      "href",
      "/feature/?run=golden-1&feature=F-1",
    );
  });

  it("shows nothing when the run has no notices", async () => {
    const { requests } = renderApp("/run/?run=golden-1");
    await screen.findByRole("list", { name: "Nodes" });
    await new Promise((r) => setTimeout(r, 50));
    expect(requests.some((r) => r.url.startsWith("/api/runs/golden-1/events"))).toBe(true);
    expect(screen.queryByRole("list", { name: "Run notices" })).toBeNull();
  });

  it("shows the feature's push and PR failures next to its PR state", async () => {
    renderApp("/feature/?run=golden-1&feature=F-1", withNotices);
    const list = await screen.findByRole("list", { name: "Run notices" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((i) => i.dataset.type)).toEqual(["feature.pr_failed", "branch.push_failed"]);
    expect(items[0]).toHaveTextContent("gh: HTTP 502 while opening the draft PR");
    expect(screen.getByText(/No PR yet/)).toBeInTheDocument();
  });
});

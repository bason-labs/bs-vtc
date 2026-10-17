import { describe, expect, it } from "vitest";
import { clientSpendModel } from "@/lib/spend";

const project = (over: Record<string, unknown>) => ({
  repo_key: "a".repeat(16),
  project: "shop",
  runs: 2,
  spent_usd: 4,
  last_finished_at: "2026-10-13T11:00:00.000Z",
  ...over,
});

describe("clientSpendModel (cost per client, §14)", () => {
  it("totals the client's projects and flags unpriced runs", () => {
    const model = clientSpendModel({
      scope: "client-acme",
      client: "acme",
      total_usd: 4.5,
      unpriced_runs: 2,
      projects: [
        project({}),
        project({ repo_key: "b".repeat(16), project: "admin", runs: 1, spent_usd: 0.5 }),
      ],
      runs: [],
    });
    expect(model.title).toBe("Client acme");
    expect(model.total).toBe("$4.50");
    expect(model.unpriced).toContain("2 role runs");
    expect(model.projects.map((p) => [p.name, p.runs, p.spent])).toEqual([
      ["shop", "2 runs", "$4.00"],
      ["admin", "1 run", "$0.50"],
    ]);
  });

  it("names the shared scope of projects with no client", () => {
    const model = clientSpendModel({
      scope: "_shared",
      client: null,
      total_usd: 0,
      unpriced_runs: 0,
      projects: [],
      runs: [],
    });
    expect(model.title).toContain("no client");
    expect(model.unpriced).toBeNull();
  });
});

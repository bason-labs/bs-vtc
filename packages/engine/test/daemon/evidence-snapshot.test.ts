/**
 * The evidence browser's frozen read routes of an automatic run (AD-27 rule 6; spine §5 reading
 * 208 (4)): every read route the dashboard's run view asks for, keyed as it asks (the event pages
 * by `?after=&limit=`), each a valid response of its route, and the run's events for the replay.
 * No diff, artifact or client-spend content.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONTRACT_SCHEMAS,
  ENGINE_HTTP,
  EVENT_PAGE_LIMIT,
  parseEventLog,
  type ContractName,
} from "@vtc/shared";
import { createReadModel, projectRun } from "../../src/core/index.js";
import { evidenceSnapshot } from "../../src/daemon/evidence-snapshot.js";

const log = parseEventLog(
  readFileSync(new URL("../../../../fixtures/golden-run/events.jsonl", import.meta.url), "utf8"),
).events;
const state = projectRun(log);
const model = createReadModel({
  repoRoot: "/nonexistent",
  mode: "snapshot",
  versions: { engine: "0.0.0", contracts: "5.0.0" },
  prototypeUrl: () => null,
  runs: () => [state],
  usage: () => new Map(),
  git: null,
});

/** The route a snapshot key answers for, by its path pattern. */
const routeOf = (key: string): keyof typeof ENGINE_HTTP.routes => {
  const path = key.split("?")[0] ?? "";
  const found = Object.entries(ENGINE_HTTP.routes).find(([, r]) =>
    new RegExp(`^${r.path.replace(/:[a-z]+/g, "[^/]+")}$`).test(path),
  );
  if (found === undefined) throw new Error(`no route for ${key}`);
  return found[0] as keyof typeof ENGINE_HTTP.routes;
};

describe("the evidence snapshot of a run (AD-27 rule 6)", () => {
  const snapshot = evidenceSnapshot(model, "golden-1");

  it("holds the run's views keyed as the dashboard asks for them", () => {
    const run = "/api/runs/golden-1";
    expect(Object.keys(snapshot.routes).sort()).toEqual(
      [
        "/api/health",
        "/api/runs",
        "/api/usage",
        "/api/automation",
        "/api/status",
        `${run}/events`,
        `${run}/events?after=0&limit=${String(EVENT_PAGE_LIMIT.max)}`,
        `${run}/tasks`,
        `${run}/tasks/T-1`,
        `${run}/tasks/T-2`,
        `${run}/features`,
        `${run}/escalations`,
        `${run}/graph`,
        `${run}/graph?scope=project`,
        `${run}/graph?scope=task_dag`,
        `${run}/graph?scope=task&task=T-1`,
        `${run}/graph?scope=task&task=T-2`,
      ].sort(),
    );
    // never a diff, an artifact's content or the client's spend
    for (const key of Object.keys(snapshot.routes))
      expect(["taskDiff", "artifact", "clientSpend"]).not.toContain(routeOf(key));
  });

  it("each answer is a valid response of its route", () => {
    for (const [key, body] of Object.entries(snapshot.routes)) {
      const contract: ContractName = ENGINE_HTTP.routes[routeOf(key)].response;
      const parsed = CONTRACT_SCHEMAS[contract].safeParse(body);
      expect(parsed.success, `${key}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
  });

  it("replays the run's whole log", () => {
    expect(snapshot.events).toEqual(log);
  });

  it("a run the model does not know has no run views", () => {
    const none = evidenceSnapshot(model, "nope-1");
    expect(none.events).toEqual([]);
    expect(Object.keys(none.routes).filter((k) => k.includes("nope-1"))).toEqual([]);
  });
});

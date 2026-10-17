/**
 * Engine core's Final Review request (`finalReviewRequest`, spine §5 reading 46c) fed into the
 * real Gate Runner on a real checkout: the runner copies in every hidden acceptance test of the
 * feature's live tasks, and engine core's `final_review.steps_run` (`finalReviewStepsRun`,
 * reading 46e) then reports step 2. This is the seam between core/ and gates/ that their own
 * suites each fake.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { engineRepoKey, hiddenTestsDir, type Feature, type Task } from "@vtc/shared";
import { afterEach, describe, expect, it } from "vitest";
import { finalReviewRequest } from "../../src/core/jobs.js";
import type { RunHandle } from "../../src/core/kernel.js";
import { finalReviewStepsRun } from "../../src/core/projections.js";
import { emptyRunState } from "../../src/core/state.js";
import { cleanupDirs } from "../helpers/repo.js";
import { cases, config, harness, testsGate } from "./fixture.js";

afterEach(cleanupDirs);

const plantHidden = (home: string, repo: string, task: string, name: string): void => {
  const dir = join(home, hiddenTestsDir(engineRepoKey(repo), "r1", task), "tests/hidden");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${task}.json`), cases([{ name }]));
};

/** A run whose feature F-1 has tasks T-1 and T-2, and a dropped T-3. */
const runWithFeature = (): RunHandle => {
  const state = emptyRunState("r1", "2026-10-14T08:00:00.000Z");
  state.features.set("F-1", { id: "F-1", tasks: ["T-1", "T-2", "T-3"] } as unknown as Feature);
  for (const [id, status] of [
    ["T-1", "done"],
    ["T-2", "done"],
    ["T-3", "dropped"],
  ] as const)
    state.tasks.set(id, { id, status } as unknown as Task);
  return { state, log: undefined as unknown as RunHandle["log"] };
};

describe("Final Review from engine core through the real Gate Runner (§6.7a step 2)", () => {
  it("copies every live task's hidden tests and reports step 2 in steps_run", async () => {
    const yml = config([testsGate]);
    const h = harness({ "tests/unit.json": cases([{ name: "[REQ-1] ok" }]) }, yml);
    plantHidden(h.home, h.repo, "T-1", "[REQ-1] hidden one");
    plantHidden(h.home, h.repo, "T-2", "[REQ-2] hidden two");
    plantHidden(h.home, h.repo, "T-3", "[REQ-3] dropped task");
    const run = runWithFeature();
    const request = finalReviewRequest(run, "F-1", {
      base: h.base,
      head: h.base,
      req_tags: ["REQ-1", "REQ-2"],
    });
    expect(request.hidden_tasks).toEqual(["T-1", "T-2"]);

    const report = await h.run({
      ...request,
      task: undefined,
      gates_config_hash: createHash("sha256").update(yml).digest("hex"),
    });
    expect(report.verdict).toBe("pass");
    const tests = report.results.find((r) => r.gate_id === "tests");
    // The visible test plus the hidden tests of T-1 and T-2; never the dropped T-3's.
    expect(tests?.tests).toMatchObject({ executed: 3 });

    run.state.gateReports.push({ seq: 1, report, raw: report });
    // Step 6 (architecture conformance) needs an L6 gate, which this config does not have.
    expect(finalReviewStepsRun(h.repo, run.state, "F-1")).toEqual([1, 2]);
  });

  it("reports no step 2 when the feature's tasks have no hidden tests", async () => {
    const yml = config([testsGate]);
    const h = harness({ "tests/unit.json": cases([{ name: "[REQ-1] ok" }]) }, yml);
    const run = runWithFeature();
    const report = await h.run({
      ...finalReviewRequest(run, "F-1", { base: h.base, head: h.base, req_tags: ["REQ-1"] }),
      task: undefined,
      gates_config_hash: createHash("sha256").update(yml).digest("hex"),
    });
    run.state.gateReports.push({ seq: 1, report, raw: report });
    expect(finalReviewStepsRun(h.repo, run.state, "F-1")).not.toContain(2);
  });
});

/**
 * The wave-3 integration round on the engine side (spine §5 readings 135–143): a role cannot put
 * its own sha256 on a submitted artifact. Lookback's human-edit detection compares the submitted
 * hash with the frozen file's, so a role-reported hash could fake a human edit of its own work.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupDirs, writeFile } from "../helpers/repo.js";
import {
  createHarness,
  draft,
  only,
  SPEC_ONE,
  submitResult,
  throughPlan,
  worktreeOf,
} from "../helpers/engine-harness.js";

vi.setConfig({ testTimeout: 20_000 });
afterEach(cleanupDirs);

describe("submitted artifact hashes are the engine's (reading 140)", () => {
  it("drops a sha256 the role reported on a path that is not rehashed", async () => {
    const h = createHarness();
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    const qa = only(actions, "qa");
    const path = "tests/acceptance/t-1.test.ts";
    writeFile(worktreeOf(h, "T-1"), path, 'test("[REQ-1.AC-1] works", () => {});\n');
    await submitResult(h, qa, {
      exit: "done",
      acceptance_tests: ["[REQ-1.AC-1] works"],
      artifacts: [{ type: "acceptance_test", path, sha256: "f".repeat(64) }],
    });
    await h.engine.settle();
    const submitted = readFileSync(
      join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/events.jsonl`),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { type: string; role?: string; data: Record<string, unknown> })
      .find((e) => e.type === "role.submitted" && e.role === "qa");
    expect(submitted?.data.artifacts).toEqual([{ type: "acceptance_test", path }]);
    await h.release();
  });
});

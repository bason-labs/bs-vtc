/**
 * Regression pins for owner-run faults fixed in v0.2.4 (design 2026-10-20 §2a). Fault 4 (a quick
 * fix gives the designer the BA's spec in their pack) is pinned in `quick-fix-design.test.ts`
 * ("get the BA's spec in their pack"); fault 6 (a Codex role reads by shell) is pinned in
 * `packages/adapters/test/codex/command.test.ts` and `packages/compiler/test/headless-asset.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { resultFields } from "../../src/core/dispatch.js";

describe("fault 10: a task-less dispatch does not take a task id from the repository", () => {
  it("tells a BA dispatch with no task that its task is null and never to take one from the repo", () => {
    const fields = resultFields({ role: "ba" }, undefined, undefined);
    expect(fields).toContain("task, feature null");
    expect(fields).toContain("never take one from the repository");
  });
});

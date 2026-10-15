/**
 * A crash's VTC stack frames (D-bv (2), D-by; spine §5 reading 216): the engine keeps only the
 * frames of its own sources, root-relative, on the `incident.recorded` it writes for a background
 * job that threw, and the automation fact carries them to the upstream module, which locates the
 * defect from them. The run log is git-tracked, so nothing else of the stack is kept.
 */
import { describe, expect, it } from "vitest";
import type { VtcEvent } from "@vtc/shared";
import {
  applyEvent,
  automationFacts,
  crashIncident,
  vtcSourceRoots,
  vtcStackFrames,
} from "../../src/core/index.js";
import { emptyRunState } from "../../src/core/state.js";

const ROOT = "/Users/alice/vtc";

const STACK = [
  "Error: could not read /Users/alice/clients/globex/secret.txt: sk-live-123",
  "    at readPlan (/Users/alice/vtc/packages/engine/src/core/plan.ts:12:7)",
  "    at async Engine.job (file:///Users/alice/vtc/packages/engine/dist/core/engine.js:40:3)",
  "    at handler (/Users/alice/clients/globex/payroll/packages/engine/src/x.ts:1:1)",
  "    at node:internal/process/task_queues:95:5",
  "    at Object.<anonymous> (/Users/alice/vtc-other/packages/engine/src/y.ts:1:1)",
].join("\n");

describe("vtcStackFrames", () => {
  it("keeps only the frames under VTC's source roots, root-relative, never the message", () => {
    expect(vtcStackFrames(STACK, [ROOT])).toBe(
      [
        "    at readPlan (packages/engine/src/core/plan.ts:12:7)",
        "    at async Engine.job (packages/engine/dist/core/engine.js:40:3)",
      ].join("\n"),
    );
  });

  it("keeps the single-file binary's own frames as they are", () => {
    const stack = "Error: x\n    at spawn (/$bunfs/root/vtc:10:2)\n    at /home/bob/app/a.js:1:1";
    expect(vtcStackFrames(stack, [])).toBe("    at spawn (/$bunfs/root/vtc:10:2)");
  });

  it("is undefined without a VTC frame, without roots for absolute frames, or without a stack", () => {
    expect(vtcStackFrames(STACK, [])).toBeUndefined();
    expect(vtcStackFrames("Error: x\n    at node:internal/a:1:1", [ROOT])).toBeUndefined();
    expect(vtcStackFrames(undefined, [ROOT])).toBeUndefined();
  });

  it("caps the frames it keeps", () => {
    const deep = [
      "Error: deep",
      ...Array.from(
        { length: 60 },
        (_, i) =>
          `    at f${String(i)} (/Users/alice/vtc/packages/engine/src/core/a.ts:${String(i + 1)}:1)`,
      ),
    ].join("\n");
    const kept = vtcStackFrames(deep, [ROOT])?.split("\n") ?? [];
    expect(kept).toHaveLength(20);
    expect(kept.join("\n").length).toBeLessThanOrEqual(4000);
  });

  it("derives the root from where the engine's own sources run", () => {
    expect(vtcSourceRoots("file:///Users/alice/vtc/packages/engine/src/core/vtc-stack.ts")).toEqual(
      ["/Users/alice/vtc"],
    );
    expect(
      vtcSourceRoots("file:///Users/alice/vtc/packages/engine/dist/core/vtc-stack.js"),
    ).toEqual(["/Users/alice/vtc"]);
    // the single-file binary: its frames are recognised by its virtual root instead
    expect(vtcSourceRoots("file:///$bunfs/root/vtc")).toEqual([]);
  });
});

describe("a crash incident carries the VTC frames to the automation fact", () => {
  it("records the frames of a failed background job beside its detail", () => {
    const error = new Error("boom");
    error.stack = STACK;
    expect(crashIncident("job-1", error, [ROOT])).toEqual({
      kind: "crash",
      detail: "background job job-1 failed: boom",
      stack: [
        "    at readPlan (packages/engine/src/core/plan.ts:12:7)",
        "    at async Engine.job (packages/engine/dist/core/engine.js:40:3)",
      ].join("\n"),
    });
    expect(crashIncident("job-2", "a string", [ROOT])).toEqual({
      kind: "crash",
      detail: "background job job-2 failed: a string",
    });
  });

  it("hands the frames on as the defect fact's stack", () => {
    const state = emptyRunState("r1", "2026-10-15T09:00:00.000Z");
    const event: VtcEvent = {
      v: 1,
      seq: 1,
      ts: "2026-10-15T10:00:00.000Z",
      run: "r1",
      type: "incident.recorded",
      actor: "engine",
      data: {
        kind: "crash",
        detail: "x",
        stack: "    at readPlan (packages/engine/src/core/plan.ts:12:7)",
      },
    };
    applyEvent(state, event);
    expect(automationFacts(state, event)).toEqual([
      expect.objectContaining({
        target: "upstream",
        kind: "defect",
        errorClass: "incident.crash",
        stack: "    at readPlan (packages/engine/src/core/plan.ts:12:7)",
      }),
    ]);
  });
});

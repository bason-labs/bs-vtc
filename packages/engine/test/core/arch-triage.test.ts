/**
 * Per-task architecture triage (spec §8.4): `fits` costs no Architect tokens; `extends` gets a
 * one-page design note before QA starts; `changes` gets an ADR that the engine puts to the human
 * as a change request on the frozen architecture, and the task waits for the answer.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupDirs, writeFile } from "../helpers/repo.js";
import {
  CLAUDE,
  createHarness,
  draft,
  only,
  SPEC_ONE,
  spawns,
  submitResult,
  throughPlan,
  workdir,
  type Harness,
} from "../helpers/engine-harness.js";

vi.setConfig({ testTimeout: 30_000 });
afterEach(cleanupDirs);

interface Line {
  type: string;
  task?: string;
  data: Record<string, unknown>;
}
const events = (h: Harness): Line[] =>
  readFileSync(join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/events.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Line);

describe("per-task architecture triage (§8.4)", () => {
  it("fits: QA starts at once, no Architect run", async () => {
    const h = createHarness();
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    expect(spawns(actions).map((a) => a.role)).toEqual(["qa"]);
    await h.release();
  });

  it("extends: the Architect writes a design note for the task first, then QA starts", async () => {
    const h = createHarness();
    const actions = await throughPlan(h, [draft("T-1", { arch_triage: "extends" })], SPEC_ONE);
    const architect = only(actions, "architect");
    expect(architect).toMatchObject({ subject: "T-1" });
    expect(architect.task).toBeUndefined();
    expect(architect.prompt).toContain("one-page design note");
    expect(readFileSync(join(h.repo, architect.pack), "utf8")).toContain("REQ-1");
    writeFile(workdir(architect), ".vtc/architecture/notes/T-1.md", "# T-1 design note\n");
    const out = await submitResult(h, architect, {
      exit: "done",
      artifacts: [{ type: "design_note", path: ".vtc/architecture/notes/T-1.md" }],
    });
    expect(out.accepted).toBe(true);
    expect(only(out.actions, "qa").task).toBe("T-1");
    expect(readFileSync(join(h.repo, ".vtc/architecture/notes/T-1.md"), "utf8")).toContain(
      "design note",
    );
    await h.release();
  });

  it("changes: the ADR becomes a change request; the task waits for the human, then QA starts", async () => {
    const h = createHarness();
    const actions = await throughPlan(h, [draft("T-1", { arch_triage: "changes" })], SPEC_ONE);
    const architect = only(actions, "architect");
    expect(architect.prompt).toContain("ADR");
    writeFile(workdir(architect), ".vtc/architecture/adr/0001-queue.md", "# ADR 1: a queue\n");
    const out = await submitResult(h, architect, {
      exit: "done",
      artifacts: [{ type: "design_note", path: ".vtc/architecture/adr/0001-queue.md" }],
    });
    expect(out.accepted).toBe(true);
    expect(spawns(out.actions)).toEqual([]);
    expect(out.actions).toContainEqual({ type: "ask_human", escalations: ["E-1"] });
    const cr = events(h).find((e) => e.type === "change_request.opened");
    expect(cr?.data).toMatchObject({ escalation: "E-1", artifact: "architecture" });
    const answered = await h.engine.answer(
      {
        escalation: "E-1",
        answer: { option: "approve", who_should_have_caught: "none" },
      },
      CLAUDE,
    );
    expect(events(h).some((e) => e.type === "change_request.decided")).toBe(true);
    expect(only(answered.actions, "qa").task).toBe("T-1");
    await h.release();
  });
});

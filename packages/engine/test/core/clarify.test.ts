/**
 * Spec and design gaps go to the BA and the Designer, not straight to the human (§6.3 steps 3
 * and 8, §6.2): a wording-only fix is `spec.clarified`, a change in meaning a change request,
 * and the task's Engineer continues; each driven through next()/submit() on a real repo.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LeadAction } from "@vtc/shared";
import { cleanupDirs, writeFile } from "../helpers/repo.js";
import {
  authorTests,
  build,
  CLAUDE,
  createHarness,
  draft,
  only,
  spawns,
  submitResult,
  throughPlan,
  SPEC_ONE,
  type Harness,
  type SpawnAction,
} from "../helpers/engine-harness.js";

afterEach(cleanupDirs);

const SPEC_PATH = ".vtc/spec/spec.md";
const next = async (h: Harness): Promise<LeadAction[]> => (await h.engine.next({}, CLAUDE)).actions;
const toEngineer = async (h: Harness): Promise<SpawnAction> => {
  const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
  await authorTests(h, only(actions, "qa"));
  return only(await next(h), "engineer");
};
const eventsOf = (h: Harness): { type: string; data: Record<string, unknown>; task?: string }[] =>
  readFileSync(join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/events.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as { type: string; data: Record<string, unknown>; task?: string });
const sha = (h: Harness, path: string): string =>
  createHash("sha256")
    .update(readFileSync(join(h.repo, path)))
    .digest("hex");
const editSpec = (h: Harness, from: string, to: string): void => {
  const path = join(h.repo, SPEC_PATH);
  writeFileSync(path, readFileSync(path, "utf8").replace(from, to));
};
/** The Spec-Verifier fails the AC with one finding of `kind` (a gap route). */
const gapFinding = async (h: Harness, kind: "spec_ambiguity" | "design_ambiguity") => {
  const verifier = only(await next(h), "spec_verifier");
  const out = await submitResult(h, verifier, {
    exit: "done",
    verdicts: [
      {
        subject: "REQ-1.AC-1",
        verdict: "fail",
        evidence: [{ type: "file_line", ref: "src/t-1/impl.ts:1" }],
      },
    ],
    findings: [
      {
        rule_id: "gap",
        category: kind === "spec_ambiguity" ? "correctness" : "design",
        kind,
        title: "Which hash?",
        confidence: 0.9,
        location: { path: "src/t-1/impl.ts" },
        evidence: { type: "file_line", ref: "src/t-1/impl.ts:1" },
      },
    ],
  });
  expect(out.accepted).toBe(true);
  await h.engine.settle();
};

describe("spec and design gaps go to the BA and the Designer (§6.3 steps 3 and 8)", () => {
  it("a reviewer's spec gap: the BA clarifies the wording, then the Engineer continues", async () => {
    const h = createHarness();
    await build(h, await toEngineer(h));
    await gapFinding(h, "spec_ambiguity");
    const ba = only(await next(h), "ba");
    expect(ba.task).toBe("T-1");
    expect(ba.prompt).toContain(`Work in: ${h.repo}\n`);
    expect(readFileSync(join(h.repo, ba.pack), "utf8")).toContain("Which hash?");
    const frozen = h.engine.status({}).run.gates.G1.frozen[0]?.sha256;
    editSpec(h, "only its hash is stored", "only its SHA-256 hash is stored");
    const out = await submitResult(h, ba, {
      exit: "done",
      summary: "The stored hash is SHA-256.",
      artifacts: [{ type: "spec", path: SPEC_PATH }],
    });
    expect(out.accepted).toBe(true);
    const clarified = eventsOf(h).find((e) => e.type === "spec.clarified");
    expect(clarified?.data).toMatchObject({
      path: SPEC_PATH,
      old_sha256: frozen,
      new_sha256: sha(h, SPEC_PATH),
      summary: "The stored hash is SHA-256.",
    });
    expect(h.engine.status({}).run.gates.G1.frozen[0]?.sha256).toBe(sha(h, SPEC_PATH));
    expect(h.engine.status({}).parked).toEqual([]);
    const engineer = only(out.actions, "engineer");
    expect(engineer.task).toBe("T-1");
    await h.release();
  });
  it("an Engineer's spec_conflict goes to the BA; a change in meaning becomes a CR the human decides", async () => {
    const h = createHarness();
    const engineer = await toEngineer(h);
    const conflict = await submitResult(h, engineer, {
      exit: "spec_conflict",
      conflict: { req_ids: ["REQ-1"], detail: "Tokens must also expire, the spec never says so." },
    });
    expect(conflict.accepted).toBe(true);
    expect(h.engine.status({}).parked).toEqual([]);
    const ba = only(conflict.actions, "ba");
    editSpec(
      h,
      "only its hash is stored.",
      "only its hash is stored.\n- REQ-1.AC-2: Given a token When an hour passes Then it expires.",
    );
    const out = await submitResult(h, ba, {
      exit: "done",
      summary: "Add token expiry (REQ-1.AC-2).",
      artifacts: [{ type: "spec", path: SPEC_PATH }],
    });
    expect(out.accepted).toBe(true);
    expect(eventsOf(h).some((e) => e.type === "spec.clarified")).toBe(false);
    expect(h.engine.status({}).parked).toEqual([{ task: "T-1", reason: "change_request" }]);
    const opened = eventsOf(h).find((e) => e.type === "change_request.opened");
    expect(opened?.data).toMatchObject({ artifact: "spec", frozen: { path: SPEC_PATH } });
    const escalation = opened?.data.escalation as string;
    const answered = await h.engine.answer(
      { escalation, answer: { option: "approve", who_should_have_caught: "none" } },
      CLAUDE,
    );
    expect(eventsOf(h).find((e) => e.type === "change_request.decided")?.data).toMatchObject({
      decision: "approved",
      new_sha256: sha(h, SPEC_PATH),
    });
    expect(h.engine.status({}).parked).toEqual([]);
    expect(only(answered.actions, "engineer").task).toBe("T-1");
    await h.release();
  });
  it("a design gap goes to the Designer; additions outside the frozen design resolve it", async () => {
    const h = createHarness();
    await build(h, await toEngineer(h));
    await gapFinding(h, "design_ambiguity");
    const designer = only(await next(h), "designer");
    expect(designer.task).toBe("T-1");
    writeFile(h.repo, ".vtc/design/notes/t-1.md", "Use the compact layout.\n");
    const out = await submitResult(h, designer, {
      exit: "done",
      artifacts: [{ type: "design", path: ".vtc/design/notes/t-1.md" }],
    });
    expect(out.accepted).toBe(true);
    expect(only(out.actions, "engineer").task).toBe("T-1");
    await h.release();
  });
  it("a clarifier works in the checkout: its writes are checked like any phase role's", async () => {
    const h = createHarness();
    const engineer = await toEngineer(h);
    const conflict = await submitResult(h, engineer, {
      exit: "spec_conflict",
      conflict: { req_ids: ["REQ-1"], detail: "Unclear." },
    });
    const ba = only(conflict.actions, "ba");
    writeFile(h.repo, "src/sneaky.ts", "export const x = 1;\n");
    const out = await submitResult(h, ba, { exit: "done" });
    expect(out).toMatchObject({ accepted: false, rejection: { reason: "write_scope" } });
    expect(h.engine.status({}).run.paused).toBe(true);
    expect(spawns(await next(h))).toEqual([]);
    await h.release();
  });
  it("a task that keeps coming back goes to the human", async () => {
    const h = createHarness();
    let engineer = await toEngineer(h);
    for (let i = 0; i < 3; i += 1) {
      const conflict = await submitResult(h, engineer, {
        exit: "spec_conflict",
        conflict: { req_ids: ["REQ-1"], detail: `Unclear, take ${String(i)}.` },
      });
      const ba = only(conflict.actions, "ba");
      const out = await submitResult(h, ba, { exit: "done", summary: "The spec says it." });
      engineer = only(out.actions, "engineer");
    }
    await submitResult(h, engineer, {
      exit: "spec_conflict",
      conflict: { req_ids: ["REQ-1"], detail: "Still unclear." },
    });
    expect(h.engine.status({}).parked).toEqual([{ task: "T-1", reason: "spec_conflict" }]);
    await h.release();
  });
});

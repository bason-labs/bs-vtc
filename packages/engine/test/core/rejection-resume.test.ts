/**
 * A format rejection is fixed in the same session (spine §5 reading 276), from the owner's runs
 * with synthetic data only: every result the engine rejected for its form (schema, claim_check,
 * dispatch_mismatch, undeclared_output, undeclared_mode, undeclared_exit, undeclared_verdict) was
 * retried as a brand-new, full-price run with `resume: null`. The retry now resumes the rejected
 * run's host session when it had one; any other rejection (write_scope) still dispatches fresh.
 */
import { afterEach, describe, expect, it } from "vitest";
import { SubmitInputSchema, type RoleResultInput, type SessionRef } from "@vtc/shared";
import { callTool } from "../../src/mcp/index.js";
import { cleanupDirs, writeFile } from "../helpers/repo.js";
import {
  authorTests,
  CLAUDE,
  createHarness,
  draft,
  only,
  result,
  SPEC_ONE,
  throughPlan,
  workdir,
  worktreeOf,
  type Harness,
  type SpawnAction,
} from "../helpers/engine-harness.js";

afterEach(cleanupDirs);

const SPEC = "# Spec\n\n## REQ-1 Order total\n\n- REQ-1.AC-1: the total shows on checkout\n";
const SESSION: SessionRef = { host: "claude-code", id: "s-1" };

const toBa = async (h: Harness): Promise<SpawnAction> => {
  await h.engine.start(
    {
      request: "Show the order total on checkout",
      track: "quick_fix",
      repo: "existing",
      has_ui: false,
      risk_hints: [],
    },
    CLAUDE,
  );
  return only((await h.engine.next({}, CLAUDE)).actions, "ba");
};

/** Submits `body` for `action`, with the host session the run used when `session` is given. */
const submitIn = (
  h: Harness,
  action: SpawnAction,
  body: Partial<RoleResultInput> & Pick<RoleResultInput, "exit">,
  session?: SessionRef,
) =>
  h.engine.submit(
    SubmitInputSchema.parse({
      kind: "result",
      action_id: action.action_id,
      result: result(action, body),
      usage: { model: "sonnet", tokens: { in: 100, out: 50, cache_r: 0, cache_w: 0 }, cost_usd: 1 },
      ...(session === undefined ? {} : { session_ref: session }),
    }),
    CLAUDE,
  );

/**
 * The BA cites a file that is not there, so the claim check rejects it (before G1 no spec is
 * frozen, so a spec ref the BA writes is not checked yet).
 */
const rejectBa = async (h: Harness, ba: SpawnAction, session?: SessionRef) => {
  writeFile(workdir(ba), ".vtc/spec/order-total.md", SPEC);
  const out = await submitIn(
    h,
    ba,
    {
      exit: "done",
      artifacts: [{ type: "spec", path: ".vtc/spec/order-total.md" }],
      claims: [{ type: "file", ref: "docs/missing.md" }],
    },
    session,
  );
  expect(out).toMatchObject({ accepted: false, rejection: { reason: "claim_check" } });
  return only(out.actions, "ba");
};

describe("a format rejection resumes the role's session (reading 276)", { timeout: 30_000 }, () => {
  it("re-dispatches the BA in the rejected run's session, with the rejection", async () => {
    const h = createHarness();
    const again = await rejectBa(h, await toBa(h), SESSION);
    expect(again.resume).toEqual(SESSION);
    expect(again.prompt).toContain("Your previous result was rejected (claim_check)");
    await h.release();
  });

  it("starts a fresh run when the rejected run named no session", async () => {
    const h = createHarness();
    const again = await rejectBa(h, await toBa(h));
    expect(again.resume).toBeUndefined();
    expect(again.prompt).toContain("Your previous result was rejected (claim_check)");
    await h.release();
  });

  it("resumes a malformed submit's session, which the schema rejected", async () => {
    const h = createHarness();
    const ba = await toBa(h);
    const session: SessionRef = { host: "claude-code", id: "s-9" };
    const out = await callTool(
      h.engine,
      "submit",
      {
        kind: "result",
        action_id: ba.action_id,
        result: { role: "ba", exit: "done" },
        session_ref: session,
      },
      CLAUDE,
    );
    const rejected = out.structuredContent as { rejection?: unknown; actions: SpawnAction[] };
    expect(rejected).toMatchObject({ accepted: false, rejection: { reason: "schema" } });
    const again = only(rejected.actions, "ba");
    expect(again.resume).toEqual(session);
    expect(again.prompt).toContain("Your previous result was rejected (schema)");
    await h.release();
  });

  it("dispatches fresh after a write_scope rejection, even when the run named a session", async () => {
    const h = createHarness();
    const ba = await toBa(h);
    writeFile(workdir(ba), ".vtc/spec/order-total.md", SPEC);
    writeFile(workdir(ba), "src/stray.ts", "export const x = 1;\n");
    const out = await submitIn(
      h,
      ba,
      { exit: "done", artifacts: [{ type: "spec", path: ".vtc/spec/order-total.md" }] },
      SESSION,
    );
    expect(out).toMatchObject({ accepted: false, rejection: { reason: "write_scope" } });
    const again = only(out.actions, "ba");
    expect(again.resume).toBeUndefined();
    expect(again.prompt).toContain("Your previous result was rejected (write_scope)");
    await h.release();
  });

  it("resumes the Engineer too, which redoes its discarded changes within scope", async () => {
    const h = createHarness();
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    await authorTests(h, only(actions, "qa"));
    const engineer = only((await h.engine.next({}, CLAUDE)).actions, "engineer");
    writeFile(worktreeOf(h, "T-1"), "src/t-1/impl.ts", "export const x = 1;\n");
    const out = await submitIn(
      h,
      engineer,
      { exit: "built", claims: [{ type: "spec_ref", ref: "REQ-99" }] },
      SESSION,
    );
    expect(out).toMatchObject({ accepted: false, rejection: { reason: "claim_check" } });
    const again = only(out.actions, "engineer");
    expect(again.resume).toEqual(SESSION);
    expect(again.prompt).toContain("redo them within scope");
    await h.release();
  });
});

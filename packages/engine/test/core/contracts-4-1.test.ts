/**
 * Contracts 4.1.0 on the engine side, each driven through the tools on a real repo: `consult`
 * for advisors (spine §5 readings 25, 30), the resolved `model` on `spawn_role`, `session_ref`
 * on a result, Level 2 without a remote and typed push/PR failures (reading 18), gaps parking
 * for the human (reading 19), pack depths and design constraints (reading 32), the Final Review
 * steps in the feature bundle, and Lead-only tools refused from role sessions (spine §7).
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTRACTS_VERSION,
  engineSocketFile,
  EvidenceBundleSchema,
  SubmitInputSchema,
  type LeadAction,
} from "@vtc/shared";
import { guardDirFor } from "../../src/core/guard.js";
import { connectEngineClient, serveEngineSocket } from "../../src/mcp/index.js";
import { cleanupDirs, git, writeFile } from "../helpers/repo.js";
import {
  authorTests,
  build,
  CLAUDE,
  createHarness,
  draft,
  only,
  result,
  SPEC_ONE,
  spawns,
  submitResult,
  throughPlan,
  verdictPass,
  workdir,
  type Harness,
  type SpawnAction,
} from "../helpers/engine-harness.js";

// Whole engine flows on a real repo spawn a few hundred git processes per test: under turbo's
// parallel load the 5 s default is too tight, so they get room on a loaded machine. A real hang
// still fails, and no assertion changes.
vi.setConfig({ testTimeout: 20_000 });

afterEach(cleanupDirs);

const next = async (h: Harness): Promise<LeadAction[]> => (await h.engine.next({}, CLAUDE)).actions;
interface Line {
  type: string;
  seq: number;
  role?: string;
  task?: string;
  feature?: string;
  model?: string;
  prompt_sha?: string;
  data: Record<string, unknown>;
}
const events = (h: Harness): Line[] =>
  readFileSync(join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/events.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Line);
const start = (h: Harness) =>
  h.engine.start(
    {
      request: "Password reset\n\nUsers reset forgotten passwords.",
      track: "feature",
      repo: "existing",
      has_ui: false,
      risk_hints: [],
    },
    CLAUDE,
  );
const toEngineer = async (h: Harness): Promise<SpawnAction> => {
  const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
  await authorTests(h, only(actions, "qa"));
  return only(await next(h), "engineer");
};
const TOKEN = `ghp_${"a1B2".repeat(9)}`;
const INSTALL_TOKEN = "i".repeat(43);

describe("consult: advisors through the engine (spine §5 readings 25, 30)", () => {
  it("dispatches an advisor like a role, outside the phase flow, and merges its export", async () => {
    const h = createHarness();
    const { run } = await start(h);
    only(await next(h), "repo_cartographer");
    const out = await h.engine.consult(
      {
        advisor: "advisor_client_liaison",
        question: "Summarise where the run stands for the client.",
        inputs: [{ type: "run_status", path: `.vtc/runs/${run}/request.md` }],
      },
      CLAUDE,
    );
    expect(out.run).toBe(run);
    const action = out.action;
    expect(action).toMatchObject({
      type: "spawn_role",
      role: "advisor_client_liaison",
      model: "sonnet",
    });
    const pack = readFileSync(join(h.repo, action.pack), "utf8");
    expect(pack).toContain("run_status");
    // the human's question is the advisor_question input, listed first (advisor protocol)
    const inputs = (pack.split("## Inputs\n")[1] ?? "").split("\n## ")[0]?.trim().split("\n") ?? [];
    expect(inputs[0]).toMatch(/^- advisor_question: \.vtc\/state\/packs\/.+\/consult-.+\.md$/);
    expect(action.prompt).toContain("The human asks: Summarise where the run stands");
    const dispatched = events(h).findLast((e) => e.type === "role.dispatched");
    expect(dispatched).toMatchObject({ role: "advisor_client_liaison", model: "sonnet" });
    expect(dispatched?.prompt_sha).toMatch(/^[a-f0-9]{64}$/);
    writeFile(workdir(action), ".vtc/exports/status.md", "# Status\n\nOn track.\n");
    const submitted = await submitResult(h, action, {
      exit: "done",
      artifacts: [{ type: "client_export", path: ".vtc/exports/status.md" }],
    });
    expect(submitted.accepted).toBe(true);
    expect(readFileSync(join(h.repo, ".vtc/exports/status.md"), "utf8")).toContain("On track.");
    expect(events(h).findLast((e) => e.type === "role.submitted")).toMatchObject({
      role: "advisor_client_liaison",
      model: "sonnet",
    });
    // the phase flow is untouched: the Cartographer is still the step in flight
    expect(h.engine.status({}).run.phase).toBe("discover");
    await h.release();
  });
  it("checks the advisor's writes on submit, and refuses a role that is not an advisor", async () => {
    const h = createHarness();
    await start(h);
    await expect(
      h.engine.consult({ advisor: "ba", question: "Rewrite the spec", inputs: [] }, CLAUDE),
    ).rejects.toThrow(/not an advisor/);
    const { action } = await h.engine.consult(
      { advisor: "advisor_estimator", question: "Why so expensive?", inputs: [] },
      CLAUDE,
    );
    writeFile(workdir(action), "src/cheaper.ts", "export const x = 1;\n");
    const out = await submitResult(h, action, { exit: "done" });
    expect(out).toMatchObject({ accepted: false, rejection: { reason: "write_scope" } });
    expect(existsSync(join(h.repo, "src/cheaper.ts"))).toBe(false);
    await h.release();
  });
  it("refuses a consult once the run's advisor budget is spent (budgets.advisor_usd)", async () => {
    const h = createHarness({ project: { budgets: { advisor_usd: 0.15 } } });
    await start(h);
    const ask = () =>
      h.engine.consult({ advisor: "advisor_estimator", question: "Spend?", inputs: [] }, CLAUDE);
    expect((await submitResult(h, (await ask()).action, { exit: "done" }, 0.1)).accepted).toBe(
      true,
    );
    expect((await submitResult(h, (await ask()).action, { exit: "done" }, 0.1)).accepted).toBe(
      true,
    );
    await expect(ask()).rejects.toThrow(/advisor budget is spent \(\$0\.20 of \$0\.15/);
    await h.release();
  });
});

describe("spawn_role.model and session_ref (contracts 4.1.0)", () => {
  it("names the resolved model, and records the session a result reports", async () => {
    const h = createHarness();
    const engineer = await toEngineer(h);
    expect(engineer.model).toBe("sonnet");
    writeFile(join(h.repo, ".vtc/state/worktrees/T-1"), "src/t-1/impl.ts", "export const x = 1;\n");
    const out = await h.engine.submit(
      SubmitInputSchema.parse({
        kind: "result",
        action_id: engineer.action_id,
        result: result(engineer, { exit: "built" }),
        usage: { model: "sonnet", tokens: null, cost_usd: 0.1 },
        session_ref: { host: "claude-code", id: "session-42" },
      }),
      CLAUDE,
    );
    expect(out.accepted).toBe(true);
    const updated = events(h).find((e) => e.type === "task.session_updated");
    expect(updated).toMatchObject({
      task: "T-1",
      data: { session_ref: { host: "claude-code", id: "session-42" } },
    });
    expect(events(h).findLast((e) => e.type === "role.submitted")?.data.session_ref).toEqual({
      host: "claude-code",
      id: "session-42",
    });
    await h.release();
  });
});

describe("Level 2 push and PR (spine §5 reading 18)", () => {
  it("without an origin remote, the run drops to Level 1 and merged tasks are done", async () => {
    const h = createHarness({ noRemote: true });
    await start(h);
    expect(events(h).find((e) => e.type === "run.merge_level_changed")?.data).toEqual({
      from: 2,
      to: 1,
      reason: "no_remote",
    });
    await h.release();
  });
  it("a remote removed mid-run drops the run to Level 1 at the push; its merged task is done", async () => {
    const h = createHarness();
    await build(h, await toEngineer(h));
    git(h.repo, "remote", "remove", "origin");
    await verdictPass(h, only(await next(h), "spec_verifier"), "src/t-1/impl.ts");
    await h.engine.settle();
    expect(events(h).some((e) => e.type === "branch.push_skipped")).toBe(false);
    expect(events(h).find((e) => e.type === "run.merge_level_changed")?.data).toMatchObject({
      reason: "no_remote",
      to: 1,
    });
    expect(h.engine.status({}).tasks_by_status).toMatchObject({ done: 1 });
    await h.release();
  });
  it("logs a failed push and a failed PR call as typed events, redacted", async () => {
    const h = createHarness();
    const hook = join(h.repo, ".git/hooks/pre-push");
    writeFileSync(hook, `#!/bin/sh\necho "denied for ${TOKEN}" >&2\nexit 1\n`);
    chmodSync(hook, 0o755);
    await build(h, await toEngineer(h));
    await verdictPass(h, only(await next(h), "spec_verifier"), "src/t-1/impl.ts");
    await h.engine.settle();
    const failed = events(h).find((e) => e.type === "branch.push_failed");
    expect(failed).toMatchObject({ feature: "F-1", data: { branch: "vtc/F-1" } });
    expect(String(failed?.data.detail)).toContain("[REDACTED:github_token]");
    expect(JSON.stringify(events(h))).not.toContain(TOKEN);
    expect(h.engine.status({}).tasks_by_status).toMatchObject({ merged: 1 });
    await h.release();
  });
  it("logs a failed PR call as feature.pr_failed, redacted", async () => {
    const h = createHarness();
    h.prs.upsertDraft = () => Promise.reject(new Error(`gh pr create failed: ${TOKEN}`));
    await build(h, await toEngineer(h));
    await verdictPass(h, only(await next(h), "spec_verifier"), "src/t-1/impl.ts");
    await h.engine.settle();
    const failed = events(h).find((e) => e.type === "feature.pr_failed");
    expect(failed).toMatchObject({ feature: "F-1" });
    expect(String(failed?.data.detail)).toContain("[REDACTED:github_token]");
    await h.release();
  });
});

describe("gaps and spec conflicts park for the human until sub-project 4 (spine §5 reading 19)", () => {
  it("a reviewer's spec gap parks the task; no BA is dispatched for it", async () => {
    const h = createHarness();
    await build(h, await toEngineer(h));
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
          category: "correctness",
          kind: "spec_ambiguity",
          title: "Which hash?",
          confidence: 0.9,
          location: { path: "src/t-1/impl.ts" },
          evidence: { type: "file_line", ref: "src/t-1/impl.ts:1" },
        },
      ],
    });
    expect(out.accepted).toBe(true);
    await h.engine.settle();
    const status = h.engine.status({});
    expect(status.parked.find((p) => p.task === "T-1")).toMatchObject({ reason: "spec_conflict" });
    expect(spawns(await next(h)).map((a) => a.role)).not.toContain("ba");
    await h.release();
  });
  it("an Engineer's spec_conflict parks the task", async () => {
    const h = createHarness();
    const engineer = await toEngineer(h);
    const out = await submitResult(h, engineer, {
      exit: "spec_conflict",
      conflict: { req_ids: ["REQ-1"], detail: "REQ-1 contradicts itself" },
    });
    expect(out.accepted).toBe(true);
    expect(h.engine.status({}).parked.find((p) => p.task === "T-1")).toMatchObject({
      reason: "spec_conflict",
    });
    expect(spawns(out.actions)).toEqual([]);
    await h.release();
  });
});

describe("packs carry what the engine decides (spine §5 reading 32)", () => {
  it("research depth for DISCOVER, architect depth from the spec and track", async () => {
    const h = createHarness();
    await start(h);
    const carto = only(await next(h), "repo_cartographer");
    expect(readFileSync(join(h.repo, carto.pack), "utf8")).toContain("research depth: light");
    await h.release();
  });
});

describe("the feature evidence bundle names the Final Review steps run (§6.7a)", () => {
  it("steps_run is [1]", async () => {
    const h = createHarness({ project: { merge_level: 1 } });
    await build(h, await toEngineer(h));
    await verdictPass(h, only(await next(h), "spec_verifier"), "src/t-1/impl.ts");
    await h.engine.settle();
    const bundle = EvidenceBundleSchema.parse(
      JSON.parse(readFileSync(join(h.repo, ".vtc/evidence/F-1/bundle.json"), "utf8")),
    );
    expect(bundle.kind === "feature" && bundle.final_review.steps_run).toEqual([1]);
    await h.release();
  });
});

describe("Lead-only tools from role sessions (spine §7, until the Codex isolation spike)", () => {
  it("refuses approve, answer, change_request and another action's submit from a role session", async () => {
    const h = createHarness();
    const home = mkdtempSync(join(tmpdir(), "vh-"));
    const server = await serveEngineSocket({
      path: join(home, engineSocketFile(h.repo)),
      host: h.engine,
      versions: { engine: "vtc-engine@0.0.0", contracts: CONTRACTS_VERSION },
      installToken: INSTALL_TOKEN,
    });
    const lead = await connectEngineClient(server.path, CONTRACTS_VERSION, {
      bridge: "claude-code",
    });
    const role = await connectEngineClient(server.path, CONTRACTS_VERSION, {
      bridge: "claude-code",
    });
    const cli = await connectEngineClient(server.path, CONTRACTS_VERSION, {
      installToken: INSTALL_TOKEN,
    });
    try {
      await lead.call("start", {
        request: "Password reset",
        track: "feature",
        repo: "existing",
        has_ui: false,
      });
      const first = (await lead.call("next", {})).actions[0];
      expect(first).toMatchObject({ type: "spawn_role", role: "repo_cartographer" });
      const approve = {
        gates: ["G1" as const],
        decision: "approve" as const,
        frozen: [{ path: ".vtc/spec/spec.md", sha256: "a".repeat(64) }],
      };
      await expect(role.call("approve", approve)).rejects.toThrow(/forbidden/);
      await expect(
        role.call("answer", {
          escalation: "E-1",
          answer: { option: "hint", who_should_have_caught: "qa" },
        }),
      ).rejects.toThrow(/forbidden/);
      await expect(
        role.call("change_request", { artifact: "spec", summary: "x", detail: "y" }),
      ).rejects.toThrow(/forbidden/);
      // the human's cli (its install token matched, D-an) and the Lead are not role sessions
      await expect(cli.call("approve", approve)).rejects.toThrow(/conflict/);
      await expect(lead.call("approve", approve)).rejects.toThrow(/conflict/);
      // a role session may submit one action: its own
      const failure = (action_id: string) => ({
        kind: "failure" as const,
        action_id,
        outcome: {
          kind: "error" as const,
          message: "x",
          retryable: true,
          tokens: null,
          cost_usd: null,
        },
      });
      expect(await role.call("submit", failure("a-1"))).toMatchObject({ accepted: true });
      await expect(role.call("submit", failure("a-2"))).rejects.toThrow(/its own result/);
    } finally {
      await lead.close();
      await role.close();
      await cli.close();
      await server.close();
      await h.release();
    }
  });
  it("a role session that submitted never becomes the Lead (finding lead-only-tools-self-declared-client)", async () => {
    const h = createHarness();
    await start(h);
    only(await next(h), "repo_cartographer");
    await h.engine.settle();
    const engine = h.reopen();
    Object.assign(h, { engine });
    const role = { host: "claude-code" as const, session: "S-role", client: "bridge" as const };
    const lead = { host: "claude-code" as const, session: "S-lead", client: "bridge" as const };
    const approve = {
      gates: ["G1" as const],
      decision: "approve" as const,
      frozen: [{ path: ".vtc/spec/spec.md", sha256: "a".repeat(64) }],
      waived_facts: [],
    };
    // after a restart no Lead is known: the role session submits first and stays a role session
    const failure = SubmitInputSchema.parse({
      kind: "failure",
      action_id: "a-1",
      outcome: { kind: "error", message: "x", retryable: true, tokens: null, cost_usd: null },
    });
    expect(await engine.submit(failure, role)).toMatchObject({ accepted: true });
    await expect(engine.approve(approve, role)).rejects.toThrow(/Lead's tool/);
    await engine.next({}, lead);
    await expect(engine.approve(approve, lead)).rejects.toThrow(/no gate is awaiting/);
    await expect(engine.approve(approve, role)).rejects.toThrow(/Lead's tool/);
    // who claimed the Lead role is logged in the engine's private directory
    const claims = readFileSync(join(guardDirFor(h.home, h.repo), "leads.jsonl"), "utf8");
    expect(claims).toContain('"session":"S-lead"');
    expect(claims).not.toContain('"session":"S-role"');
    await h.release();
  });
});

describe("spawn_role.agent on a host that namespaces plugin agents (AD-14 rule 1)", () => {
  it("names the agent as the host's adapter spawns it; the log keeps the base name", async () => {
    const h = createHarness({ subagentName: (agent) => `vtc:${agent}` });
    await start(h);
    const carto = only(await next(h), "repo_cartographer");
    expect(carto.agent).toBe("vtc:vtc-repo-cartographer");
    const dispatched = events(h).findLast((e) => e.type === "role.dispatched");
    expect(dispatched?.data.agent).toBe("vtc-repo-cartographer");
    expect(dispatched?.prompt_sha).toMatch(/^[a-f0-9]{64}$/);
    await h.release();
  });
  it("leaves the base name when the adapter adds no namespace", async () => {
    const h = createHarness();
    await start(h);
    expect(only(await next(h), "repo_cartographer").agent).toBe("vtc-repo-cartographer");
    await h.release();
  });
});

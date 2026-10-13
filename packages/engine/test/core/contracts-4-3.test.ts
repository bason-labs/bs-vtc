/**
 * Contracts 4.3.0 on the engine side (the hardening round, spine §5 readings 69, 71, 72, 77, 78),
 * driven through the tools on a real repo: human-only tools need a human channel (D-an), a
 * code-running role runs in-session only when the run's Lead session reports its sandbox on
 * (D-an), host config in a worktree is restored before every dispatch (D-ao), every unconfined
 * gate run is an incident (D-al), a host-reported cost counts whatever the model (D-at), and a run
 * needs a committed `gates.yml` (D-au).
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONTRACTS_VERSION,
  engineSocketFile,
  GateReportSchema,
  gatesConfigNotCommitted,
  humanChannelRequired,
  SESSION_DEFAULT_MODEL,
  SESSION_SANDBOX_OFF_REASON,
  SubmitInputSchema,
  type LeadAction,
  type SessionSandboxState,
} from "@vtc/shared";
import { EngineError, type CallContext } from "../../src/core/index.js";
import { NO_LEAD_WAIT_REASON } from "../../src/core/dispatch.js";
import { spendOf, writeRunSummary } from "../../src/core/projections.js";
import { shareSpend } from "../../src/core/queries.js";
import { connectEngineClient, handshake, serveEngineSocket } from "../../src/mcp/index.js";
import type { ToolHost } from "../../src/mcp/index.js";
import { cleanupDirs, git, writeFile } from "../helpers/repo.js";
import { ALL_FIXTURE_ROLES } from "../fixtures/roles.js";
import {
  authorTests,
  build,
  CLAUDE,
  createHarness,
  DEFAULT_GATES_YML,
  draft,
  only,
  spawns,
  SPEC_ONE,
  submitResult,
  throughPlan,
  toPlanner,
  workdir,
  worktreeOf,
  type Harness,
  type SpawnAction,
} from "../helpers/engine-harness.js";

// Whole engine flows on a real repo spawn a few hundred git processes per test: under turbo's
// parallel load the 5 s default is too tight, so they get room on a loaded machine. A real hang
// still fails, and no assertion changes.
vi.setConfig({ testTimeout: 20_000 });

afterEach(cleanupDirs);

const TOKEN = "t".repeat(43);
const VERSIONS = { engine: "vtc-engine@0.0.0", contracts: CONTRACTS_VERSION };

const next = async (h: Harness, call: CallContext = CLAUDE): Promise<LeadAction[]> =>
  (await h.engine.next({}, call)).actions;
interface Line {
  type: string;
  task?: string;
  role?: string;
  host?: string;
  model?: string;
  cost_usd?: number | null;
  data: Record<string, unknown>;
}
const events = (h: Harness): Line[] =>
  readFileSync(join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/events.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Line);
const incidents = (h: Harness, kind: string): Line[] =>
  events(h).filter((e) => e.type === "incident.recorded" && e.data.kind === kind);
const start = (h: Harness, call: CallContext = CLAUDE) =>
  h.engine.start(
    {
      request: "Password reset\n\nUsers reset forgotten passwords.",
      track: "feature",
      repo: "existing",
      has_ui: false,
      risk_hints: [],
    },
    call,
  );
const socketFor = async (h: Harness) =>
  serveEngineSocket({
    path: join(mkdtempSync(join(tmpdir(), "vh-")), engineSocketFile(h.repo)),
    host: h.engine,
    versions: VERSIONS,
    installToken: TOKEN,
  });
const APPROVE = {
  gates: ["G1" as const],
  decision: "approve" as const,
  frozen: [{ path: ".vtc/spec/spec.md", sha256: "a".repeat(64) }],
  waived_facts: [],
};
const ANSWER = { escalation: "E-1", answer: { option: "hint", who_should_have_caught: "qa" } };

describe("human-only tools need a human channel (D-an, spine §5 reading 71)", () => {
  it("refuses approve, answer and change_request from a cli call without a verified token", async () => {
    const h = createHarness();
    await start(h);
    const cli: CallContext = { host: null, client: "cli" };
    await expect(h.engine.approve(APPROVE, cli)).rejects.toThrow(humanChannelRequired("approve"));
    await expect(h.engine.answer(ANSWER as never, cli)).rejects.toThrow(
      humanChannelRequired("answer"),
    );
    await expect(
      h.engine.changeRequest({ artifact: "spec", summary: "x", detail: "y" }, cli),
    ).rejects.toMatchObject({ code: "forbidden" });
    // other tools stay open to the cli
    expect(h.engine.status({}).run.phase).toBe("discover");
    // a cli whose install token matched is a human channel
    const human: CallContext = { host: null, client: "cli", human: true };
    await expect(h.engine.approve(APPROVE, human)).rejects.toThrow(/no gate is awaiting/);
    await expect(h.engine.answer(ANSWER as never, human)).rejects.toThrow(/no escalation E-1/);
    await h.release();
  });
  it("over the socket: a bare cli hello is refused the tools, a matching token is accepted, a wrong one is refused the connection", async () => {
    const h = createHarness();
    await start(h);
    const server = await socketFor(h);
    const bare = await connectEngineClient(server.path);
    const human = await connectEngineClient(server.path, CONTRACTS_VERSION, {
      installToken: TOKEN,
    });
    try {
      expect((await bare.call("status", {})).run.phase).toBe("discover");
      await expect(bare.call("approve", APPROVE)).rejects.toThrow(
        `forbidden: ${humanChannelRequired("approve")}`,
      );
      await expect(bare.call("answer", ANSWER)).rejects.toThrow(/forbidden/);
      await expect(
        bare.call("change_request", { artifact: "spec", summary: "x", detail: "y" }),
      ).rejects.toThrow(/forbidden/);
      await expect(human.call("approve", APPROVE)).rejects.toThrow(/conflict: no gate/);
      await expect(human.call("answer", ANSWER)).rejects.toThrow(/no escalation E-1/);
      await expect(
        connectEngineClient(server.path, CONTRACTS_VERSION, { installToken: "x".repeat(43) }),
      ).rejects.toThrow(/refused the connection: .*install token/);
      // only the cli carries the token: a bridge that sends one is a malformed hello
      await expect(
        handshake(server.path, {
          v: 1,
          client: "bridge",
          host: "claude-code",
          contracts_version: CONTRACTS_VERSION,
          install_token: TOKEN,
        }),
      ).rejects.toThrow(/refused/);
      expect(server.connections()).toEqual({ bridge: 0, cli: 2 });
    } finally {
      await bare.close();
      await human.close();
      await server.close();
      await h.release();
    }
  });
  it("passes the session's sandbox and the verified token into each call's context", async () => {
    const seen: CallContext[] = [];
    const host = {
      next: (_input: unknown, call: CallContext) => {
        seen.push(call);
        return Promise.resolve({
          run: "r20261013-090000",
          actions: [{ type: "wait", reason: "x", until: null }],
        });
      },
    } as unknown as ToolHost;
    const server = await serveEngineSocket({
      path: join(mkdtempSync(join(tmpdir(), "vh-")), "t.sock"),
      host,
      versions: VERSIONS,
      installToken: TOKEN,
    });
    const clients = [
      await connectEngineClient(server.path, CONTRACTS_VERSION, {
        bridge: "claude-code",
        sessionSandbox: "on",
      }),
      await connectEngineClient(server.path, CONTRACTS_VERSION, { bridge: "claude-code" }),
      await connectEngineClient(server.path, CONTRACTS_VERSION, { installToken: TOKEN }),
      await connectEngineClient(server.path),
    ];
    try {
      for (const client of clients) await client.call("next", {});
      expect(seen.map((c) => [c.client, c.sessionSandbox, c.human])).toEqual([
        ["bridge", "on", undefined],
        ["bridge", undefined, undefined],
        ["cli", undefined, true],
        ["cli", undefined, undefined],
      ]);
    } finally {
      for (const client of clients) await client.close();
      await server.close();
    }
  });
  it("the run's Lead session is a human channel; another bridge session is not", async () => {
    const h = createHarness();
    const lead: CallContext = { host: "claude-code", session: "S-lead", client: "bridge" };
    const role: CallContext = { host: "claude-code", session: "S-role", client: "bridge" };
    await start(h, lead);
    await expect(h.engine.approve(APPROVE, role)).rejects.toMatchObject({ code: "forbidden" });
    await expect(h.engine.approve(APPROVE, lead)).rejects.toThrow(/no gate is awaiting/);
    await h.release();
  });
});

/** Through the QA author's submit and its base-fail check; then `next` would dispatch the Engineer. */
const toQaSubmit = async (h: Harness, call: CallContext): Promise<LeadAction[]> => {
  const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
  const qa = only(actions, "qa");
  writeFile(
    worktreeOf(h, "T-1"),
    "tests/acceptance/t-1.test.ts",
    'test("[REQ-1.AC-1] x", () => {});\n',
  );
  const out = await submitResult(
    h,
    qa,
    {
      exit: "done",
      acceptance_tests: ["[REQ-1.AC-1] x"],
      artifacts: [{ type: "acceptance_test", path: "tests/acceptance/t-1.test.ts" }],
    },
    0.1,
    call,
  );
  expect(out.accepted).toBe(true);
  await h.engine.settle();
  return next(h, call);
};
const sandboxed = (
  state: SessionSandboxState | undefined,
  host: "claude-code" | "codex" = "claude-code",
): CallContext => ({ host, ...(state === undefined ? {} : { sessionSandbox: state }) });

// whole engine flows on a real repo: like engine-flow, they get room on a loaded machine
describe(
  "a code-running role runs in-session only in a sandboxed Lead session (D-an)",
  { timeout: 20_000 },
  () => {
    for (const state of ["off", undefined] as const) {
      it(`claude-code, code_sandboxed, sandbox ${state ?? "unknown"}: parks the task as blocked, and answering retries`, async () => {
        const h = createHarness();
        const actions = await toQaSubmit(h, sandboxed(state));
        expect(spawns(actions).map((a) => a.role)).not.toContain("engineer");
        expect(h.engine.status({}).parked).toEqual([
          expect.objectContaining({ task: "T-1", reason: "blocked" }),
        ]);
        const escalation = events(h).find((e) => e.type === "escalation.opened")?.data
          .escalation as {
          id: string;
          detail: string;
          reason: string;
        };
        expect(escalation).toMatchObject({ reason: "blocked", detail: SESSION_SANDBOX_OFF_REASON });
        expect(events(h).some((e) => e.type === "role.dispatched" && e.role === "engineer")).toBe(
          false,
        );
        // still off: answering parks it again, with the same reason
        await h.engine.answer(
          {
            escalation: escalation.id,
            answer: { option: "clarify", text: "retry", who_should_have_caught: "none" },
          },
          sandboxed(state),
        );
        expect(h.engine.status({}).parked).toEqual([
          expect.objectContaining({ task: "T-1", reason: "blocked" }),
        ]);
        const again = events(h).findLast((e) => e.type === "escalation.opened")?.data
          .escalation as {
          id: string;
          detail: string;
        };
        expect(again.detail).toBe(SESSION_SANDBOX_OFF_REASON);
        // the human ran vtc install and restarted the session: the answer retries the dispatch
        const resumed = await h.engine.answer(
          {
            escalation: again.id,
            answer: { option: "clarify", text: "sandbox on now", who_should_have_caught: "none" },
          },
          CLAUDE,
        );
        expect(only(resumed.actions, "engineer").task).toBe("T-1");
        expect(h.engine.status({}).parked).toEqual([]);
        await h.release();
      });
    }
    it("claude-code, code_sandboxed, sandbox on: dispatches the Engineer", async () => {
      const h = createHarness();
      const actions = await toQaSubmit(h, sandboxed("on"));
      expect(only(actions, "engineer").task).toBe("T-1");
      expect(h.engine.status({}).parked).toEqual([]);
      await h.release();
    });
    it("write_scoped and read_only roles run in-session with the sandbox off", async () => {
      const h = createHarness();
      const off = sandboxed("off");
      await start(h, off);
      const carto = only(await next(h, off), "repo_cartographer");
      writeFile(workdir(carto), ".vtc/research/repo-map/map.md", "# map\n");
      const out = await submitResult(
        h,
        carto,
        { exit: "done", artifacts: [{ type: "repo_map", path: ".vtc/research/repo-map/map.md" }] },
        0.1,
        off,
      );
      expect(only(out.actions, "ba").role).toBe("ba");
      expect(h.engine.status({}).parked).toEqual([]);
      await h.release();
    });
    it("a QA author (write_scoped) is dispatched with the sandbox off", async () => {
      const h = createHarness();
      const planner = await toPlanner(h, SPEC_ONE);
      const out = await submitResult(
        h,
        planner,
        { exit: "done", tasks: [draft("T-1")] as never },
        0.1,
        sandboxed("off"),
      );
      expect(out.accepted).toBe(true);
      await h.engine.settle();
      expect(only(await next(h, sandboxed("off")), "qa").task).toBe("T-1");
      await h.release();
    });
    it("codex: an Engineer runs as a Codex subagent with its own sandbox_mode, whatever the session reports", async () => {
      const h = createHarness();
      const actions = await toQaSubmit(h, sandboxed("off", "codex"));
      expect(only(actions, "engineer").task).toBe("T-1");
      expect(events(h).findLast((e) => e.type === "role.dispatched")).toMatchObject({
        role: "engineer",
        host: "codex",
      });
      await h.release();
    });
    it("refuses to consult an advisor with a shell from an unsandboxed Lead session", async () => {
      const shelled = ALL_FIXTURE_ROLES.map((r) =>
        r.id === "advisor_estimator"
          ? { ...r, tools: { ...r.tools, profile: "code_sandboxed" as const } }
          : r,
      );
      const h = createHarness({ roles: shelled });
      await start(h, sandboxed("off"));
      const ask = (call: CallContext) =>
        h.engine.consult({ advisor: "advisor_estimator", question: "How long?", inputs: [] }, call);
      await expect(ask(sandboxed("off"))).rejects.toThrow(/sandbox is not on/);
      await expect(ask(sandboxed(undefined))).rejects.toMatchObject({ code: "conflict" });
      expect((await ask(CLAUDE)).action.role).toBe("advisor_estimator");
      await h.release();
    });
    it("with no Lead session, a caller that cannot be the Lead waits: nothing parks", async () => {
      const h = createHarness();
      // a cli connection never claims the Lead; nobody holds it for this run
      const cli: CallContext = { host: "claude-code", client: "cli" };
      const actions = await toQaSubmit(h, cli);
      expect(spawns(actions)).toEqual([]);
      expect(actions).toEqual([{ type: "wait", reason: NO_LEAD_WAIT_REASON, until: null }]);
      expect(NO_LEAD_WAIT_REASON).toMatch(/no Lead session holds this run/);
      // a bridge session bound to a role action cannot claim it either
      const role: CallContext = { host: "claude-code", session: "S-role", client: "bridge" };
      const { action } = await h.engine.consult(
        { advisor: "advisor_estimator", question: "x?", inputs: [] },
        CLAUDE,
      );
      expect((await submitResult(h, action, { exit: "done" }, 0.01, role)).accepted).toBe(true);
      expect(spawns(await next(h, role))).toEqual([]);
      expect(h.engine.status({}).parked).toEqual([]);
      expect(events(h).some((e) => e.type === "escalation.opened")).toBe(false);
      // the Lead (here in-process, its sandbox on) gets the Engineer
      expect(only(await next(h, CLAUDE), "engineer").task).toBe("T-1");
      await h.release();
    });
    it("uses the run's Lead session's report, not the caller's", async () => {
      const h = createHarness();
      const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
      const qa = only(actions, "qa");
      // the Lead's bridge session claims the run; its session's sandbox is off
      const lead: CallContext = {
        host: "claude-code",
        session: "S-lead",
        client: "bridge",
        sessionSandbox: "off",
      };
      await next(h, lead);
      // another session says "on", but the Lead's session is where the Engineer would run
      const other: CallContext = {
        host: "claude-code",
        session: "S-other",
        client: "bridge",
        sessionSandbox: "on",
      };
      writeFile(
        worktreeOf(h, "T-1"),
        "tests/acceptance/t-1.test.ts",
        'test("[REQ-1.AC-1] x", () => {});\n',
      );
      const out = await submitResult(
        h,
        qa,
        {
          exit: "done",
          acceptance_tests: ["[REQ-1.AC-1] x"],
          artifacts: [{ type: "acceptance_test", path: "tests/acceptance/t-1.test.ts" }],
        },
        0.1,
        other,
      );
      expect(out.accepted).toBe(true);
      await h.engine.settle();
      expect(spawns(await next(h, other)).map((a) => a.role)).not.toContain("engineer");
      expect(h.engine.status({}).parked).toEqual([
        expect.objectContaining({ task: "T-1", reason: "blocked" }),
      ]);
      await h.release();
    });
  },
);

// whole engine flows on a real repo: like engine-flow, they get room on a loaded machine
describe(
  "host config in a worktree is restored before every dispatch (D-ao, reading 72)",
  { timeout: 20_000 },
  () => {
    it("restores .claude, .codex and .mcp.json to the base before the fix round, and records the paths", async () => {
      const h = createHarness({ files: { ".claude/agents/helper.md": "base agent\n" } });
      const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
      await authorTests(h, only(actions, "qa"));
      const engineer = only(await next(h), "engineer");
      expect(incidents(h, "host_config_restored")).toEqual([]);
      h.gates.queue("round", "fail");
      await build(h, engineer);
      // what the role left in its worktree, committed or not, for the next host start there
      const tree = worktreeOf(h, "T-1");
      writeFile(tree, ".codex/config.toml", "notify = ['sh', '-c', 'evil']\n");
      writeFile(tree, ".mcp.json", '{"mcpServers":{"vtc":{"command":"evil"}}}\n');
      writeFile(tree, ".claude/agents/helper.md", "planted\n");
      writeFile(tree, ".claude/settings.local.json", '{"hooks":{}}\n');
      const fix = only(await next(h), "engineer");
      expect(fix.task).toBe("T-1");
      expect(existsSync(join(tree, ".codex/config.toml"))).toBe(false);
      expect(existsSync(join(tree, ".mcp.json"))).toBe(false);
      expect(existsSync(join(tree, ".claude/settings.local.json"))).toBe(false);
      expect(readFileSync(join(tree, ".claude/agents/helper.md"), "utf8")).toBe("base agent\n");
      const [incident] = incidents(h, "host_config_restored");
      expect(incident?.data.detail).toContain("engineer");
      expect(incident?.data.evidence).toEqual(
        [
          ".claude/agents/helper.md",
          ".claude/settings.local.json",
          ".codex/config.toml",
          ".mcp.json",
        ].map((p) => ({ type: "file", ref: `.vtc/state/worktrees/T-1/${p}` })),
      );
      // the dispatch comes after the incident: nothing planted reaches the host start
      const order = events(h).map((e) =>
        e.type === "incident.recorded" ? "incident" : e.type === "role.dispatched" ? e.role : null,
      );
      expect(order.filter((o) => o !== null).slice(-2)).toEqual(["incident", "engineer"]);
      await h.release();
    });
    it("records nothing when the worktree's host config matches its base", async () => {
      const h = createHarness({ files: { ".mcp.json": "{}\n" } });
      const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
      await authorTests(h, only(actions, "qa"));
      only(await next(h), "engineer");
      expect(incidents(h, "host_config_restored")).toEqual([]);
      expect(readFileSync(join(worktreeOf(h, "T-1"), ".mcp.json"), "utf8")).toBe("{}\n");
      await h.release();
    });
  },
);

// whole engine flows on a real repo: like engine-flow, they get room on a loaded machine
describe("an unconfined gate run is an incident (D-al, reading 69)", { timeout: 20_000 }, () => {
  it("records unsandboxed_gate for every gate.result whose report ran with sandbox none", async () => {
    const h = createHarness();
    h.gates.reshape((_request, report) => GateReportSchema.parse({ ...report, sandbox: "none" }));
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    await authorTests(h, only(actions, "qa"));
    const gateResults = events(h).filter((e) => e.type === "gate.result").length;
    expect(gateResults).toBeGreaterThan(0);
    const recorded = incidents(h, "unsandboxed_gate");
    expect(recorded).toHaveLength(gateResults);
    expect(recorded[0]?.data.detail).toMatch(/no OS sandbox/);
    await h.release();
  });
  it("records it even when the report is dropped because the gate changed git config", async () => {
    const h = createHarness();
    h.gates.reshape((request, report) => {
      // the unconfined gate's code writes the repo's git config
      if (request.reason === "base_fail_check") git(h.repo, "config", "filter.evil.clean", "cat");
      return GateReportSchema.parse({ ...report, sandbox: "none" });
    });
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    await authorTests(h, only(actions, "qa"));
    expect(events(h).some((e) => e.type === "gate.result")).toBe(false);
    expect(incidents(h, "checkout_write")).not.toEqual([]);
    const recorded = incidents(h, "unsandboxed_gate");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ task: "T-1" });
    expect(recorded[0]?.data.detail).toMatch(/base_fail_check gate run of T-1 .*no OS sandbox/);
    git(h.repo, "config", "--unset", "filter.evil.clean");
    await h.release();
  });
  it("records nothing for a gate run in an OS sandbox", async () => {
    const h = createHarness();
    h.gates.reshape((_request, report) =>
      GateReportSchema.parse({ ...report, sandbox: "sandbox-exec" }),
    );
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    await authorTests(h, only(actions, "qa"));
    expect(events(h).some((e) => e.type === "gate.result")).toBe(true);
    expect(incidents(h, "unsandboxed_gate")).toEqual([]);
    await h.release();
  });
});

// whole engine flows on a real repo: like engine-flow, they get room on a loaded machine
describe(
  "a host-reported cost counts toward budgets whatever the model (D-at, reading 77)",
  { timeout: 20_000 },
  () => {
    const toEngineer = async (h: Harness): Promise<SpawnAction> => {
      const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
      await authorTests(h, only(actions, "qa"));
      return only(await next(h), "engineer");
    };
    it("counts a session-default or unpriced-model run's cost toward the task budget and shares", async () => {
      const h = createHarness();
      const engineer = await toEngineer(h);
      const spentBefore = h.engine.states().at(-1)?.tasks.get("T-1")?.spent_usd ?? 0;
      writeFile(worktreeOf(h, "T-1"), "src/t-1/impl.ts", "export const x = 1;\n");
      const out = await submitResult(
        h,
        engineer,
        { exit: "built" },
        0.75,
        CLAUDE,
        SESSION_DEFAULT_MODEL,
      );
      expect(out.accepted).toBe(true);
      await h.engine.settle();
      const submitted = events(h).findLast((e) => e.type === "role.submitted");
      expect(submitted).toMatchObject({ model: SESSION_DEFAULT_MODEL, cost_usd: 0.75 });
      const task = h.engine.states().at(-1)?.tasks.get("T-1");
      expect(task?.spent_usd).toBeCloseTo(spentBefore + 0.75, 4);
      await h.release();
    });
    it("parks on the Engineer share when only unknown-model runs spent it", async () => {
      const h = createHarness();
      const engineer = await toEngineer(h);
      const budget = h.engine.states().at(-1)?.tasks.get("T-1")?.budget_usd ?? 0;
      h.gates.queue("round", "fail");
      writeFile(worktreeOf(h, "T-1"), "src/t-1/impl.ts", "export const x = 1;\n");
      await submitResult(h, engineer, { exit: "built" }, budget * 0.5, CLAUDE, "gpt-unknown-9");
      await h.engine.settle();
      expect(spawns(await next(h)).map((a) => a.role)).not.toContain("engineer");
      expect(h.engine.status({}).parked).toEqual([
        expect.objectContaining({ task: "T-1", reason: "budget" }),
      ]);
      await h.release();
    });
    it("counts an unknown-model advisor's cost toward the advisor budget", async () => {
      const h = createHarness({ project: { budgets: { advisor_usd: 0.15 } } });
      await start(h);
      const ask = () =>
        h.engine.consult({ advisor: "advisor_estimator", question: "Spend?", inputs: [] }, CLAUDE);
      const first = (await ask()).action;
      expect(
        (await submitResult(h, first, { exit: "done" }, 0.2, CLAUDE, SESSION_DEFAULT_MODEL))
          .accepted,
      ).toBe(true);
      await expect(ask()).rejects.toThrow(/advisor budget is spent \(\$0\.20 of \$0\.15/);
      await h.release();
    });
    it("counts a failed run's reported cost too (a failed advisor run spends its budget)", async () => {
      const h = createHarness({ project: { budgets: { advisor_usd: 0.15 } } });
      await start(h);
      const { action } = await h.engine.consult(
        { advisor: "advisor_estimator", question: "Spend?", inputs: [] },
        CLAUDE,
      );
      const failed = await h.engine.submit(
        SubmitInputSchema.parse({
          kind: "failure",
          action_id: action.action_id,
          outcome: { kind: "error", message: "x", retryable: false, tokens: null, cost_usd: 0.3 },
        }),
        CLAUDE,
      );
      expect(failed.accepted).toBe(true);
      expect(events(h).findLast((e) => e.type === "role.failed")).toMatchObject({ cost_usd: 0.3 });
      await expect(
        h.engine.consult({ advisor: "advisor_estimator", question: "Again?", inputs: [] }, CLAUDE),
      ).rejects.toThrow(/advisor budget is spent/);
      await h.release();
    });
    const LIMIT = {
      kind: "limit" as const,
      session_ref: { host: "claude-code" as const, id: "sess-9" },
      resets_at: "2026-10-13T13:00:00.000Z",
      window: "five_hour" as const,
      model: null,
      message: "limit",
      tokens: null,
    };
    it("puts a limit-hit run's reported cost on limit.hit and on the run, so the shares count it", async () => {
      const h = createHarness();
      const engineer = await toEngineer(h);
      const failed = await h.engine.submit(
        SubmitInputSchema.parse({
          kind: "failure",
          action_id: engineer.action_id,
          outcome: { ...LIMIT, cost_usd: 0.4 },
        }),
        CLAUDE,
      );
      expect(failed.accepted).toBe(true);
      expect(events(h).findLast((e) => e.type === "limit.hit")).toMatchObject({
        task: "T-1",
        role: "engineer",
        cost_usd: 0.4,
      });
      const state = h.engine.states().at(-1);
      if (state === undefined) throw new Error("no run");
      expect(state.roleRuns.get(engineer.action_id)).toMatchObject({
        status: "interrupted",
        costUsd: 0.4,
      });
      expect(shareSpend(state, "T-1").engineer).toBeCloseTo(0.4, 4);
      // the evidence bundle's spend counts it too, as the task budget does
      const engineerRuns = [...state.roleRuns.values()].filter((r) => r.role === "engineer");
      expect(spendOf(engineerRuns).usd).toBe(0.4);
      await h.release();
    });
    it("a limit-hit advisor run's reported cost spends the advisor budget", async () => {
      const h = createHarness({ project: { budgets: { advisor_usd: 0.15 } } });
      await start(h);
      const { action } = await h.engine.consult(
        { advisor: "advisor_estimator", question: "Spend?", inputs: [] },
        CLAUDE,
      );
      await h.engine.submit(
        SubmitInputSchema.parse({
          kind: "failure",
          action_id: action.action_id,
          outcome: { ...LIMIT, cost_usd: 0.3 },
        }),
        CLAUDE,
      );
      expect(events(h).findLast((e) => e.type === "limit.hit")).toMatchObject({ cost_usd: 0.3 });
      await expect(
        h.engine.consult({ advisor: "advisor_estimator", question: "Again?", inputs: [] }, CLAUDE),
      ).rejects.toThrow(/advisor budget is spent \(\$0\.30 of \$0\.15/);
      await h.release();
    });
    it("reported spend counts failed and interrupted runs' host-reported cost, like the budgets", () => {
      const run = (status: string, costUsd: number | null) => ({ status, costUsd, tokens: null });
      expect(
        spendOf([
          run("submitted", 0.5),
          run("failed", 0.25),
          run("interrupted", 0.125),
          // a failed run that reported nothing is unknown, not unpriced: it adds nothing
          run("failed", null),
        ]).usd,
      ).toBe(0.875);
      // a submitted run with no cost is still unpriced (§11): the total is unknown
      expect(spendOf([run("submitted", null), run("failed", 0.25)]).usd).toBeNull();
    });
    it("notes 'model unknown' in the run summary for runs on the session's default model", async () => {
      const h = createHarness();
      await start(h, { host: "codex" });
      const carto = only(await next(h, { host: "codex" }), "repo_cartographer");
      writeFile(workdir(carto), ".vtc/research/repo-map/map.md", "# map\n");
      await submitResult(
        h,
        carto,
        { exit: "done", artifacts: [{ type: "repo_map", path: ".vtc/research/repo-map/map.md" }] },
        0.4,
        { host: "codex" },
        SESSION_DEFAULT_MODEL,
      );
      const run = h.engine.status({}).run.id;
      const state = h.engine.states().at(-1);
      if (state === undefined) throw new Error("no run");
      writeRunSummary(h.repo, state, [], []);
      const summary = readFileSync(join(h.repo, `.vtc/runs/${run}/summary.md`), "utf8");
      expect(summary).toContain("model unknown");
      expect(summary).toContain("host-reported cost is counted");
      await h.release();
    });
  },
);

describe("a run needs a committed gates.yml (D-au, reading 78)", () => {
  it("refuses to start when .vtc/gates.yml is only in the working tree", async () => {
    const h = createHarness({ gatesYml: null });
    writeFile(h.repo, ".vtc/gates.yml", JSON.stringify(DEFAULT_GATES_YML));
    const head = git(h.repo, "rev-parse", "HEAD");
    const refused = start(h);
    await expect(refused).rejects.toBeInstanceOf(EngineError);
    await expect(start(h)).rejects.toMatchObject({
      code: "config",
      message: gatesConfigNotCommitted(head),
    });
    expect(h.engine.states()).toEqual([]);
    // committed, the run starts
    git(h.repo, "add", ".vtc/gates.yml");
    git(h.repo, "commit", "--quiet", "-m", "calibrate");
    expect((await start(h)).phase).toBe("discover");
    await h.release();
  });
  it("refuses with no gates.yml at all", async () => {
    const h = createHarness({ gatesYml: null });
    await expect(start(h)).rejects.toThrow(/run vtc calibrate, commit \.vtc\/gates\.yml/);
    await h.release();
  });
});

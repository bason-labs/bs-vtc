/**
 * D-cf (spine §5 reading 200; `hostWebRoute`): a `host_web` role (the Research Analyst) never gets
 * model-directed live fetching on a host that cannot deny its reads. When Claude Code can run it,
 * it runs there; else on the Lead's host when that host's web search is safe
 * (`HostCapabilities.safeHostWeb`); else on the Lead's host without host web search, with the
 * engine's own fetchers, and the run shows `HOST_WEB_OFF_NOTICE` in `NextResult.notices` once.
 */
import { afterEach, describe, expect, it } from "vitest";
import { HOST_WEB_OFF_NOTICE, type HostOutcome } from "@vtc/shared";
import type { CallContext } from "../../src/core/index.js";
import { cleanupDirs, writeFile } from "../helpers/repo.js";
import {
  CLAUDE,
  createHarness,
  type Harness,
  type HeadlessScript,
} from "../helpers/engine-harness.js";

// the temp repos and VTC homes go after each test
afterEach(cleanupDirs);

const CODEX: CallContext = { host: "codex" };

/** The DISCOVER role of a new idea, done well: it writes its brief where it works. */
const researcher: HeadlessScript = (request): HostOutcome => {
  writeFile(request.cwd, ".vtc/research/brief.md", "# Brief\n");
  return {
    kind: "done",
    session_ref: null,
    output: {
      role: request.role,
      summary: "done",
      exit: "done",
      artifacts: [{ type: "research_brief", path: ".vtc/research/brief.md" }],
    },
    model: "m",
    tokens: { in: 1, out: 1, cache_r: 0, cache_w: 0 },
    cost_usd: 0.01,
  };
};

const startNew = (h: Harness, call: CallContext) =>
  h.engine.start(
    {
      request: "Recipe sharing\n\nPeople share recipes.",
      track: "feature",
      repo: "new",
      has_ui: false,
      risk_hints: [],
    },
    call,
  );

describe("host_web roles are routed where host web search is safe (D-cf, reading 200)", () => {
  it("on a Codex Lead with Claude Code available, the Research Analyst runs headless on Claude Code with host web", async () => {
    const h = createHarness({
      capabilities: { safeHostWeb: true },
      headless: researcher,
      codex: { headless: researcher },
    });
    await startNew(h, CODEX);
    const result = await h.engine.next({}, CODEX);
    await h.engine.settle();
    expect(h.launched.map((l) => [l.host, l.request.role])).toEqual([
      ["claude-code", "research_analyst"],
    ]);
    expect(h.launched[0]?.request.sandbox.host).toBe("claude-code");
    expect(h.sandboxRequests.at(-1)?.tools.host_web).toBe(true);
    expect(result.notices).toBeUndefined();
    await h.release();
  });

  it("with only Codex, whose web search is not confirmed safe, it runs without host web and the Lead relays HOST_WEB_OFF_NOTICE once", async () => {
    const h = createHarness({
      // Claude Code is installed but cannot run anything for this run
      capabilities: { subagents: false, headless: false },
      codex: { headless: researcher },
    });
    await startNew(h, CODEX);
    const first = await h.engine.next({}, CODEX);
    await h.engine.settle();
    expect(h.launched.map((l) => [l.host, l.request.role])).toEqual([
      ["codex", "research_analyst"],
    ]);
    // the request names no host web: the adapter configures web_search "disabled"
    expect(
      h.sandboxRequests.find((r) => r.cwd === h.launched[0]?.request.cwd)?.tools.host_web,
    ).toBe(false);
    // the engine-driven dispatch relays it while it runs, so it reaches the first `next` or, when
    // that dispatch finished after the notices were taken, the one after the settle: once in all
    const second = await h.engine.next({}, CODEX);
    expect([...(first.notices ?? []), ...(second.notices ?? [])]).toEqual([HOST_WEB_OFF_NOTICE]);
    const third = await h.engine.next({}, CODEX);
    expect(third.notices).toBeUndefined();
    await h.release();
  });

  it("with only Codex and its cached web search confirmed safe, it runs on Codex with host web and no notice", async () => {
    const h = createHarness({
      capabilities: { subagents: false, headless: false },
      codex: { headless: researcher, capabilities: { safeHostWeb: true } },
    });
    await startNew(h, CODEX);
    const result = await h.engine.next({}, CODEX);
    await h.engine.settle();
    expect(h.launched.map((l) => l.host)).toEqual(["codex"]);
    expect(
      h.sandboxRequests.find((r) => r.cwd === h.launched[0]?.request.cwd)?.tools.host_web,
    ).toBe(true);
    expect(result.notices).toBeUndefined();
    await h.release();
  });

  it("on its Lead's own host without safe web search, it never runs in session: headless without host web, with the notice", async () => {
    // only Claude Code, its web search not safe here: the route is the Lead's host, hostWeb off
    const h = createHarness({ capabilities: { safeHostWeb: false }, headless: researcher });
    await startNew(h, CLAUDE);
    const first = await h.engine.next({}, CLAUDE);
    await h.engine.settle();
    expect(first.actions.some((a) => a.type === "spawn_role")).toBe(false);
    expect(h.launched.map((l) => [l.host, l.request.role])).toEqual([
      ["claude-code", "research_analyst"],
    ]);
    expect(
      h.sandboxRequests.find((r) => r.cwd === h.launched[0]?.request.cwd)?.tools.host_web,
    ).toBe(false);
    const second = await h.engine.next({}, CLAUDE);
    expect([...(first.notices ?? []), ...(second.notices ?? [])]).toEqual([HOST_WEB_OFF_NOTICE]);
    await h.release();
  });

  it("and when that host cannot run it headless either, the step is refused, never run in session", async () => {
    const h = createHarness({ capabilities: { safeHostWeb: false, headless: false } });
    await startNew(h, CLAUDE);
    const result = await h.engine.next({}, CLAUDE);
    expect(result.actions.some((a) => a.type === "spawn_role")).toBe(false);
    expect(h.launched).toEqual([]);
    // a phase step: the human gets an escalation saying why
    expect(h.engine.status({}).open_escalations).toBe(1);
    await h.release();
  });

  it("a role without host_web is not rerouted", async () => {
    const h = createHarness({
      capabilities: { safeHostWeb: true },
      headless: researcher,
      codex: { headless: researcher },
    });
    await h.engine.start(
      {
        request: "Password reset\n\nUsers reset passwords.",
        track: "feature",
        repo: "existing",
        has_ui: false,
        risk_hints: [],
      },
      CODEX,
    );
    await h.engine.next({}, CODEX);
    await h.engine.settle();
    expect(h.launched.map((l) => [l.host, l.request.role])).toEqual([
      ["codex", "repo_cartographer"],
    ]);
    await h.release();
  });
});

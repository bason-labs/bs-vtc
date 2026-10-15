/**
 * D-cs (spine §5 reading 221 (1)): the engine records a role run's shell calls as normalised
 * shapes on `role.submitted.command_shapes`: a headless run's from its adapter's stream, an
 * in-session subagent's from the hook's spool in the engine's private directory, which the engine
 * drains for the dispatch (agent, working directory, time) and truncates.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  COMMAND_SHAPE_SPOOL_FILE,
  commandShapes,
  countCommandShapes,
  type CommandShapeSpoolRow,
  type HostOutcome,
  type LeadAction,
} from "@vtc/shared";
import { capabilitySignalFacts, loadRuns, type CallContext } from "../../src/core/index.js";
import { drainCommandShapeSpool, SPOOL_ROW_MAX_AGE_MS } from "../../src/core/command-shapes.js";
import { ensurePrivateDir } from "../../src/core/guard.js";
import { cleanupDirs, tempDir, writeFile } from "../helpers/repo.js";
import {
  authorTests,
  createHarness,
  draft,
  only,
  SPEC_ONE,
  submitResult,
  throughPlan,
  workdir,
  worktreeOf,
  type Harness,
  type HeadlessScript,
} from "../helpers/engine-harness.js";

vi.setConfig({ testTimeout: 30_000 });
afterEach(cleanupDirs);

const AT = "2026-10-13T09:00:00.000Z";
const shape = (command: string) => commandShapes(command)[0]!;
const row = (over: Partial<CommandShapeSpoolRow> & { command?: string }): string => {
  const { command, ...rest } = over;
  return `${JSON.stringify({
    v: 1,
    at: AT,
    agent: "vtc:vtc-qa-author",
    cwd: "/w/T-1",
    shape: shape(command ?? "git status --short"),
    ...rest,
  })}\n`;
};
const spool = (dir: string): string => join(dir, COMMAND_SHAPE_SPOOL_FILE);

describe("drainCommandShapeSpool (D-cs)", () => {
  const match = { agents: ["vtc-qa-author"], cwd: "/w/T-1", since: "2026-10-13T08:00:00.000Z" };
  const now = new Date("2026-10-13T10:00:00.000Z");

  it("takes the dispatch's rows (agent, cwd inside its worktree, after the dispatch) and keeps the rest", () => {
    const dir = tempDir("guard-");
    const other = row({ agent: "vtc:vtc-engineer-backend" });
    const elsewhere = row({ cwd: "/w/T-2" });
    const before = row({ at: "2026-10-13T07:00:00.000Z" });
    writeFileSync(
      spool(dir),
      [
        row({}),
        other,
        "not json\n",
        elsewhere,
        row({ cwd: "/w/T-1/src", command: "pnpm test --run" }),
        before,
        JSON.stringify({ v: 1, at: AT }) + "\n",
      ].join(""),
    );
    expect(drainCommandShapeSpool(dir, match, now)).toEqual([
      shape("git status --short"),
      shape("pnpm test --run"),
    ]);
    // the bad lines are gone; the rows of other dispatches stay for them
    expect(readFileSync(spool(dir), "utf8")).toBe([other, elsewhere, before].join(""));
    // drained once: a second drain finds nothing
    expect(drainCommandShapeSpool(dir, match, now)).toEqual([]);
  });

  it("drops rows no dispatch can claim any more, and keeps a line still being written", () => {
    const dir = tempDir("guard-");
    const old = new Date(now.getTime() - SPOOL_ROW_MAX_AGE_MS - 1).toISOString();
    const partial = '{"v":1,"at":"2026';
    writeFileSync(spool(dir), `${row({ at: old, agent: "x" })}${row({ agent: "y" })}${partial}`);
    expect(drainCommandShapeSpool(dir, match, now)).toEqual([]);
    expect(readFileSync(spool(dir), "utf8")).toBe(`${row({ agent: "y" })}${partial}`);
  });

  it("finds nothing in a missing spool", () => {
    expect(drainCommandShapeSpool(tempDir("guard-"), match, now)).toEqual([]);
  });
});

const CODEX: CallContext = { host: "codex" };
const CLAUDE_LEAD: CallContext = { host: "claude-code", sessionSandbox: "on" };
interface Line {
  type: string;
  role?: string;
  task?: string;
  data: Record<string, unknown>;
}
const submitted = (h: Harness, role: string): Line[] =>
  readFileSync(join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/events.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Line)
    .filter((e) => e.type === "role.submitted" && e.role === role);

describe("role.submitted.command_shapes (D-cs)", () => {
  it("drains an in-session subagent's spool rows into its role.submitted", async () => {
    const h = createHarness();
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    const qa = only(actions, "qa");
    const guard = h.engine.guardDir;
    ensurePrivateDir(guard);
    const at = h.clock.toISOString();
    const mine = { agent: `vtc:${qa.agent}`, cwd: workdir(qa), at };
    const theirs = row({ agent: "vtc:vtc-ba", cwd: workdir(qa), at });
    writeFileSync(
      spool(guard),
      [
        row({ ...mine, command: "pnpm test" }),
        row({ ...mine, command: "pnpm test" }),
        row({ ...mine, cwd: join(workdir(qa), "tests"), command: "git status -s" }),
        theirs,
      ].join(""),
    );
    await authorTests(h, qa);
    const [qaSubmitted] = submitted(h, "qa");
    expect(qaSubmitted?.data.command_shapes).toEqual([
      { ...shape("pnpm test"), count: 2 },
      { ...shape("git status -s"), count: 1 },
    ]);
    expect(readFileSync(spool(guard), "utf8")).toBe(theirs);
    await h.release();
  });

  it("records none when the spool holds none of the run's", async () => {
    const h = createHarness();
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    await authorTests(h, only(actions, "qa"));
    expect(submitted(h, "qa")[0]?.data).not.toHaveProperty("command_shapes");
    await h.release();
  });

  it("counts a headless run's shapes from its adapter's stream", async () => {
    const script: HeadlessScript = (request) => {
      writeFile(request.cwd, ".vtc/research/repo-map/map.md", "# map\n");
      const outcome: HostOutcome = {
        kind: "done",
        session_ref: null,
        output: {
          summary: "done",
          role: "repo_cartographer",
          exit: "done",
          artifacts: [{ type: "repo_map", path: ".vtc/research/repo-map/map.md" }],
        },
        model: "gpt-x",
        tokens: { in: 1, out: 1, cache_r: 0, cache_w: 0 },
        cost_usd: 0.01,
      };
      return {
        outcome,
        lines: [
          JSON.stringify({ command: "git log --oneline -5 && rg -n foo src" }),
          JSON.stringify({ command: "git log --oneline" }),
          "not a json line",
        ],
      };
    };
    const h = createHarness({ codex: { headless: script } });
    await h.engine.start(
      {
        request: "Password reset\n\nUsers reset forgotten passwords.",
        track: "feature",
        repo: "existing",
        has_ui: false,
        risk_hints: [],
      },
      CODEX,
    );
    const actions: LeadAction[] = (await h.engine.next({}, CODEX)).actions;
    expect(actions.some((a) => a.type === "spawn_role")).toBe(false);
    await h.engine.settle();
    expect(submitted(h, "repo_cartographer")[0]?.data.command_shapes).toEqual(
      countCommandShapes([
        ...commandShapes("git log --oneline -5 && rg -n foo src"),
        ...commandShapes("git log --oneline"),
      ]),
    );
    expect((submitted(h, "repo_cartographer")[0]?.data.command_shapes as unknown[]).length).toBe(3);
    await h.release();
  });
});

describe("missing_capability on the escalation records (D-cs)", () => {
  it("keeps the role's on escalation.opened and the Lead's on escalation.answered; two raise a capability fact", async () => {
    const h = createHarness();
    const actions = await throughPlan(h, [draft("T-1")], SPEC_ONE);
    const qa = only(actions, "qa");
    writeFile(worktreeOf(h, "T-1"), "tests/acceptance/t-1.test.ts", "test\n");
    await submitResult(h, qa, {
      exit: "done",
      acceptance_tests: ["t"],
      artifacts: [{ type: "acceptance_test", path: "tests/acceptance/t-1.test.ts" }],
      questions: [
        {
          question: "Which browser runs the flow?",
          options: [
            { id: "yes", label: "Yes", effect: "clarify" },
            { id: "no", label: "No", effect: "clarify" },
          ],
          recommended: "yes",
          evidence: [{ type: "spec_ref", ref: "REQ-1.AC-1" }],
          missing_capability: {
            slug: "browser_automation",
            reason: "the acceptance flow needs a browser",
          },
        },
      ],
    });
    await h.engine.settle();
    const [question] = h.engine.escalations({}).escalations;
    expect(question?.missing_capability).toEqual({
      slug: "browser_automation",
      reason: "the acceptance flow needs a browser",
    });
    await h.engine.answer(
      {
        escalation: question?.id ?? "",
        answer: {
          option: "yes",
          who_should_have_caught: "none",
          missing_capability: { slug: "browser_automation", reason: "no headless browser tool" },
        },
      },
      CLAUDE_LEAD,
    );
    const log = readFileSync(
      join(h.repo, `.vtc/runs/${h.engine.status({}).run.id}/events.jsonl`),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Line);
    const answered = log.find((e) => e.type === "escalation.answered");
    expect(answered?.data.answer).toMatchObject({
      missing_capability: { slug: "browser_automation", reason: "no headless browser tool" },
    });
    // one escalation named it (twice): no signal yet
    const [run] = loadRuns(h.repo);
    const base = { run: "r", source: "run.finished", at: "2026-10-13T09:00:00.000Z" };
    expect(capabilitySignalFacts([run!.state], base)).toEqual([]);
    // another run's escalation with the same slug makes two
    const other = {
      id: "r-other",
      events: [
        {
          type: "escalation.opened",
          data: {
            escalation: {
              id: "E-1",
              missing_capability: { slug: "browser_automation", reason: "x" },
            },
          },
        },
      ] as never,
    };
    expect(capabilitySignalFacts([run!.state, other], base)).toMatchObject([
      {
        kind: "capability",
        subject: "browser_automation",
        metrics: { "capability.escalations": 2 },
      },
    ]);
    await h.release();
  });
});

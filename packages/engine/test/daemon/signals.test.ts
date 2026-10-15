/**
 * The tool and capability signals (D-cs; spine §5 reading 221), from the run logs to an issue: a
 * command shape the roles ran in 3 or more tasks raises a `tool` fact, a missing capability named
 * on 2 or more escalations a `capability` fact; at a run's end the daemon hands both to the real
 * upstream module, which opens VTC's issue (in-memory GitHub, D-cc: no real gh).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  commandShapeKey,
  COMMAND_SHAPE_SUBCOMMAND_PROGRAMS,
  commandShapes,
  countCommandShapes,
  type AutomationDeps,
  type VtcEvent,
} from "@vtc/shared";
import {
  capabilitySignalFacts,
  toolShapeUpstreamKey,
  toolSignalFacts,
  TOOL_SUBCOMMAND_PROGRAMS,
  type Engine,
  type EventDraft,
} from "../../src/core/index.js";
import { wireAutomation } from "../../src/daemon/automation.js";
import { routingConfigFact } from "../../src/daemon/index.js";
import { bridgeUpstream } from "../../src/daemon/upstream-bridge.js";
import { createUpstream } from "../../src/upstream/index.js";
import { cleanupDirs, tempDir } from "../helpers/repo.js";
import { fakeAssets, memoryGitHub } from "../upstream/fakes.js";

afterEach(cleanupDirs);

const AT = "2026-10-15T10:00:00.000Z";
const BASE = { run: "R-2", source: "run.finished", at: AT };
const PNPM = commandShapes("pnpm vitest run --reporter=dot")[0]!;
const GIT = commandShapes("git status")[0]!;

const submitted = (task: string | undefined, ...commands: string[]): VtcEvent =>
  ({
    type: "role.submitted",
    ...(task === undefined ? {} : { task }),
    data: {
      action_id: "a",
      exit: "done",
      findings: 0,
      questions: 0,
      session_ref: null,
      command_shapes: countCommandShapes(commands.flatMap(commandShapes)),
    },
  }) as unknown as VtcEvent;

const escalation = (id: string, slug?: string): VtcEvent =>
  ({
    type: "escalation.opened",
    data: {
      escalation: {
        id,
        ...(slug === undefined ? {} : { missing_capability: { slug, reason: "a local reason" } }),
      },
    },
  }) as unknown as VtcEvent;

const answered = (id: string, slug: string): VtcEvent =>
  ({
    type: "escalation.answered",
    data: {
      escalation: id,
      answer: {
        option: "retry",
        who_should_have_caught: "none",
        missing_capability: { slug, reason: "the Lead's reason" },
      },
    },
  }) as unknown as VtcEvent;

describe("toolSignalFacts (D-cs)", () => {
  it("raises a shape seen in 3 distinct tasks across the repo's runs, with the task count only", () => {
    const states = [
      {
        id: "R-1",
        events: [submitted("T-1", "pnpm vitest run"), submitted("T-1", "pnpm vitest run")],
      },
      {
        id: "R-2",
        events: [
          submitted("T-1", "pnpm vitest run --reporter=dot", "git status"),
          submitted("T-2", "pnpm vitest run --reporter=json && git status"),
          // a run with no task (a phase role, a replay trial) does not count
          submitted(undefined, "git status"),
        ],
      },
    ];
    // `--reporter=dot` and `--reporter=json` are the same flag name: one shape
    expect(toolSignalFacts(states, BASE)).toEqual([]);
    states.push({ id: "R-3", events: [submitted("T-1", "pnpm vitest run --reporter=x")] });
    expect(toolSignalFacts(states, BASE)).toEqual([
      {
        ...BASE,
        target: "upstream",
        kind: "tool",
        // pnpm's next word may be a project script: the upstream subject leaves it out
        subject: commandShapeKey({ program: "pnpm", flags: PNPM.flags }),
        metrics: { "tool.tasks": 3 },
        detail: expect.stringContaining("3 tasks") as string,
      },
    ]);
    // R-1's T-1 and R-2's T-1 are two tasks; git status ran in 1 + 1 of them
    expect(JSON.stringify(toolSignalFacts(states, BASE))).not.toContain(commandShapeKey(GIT));
  });

  it("never sends a project's host or database name: only a known multi-command program keeps its subcommand", () => {
    const states = ["T-1", "T-2", "T-3"].map((task, i) => ({
      id: `R-${String(i)}`,
      events: [
        submitted(task, "ssh prod-db uptime", "psql acme_orders -c 'select 1'", "git rebase main"),
      ],
    }));
    const facts = toolSignalFacts(states, BASE);
    const text = JSON.stringify(facts);
    expect(text).not.toContain("prod-db");
    expect(text).not.toContain("acme_orders");
    expect(facts.map((f) => (f.subject ?? "").split(" ").slice(0, 2).join(" "))).toEqual([
      "git rebase",
      "psql -",
      "ssh -",
    ]);
    expect(TOOL_SUBCOMMAND_PROGRAMS.has("git")).toBe(true);
    // since 5.5.0 the shape itself keeps no subcommand after ssh (reading 228)
    expect(commandShapes("ssh prod-db uptime")[0]?.subcommand).toBeUndefined();
    // the run's own log keeps a package manager's script name; the upstream key leaves it out
    const [script] = commandShapes("pnpm acme-migrate");
    expect(script?.subcommand).toBe("acme-migrate");
    expect(toolShapeUpstreamKey(script!)).toBe(
      commandShapeKey({ program: "pnpm", flags: script!.flags }),
    );
    // the upstream list only narrows the shared one (a program outside it has no subcommand)
    for (const program of TOOL_SUBCOMMAND_PROGRAMS)
      expect(COMMAND_SHAPE_SUBCOMMAND_PROGRAMS).toContain(program);
  });
});

describe("capabilitySignalFacts (D-cs)", () => {
  it("raises a slug named on 2 escalations, by a role or the Lead, with the count only", () => {
    const one = [{ id: "R-1", events: [escalation("E-1", "browser_automation")] }];
    expect(capabilitySignalFacts(one, BASE)).toEqual([]);
    // the same escalation named again by the Lead counts once
    one[0]!.events.push(answered("E-1", "browser_automation"));
    expect(capabilitySignalFacts(one, BASE)).toEqual([]);
    const two = [
      ...one,
      { id: "R-2", events: [escalation("E-1"), answered("E-1", "browser_automation")] },
    ];
    const facts = capabilitySignalFacts(two, BASE);
    expect(facts).toEqual([
      {
        ...BASE,
        target: "upstream",
        kind: "capability",
        subject: "browser_automation",
        metrics: { "capability.escalations": 2 },
        detail: "2 escalations named the missing capability browser_automation",
      },
    ]);
    // the reason text stays local
    expect(JSON.stringify(facts)).not.toContain("reason");
  });
});

describe("the tool and capability signals become VTC issues (D-cs)", () => {
  it("hands both to the upstream module at a run's end, which opens one issue each; a routing proposal too (D-cn)", async () => {
    const github = memoryGitHub({ now: () => new Date(AT) });
    const automation: AutomationDeps = {
      issues: github.issues,
      pullRequests: github.pullRequests,
      upstream: { repo: "bason-labs/bs-vtc", share: true },
      hosting: "branch",
      ffmpeg: false,
    };
    const events: VtcEvent[] = [
      submitted("T-1", "pnpm vitest run"),
      submitted("T-2", "pnpm vitest run"),
      submitted("T-3", "pnpm vitest run"),
      escalation("E-1", "db_migration_runner"),
      answered("E-2", "db_migration_runner"),
    ];
    let listener: ((event: VtcEvent) => void) | undefined;
    const guardDir = tempDir("vtc-guard-");
    const engine = {
      guardDir,
      states: () => [
        {
          id: "R-1",
          run: { finished_at: AT, paused: false },
          automation: null,
          findings: new Map(),
          roleRuns: new Map(),
          tasks: new Map(),
          events,
        },
      ],
      config: () => ({}),
      recordModuleEvent: (_run: string, _draft: EventDraft): boolean => false,
      onEvent: (fn: (event: VtcEvent) => void) => {
        listener = fn;
        return () => {
          listener = undefined;
        };
      },
      relay: () => undefined,
      notice: () => undefined,
    } as unknown as Engine;
    const wiring = wireAutomation(
      engine,
      {
        repoRoot: tempDir("acme-app-"),
        vtcHome: tempDir("vtc-home-"),
        automation,
        now: () => new Date(AT),
      },
      {
        githubRemote: true,
        sweepEveryMs: 60 * 60_000,
        createUpstream: bridgeUpstream(createUpstream, {
          guardDir,
          vtcVersion: "0.5.0",
          assets: fakeAssets(),
          remoteUrl: "git@github.com:acme/app.git",
          clientNames: () => [],
          knownValues: () => [],
          redactSelectors: () => undefined,
          projectEvidence: () => undefined,
          lookbackPr: () => Promise.resolve("none"),
          evidenceSnapshot: () => ({ routes: {}, events: [] }),
          gitOps: () => ({ readFileAtCommit: () => Promise.resolve(undefined) }),
          remoteRefs: () => ({
            fetch: () => Promise.resolve(),
            message: () => Promise.resolve(null),
          }),
          plumbing: () => {
            throw new Error("no PR in this test");
          },
        }),
      },
    );
    listener?.({
      ts: AT,
      seq: 9,
      run: "R-1",
      actor: "engine",
      type: "run.finished",
      data: { outcome: "completed" },
    } as unknown as VtcEvent);
    await wiring.idle();
    // D-cn: a routing proposal Lookback made at RETRO is a config fact, raised the same way
    wiring.improvements([
      routingConfigFact(
        "R-1",
        {
          role: "engineer",
          size: "S",
          risk: "none",
          metrics: { "routing.tasks": 12 },
          detail: "a local note about the project's tasks",
        },
        AT,
      ),
    ]);
    await wiring.idle();
    expect(
      github.state.issues
        .map((i) => [i.repo, i.labels.find((l) => l.startsWith("vtc:kind/"))])
        .sort(),
    ).toEqual([
      ["bason-labs/bs-vtc", "vtc:kind/capability"],
      ["bason-labs/bs-vtc", "vtc:kind/config"],
      ["bason-labs/bs-vtc", "vtc:kind/tool"],
    ]);
    // nothing of the project: no reason text, no command values
    const bodies = JSON.stringify(github.state.issues);
    expect(bodies).not.toContain("the Lead's reason");
    expect(bodies).not.toContain("vitest run");
    expect(bodies).not.toContain("a local note");
    await wiring.close();
  });
});

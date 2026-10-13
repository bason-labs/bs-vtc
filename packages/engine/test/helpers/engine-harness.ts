/**
 * An engine on a real temp git repo (with a local bare remote) and fakes for everything outside
 * engine core: the Gate Runner (programmable verdicts, a real write-scope check over git), the PR
 * service, the auto-resume timer, host adapters and the clock.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  GateReportSchema,
  SubmitInputSchema,
  type GateReport,
  type GateRunner,
  type GateRunRequest,
  type HostAdapter,
  type LeadAction,
  type PullRequestRef,
  type RoleResultInput,
  type ToolFinding,
  type WriteScopeReport,
} from "@vtc/shared";
import {
  acquireEngineLock,
  createPluginCatalog,
  Engine,
  createRoleRegistry,
  type EngineCoreDeps,
} from "../../src/core/index.js";
import { createGitOps, createWorkspace, type PullRequestService } from "../../src/git/index.js";
import { globMatch } from "../../src/core/globs.js";
import { ALL_FIXTURE_ROLES } from "../fixtures/roles.js";
import { addBareRemote, initRepo, tempDir, writeFile } from "./repo.js";

export type SpawnAction = Extract<LeadAction, { type: "spawn_role" }>;

export const SPEC = [
  "# Password reset",
  "",
  "## REQ-1 Reset token store",
  "",
  "- REQ-1.AC-1: Given a reset request When a token is issued Then only its hash is stored.",
  "",
  "## REQ-2 Reset endpoint",
  "",
  "- REQ-2.AC-1: Given an expired token When it is submitted Then the reset is refused.",
  "",
].join("\n");

type ToolFindingInput = ToolFinding;

/** A tool finding of a fake scanner, for gates that fail with parsed findings. */
export const toolFinding = (
  rule: string,
  label: string,
  path = "src/t-1/impl.ts",
): ToolFinding => ({
  tool: "opengrep",
  rule_id: rule,
  category: "correctness",
  title: rule,
  location: { path },
  evidence: { type: "file", ref: path },
  label,
});

/** A spec with one requirement, for single-task tests. */
export const SPEC_ONE = [
  "# Password reset",
  "",
  "## REQ-1 Reset token store",
  "",
  "- REQ-1.AC-1: Given a reset request When a token is issued Then only its hash is stored.",
  "",
].join("\n");

type Verdict =
  | "pass"
  | "fail"
  | "infra"
  /** A failure the Gate Runner classified `flaky` (§6.3 step 8: one re-run). */
  | "flaky"
  | { readonly fail: readonly ToolFindingInput[] };

export interface FakeGates extends GateRunner {
  readonly requests: GateRunRequest[];
  /** Holds every run until the returned function is called (a gate run in progress). */
  hold(): () => void;
  /** Verdicts to return next for a reason (queue); default: pass, and fail for base_fail_check. */
  queue(reason: GateRunRequest["reason"], ...verdicts: Verdict[]): void;
}

const report = (request: GateRunRequest, verdict: Verdict, now: Date): GateReport => {
  const failed = verdict !== "pass";
  const findings = typeof verdict === "object" ? verdict.fail : [];
  return GateReportSchema.parse({
    run: request.run,
    ...(request.task === undefined ? {} : { task: request.task }),
    ...(request.feature === undefined ? {} : { feature: request.feature }),
    reason: request.reason,
    scope: request.scope,
    base: request.base,
    head: request.head,
    expect: request.expect,
    results: [
      {
        gate_id: "tests",
        layer: "L2",
        phase: "verify",
        status: failed ? "fail" : "pass",
        blocking: true,
        new_violations: findings.length,
        baseline_violations: 0,
        findings,
        ...(failed
          ? {
              failure_class:
                verdict === "infra" ? "infra" : verdict === "flaky" ? "flaky" : "product",
            }
          : {}),
        evidence: [],
        duration_ms: 5,
      },
    ],
    verdict: verdict === "pass" ? "pass" : verdict === "infra" ? "infra_error" : "fail",
    started_at: now.toISOString(),
    finished_at: now.toISOString(),
  });
};

export const fakeGates = (repoRoot: string, now: () => Date): FakeGates => {
  const git = createGitOps({ repoRoot });
  const queues = new Map<string, Verdict[]>();
  const requests: GateRunRequest[] = [];
  let held: Promise<void> | null = null;
  return {
    requests,
    hold: () => {
      let release: () => void = () => undefined;
      held = new Promise((resolve) => {
        release = () => {
          held = null;
          resolve();
        };
      });
      return release;
    },
    queue: (reason, ...verdicts) => {
      queues.set(reason, [...(queues.get(reason) ?? []), ...verdicts]);
    },
    run: async (request) => {
      requests.push(request);
      if (held !== null) await held;
      const queued = queues.get(request.reason)?.shift();
      const verdict = queued ?? (request.reason === "base_fail_check" ? "fail" : "pass");
      return report(request, verdict, now());
    },
    checkWriteScope: async (request): Promise<WriteScopeReport> => {
      const violations: WriteScopeReport["violations"] = [];
      for (const file of await git.changedFiles(request.base, request.head)) {
        const guarded = request.protected.find((p) => p.path === file.path);
        if (guarded !== undefined) {
          const bytes = await git.readFileAtCommit(request.head, file.path);
          const sum = bytes === undefined ? null : createHash("sha256").update(bytes).digest("hex");
          if (sum === null) violations.push({ kind: "protected_deleted", path: file.path });
          else if (sum !== guarded.sha256)
            violations.push({ kind: "protected_modified", path: file.path });
          continue;
        }
        if (!request.filesScope.some((g) => globMatch(g, file.path))) {
          violations.push({ kind: "out_of_scope_write", path: file.path });
        }
      }
      return { ok: violations.length === 0, violations };
    },
  };
};

export const fakePullRequests = (): PullRequestService & { readonly calls: string[] } => {
  const calls: string[] = [];
  let pr: PullRequestRef | null = null;
  return {
    calls,
    upsertDraft: (request) => {
      calls.push(`upsert ${request.branch} -> ${request.base}`);
      pr = {
        url: "https://github.com/acme/app/pull/7",
        draft: pr?.draft ?? true,
        state: "open",
        head_sha: "f".repeat(40),
        ci: "unknown",
      };
      return Promise.resolve(pr);
    },
    markReady: (branch) => {
      calls.push(`ready ${branch}`);
      pr = {
        url: "https://github.com/acme/app/pull/7",
        draft: false,
        state: "open",
        head_sha: "f".repeat(40),
        ci: "pending",
      };
      return Promise.resolve(pr);
    },
    view: () => Promise.resolve(pr),
  };
};

export interface Harness {
  readonly repo: string;
  readonly remote: string;
  /** The VTC home (outside the repo): the engine's private directory lives under it. */
  readonly home: string;
  readonly engine: Engine;
  readonly gates: FakeGates;
  readonly prs: ReturnType<typeof fakePullRequests>;
  readonly scheduled: { at: Date | null; cancelled: number };
  readonly spawned: string[];
  clock: Date;
  advance(ms: number): void;
  reopen(): Engine;
  release(): Promise<void>;
  deps: EngineCoreDeps;
}

export interface HarnessOptions {
  readonly project?: Record<string, unknown>;
  /** Overrides of the fake Claude Code adapter's capabilities. */
  readonly capabilities?: Partial<HostAdapter["capabilities"]>;
  readonly gatesYml?: Record<string, unknown> | null;
  readonly files?: Record<string, string>;
  /** No `origin` remote (Level 2 then drops to Level 1, spine §5 reading 18). */
  readonly noRemote?: boolean;
}

export const DEFAULT_GATES_YML = {
  version: 1,
  baseline: {
    revision: "a".repeat(40),
    calibrated_at: "2026-10-13T08:00:00.000Z",
    confirmed: true,
  },
  tests: { acceptance_globs: ["tests/acceptance/**"], protected_configs: ["vitest.config.ts"] },
  gates: [
    { id: "typecheck", layer: "L0", command: ["pnpm", "typecheck"] },
    { id: "tests", layer: "L2", command: ["pnpm", "test"] },
  ],
};

export const createHarness = (options: HarnessOptions = {}): Harness => {
  const files: Record<string, string> = {
    "README.md": "# app\n",
    "vitest.config.ts": "export default {};\n",
    ".vtc/project.yaml": `${JSON.stringify({ version: 1, ...options.project }, null, 2)}\n`,
    ...(options.gatesYml === null
      ? {}
      : {
          ".vtc/gates.yml": `${JSON.stringify(options.gatesYml ?? DEFAULT_GATES_YML, null, 2)}\n`,
        }),
    ...options.files,
  };
  const repo = initRepo(files);
  const remote = options.noRemote === true ? "" : addBareRemote(repo);
  const home = tempDir("vtc-home-");
  const scheduled = { at: null as Date | null, cancelled: 0 };
  const spawned: string[] = [];
  const adapter: HostAdapter = {
    host: "claude-code",
    capabilities: {
      subagents: true,
      backgroundSubagents: true,
      perPathWriteDeny: true,
      headless: true,
      turnCap: true,
      budgetCap: true,
      ...options.capabilities,
    },
    install: () => Promise.reject(new Error("not in tests")),
    spawnRole: (request) => {
      spawned.push(request.role);
      return Promise.reject(
        new Error("the engine must not start a headless run in plugin-only mode"),
      );
    },
    parseEvents: () => ({
      outcome: null,
      sessionRef: null,
      usage: null,
      retry: null,
      unrecognizedLines: 0,
    }),
    headlessCommand: () => ({ command: "host", args: [], env: {} }),
    resume: (_session, request) => {
      spawned.push(`resume:${request.role}`);
      return Promise.reject(new Error("the engine must not resume headless in plugin-only mode"));
    },
    sandboxProfile: () => ({
      host: "claude-code",
      enforced: { readOnly: false, perPathWriteDeny: false, network: false },
      settings: {},
      cliArgs: [],
    }),
    dispose: () => Promise.resolve(),
  };
  const h = {
    repo,
    remote,
    home,
    clock: new Date("2026-10-13T09:00:00.000Z"),
    scheduled,
    spawned,
  } as Harness;
  const now = (): Date => h.clock;
  const gates = fakeGates(repo, now);
  const prs = fakePullRequests();
  let lock = acquireEngineLock(repo);
  const deps = (): EngineCoreDeps => ({
    repoRoot: repo,
    vtcHome: home,
    lock,
    gateRunner: gates,
    git: createGitOps({ repoRoot: repo }),
    workspace: createWorkspace(repo),
    pullRequests: prs,
    adapters: { "claude-code": adapter },
    autoResume: {
      schedule: (_root, at) => {
        scheduled.at = at;
        return Promise.resolve();
      },
      cancel: () => {
        scheduled.cancelled += 1;
        return Promise.resolve();
      },
    },
    roles: createRoleRegistry(ALL_FIXTURE_ROLES),
    plugins: createPluginCatalog({}),
    now,
    random: () => 0.5,
    remote: "origin",
  });
  Object.assign(h, {
    gates,
    prs,
    deps: deps(),
    engine: Engine.open(deps()),
    advance: (ms: number) => {
      h.clock = new Date(h.clock.getTime() + ms);
    },
    reopen: () => {
      lock.release();
      // the old engine's lock is gone: it can no longer append (AD-12)
      lock = acquireEngineLock(repo);
      return Engine.open(deps());
    },
    release: async () => {
      await h.engine.settle();
      lock.release();
    },
  });
  return h;
};

// ------------------------------------------------------------------ the Lead

export const CLAUDE = { host: "claude-code" as const };

export const spawns = (actions: readonly LeadAction[]): SpawnAction[] =>
  actions.filter((a): a is SpawnAction => a.type === "spawn_role");

export const only = (actions: readonly LeadAction[], role: string): SpawnAction => {
  const found = spawns(actions).filter((a) => a.role === role);
  if (found.length !== 1)
    throw new Error(`expected one ${role} spawn, got ${JSON.stringify(actions)}`);
  return found[0]!;
};

export const worktreeOf = (h: Harness, task: string): string =>
  join(h.repo, ".vtc/state/worktrees", task);

/** Where a dispatched role works (its worktree): the action's `Work in:` line. */
export const workdir = (action: SpawnAction): string => {
  const line = action.prompt.split("\n").find((l) => l.startsWith("Work in: "));
  if (line === undefined) throw new Error(`no Work in: line in ${action.prompt}`);
  return line.slice("Work in: ".length);
};

export const result = (
  action: SpawnAction,
  body: Partial<RoleResultInput> & Pick<RoleResultInput, "exit">,
): RoleResultInput =>
  ({
    role: action.role,
    ...(action.mode === undefined ? {} : { mode: action.mode }),
    ...(action.task === undefined ? {} : { task: action.task }),
    summary: "done",
    ...body,
  }) as RoleResultInput;

export const submitResult = (
  h: Harness,
  action: SpawnAction,
  body: Partial<RoleResultInput> & Pick<RoleResultInput, "exit">,
  cost: number | null = 0.1,
) =>
  h.engine.submit(
    SubmitInputSchema.parse({
      kind: "result",
      action_id: action.action_id,
      result: result(action, body),
      usage: {
        model: "sonnet",
        tokens: { in: 100, out: 50, cache_r: 0, cache_w: 0 },
        cost_usd: cost,
      },
    }),
    CLAUDE,
  );

export const draft = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `Task ${id}`,
  covers: ["REQ-1"],
  files_scope: [`src/${id.toLowerCase()}/**`],
  discipline: "backend",
  risk: "med",
  size: "M",
  arch_triage: "fits",
  intent: {
    statement: `Implement ${id}`,
    io_matrix: [{ case: "basic", input: "x", expected: "y" }],
  },
  ...over,
});

/** Drives the front half (discover, specify, G1, design, G2) up to the Planner's dispatch. */
export const toPlanner = async (h: Harness, spec: string = SPEC): Promise<SpawnAction> => {
  await h.engine.start(
    {
      request: "Password reset\n\nUsers reset forgotten passwords.",
      track: "feature",
      repo: "existing",
      has_ui: false,
      risk_hints: [],
    },
    CLAUDE,
  );
  let actions = (await h.engine.next({}, CLAUDE)).actions;
  const carto = only(actions, "repo_cartographer");
  writeFile(workdir(carto), ".vtc/research/repo-map.md", "# map\n");
  actions = (
    await submitResult(h, carto, {
      exit: "done",
      artifacts: [{ type: "repo_map", path: ".vtc/research/repo-map.md" }],
    })
  ).actions;
  const ba = only(actions, "ba");
  writeFile(workdir(ba), ".vtc/spec/spec.md", spec);
  actions = (
    await submitResult(h, ba, {
      exit: "done",
      artifacts: [{ type: "spec", path: ".vtc/spec/spec.md" }],
    })
  ).actions;
  const g1 = actions.find((a) => a.type === "approve_gate");
  if (g1?.type !== "approve_gate") throw new Error(`expected G1, got ${JSON.stringify(actions)}`);
  actions = (
    await h.engine.approve(
      { gates: g1.gates, decision: "approve", frozen: g1.artifacts, waived_facts: [] },
      CLAUDE,
    )
  ).actions;
  const architect = only(actions, "architect");
  writeFile(workdir(architect), ".vtc/architecture/spine.md", "# spine\n");
  actions = (
    await submitResult(h, architect, {
      exit: "done",
      artifacts: [{ type: "architecture", path: ".vtc/architecture/spine.md" }],
    })
  ).actions;
  const g2 = actions.find((a) => a.type === "approve_gate");
  if (g2?.type !== "approve_gate") throw new Error(`expected G2, got ${JSON.stringify(actions)}`);
  actions = (
    await h.engine.approve(
      { gates: g2.gates, decision: "approve", frozen: g2.artifacts, waived_facts: [] },
      CLAUDE,
    )
  ).actions;
  return only(actions, "planner");
};

/** The front half, then the plan with the given task drafts; returns the next actions. */
export const throughPlan = async (
  h: Harness,
  drafts: readonly Record<string, unknown>[],
  spec: string = SPEC,
): Promise<LeadAction[]> => {
  const planner = await toPlanner(h, spec);
  const planned = await submitResult(h, planner, { exit: "done", tasks: drafts as never });
  if (!planned.accepted) throw new Error(`plan rejected: ${JSON.stringify(planned.rejection)}`);
  await h.engine.settle();
  return (await h.engine.next({}, CLAUDE)).actions;
};

/** QA author for a task: writes one acceptance test into the worktree and submits it. */
export const authorTests = async (h: Harness, action: SpawnAction, ac = "REQ-1.AC-1") => {
  const task = action.task ?? "";
  const path = `tests/acceptance/${task.toLowerCase()}.test.ts`;
  writeFile(worktreeOf(h, task), path, `test("[${ac}] works", () => {});\n`);
  const out = await submitResult(h, action, {
    exit: "done",
    acceptance_tests: [`[${ac}] works`],
    artifacts: [{ type: "acceptance_test", path }],
  });
  await h.engine.settle();
  return out;
};

/** The Engineer writes `src/<task>/impl.ts` (or `content` elsewhere) and submits `built`. */
export const build = async (
  h: Harness,
  action: SpawnAction,
  content = "export const x = 1;\n",
  path?: string,
) => {
  const task = action.task ?? "";
  writeFile(worktreeOf(h, task), path ?? `src/${task.toLowerCase()}/impl.ts`, content);
  const out = await submitResult(h, action, { exit: "built" });
  await h.engine.settle();
  return out;
};

export const verdictPass = (h: Harness, action: SpawnAction, file: string) =>
  submitResult(h, action, {
    exit: "done",
    verdicts: [
      {
        subject: action.subject ?? action.task ?? "T-1",
        verdict: "pass",
        evidence: [{ type: "file_line", ref: `${file}:1` }],
      },
    ],
  });

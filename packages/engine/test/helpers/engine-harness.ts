/**
 * An engine on a real temp git repo (with a local bare remote) and fakes for everything outside
 * engine core: the Gate Runner (programmable verdicts, a real write-scope check over git), the PR
 * service, the auto-resume timer, host adapters and the clock.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach } from "vitest";
import {
  commandShapes,
  GateReportSchema,
  ModelPriceSchema,
  SubmitInputSchema,
  type CommandShape,
  type GateReport,
  type GateRunner,
  type GateRunRequest,
  type ArmPluginCompiler,
  type HeadlessRun,
  type PluginLoadProof,
  type SandboxProfileRequest,
  type HostAdapter,
  type HostAuthStatus,
  type HostId,
  type HostOutcome,
  type ModelPriceInput,
  type PriceTable,
  type RoutingTable,
  type BaseRun,
  type RemoteInfo,
  type RemoteMergePolicy,
  type RemoteMergeService,
  type RequiredCheck,
  type RevertRef,
  type SessionRef,
  type SpawnRoleRequest,
  type UsageSnapshot,
  type ConsultResult,
  type LeadAction,
  type PullRequestRef,
  type RoleContract,
  type RoleResultInput,
  type ToolFinding,
  type WriteScopeReport,
} from "@vtc/shared";
import {
  acquireEngineLock,
  createPluginCatalog,
  Engine,
  createRoleRegistry,
  type CallContext,
  type EngineCoreDeps,
  type PluginCatalog,
} from "../../src/core/index.js";
import { createGitOps, createWorkspace, type PullRequestService } from "../../src/git/index.js";
import { globMatch } from "../../src/core/globs.js";
import { ALL_FIXTURE_ROLES } from "../fixtures/roles.js";
import { addBareRemote, git, initRepo, tempDir, writeFile } from "./repo.js";

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
  /** Rewrites every report before it is returned (results, traceability); `null` stops it. */
  reshape(fn: ((request: GateRunRequest, report: GateReport) => GateReport) | null): void;
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
  let reshaper: ((request: GateRunRequest, report: GateReport) => GateReport) | null = null;
  return {
    requests,
    reshape: (fn) => {
      reshaper = fn;
    },
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
      const out = report(request, verdict, now());
      return reshaper === null ? out : reshaper(request, out);
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

export interface FakePullRequests extends PullRequestService {
  readonly calls: string[];
  /** The PR as the fake host has it now (tests change it: merged, closed, a moved head). */
  current: PullRequestRef | null;
}

/** The PR service fake: one PR per repo, its head the branch's real head (as GitHub has it). */
export const fakePullRequests = (repoRoot?: string): FakePullRequests => {
  const calls: string[] = [];
  const headOf = (branch: string): string => {
    if (repoRoot === undefined) return "f".repeat(40);
    try {
      return git(repoRoot, "rev-parse", branch);
    } catch {
      return "f".repeat(40);
    }
  };
  const fake: FakePullRequests = {
    calls,
    current: null,
    upsertDraft: (request) => {
      calls.push(`upsert ${request.branch} -> ${request.base}`);
      fake.current = {
        url: "https://github.com/acme/app/pull/7",
        draft: fake.current?.draft ?? true,
        state: "open",
        head_sha: headOf(request.branch),
        ci: "unknown",
        number: 7,
      };
      return Promise.resolve(fake.current);
    },
    markReady: (branch) => {
      calls.push(`ready ${branch}`);
      fake.current = {
        url: "https://github.com/acme/app/pull/7",
        draft: false,
        state: "open",
        head_sha: headOf(branch),
        ci: "pending",
        number: 7,
      };
      return Promise.resolve(fake.current);
    },
    view: () => Promise.resolve(fake.current),
  };
  return fake;
};

/** A scripted `RemoteMergeService` (AD-23) over the PR fake; every call is recorded. */
export interface FakeRemoteMerge extends RemoteMergeService {
  readonly calls: string[];
  info: RemoteInfo;
  /** `policy(base)`; a function may throw. */
  rules: RemoteMergePolicy;
  /** Required checks on the gated SHA, one list per call (the last repeats). */
  checks: RequiredCheck[][];
  /** After `enableAutoMerge`, the PR merges on the next view (default true). */
  mergeOnEnable: boolean;
  baseRunList: BaseRun[];
  reverts: RevertRef[];
}

export const GREEN_POLICY: RemoteMergePolicy = {
  base: "main",
  auto_merge_allowed: true,
  required_checks: ["ci"],
  merge_methods: ["squash"],
  merge_queue: false,
  requires_review: false,
  signatures_required: false,
};

export const fakeRemoteMerge = (prs: FakePullRequests): FakeRemoteMerge => {
  const fake: FakeRemoteMerge = {
    calls: [],
    info: { github: true, ghAuthenticated: true },
    rules: GREEN_POLICY,
    checks: [[{ name: "ci", state: "success" }]],
    mergeOnEnable: true,
    baseRunList: [],
    reverts: [],
    remote: () => {
      fake.calls.push("remote");
      return Promise.resolve(fake.info);
    },
    policy: (base) => {
      fake.calls.push(`policy ${base}`);
      return Promise.resolve(fake.rules);
    },
    requiredChecks: (branch, sha) => {
      fake.calls.push(`checks ${branch} ${sha.slice(0, 7)}`);
      const next = fake.checks.length > 1 ? fake.checks.shift() : fake.checks[0];
      return Promise.resolve(next ?? []);
    },
    enableAutoMerge: (request) => {
      if (request.headSha.length !== 40) throw new Error("not bound to a SHA");
      fake.calls.push(`enable ${request.branch} ${request.headSha.slice(0, 7)} ${request.method}`);
      const pr = prs.current;
      if (pr === null) return Promise.reject(new Error("no PR"));
      const enabled: PullRequestRef = { ...pr, auto_merge: "enabled" };
      prs.current = fake.mergeOnEnable
        ? { ...enabled, state: "merged", auto_merge: "merged", merge_commit: "c".repeat(40) }
        : enabled;
      return Promise.resolve(enabled);
    },
    disableAutoMerge: (branch) => {
      fake.calls.push(`disable ${branch}`);
      const pr = prs.current;
      if (pr === null) return Promise.resolve(null);
      prs.current = { ...pr, auto_merge: "disabled" };
      return Promise.resolve(prs.current);
    },
    baseRuns: (base, sha) => {
      fake.calls.push(`runs ${base} ${sha.slice(0, 7)}`);
      return Promise.resolve(fake.baseRunList);
    },
    findReverts: (base, sha) => {
      fake.calls.push(`reverts ${base} ${sha.slice(0, 7)}`);
      return Promise.resolve(fake.reverts);
    },
  };
  return fake;
};

/**
 * A scripted engine-launched run (AD-25): what the role does (it may write files in
 * `request.cwd`) and how it ends. Returning `{ outcome, lines }` also streams `lines`; a line
 * `{"usage": <UsageSnapshot>}` is a usage event the fake's `parseEvents` reports.
 */
export type HeadlessScript = (
  request: SpawnRoleRequest,
  session: SessionRef | undefined,
) =>
  | HostOutcome
  | { readonly outcome: HostOutcome; readonly lines?: readonly string[] }
  | Promise<HostOutcome | { readonly outcome: HostOutcome; readonly lines?: readonly string[] }>;

/** One engine-launched run the fake adapters started. */
export interface Launched {
  readonly host: HostId;
  readonly request: SpawnRoleRequest;
  readonly session: SessionRef | undefined;
}

export interface FakeAdapterOptions {
  readonly capabilities?: Partial<HostAdapter["capabilities"]>;
  /** Launches headless runs with this script; absent: a headless launch is refused. */
  readonly headless?: HeadlessScript;
  /** `HostAdapter.authStatus`; absent: the adapter has none. */
  readonly authStatus?: () => Promise<HostAuthStatus>;
  /**
   * `HeadlessRun.pluginLoad` of a run started with `pluginDir` (D-cg). Default: the copy loaded;
   * `null`: the run has no `pluginLoad`.
   */
  readonly pluginLoad?: ((request: SpawnRoleRequest) => PluginLoadProof) | null;
  /** The sandbox enforces `SandboxProfileRequest.readDeny` (reading 178). */
  readonly readDeny?: boolean;
  /** `HostAdapter.defaultPrices` (H-12); absent: the adapter ships no price table. */
  readonly defaultPrices?: PriceTable;
}

const outcomeOf = async (
  script: ReturnType<HeadlessScript>,
): Promise<{ outcome: HostOutcome; lines: readonly string[] }> => {
  const value = await script;
  return "kind" in value
    ? { outcome: value, lines: [] }
    : { outcome: value.outcome, lines: value.lines ?? [] };
};

const fakeAdapter = (
  host: HostId,
  options: FakeAdapterOptions & { readonly subagentName?: (agent: string) => string },
  record: {
    spawned: string[];
    launched: Launched[];
    killed: string[];
    sandboxRequests: SandboxProfileRequest[];
  },
): HostAdapter => {
  const launch = (request: SpawnRoleRequest, session: SessionRef | undefined): HeadlessRun => {
    const script = options.headless;
    if (script === undefined) throw new Error("this fake host launches no headless runs");
    record.launched.push({ host, request, session });
    let kill: () => void = () => undefined;
    const killed = new Promise<{ outcome: HostOutcome; lines: readonly string[] }>((resolve) => {
      kill = () => {
        resolve({
          outcome: {
            kind: "error",
            message: "killed",
            retryable: true,
            cause: "killed",
            tokens: null,
            cost_usd: null,
          },
          lines: [],
        });
      };
    });
    const done = Promise.race([outcomeOf(script(request, session)), killed]);
    return {
      command: { command: "host", args: [], env: {} },
      pid: 4242,
      lines: async function* () {
        for (const line of (await done).lines) yield line;
      },
      wait: async () => (await done).outcome,
      ...(request.pluginDir === undefined || options.pluginLoad === null
        ? {}
        : {
            pluginLoad: () =>
              Promise.resolve(
                options.pluginLoad?.(request) ?? {
                  loaded: true as const,
                  dir: request.pluginDir ?? "",
                },
              ),
          }),
      kill: () => {
        record.killed.push(request.role);
        kill();
        return Promise.resolve();
      },
    };
  };
  return {
    host,
    capabilities: {
      subagents: true,
      backgroundSubagents: true,
      perPathWriteDeny: true,
      headless: true,
      turnCap: true,
      budgetCap: true,
      // as the real adapters report it: Claude Code's role profiles deny the credential stores,
      // Codex's web search is not confirmed safe (D-cf)
      safeHostWeb: host === "claude-code",
      ...options.capabilities,
    },
    install: () => Promise.reject(new Error("not in tests")),
    ...(options.defaultPrices === undefined ? {} : { defaultPrices: options.defaultPrices }),
    ...(options.subagentName === undefined ? {} : { subagentName: options.subagentName }),
    spawnRole: (request) => {
      record.spawned.push(request.role);
      if (options.headless === undefined)
        return Promise.reject(
          new Error("the engine must not start a headless run in plugin-only mode"),
        );
      return Promise.resolve({ dispatch: "headless", run: launch(request, undefined) });
    },
    parseEvents: (lines) => {
      let usage: UsageSnapshot | null = null;
      // D-cs: a `{"command": "..."}` line is a shell call the adapter shapes
      const shapes: CommandShape[] = [];
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as { usage?: UsageSnapshot; command?: string };
          if (parsed.usage !== undefined) usage = parsed.usage;
          if (typeof parsed.command === "string") shapes.push(...commandShapes(parsed.command));
        } catch {
          // not a usage line
        }
      }
      return {
        outcome: null,
        sessionRef: null,
        usage,
        retry: null,
        unrecognizedLines: 0,
        ...(shapes.length === 0 ? {} : { commandShapes: shapes }),
      };
    },
    headlessCommand: () => ({ command: "host", args: [], env: {} }),
    resume: (session, request) => {
      record.spawned.push(`resume:${request.role}`);
      if (options.headless === undefined)
        return Promise.reject(new Error("the engine must not resume headless in plugin-only mode"));
      return Promise.resolve({ dispatch: "headless", run: launch(request, session) });
    },
    // Claude Code keeps the token unreadable; Codex cannot, but enforces "no network" (D-ac)
    sandboxProfile: (request) => {
      record.sandboxRequests.push(request);
      return {
        host,
        enforced: {
          readOnly: false,
          perPathWriteDeny: host === "claude-code",
          network: true,
          secretsUnreadable: host === "claude-code",
          ...(options.readDeny === true ? { readDeny: true } : {}),
        },
        settings: {},
        cliArgs: [],
      };
    },
    ...(options.authStatus === undefined ? {} : { authStatus: options.authStatus }),
    dispose: () => Promise.resolve(),
  };
};

export interface Harness {
  readonly repo: string;
  readonly remote: string;
  /** The VTC home (outside the repo): the engine's private directory lives under it. */
  readonly home: string;
  readonly engine: Engine;
  readonly gates: FakeGates;
  readonly prs: FakePullRequests;
  /** The Level-3 service fake (AD-23), when `level3` was set. */
  readonly remote3: FakeRemoteMerge;
  readonly scheduled: { at: Date | null; cancelled: number };
  readonly spawned: string[];
  /** Engine-launched runs the fake adapters started (AD-25). */
  readonly launched: Launched[];
  /** Roles of engine-launched runs the engine killed. */
  readonly killed: string[];
  /** Every sandbox profile request the fake adapters answered. */
  readonly sandboxRequests: SandboxProfileRequest[];
  clock: Date;
  /** Replaces the engine's waits between remote polls (default: the clock moves `ms`). */
  sleeper: ((ms: number) => Promise<void>) | null;
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
  /** The fake adapter's `subagentName` (a host that namespaces plugin agents, AD-14 rule 1). */
  readonly subagentName?: (agent: string) => string;
  /** Role contracts in place of the fixture set (they mirror `roles/`). */
  readonly roles?: readonly RoleContract[];
  /** The compiled plugins' catalog (prompt SHAs, discipline profiles); none by default. */
  readonly plugins?: PluginCatalog;
  /** The platform roles run on (default `darwin`, where Codex roles may run in-session). */
  readonly platform?: NodeJS.Platform;
  /** The fake Claude Code adapter launches headless runs with this script. */
  readonly headless?: HeadlessScript;
  /** The fake Claude Code adapter's `authStatus`. */
  readonly authStatus?: () => Promise<HostAuthStatus>;
  /** The fake Claude Code adapter's `HeadlessRun.pluginLoad` (see {@link FakeAdapterOptions}). */
  readonly pluginLoad?: FakeAdapterOptions["pluginLoad"];
  /** The replay arm plugin compiler (`EngineDeps.armPlugins`, D-cg); none by default. */
  readonly armPlugins?: ArmPluginCompiler;
  /** The fake Claude Code adapter's sandbox enforces `readDeny` (reading 178). */
  readonly readDeny?: boolean;
  /** A Codex adapter too (absent: none is installed). */
  readonly codex?: FakeAdapterOptions;
  /** Wire a Level-3 `RemoteMergeService` fake (AD-23); `h.remote3` scripts it. */
  readonly level3?: boolean;
  /** The user's price table (`~/.vtc/config.yaml` `prices`, §11). */
  readonly prices?: Readonly<Record<string, ModelPriceInput>>;
  /** The routing table (default {@link DCM_ROUTING_TABLE}, never the tunable default's values). */
  readonly routingTable?: RoutingTable;
  /** `next`'s hold on an autopilot run's wait (`EngineCoreDeps.nextWaitMs`; default 0 here). */
  readonly nextWaitMs?: number;
}

/**
 * D-cm's routing table as decided (spine §5 reading 218(2)): the engine's flow tests route with
 * it. `DEFAULT_ROUTING_TABLE` started equal to it, and its tiers move through reviewed D-cn
 * routing PRs that change `tier-routing.ts` only (reading 233), which no test may then block.
 */
export const DCM_ROUTING_TABLE: RoutingTable = {
  v: 1,
  by_size: { S: "low", M: "mid", L: "top" },
  tagged_floor: "mid",
  high_floor: "top",
  high_risk_tags: ["auth", "payments", "data", "security", "migration"],
};

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

/**
 * The teardowns of the harnesses whose test has not released them yet (D-cz; spine §5 reading
 * 246). A test that fails or times out never reaches its `release()`, and vitest cannot stop its
 * body: its engine would keep running jobs (gates, merges, git) and the abandoned body would keep
 * driving it, under the next tests of the same worker, which then slow down and time out in turn.
 * After each test every harness still live is shut down (`Engine.shutdown`: nothing new starts,
 * the engine-launched runs are killed) and its lock released, so an abandoned engine stops instead
 * of loading the worker.
 */
const live = new Set<() => Promise<void>>();

afterEach(async () => {
  const pending = [...live];
  live.clear();
  await Promise.allSettled(pending.map((teardown) => teardown()));
});

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
  const launched: Launched[] = [];
  const killed: string[] = [];
  const sandboxRequests: SandboxProfileRequest[] = [];
  const record = { spawned, launched, killed, sandboxRequests };
  const adapter = fakeAdapter(
    "claude-code",
    {
      ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
      ...(options.headless === undefined ? {} : { headless: options.headless }),
      ...(options.authStatus === undefined ? {} : { authStatus: options.authStatus }),
      ...(options.subagentName === undefined ? {} : { subagentName: options.subagentName }),
      ...(options.pluginLoad === undefined ? {} : { pluginLoad: options.pluginLoad }),
      ...(options.readDeny === undefined ? {} : { readDeny: options.readDeny }),
    },
    record,
  );
  const adapters: Partial<Record<HostId, HostAdapter>> = { "claude-code": adapter };
  if (options.codex !== undefined) adapters.codex = fakeAdapter("codex", options.codex, record);
  const h = {
    repo,
    remote,
    home,
    clock: new Date("2026-10-13T09:00:00.000Z"),
    scheduled,
    spawned,
    launched,
    killed,
    sandboxRequests,
    sleeper: null,
  } as Harness;
  const now = (): Date => h.clock;
  const gates = fakeGates(repo, now);
  const prs = fakePullRequests(repo);
  const remote3 = fakeRemoteMerge(prs);
  let lock = acquireEngineLock(repo);
  const deps = (): EngineCoreDeps => ({
    repoRoot: repo,
    nextWaitMs: options.nextWaitMs ?? 0,
    vtcHome: home,
    lock,
    gateRunner: gates,
    git: createGitOps({ repoRoot: repo }),
    workspace: createWorkspace(repo),
    pullRequests: prs,
    ...(options.level3 === true ? { remoteMerge: remote3 } : {}),
    // Level 3 waits between polls: the test clock moves instead of the wall clock
    sleep: (ms: number) => {
      if (h.sleeper !== null) return h.sleeper(ms);
      h.clock = new Date(h.clock.getTime() + ms);
      return Promise.resolve();
    },
    adapters,
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
    roles: createRoleRegistry(options.roles ?? ALL_FIXTURE_ROLES),
    plugins: options.plugins ?? createPluginCatalog({}),
    now,
    random: () => 0.5,
    remote: "origin",
    platform: options.platform ?? "darwin",
    ...(options.armPlugins === undefined ? {} : { armPlugins: options.armPlugins }),
    routingTable: options.routingTable ?? DCM_ROUTING_TABLE,
    ...(options.prices === undefined
      ? {}
      : {
          prices: Object.fromEntries(
            Object.entries(options.prices).map(([id, p]) => [id, ModelPriceSchema.parse(p)]),
          ),
        }),
  });
  const engines: Engine[] = [Engine.open(deps())];
  // never awaited to the end: a test may hold a job open on purpose (`gates.hold`), and the
  // shutdown's abort, which stops all new work, happens before its first wait
  const teardown = (): Promise<void> => {
    for (const engine of engines) void engine.shutdown().catch(() => undefined);
    lock.release();
    return Promise.resolve();
  };
  live.add(teardown);
  Object.assign(h, {
    gates,
    prs,
    remote3,
    deps: deps(),
    engine: engines[0],
    advance: (ms: number) => {
      h.clock = new Date(h.clock.getTime() + ms);
    },
    reopen: () => {
      lock.release();
      // the old engine's lock is gone: it can no longer append (AD-12)
      lock = acquireEngineLock(repo);
      const engine = Engine.open(deps());
      engines.push(engine);
      return engine;
    },
    release: async () => {
      live.delete(teardown);
      await h.engine.settle();
      lock.release();
    },
  });
  return h;
};

// ------------------------------------------------------------------ the Lead

/**
 * The Lead on Claude Code, in-process: its session reports the OS sandbox `on` (D-an, spine §5
 * reading 71), so code-running roles may run in it.
 */
export const CLAUDE: CallContext = { host: "claude-code", sessionSandbox: "on" };

export const spawns = (actions: readonly LeadAction[]): SpawnAction[] =>
  actions.filter((a): a is SpawnAction => a.type === "spawn_role");

export const only = (actions: readonly LeadAction[], role: string): SpawnAction => {
  const found = spawns(actions).filter((a) => a.role === role);
  if (found.length !== 1)
    throw new Error(`expected one ${role} spawn, got ${JSON.stringify(actions)}`);
  return found[0]!;
};

/** A consult the Lead runs in its own session (a Claude Lead): its `spawn_role` (5.13.0 union). */
export const inSession = (out: ConsultResult): { run: string; action: SpawnAction } => {
  if (!("action" in out))
    throw new Error(`expected an in-session consult, got ${JSON.stringify(out)}`);
  return out;
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
  call: CallContext = CLAUDE,
  model = "sonnet",
) =>
  h.engine.submit(
    SubmitInputSchema.parse({
      kind: "result",
      action_id: action.action_id,
      result: result(action, body),
      usage: {
        model,
        tokens: { in: 100, out: 50, cache_r: 0, cache_w: 0 },
        cost_usd: cost,
      },
    }),
    call,
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

/** Security's design mode (§6.1 DESIGN): writes the threat model and submits it. */
export const threatModel = async (
  h: Harness,
  action: SpawnAction,
  text = "# Threat model\n\nNo threat needs a new SEC-n requirement.\n",
): Promise<LeadAction[]> => {
  const path = ".vtc/architecture/threat-model/model.md";
  writeFile(workdir(action), path, text);
  return (
    await submitResult(h, action, { exit: "done", artifacts: [{ type: "threat_model", path }] })
  ).actions;
};

/** Drives the front half (discover, specify, G1, design, G2) up to the Planner's dispatch. */
export interface FrontHalfOptions {
  /** A run with UI: the Designer runs in DESIGN and writes this `screens.yaml`. */
  readonly screens?: string;
  /** Security's threat model (default: no SEC-n requirement). */
  readonly threats?: string;
}

/**
 * An architecture artifact whose requirement-to-component map names every requirement of `spec`
 * (the DESIGN check, §6.1, spine §5 reading 146).
 */
export const spineFor = (spec: string): string =>
  [
    "# spine",
    "",
    "## Requirement map",
    "",
    ...[...new Set(spec.match(/\b(?:REQ|SEC)-[1-9]\d*\b/g) ?? [])].map((id) => `- ${id}: app`),
    "",
  ].join("\n");

export const toPlanner = async (
  h: Harness,
  spec: string = SPEC,
  options: FrontHalfOptions = {},
): Promise<SpawnAction> => {
  await h.engine.start(
    {
      request: "Password reset\n\nUsers reset forgotten passwords.",
      track: "feature",
      repo: "existing",
      has_ui: options.screens !== undefined,
      risk_hints: [],
    },
    CLAUDE,
  );
  let actions = (await h.engine.next({}, CLAUDE)).actions;
  const carto = only(actions, "repo_cartographer");
  writeFile(workdir(carto), ".vtc/research/repo-map/map.md", "# map\n");
  actions = (
    await submitResult(h, carto, {
      exit: "done",
      artifacts: [{ type: "repo_map", path: ".vtc/research/repo-map/map.md" }],
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
  // DESIGN: the Architect, Security's threat model and, with UI, the Designer, as many at a
  // time as the concurrency allows; each is done when it is handed out
  const pending: SpawnAction[] = [];
  const seen = new Set<string>();
  const collect = (list: readonly LeadAction[]): void => {
    for (const a of spawns(list))
      if (!seen.has(a.action_id)) {
        seen.add(a.action_id);
        pending.push(a);
      }
  };
  collect(actions);
  for (let step = pending.shift(); step !== undefined; step = pending.shift()) {
    if (step.role === "security") actions = await threatModel(h, step, options.threats);
    else if (step.role === "designer") {
      writeFile(workdir(step), ".vtc/design/screens.yaml", options.screens ?? "screens: []\n");
      actions = (
        await submitResult(h, step, {
          exit: "done",
          artifacts: [{ type: "screens", path: ".vtc/design/screens.yaml" }],
        })
      ).actions;
    } else {
      writeFile(workdir(step), ".vtc/architecture/spine.md", spineFor(spec));
      actions = (
        await submitResult(h, step, {
          exit: "done",
          artifacts: [{ type: "architecture", path: ".vtc/architecture/spine.md" }],
        })
      ).actions;
    }
    collect(actions);
  }
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
  options: FrontHalfOptions = {},
): Promise<LeadAction[]> => {
  const planner = await toPlanner(h, spec, options);
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

/**
 * The fake Gate Runner reports full coverage on Final Review: it writes a traceability report
 * (every requirement of the request covered by a passing test) the way the real one does.
 */
export const reportCoverage = (h: Harness): void => {
  h.gates.reshape((request, report) => {
    if (request.reason !== "final_review" || request.feature === undefined) return report;
    const path = `.vtc/evidence/${request.feature}/traceability.json`;
    writeFile(
      h.repo,
      path,
      `${JSON.stringify({
        run: request.run,
        feature: request.feature,
        rows: request.req_tags.map((req) => ({
          req,
          tests: [{ id: `[${req}] works`, status: "pass" }],
          covered: true,
        })),
        gaps: [],
        built_at: h.clock.toISOString(),
      })}\n`,
    );
    return { ...report, traceability: path };
  });
};

/**
 * Final Review's AI steps (§6.7a steps 3–4) for the Lead: every feature-level reviewer the
 * engine hands out passes, citing `cite` (a file at the integrated head). Returns the actions
 * after them (the release runs in the background; settle to see it).
 */
export const passFinalReview = async (
  h: Harness,
  cite = "src/t-1/impl.ts:1",
): Promise<LeadAction[]> => {
  let actions = (await h.engine.next({}, CLAUDE)).actions;
  for (let i = 0; i < 4; i += 1) {
    const reviewers = spawns(actions).filter(
      (a) => a.task === undefined && a.subject?.startsWith("F-") === true,
    );
    if (reviewers.length === 0) break;
    for (const reviewer of reviewers) {
      const out = await submitResult(h, reviewer, {
        exit: "done",
        ...(reviewer.feature === undefined ? {} : { feature: reviewer.feature }),
        verdicts: [
          {
            subject: reviewer.subject ?? "F-1",
            verdict: "pass",
            evidence: [{ type: "file_line", ref: cite }],
          },
        ],
      });
      if (!out.accepted)
        throw new Error(`Final Review reviewer rejected: ${JSON.stringify(out.rejection)}`);
    }
    await h.engine.settle();
    actions = (await h.engine.next({}, CLAUDE)).actions;
  }
  await h.engine.settle();
  return actions;
};

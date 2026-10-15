/**
 * The upstream module wired over in-memory fakes (D-cc: no real gh, git or GitHub), shared by the
 * module's end-to-end tests.
 */
import { automationFor, type AutomationContext, type AutomationDeps } from "@vtc/shared";
import {
  createUpstream,
  type AutomationFact,
  type FfmpegCommand,
  type ProjectContext,
  type RemoteRefs,
  type UpstreamEvent,
} from "../../src/upstream/index.js";
import { tempDir } from "../helpers/repo.js";
import {
  fakeAssets,
  fakePlumbing,
  fakeRecorder,
  fakeRemoteRefs,
  memoryGitHub,
  type FakePlumbing,
} from "./fakes.js";

export const UPSTREAM = "bason-labs/bs-vtc";
export const PROJECT = "acme-corp/payroll-portal";
export const BASE_SHA = "1".repeat(40);

export interface Harness {
  readonly github: ReturnType<typeof memoryGitHub>;
  readonly events: UpstreamEvent[];
  readonly upstream: ReturnType<typeof createUpstream>;
  readonly ctx: ProjectContext;
  readonly plumbing: FakePlumbing;
  readonly clock: { now: Date };
  readonly checkout: string;
  readonly vtcHome: string;
  /** The bs-vtc checkout's files at `BASE_SHA` (what `gitOps.readFileAtCommit` serves). */
  readonly files: Map<string, string>;
  setContext(change: Partial<AutomationContext>): void;
  setShare(share: boolean): void;
}

export const harness = (
  options: {
    automation?: Partial<AutomationDeps>;
    noRecorder?: boolean;
    contexts?: () => Partial<AutomationContext>;
    /** Share GitHub, the remote and the clock with another installation's harness. */
    shared?: Harness;
    /** Share VTC's home too (another daemon on the same machine). */
    sameHome?: boolean;
    /** With `shared`: its own clone of the shared remote (another installation's checkout). */
    clone?: boolean;
    /** Wire `UpstreamDeps.remoteRefs` (fetch and commit messages) over the fake plumbing. */
    remoteRefs?: boolean;
    /** A `UpstreamDeps.remoteRefs` of the test's own (wins over `remoteRefs`). */
    remoteRefsSeam?: (repoRoot: string) => RemoteRefs;
    noGitOps?: boolean;
    ffmpegCommand?: FfmpegCommand;
    evidence?: ProjectContext["evidence"];
    /** `UpstreamDeps.startRun`: an automatic run started from an issue. */
    startRun?: NonNullable<Parameters<typeof createUpstream>[0]["startRun"]>;
    /** The project is the bs-vtc checkout itself ("VTC builds VTC"). */
    self?: boolean;
  } = {},
): Harness => {
  const clock = options.shared?.clock ?? { now: new Date("2026-10-15T12:00:00Z") };
  const plumbing =
    options.shared !== undefined && options.clone !== true
      ? options.shared.plumbing
      : fakePlumbing({ "refs/remotes/origin/main": BASE_SHA }, options.shared?.plumbing);
  const github =
    options.shared?.github ?? memoryGitHub({ remote: plumbing.remote, now: () => clock.now });
  const events: UpstreamEvent[] = [];
  const repoRoot = options.shared?.ctx.repoRoot ?? tempDir("vtc-project-");
  const checkout = options.shared?.checkout ?? tempDir("vtc-checkout-");
  const files = options.shared?.files ?? new Map<string, string>();
  const vtcHome =
    options.shared !== undefined && options.sameHome === true
      ? options.shared.vtcHome
      : tempDir("vtc-home-");
  let context: AutomationContext = { githubRemote: true, ghLoggedIn: true, paused: false };
  let share = true;
  const automation: AutomationDeps = {
    issues: github.issues,
    pullRequests: github.pullRequests,
    ...(options.noRecorder === true ? {} : { evidence: fakeRecorder() }),
    plumbing: () => plumbing,
    upstream: { repo: UPSTREAM, share: true, checkout },
    hosting: "branch",
    ffmpeg: false,
    ...options.automation,
  };
  const ctx: ProjectContext = {
    repoRoot: options.self === true ? checkout : repoRoot,
    repo: options.self === true ? UPSTREAM : PROJECT,
    state: () => {
      const c = { ...context, ...options.contexts?.() };
      return {
        settings: automationFor({ upstream: { share } }, {}, c),
        context: c,
      };
    },
    identity: {
      repo: PROJECT,
      remoteUrl: `git@github.com:${PROJECT}.git`,
      repoRoot: "/Users/alice/clients/globex/payroll-portal",
      clientNames: ["Globex Industries"],
      homeDir: "/Users/alice",
    },
    knownValues: ["sk-live-payroll-SECRET-1234"],
    ...(options.evidence === undefined ? {} : { evidence: options.evidence }),
  };
  const upstream = createUpstream({
    automation,
    vtcHome,
    guardDir: tempDir("vtc-guard-"),
    vtcVersion: "0.4.0",
    assets: fakeAssets(),
    emit: (e) => events.push(e),
    now: () => clock.now,
    defaultBranch: () => Promise.resolve("main"),
    vtcRoots: ["/Users/alice/vtc"],
    ...(options.noGitOps === true
      ? {}
      : {
          gitOps: () => ({
            readFileAtCommit: (sha, path) => {
              const text = sha === BASE_SHA ? files.get(path) : undefined;
              return Promise.resolve(
                text === undefined ? undefined : new TextEncoder().encode(text),
              );
            },
          }),
        }),
    ...(options.ffmpegCommand === undefined ? {} : { ffmpegCommand: options.ffmpegCommand }),
    ...(options.remoteRefsSeam !== undefined
      ? { remoteRefs: options.remoteRefsSeam }
      : options.remoteRefs === true
        ? { remoteRefs: () => fakeRemoteRefs(plumbing) }
        : {}),
    ...(options.startRun === undefined ? {} : { startRun: options.startRun }),
  });
  return {
    github,
    events,
    upstream,
    ctx,
    plumbing,
    clock,
    checkout,
    vtcHome,
    files,
    setContext: (change) => {
      context = { ...context, ...change };
    },
    setShare: (value) => {
      share = value;
    },
  };
};

export const defect = (
  over: Partial<Extract<AutomationFact, { type: "vtc_defect" }>> = {},
): AutomationFact => ({
  type: "vtc_defect",
  errorClass: "adapter.parse_failure",
  role: "implementer",
  host: "codex",
  model: "gpt-5.5-codex",
  stack: `Error: x\n    at parseLine (/Users/alice/vtc/packages/adapters/src/codex/parse.ts:1:1)\n    at handler (/Users/alice/clients/globex/payroll-portal/src/a.ts:1:1)`,
  at: "2026-10-15T11:00:00Z",
  ...over,
});

export const types = (events: readonly UpstreamEvent[]): string[] => events.map((e) => e.type);

/**
 * The upstream module as the daemon drives it (AD-27 rule 8; spine §5 readings 189, 190 and 196).
 * The module (`upstream/`, the upstream team's) owns what to raise: its facts, fingerprints,
 * dedupe, caps, privacy projection and evidence. The daemon hands it engine facts in the module's
 * own vocabulary and a context to check them against, and turns what it reports into events:
 * - a VTC defect → `vtc_defect`; a cost regression → `cost_regression`; an advisory in VTC's own
 *   dependencies → `security_advisory`; Lookback's new-agent signal → `improvement` (D-cd); a
 *   project problem → `project_problem` (with the engine's stable `ruleId`);
 * - a replay verdict `improve` → `openLookbackPr` with the `ReplayResult` and its `PromptProposal`,
 *   whose editable section is the stored candidate version the replay measured, never the
 *   role-writable proposal file as it is now (D-cb);
 * - the module's `{ type, payload }` events → the engine's `upstream.*` / `automation.skipped`
 *   events, through the wiring's only sink;
 * - an automatic run's release → `openPullRequest` from the head the run pushed to its `vtc/auto`
 *   branch, with the run's read routes and events as the evidence snapshot (marked ready on the
 *   Spec Verifier's pass), once per pushed head; `completePullRequest` when the module already
 *   opened that run's PR;
 * - its sweep (auto-close, stale PRs) at most once a day after one that worked, remembered across
 *   daemon restarts;
 * - `startRun` (`Engine.startAutomatic`, queued by the wiring), which the module calls once it
 *   opened the issue of a fixable item, and, on the bs-vtc checkout, for every open fixable issue
 *   another installation opened (`pickup`, at each of the wiring's ticks).
 *
 * The module is not imported here: {@link UpstreamModule} and {@link UpstreamModuleDeps} are the
 * structural shape of `createUpstream` (`upstream/upstream.ts`), and the daemon passes that factory
 * in (`../upstream/index.js` joins the engine at the round-4 merge, AD-13 rule 13), so a drift
 * between the two is a type error at that one call.
 */
import { join } from "node:path";
import {
  AUTO_LABELS,
  GitShaSchema,
  LOOKBACK_REPO,
  parsePersisted,
  PromptProposalSchema,
  ReplayResultSchema,
  sha256Hex,
  UpstreamReportSchema,
  type AssetBundle,
  type AutoFingerprint,
  type AutoKind,
  type AutoTemplateSlot,
  type AutomationContext,
  type AutomationDeps,
  type AutomationRunRef,
  type AutomationSettings,
  type GateReport,
  type GitHubRepo,
  type GitOps,
  type GitSha,
  type PromptProposal,
  type ReplayResult,
  type Scorecard,
  type ScorecardMetricId,
  type StartInput,
  type UpstreamReport,
} from "@vtc/shared";
import {
  ensurePrivateDir,
  readPrivateFile,
  writePrivateFile,
  type AutomaticRelease,
  type AutomationFact,
  type CreateUpstream,
  type UpstreamWiring,
} from "../core/index.js";
import { readRepoFileCapped, type RemoteRefs } from "../git/index.js";
import type { EvidenceSnapshot } from "./evidence-snapshot.js";

// --------------------------------------------------------------- the module's shape

/** The module's project problem kinds (`AUTO_KINDS_BY_TARGET.project`). */
type ProjectProblemKind = "parked" | "ci_failure" | "escaped_defect" | "finding" | "final_review";

/** The facts the module evaluates (`upstream/triggers.ts` `AutomationFact`, the engine's subset). */
export type UpstreamModuleFact =
  | {
      readonly type: "vtc_defect";
      readonly errorClass: string;
      readonly role?: string | undefined;
      readonly mode?: string | undefined;
      readonly host?: string | undefined;
      readonly model?: string | undefined;
      readonly promptSha?: string | undefined;
      /** A crash's VTC frames (root-relative `at` lines); the module keeps the top three. */
      readonly stack?: string | undefined;
      readonly at: string;
    }
  | {
      readonly type: "cost_regression";
      readonly role: string;
      readonly host?: string | undefined;
      readonly model?: string | undefined;
      readonly metric: ScorecardMetricId;
      readonly baselinePromptSha: string;
      readonly promptSha?: string | undefined;
      readonly baseline: number;
      readonly current: number;
      readonly at: string;
    }
  | {
      /** An OSV advisory in VTC's own dependencies (D-bv (4)). */
      readonly type: "security_advisory";
      readonly advisoryId: string;
      readonly package: string;
      readonly at: string;
    }
  | {
      /** A D-cd improvement: Lookback's new-agent signal (and, later, tool, config, capability). */
      readonly type: "improvement";
      readonly kind: "new_agent" | "tool" | "config" | "capability";
      readonly subject: string;
      readonly role?: string | undefined;
      readonly metrics?: Readonly<Record<string, number>> | undefined;
      readonly at: string;
    }
  | {
      readonly type: "project_problem";
      readonly kind: ProjectProblemKind;
      readonly ruleId: string;
      readonly path?: string | undefined;
      readonly title: string;
      readonly detail: string;
      readonly run?: string | undefined;
      readonly at: string;
    };

/** The project the facts come from (`upstream/upstream.ts` `ProjectContext`). */
export interface UpstreamModuleContext {
  readonly repoRoot: string;
  readonly repo: GitHubRepo | null;
  readonly state: () => {
    readonly settings: AutomationSettings;
    readonly context: AutomationContext;
  };
  /** Never sent; the module builds its project-identifier denylist from it (D-by). */
  readonly identity: {
    readonly repo?: string | undefined;
    readonly remoteUrl?: string | undefined;
    readonly repoRoot?: string | undefined;
    readonly clientNames?: readonly string[] | undefined;
  };
  readonly knownValues: readonly string[];
  readonly redactSelectors?: readonly string[];
  /**
   * `project.yaml` `automation.evidence` for the project repo's PRs: `max_mb` in bytes and
   * `video` (`false`: screenshots only).
   */
  readonly evidence?: { readonly maxBytes?: number; readonly video?: boolean };
}

/** What the module answers; `error` is a failure the daemon reports as an engine notice. */
export interface UpstreamModuleOutcome {
  readonly status: string;
  readonly detail?: string;
}

export interface LookbackPrInput {
  readonly replay: ReplayResult;
  readonly proposal: PromptProposal;
  /** The role's scorecards on the replay's host, for the evidence charts (reading 212(3)). */
  readonly scorecards?: readonly Scorecard[];
}

/**
 * An automatic PR from a branch an automatic run pushed (`upstream/upstream.ts` `AutoPrInput` with
 * `source.pushedHead`, the parts the daemon sets).
 */
export interface UpstreamModuleAutoPr {
  readonly target: "upstream" | "project";
  readonly kind: AutoKind;
  readonly fingerprint: AutoFingerprint;
  /** One line for `vtc(<kind>): …`. */
  readonly summary: string;
  readonly slots: Partial<Record<AutoTemplateSlot, string>>;
  readonly source: { readonly pushedHead: GitSha };
  /** Upstream: the report the body is checked against (D-by). */
  readonly report?: UpstreamReport | undefined;
  readonly issue?: number | undefined;
  readonly evidence: {
    readonly plan: {
      readonly run?: string;
      readonly upstreamSafe: boolean;
      readonly change: "ui" | "non_ui";
    };
    readonly snapshot: {
      readonly routes: Readonly<Record<string, unknown>>;
      readonly events: readonly unknown[];
    };
    readonly gateReport?: GateReport | undefined;
  };
  readonly specVerifier: "pending" | "pass" | "fail";
  /** Labels beside `vtc:auto` and the kind's (a new agent's PR: `needs-eval`, D-cd). */
  readonly extraLabels?: readonly string[];
}

/** The module as the daemon calls it (`upstream/upstream.ts` `Upstream`). */
export interface UpstreamModule {
  report(fact: UpstreamModuleFact, ctx: UpstreamModuleContext): Promise<UpstreamModuleOutcome>;
  openLookbackPr(
    input: LookbackPrInput,
    ctx: UpstreamModuleContext,
  ): Promise<UpstreamModuleOutcome>;
  /** Opens an automatic PR: caps, evidence (or no PR), draft, then ready on the verifier's pass. */
  openPullRequest(
    input: UpstreamModuleAutoPr,
    ctx: UpstreamModuleContext,
  ): Promise<UpstreamModuleOutcome>;
  /** Marks an automatic PR ready once its Spec-Verifier verdict passed. */
  completePullRequest(
    target: "upstream" | "project",
    number: number,
    specVerifier: "pass" | "fail",
    ctx: UpstreamModuleContext,
  ): Promise<UpstreamModuleOutcome>;
  sweep(ctx: UpstreamModuleContext): Promise<readonly UpstreamModuleOutcome[]>;
  /**
   * On the bs-vtc checkout: asks `startRun` for the open fixable VTC-repo issues no PR answers
   * yet, whichever installation opened them (reading 216); elsewhere it asks for none.
   */
  pickup(ctx: UpstreamModuleContext): Promise<readonly AutomationRunRef[]>;
}

/** What the module is built with (`upstream/upstream.ts` `UpstreamDeps`, the parts the daemon sets). */
export interface UpstreamModuleDeps {
  readonly automation: AutomationDeps;
  readonly vtcHome: string;
  readonly guardDir: string;
  readonly vtcVersion: string;
  readonly assets: AssetBundle;
  readonly emit: (event: { readonly type: string; readonly payload: unknown }) => void;
  /**
   * Starts an automatic run from one of its issues (D-bv "a fixable one becomes a normal VTC run";
   * D-cd; AD-27 rule 2): the wiring queues it for `Engine.startAutomatic` until no run of the repo
   * is open. The module calls it right after it opened a fixable item's issue (`fixableItem`).
   */
  readonly startRun?: (input: StartInput, issue: AutomationRunRef) => Promise<void>;
  readonly now?: () => Date;
  /**
   * Reads a file at a commit (engine git): the Lookback PR reads the role prompt and the CHANGELOG
   * at the default branch's commit it builds on, never the work tree; without it none opens.
   */
  readonly gitOps?: (repoRoot: string) => Pick<GitOps, "readFileAtCommit">;
  /** Fetches the shared automation branches and reads commit messages (engine git). */
  readonly remoteRefs?: (repoRoot: string) => RemoteRefs;
}

/** `upstream.createUpstream`. */
export type CreateUpstreamModule = (deps: UpstreamModuleDeps) => UpstreamModule;

// ------------------------------------------------------------------- fact mapping

/** Pure: the module's fact for an engine fact, or `null` (a Lookback fact goes to a PR). */
export const upstreamModuleFact = (fact: AutomationFact): UpstreamModuleFact | null => {
  if (fact.target === "upstream") {
    if (fact.kind === "defect" && fact.errorClass !== undefined)
      return {
        type: "vtc_defect",
        errorClass: fact.errorClass,
        role: fact.role,
        mode: fact.mode,
        host: fact.host,
        model: fact.model,
        promptSha: fact.promptSha,
        ...(fact.stack === undefined ? {} : { stack: fact.stack }),
        at: fact.at,
      };
    if (
      fact.kind === "cost" &&
      fact.role !== undefined &&
      fact.metric !== undefined &&
      fact.baselinePromptSha !== undefined &&
      fact.baseline !== undefined &&
      fact.current !== undefined
    )
      return {
        type: "cost_regression",
        role: fact.role,
        host: fact.host,
        model: fact.model,
        metric: fact.metric,
        baselinePromptSha: fact.baselinePromptSha,
        promptSha: fact.promptSha,
        baseline: fact.baseline,
        current: fact.current,
        at: fact.at,
      };
    if (fact.kind === "security" && fact.advisory !== undefined)
      return {
        type: "security_advisory",
        advisoryId: fact.advisory.id,
        package: fact.advisory.package,
        at: fact.at,
      };
    if (
      (fact.kind === "new_agent" ||
        fact.kind === "tool" ||
        fact.kind === "config" ||
        fact.kind === "capability") &&
      fact.subject !== undefined
    )
      return {
        type: "improvement",
        kind: fact.kind,
        subject: fact.subject,
        ...(fact.role === undefined ? {} : { role: fact.role }),
        ...(fact.metrics === undefined ? {} : { metrics: fact.metrics }),
        at: fact.at,
      };
    return null;
  }
  switch (fact.kind) {
    case "parked":
    case "ci_failure":
    case "escaped_defect":
    case "finding":
    case "final_review":
      if (fact.ruleId === undefined) return null;
      return {
        type: "project_problem",
        kind: fact.kind,
        ruleId: fact.ruleId,
        path: fact.path,
        title: fact.title ?? fact.detail.slice(0, 200),
        detail: fact.detail,
        run: fact.run,
        at: fact.at,
      };
    default:
      return null;
  }
};

/** `owner/name` of a GitHub remote URL, or `null`. */
export const githubRepoOf = (url: string | null): GitHubRepo | null => {
  if (url === null) return null;
  const match =
    /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(
      url.trim(),
    );
  const repo = match?.[1];
  return repo !== undefined &&
    /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/.test(repo)
    ? repo
    : null;
};

// ------------------------------------------------------- an automatic run's PR

const bullets = (lines: readonly string[], none: string): string =>
  lines.length === 0 ? none : lines.map((l) => `- ${l}`).join("\n");

/**
 * Pure: the module's PR input for an automatic run's release (AD-27 rules 2, 3 and 6). The body
 * slots say what the run did, against which issue, and how it was checked; the evidence is the
 * run's own replay (a project-repo PR, or VTC building VTC on the bs-vtc checkout, records its own
 * run, reading 208) plus the Final Review gate report. An upstream PR carries the allowlisted
 * report the module checks its body against (D-by).
 */
export const automaticPrInput = (
  release: AutomaticRelease,
  snapshot: EvidenceSnapshot,
  vtcVersion: string,
): UpstreamModuleAutoPr => {
  const { automation } = release;
  const issue = `#${String(automation.issue)}`;
  const report =
    automation.target.kind === "upstream"
      ? UpstreamReportSchema.safeParse({
          v: 1,
          kind: automation.kind,
          fingerprint: automation.fingerprint,
          vtc_version: vtcVersion,
          occurrences: 1,
          first_seen: release.startedAt,
          last_seen: release.at,
        })
      : undefined;
  const risks = [...new Set(release.tasks.flatMap((t) => t.risk_tags))].sort();
  return {
    target: automation.target.kind,
    kind: automation.kind,
    fingerprint: automation.fingerprint,
    summary: release.title,
    slots: {
      summary: release.title,
      why: `VTC ran on its own for issue ${issue} (${automation.kind}). The issue is the spec, so the human gates G1 and G2 were skipped; the Spec Verifier checked the work against the issue.`,
      changes: bullets(
        release.tasks.map((t) => `${t.id}: ${t.title}`),
        "No task changed code.",
      ),
      verification: [
        bullets(
          release.steps.map((s) => `Final Review step ${String(s.step)}: ${s.status}`),
          "No Final Review step recorded a result.",
        ),
        ...(release.gateReport === undefined
          ? []
          : [`Final Review gate run: ${release.gateReport.verdict}.`]),
      ].join("\n\n"),
      risk: `${risks.length === 0 ? "No task carries a risk tag." : `Risk tags: ${risks.join(", ")}.`} Every gate, review and risk rule applied; a risky change would have stopped for a human. Revert the merge to roll back.`,
      checklist: [
        `- [ ] The change does what issue ${issue} asks, and nothing more`,
        "- [ ] The evidence shows the run and its checks",
        "- [ ] Merge it yourself: VTC never merges an automatic PR",
      ].join("\n"),
    },
    source: { pushedHead: GitShaSchema.parse(release.head) },
    ...(report?.success === true ? { report: report.data } : {}),
    issue: automation.issue,
    evidence: {
      plan: { run: release.run, upstreamSafe: false, change: release.change },
      snapshot,
      ...(release.gateReport === undefined ? {} : { gateReport: release.gateReport }),
    },
    specVerifier: release.specVerifier,
    // D-cd: a new role has no recorded dispatches a replay could run again, so its PR is
    // evidence-only and says so
    ...(automation.kind === "new_agent" ? { extraLabels: [AUTO_LABELS.needsEval] } : {}),
  };
};

// ------------------------------------------------------------- the Lookback PR input

/** The largest replay result file the bridge reads. */
const REPLAY_FILE_MAX_BYTES = 1024 * 1024;

/**
 * The `ReplayResult` and `PromptProposal` of a replay verdict `improve` (D-cb), or why there are
 * none. The replay file must be the one the event names, under `.vtc/lookback/replays/`, its
 * bytes still hashing to the SHA-256 the event recorded (the file is role-writable, so an edited
 * one, or an event without the hash, opens no PR; spine §5 reading 128), for that proposal, saying
 * `improve`; the proposal must be the one replayed; its editable section is
 * the candidate version Lookback stored and the replay measured (`candidateEditable`), because the
 * proposal files are role-writable and a later RETRO may have rewritten them.
 */
export const readLookbackPrInput = async (input: {
  readonly projectRoot: string;
  readonly proposal: string;
  readonly replayPath: string;
  /** `lookback.replay_finished` `sha256`: the bytes the engine wrote. */
  readonly replaySha256: string | undefined;
  readonly readProposal: (role: string) => Promise<unknown>;
  readonly candidateEditable: (replay: ReplayResult) => Promise<string | undefined>;
}): Promise<LookbackPrInput | string> => {
  const path = input.replayPath;
  if (!path.startsWith(`${LOOKBACK_REPO.replaysDir}/`) || path.split("/").includes(".."))
    return `the replay result ${path} is not under ${LOOKBACK_REPO.replaysDir}`;
  if (input.replaySha256 === undefined)
    return `the replay result ${path} has no recorded SHA-256, so the engine's file cannot be told from an edited one`;
  let raw: unknown;
  try {
    // the engine writes it; a link (at any component) or an oversized file is never read
    const read = readRepoFileCapped(input.projectRoot, path, REPLAY_FILE_MAX_BYTES);
    if (!read.ok && read.reason === "not_a_file")
      return `the replay result ${path} is not a regular file`;
    if (!read.ok && read.reason === "too_large") return `the replay result ${path} is too large`;
    if (!read.ok) return `the replay result ${path} is missing or not JSON`;
    if (sha256Hex(read.text) !== input.replaySha256)
      return `the replay result ${path} was edited after the engine wrote it`;
    raw = JSON.parse(read.text);
  } catch {
    return `the replay result ${path} is missing or not JSON`;
  }
  const replay = parsePersisted(ReplayResultSchema, raw);
  if (!replay.success) return `the replay result ${path} is not a ReplayResult`;
  if (replay.data.proposal !== input.proposal)
    return `the replay result ${path} is for ${replay.data.proposal}, not ${input.proposal}`;
  if (replay.data.verdict !== "improve")
    return `the replay result ${path} says ${replay.data.verdict}, not improve`;
  const proposal = PromptProposalSchema.safeParse(await input.readProposal(replay.data.role));
  if (!proposal.success || proposal.data.id !== input.proposal)
    return `the proposal ${input.proposal} of ${replay.data.role} is no longer in its proposal file`;
  const editable = await input.candidateEditable(replay.data);
  if (editable === undefined)
    return `the candidate version ${replay.data.candidate.slice(0, 12)} of ${replay.data.role} is not stored`;
  return { replay: replay.data, proposal: { ...proposal.data, editable } };
};

// ------------------------------------------------------------------- the bridge

/** The sweep runs at most this often (the module's "daily sweep"). */
export const UPSTREAM_SWEEP_EVERY_MS = 24 * 60 * 60_000;

const SWEEP_FILE = "automation-sweep.json";
/** The automatic runs' pushed heads the module opened a PR for (or decided on). */
const RELEASED_FILE = "automation-released.json";
/** How many of them the guard dir remembers. */
const RELEASED_MAX = 200;

export interface UpstreamBridgeOptions {
  /** The engine's guard dir (`Engine.guardDir`): the module's staging, the sweep clock. */
  readonly guardDir: string;
  readonly vtcVersion: string;
  readonly assets: AssetBundle;
  /** The project's push remote URL (`origin`), or `null`. */
  readonly remoteUrl: string | null;
  /** The project's client names (`project.yaml` `client`), never sent (D-by). */
  readonly clientNames: () => readonly string[];
  /** Known secret values (the repo's `.env`), redacted from every body. */
  readonly knownValues: () => readonly string[];
  /** `gates.yml` `visual.redact_selectors`. */
  readonly redactSelectors: () => readonly string[] | undefined;
  /** `project.yaml` `automation.evidence` (absent: the defaults). */
  readonly projectEvidence: () =>
    { readonly max_mb?: number | undefined; readonly video?: boolean | undefined } | undefined;
  /** A replay verdict `improve`'s PR input, or why there is none ({@link readLookbackPrInput}). */
  readonly lookbackPr: (fact: AutomationFact) => Promise<LookbackPrInput | string>;
  /**
   * The project's scorecards of a role on a host (Lookback's index), which the Lookback PR's
   * upstream-safe evidence charts (VTC-side numbers only; the module drops their breakdown).
   */
  readonly scorecards?: (role: string, host: string) => readonly Scorecard[];
  /** The run's read routes and events for the evidence browser ({@link automaticPrInput}). */
  readonly evidenceSnapshot: (run: string) => EvidenceSnapshot;
  /** Engine git's file-at-commit reader and remote refs for a repo (`createGitOps`, `createRemoteRefs`). */
  readonly gitOps: NonNullable<UpstreamModuleDeps["gitOps"]>;
  readonly remoteRefs: NonNullable<UpstreamModuleDeps["remoteRefs"]>;
  /** The default plumbing when the cli injects none (`git.createGitPlumbing`). */
  readonly plumbing: NonNullable<AutomationDeps["plumbing"]>;
}

/** Pure: `automation.evidence` as the module reads it (`max_mb` in bytes), or none when unset. */
export const projectEvidence = (
  config:
    { readonly max_mb?: number | undefined; readonly video?: boolean | undefined } | undefined,
): UpstreamModuleContext["evidence"] => {
  if (config === undefined || (config.max_mb === undefined && config.video === undefined))
    return undefined;
  return {
    ...(config.max_mb === undefined ? {} : { maxBytes: Math.floor(config.max_mb * 1024 * 1024) }),
    ...(config.video === undefined ? {} : { video: config.video }),
  };
};

/** The module's event as an engine event draft (its payload is the event's data). */
const asDraft = (event: { readonly type: string; readonly payload: unknown }) => ({
  type: event.type,
  actor: "engine" as const,
  data: event.payload as Record<string, unknown>,
});

/**
 * The wiring's `CreateUpstream` for the upstream module's factory: the module built with the
 * cli's automation seams (and engine git's plumbing when none is injected), fed the engine facts
 * in its vocabulary, its events recorded through the wiring's sink, its sweep once a day.
 */
export const bridgeUpstream =
  (create: CreateUpstreamModule, options: UpstreamBridgeOptions): CreateUpstream =>
  (deps): UpstreamWiring => {
    const now = deps.now;
    const module = create({
      automation: { ...deps.automation, plumbing: deps.automation.plumbing ?? options.plumbing },
      vtcHome: deps.vtcHome,
      guardDir: options.guardDir,
      vtcVersion: options.vtcVersion,
      assets: options.assets,
      emit: (event) => {
        deps.emit(asDraft(event));
      },
      startRun: deps.startRun,
      now,
      gitOps: options.gitOps,
      remoteRefs: options.remoteRefs,
    });
    const repo = githubRepoOf(options.remoteUrl);
    const ctx = (): UpstreamModuleContext => {
      const selectors = options.redactSelectors();
      const evidence = projectEvidence(options.projectEvidence());
      return {
        repoRoot: deps.projectRoot,
        repo,
        state: () => ({ settings: deps.settings(), context: deps.context() }),
        identity: {
          ...(repo === null ? {} : { repo }),
          ...(options.remoteUrl === null ? {} : { remoteUrl: options.remoteUrl }),
          repoRoot: deps.projectRoot,
          clientNames: options.clientNames(),
        },
        knownValues: options.knownValues(),
        ...(selectors === undefined ? {} : { redactSelectors: selectors }),
        ...(evidence === undefined ? {} : { evidence }),
      };
    };
    const failed = (outcome: UpstreamModuleOutcome, what: string): void => {
      if (outcome.status === "error")
        throw new Error(`${what}: ${outcome.detail ?? "the upstream module failed"}`);
    };
    const sweepFile = join(options.guardDir, SWEEP_FILE);
    const lastSweep = (): number => {
      try {
        const value = JSON.parse(readPrivateFile(sweepFile) ?? "null") as { at?: unknown } | null;
        return typeof value?.at === "string" ? Date.parse(value.at) : Number.NaN;
      } catch {
        return Number.NaN;
      }
    };
    const releasedFile = join(options.guardDir, RELEASED_FILE);
    const released = (): string[] => {
      try {
        const value = JSON.parse(readPrivateFile(releasedFile) ?? "[]") as unknown;
        return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
      } catch {
        return [];
      }
    };
    return {
      onAutomaticRelease: async (release) => {
        const target = release.automation.target;
        // the run pushed to this project's remote: its PR can only open in that repo
        if (repo === null || target.repo !== repo)
          throw new Error(
            `run ${release.run} pushed its work to ${repo ?? "a remote that is not on GitHub"}, but its issue is in ${target.repo}`,
          );
        if (release.pr !== undefined) {
          if (release.specVerifier === "pending") return;
          failed(
            await module.completePullRequest(target.kind, release.pr, release.specVerifier, ctx()),
            "the automatic run's PR",
          );
          return;
        }
        // one PR per pushed head: a release that runs again (an engine restart) opens no second
        const key = [target.kind, target.repo, release.automation.fingerprint, release.head].join(
          " ",
        );
        const seen = released();
        if (seen.includes(key)) return;
        const input = automaticPrInput(
          release,
          options.evidenceSnapshot(release.run),
          options.vtcVersion,
        );
        failed(await module.openPullRequest(input, ctx()), "the automatic run's PR");
        ensurePrivateDir(options.guardDir);
        writePrivateFile(releasedFile, `${JSON.stringify([...seen, key].slice(-RELEASED_MAX))}\n`);
      },
      onFact: async (fact) => {
        if (fact.target === "upstream" && fact.kind === "lookback") {
          const input = await options.lookbackPr(fact);
          if (typeof input === "string") throw new Error(`no Lookback PR: ${input}`);
          const scorecards = options.scorecards?.(input.replay.role, input.replay.host) ?? [];
          failed(
            await module.openLookbackPr(
              { ...input, ...(scorecards.length === 0 ? {} : { scorecards }) },
              ctx(),
            ),
            "the Lookback PR",
          );
          return;
        }
        const mapped = upstreamModuleFact(fact);
        if (mapped === null) return;
        failed(await module.report(mapped, ctx()), `the ${fact.kind} report`);
      },
      sweep: async () => {
        // "VTC builds VTC" (reading 216): every tick, the bs-vtc checkout's engine asks for the
        // runs of the fixable issues other projects' daemons opened (the wiring queues each once)
        // (one that fails is told with the sweep's outcome and never stops the sweep)
        const failures: string[] = [];
        try {
          await module.pickup(ctx());
        } catch (error) {
          failures.push(
            `picking up the fixable issues: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const at = now();
        const last = lastSweep();
        const due = Number.isNaN(last) || at.getTime() - last >= UPSTREAM_SWEEP_EVERY_MS;
        if (due) {
          const errors = (await module.sweep(ctx())).filter((o) => o.status === "error");
          // the clock moves only after a sweep that worked: a failed one is tried again at the
          // wiring's next tick, not a day later
          if (errors.length === 0) {
            ensurePrivateDir(options.guardDir);
            writePrivateFile(sweepFile, `${JSON.stringify({ at: at.toISOString() })}\n`);
          }
          failures.push(...errors.map((o) => o.detail ?? "error"));
        }
        if (failures.length > 0) throw new Error(failures.join("; ").slice(0, 500));
      },
    };
  };

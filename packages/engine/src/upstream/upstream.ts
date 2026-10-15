/**
 * The upstream module (AD-27; D-bu): automatic issues and PRs in VTC's own repo and in the
 * project's repo, from the engine facts the daemon hands over. It reaches GitHub, git and capture
 * only through the `@vtc/shared` seams in `AutomationDeps`, checks the opt-outs when an item is
 * queued and again when it is sent, dedupes against the remote label listing, keeps the caps, fails
 * closed on privacy, opens no PR without evidence, and reports every action (or skip) as an event.
 * The list → decide → write sequence of a target repo runs under a lock file in VTC's home, so the
 * daemons of several projects reporting to the same repo never race each other.
 */
import { mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  AUTO_LABELS,
  DESIGN_FLOWS_PATH,
  LOOKBACK_REPO,
  ROUTING_FACT_METRICS,
  ROUTING_REPLAY_VERDICT_CODES,
  TIER_ORDER,
  RoutingScorecardSchema,
  autoBranchName,
  autoKindLabel,
  autoPushRefAllowed,
  renderAutoMarker,
  redactSecrets,
  UPSTREAM_EVENT_PAYLOAD_SCHEMAS,
  upstreamSubjectKey,
  type AssetBundle,
  type AutoFingerprint,
  type AutoKind,
  type AutoIssueRef,
  type AutoPrRef,
  type AutomationContext,
  type AutomationDeps,
  type AutomationSettings,
  type AutomationSkipReason,
  type AutoPullRequestService,
  type GateReport,
  type GitHubRepo,
  type GitOps,
  type GitSha,
  type IssueService,
  type PlumbingChange,
  type PromptProposal,
  type ReplayResult,
  type RoutingScorecard,
  type Scorecard,
  type AutomationRunRef,
  type StartInput,
  type UpstreamReport,
} from "@vtc/shared";
import type { z } from "zod";
import {
  loadAutoTemplate,
  renderBody,
  renderNote,
  renderTitle,
  UNAVAILABLE,
  type TemplateSlots,
} from "./body.js";
import {
  decideIssue,
  isMaterialChange,
  issueCapReached,
  planPrCap,
  planQuietSweep,
  planStalePrs,
  QUIET_CLOSE_MARKER,
} from "./decisions.js";
import { changedFlow } from "./evidence/flow.js";
import { createFfmpegCommand, type FfmpegCommand } from "./evidence/gif.js";
import type { EvidencePlanInput } from "./evidence/plan.js";
import { prepareEvidence } from "./evidence/pipeline.js";
import { withFileLock } from "./file-lock.js";
import { autoFingerprint } from "./fingerprint.js";
import { createGhServices } from "./gh-services.js";
import { ledgerPath, openLedger, type Ledger, type LedgerRecord } from "./ledger.js";
import {
  assertNoProjectPaths,
  assertUpstreamSafe,
  projectDenylist,
  projectUpstreamReport,
  redactProjectText,
  selfDenylist,
  type ProjectIdentity,
} from "./privacy.js";
import {
  buildLookbackPr,
  isEngineerProfileYaml,
  roleYamlPath,
  rolePromptIdentitySha,
} from "./lookback-pr.js";
import {
  artifactRouteKey,
  jsonArtifact,
  upstreamEvidenceSnapshot,
  type UpstreamEvidenceData,
} from "./evidence/upstream-snapshot.js";
import { upstreamIssueSlots } from "./report-render.js";
import { ensureDirNoFollow, readRegularFileBelow, repoFileName } from "./safe-fs.js";
import { AutomationSkip, isAutomationSkip } from "./skip.js";
import { createKeyedSerial } from "./queue.js";
import {
  AUTO_BRANCHES_REFSPEC,
  refreshRemote,
  vtcAuthored,
  type RemoteRefs,
} from "./remote-refs.js";
import { createStaging, stagingRootFor, type Staging } from "./staging.js";
import { upstreamStateDir } from "./state-dir.js";
import {
  buildRoutingPr,
  routingMoveOfBody,
  routingMoveOfMetrics,
  routingReplayOfBody,
  routingReplayOfMetrics,
  type RoutingMove,
  type RoutingReplay,
} from "./routing-pr.js";
import {
  assertProducerCell,
  ROUTING_TABLE_FILE,
  routingSubjectOfBody,
  type RoutingSubject,
} from "./subject.js";
import {
  evaluateTrigger,
  fixableItem,
  fixableUpstreamIssue,
  type AutomationFact,
  type AutoWorkItem,
} from "./triggers.js";
import { framesFromIssueBody, framesTouchUi, projectTouchesUi } from "./ui-paths.js";

type Schemas = typeof UPSTREAM_EVENT_PAYLOAD_SCHEMAS;
export type UpstreamEventType = keyof Schemas;
/** One automation event (D-ca); the daemon appends it to the run's log. */
export type UpstreamEvent = {
  [K in UpstreamEventType]: { readonly type: K; readonly payload: z.infer<Schemas[K]> };
}[UpstreamEventType];

/** What the opt-outs and controls say now (re-read at enqueue and at send). */
export interface AutomationState {
  readonly settings: AutomationSettings;
  readonly context: AutomationContext;
}

/** The project the facts come from. */
export interface ProjectContext {
  readonly repoRoot: string;
  /** The project's GitHub repo; `null` without a GitHub remote. */
  readonly repo: GitHubRepo | null;
  readonly state: () => AutomationState;
  /** Never sent; the project-identifier denylist is built from it. */
  readonly identity: ProjectIdentity;
  /** Known secret values (the run's secrets, `dotenvValues` of the project's env files). */
  readonly knownValues: readonly string[];
  /** `visual.redact_selectors`. */
  readonly redactSelectors?: readonly string[];
  /**
   * `project.yaml` `automation.evidence`, resolved by the daemon, for the project repo's PRs:
   * `maxBytes` is `max_mb` in bytes (it lowers the per-PR budget, never above `EVIDENCE_LIMITS`);
   * `video: false` drops the recordings (screenshots only, `evidence: partial`).
   */
  readonly evidence?: { readonly maxBytes?: number; readonly video?: boolean };
}

export interface UpstreamDeps {
  readonly automation: AutomationDeps;
  readonly vtcHome: string;
  /** The engine's guard dir (`guardDirFor`); staging directories live under it. */
  readonly guardDir: string;
  readonly vtcVersion: string;
  /** The compiled plugins' templates and the dashboard export. */
  readonly assets: AssetBundle;
  /**
   * Every action and skip as an event (D-ca). An unexpected failure (a gh, git or template error)
   * is `automation.skipped` with reason `error` and the redacted message (contracts 5.4.0), and
   * the call still answers `{ status: "error" }`, so the daemon can retry it.
   */
  readonly emit: (event: UpstreamEvent) => void;
  readonly now?: () => Date;
  /** The `gh` binary for the default services. */
  readonly ghCommand?: string;
  /** A repo's default branch; default `gh repo view`. */
  readonly defaultBranch?: (repo: GitHubRepo) => Promise<string>;
  /** Default with `automation.ffmpeg`: `createFfmpegCommand()` (the `ffmpeg` on PATH). */
  readonly ffmpegCommand?: FfmpegCommand;
  /**
   * Reads a file at a commit (engine git's `GitOps`). The Lookback PR reads the role prompt and
   * the CHANGELOG at the default branch's commit it builds on; without it no Lookback PR opens
   * (never from the checkout's work tree, which may be dirty, behind or on another branch).
   */
  readonly gitOps?: (repoRoot: string) => Pick<GitOps, "readFileAtCommit">;
  /**
   * Absolute directories VTC's own sources run from. Absolute stack frames outside them are
   * dropped; absent, only the single-file binary's own frames count (fail closed).
   */
  readonly vtcRoots?: readonly string[];
  /**
   * Starts an automatic run from one of its issues (D-bv "a fixable one becomes a normal VTC run",
   * D-cd; AD-27 rule 2): the daemon's `Engine.startAutomatic`, which queues the run until no other
   * run of the repo is open. The module calls it once, right after it opened the issue of a
   * fixable item (`fixableItem`) with `automation.prs` on, or saw it again while it is open; for
   * a VTC-repo item only when the project is the configured `upstream.checkout` itself ("VTC
   * builds VTC"), which also picks up the fixable issues other projects' daemons opened
   * (`pickup`). Absent: no run is started. The daemon queues each issue's run once.
   */
  readonly startRun?: (input: StartInput, issue: AutomationRunRef) => Promise<void>;
}

/** The longest request an automatic run is started with (`StartInput.request` holds 20 000). */
const RUN_REQUEST_MAX = 12_000;

export type AutomationOutcome =
  /** The fact raises nothing. */
  | { readonly status: "ignored" }
  /** The occurrence is in the ledger; it is not yet recurring enough to raise. */
  | { readonly status: "recorded"; readonly fingerprint: AutoFingerprint }
  | { readonly status: "skipped"; readonly reason: AutomationSkipReason; readonly detail: string }
  | {
      readonly status: "issue";
      readonly action: "opened" | "commented" | "edited" | "reopened" | "closed";
      readonly number: number;
      readonly url: string;
    }
  | {
      readonly status: "pr";
      readonly number: number;
      readonly url: string;
      readonly ready: boolean;
      readonly evidence: "complete" | "partial";
    }
  | { readonly status: "pr_closed"; readonly number: number; readonly url: string }
  | { readonly status: "error"; readonly detail: string };

/**
 * What an automatic PR changes: commit these files, or a branch the run already pushed. With
 * `pushedHead`, `base` is the default-branch commit the run's branch was cut from (the run's
 * recorded start commit); a UI PR's before/after renders it as the "before" (D-ct). Without it
 * the module does not guess (the default branch may have moved since the cut), so no before/after
 * is rendered and the evidence is partial (`capture_failed`). `screens` are the `screens.yaml` ids
 * the run's tasks touched, when the caller knows them: the before/after renders those screens, and
 * a flow that passes one is scripted when no flow's globs match a changed path (reading 247(7)).
 */
export type PrSource =
  | { readonly changes: readonly PlumbingChange[]; readonly message: string }
  | {
      readonly pushedHead: GitSha;
      readonly base?: GitSha | undefined;
      readonly screens?: readonly string[] | undefined;
    };

export interface AutoPrInput {
  readonly target: "upstream" | "project";
  readonly kind: AutoKind;
  readonly fingerprint: AutoFingerprint;
  readonly role?: string | undefined;
  /** One-line summary for `vtc(<kind>): …`. */
  readonly summary: string;
  /** Body slots besides marker, note, title and evidence. */
  readonly slots: TemplateSlots;
  readonly source: PrSource;
  /** Upstream PRs: the report the body is checked against (D-by). */
  readonly report?: UpstreamReport | undefined;
  /** Extra texts the privacy check reads (for upstream); committed files are always read. */
  readonly checkTexts?: readonly string[];
  /**
   * Upstream: model-written free text this PR carries beyond its slots (proposal summaries,
   * hypotheses, new prompt lines). With the title and slots it is refused when it names a file
   * path outside VTC's tree (D-by).
   */
  readonly freeTexts?: readonly string[];
  readonly issue?: number | undefined;
  readonly evidence: {
    readonly plan: EvidencePlanInput;
    readonly snapshot: {
      readonly routes: Readonly<Record<string, unknown>>;
      readonly events: readonly unknown[];
    };
    readonly gateReport?: GateReport | undefined;
    readonly uiShots?: readonly {
      readonly before: string;
      readonly after: string;
      readonly label: string;
    }[];
    /**
     * An upstream-safe page's VTC-side data (a Lookback replay, the role's scorecards): the
     * module builds that page's read routes from it and the report, never from `snapshot`
     * (reading 212(3)).
     */
    readonly upstream?: UpstreamEvidenceData;
  };
  /**
   * The Spec-Verifier verdict so far (AD-27 rule 2): the PR is marked ready only on `pass`, or on
   * `none` for a kind with no Spec Verifier (a Lookback prompt edit, a dependency bump). A branch
   * an automatic run pushed (`pushedHead`) always has one, so `none` keeps it draft.
   */
  readonly specVerifier: "pending" | "pass" | "fail" | "none";
  readonly extraLabels?: readonly string[];
}

export interface Upstream {
  /** Evaluates a fact and raises (or updates) its issue. */
  report(fact: AutomationFact, ctx: ProjectContext): Promise<AutomationOutcome>;
  /** Raises an evaluated item. */
  raise(item: AutoWorkItem, ctx: ProjectContext): Promise<AutomationOutcome>;
  /** Opens an automatic PR: caps, evidence (or no PR), commit and push, draft, then ready. */
  openPullRequest(input: AutoPrInput, ctx: ProjectContext): Promise<AutomationOutcome>;
  /**
   * A Lookback replay verdict `improve` (D-cb): commits the edited editable section of
   * `roles/<role>/prompt.md` plus a `ROLES_CHANGELOG` entry on the bs-vtc checkout, pushes
   * `vtc/auto/lookback/<fp8>`, opens a draft with upstream-safe evidence, then marks it ready.
   */
  openLookbackPr(
    input: {
      readonly replay: ReplayResult;
      readonly proposal: PromptProposal;
      /** The role's scorecards (VTC-side numbers), for the evidence charts. */
      readonly scorecards?: readonly Scorecard[];
    },
    ctx: ProjectContext,
  ): Promise<AutomationOutcome>;
  /** Marks an automatic PR ready once its Spec-Verifier verdict passed (automatic runs). */
  completePullRequest(
    target: "upstream" | "project",
    number: number,
    specVerifier: "pass" | "fail",
    ctx: ProjectContext,
  ): Promise<AutomationOutcome>;
  /** The daily sweep: quiet issues closed, PRs of closed issues closed. */
  sweep(ctx: ProjectContext): Promise<AutomationOutcome[]>;
  /**
   * On the bs-vtc checkout only ("VTC builds VTC", D-bv (2), D-cd; reading 216): asks `startRun`
   * for every open VTC-repo issue VTC can fix (`fixableUpstreamIssue`) that no open PR answers
   * yet, whichever installation opened it, with the issue's title and body as the spec. Returns
   * the issues it asked for; the daemon starts each issue's run at most once.
   */
  pickup(ctx: ProjectContext): Promise<readonly AutomationRunRef[]>;
  /** The services in use (the injected ones, or the gh-backed defaults). */
  readonly services: {
    readonly issues: IssueService;
    readonly pullRequests: AutoPullRequestService;
  };
}

/** The largest routing scorecard the module reads from a checkout. */
const ROUTING_SCORECARD_MAX_BYTES = 1024 * 1024;

/** The automatic issue a PR answers: the one it closes, else the open one of its fingerprint. */
const ownIssue = (
  listed: readonly AutoIssueRef[],
  input: Pick<AutoPrInput, "issue" | "fingerprint">,
): AutoIssueRef | undefined =>
  listed.find((i) =>
    input.issue === undefined
      ? i.state === "open" && i.marker?.fp === input.fingerprint
      : i.number === input.issue && i.marker?.fp === input.fingerprint,
  );

/**
 * A checkout's routing scorecard (D-cn, `LOOKBACK_REPO.routingScorecard`), never through a
 * symlink (the file or any directory below the checkout) and only when it is valid as its strict
 * contract (VTC vocabulary and numbers); else `undefined` (the chart is then not captured and the
 * evidence says so).
 */
const readRoutingScorecard = (repoRoot: string): RoutingScorecard | undefined => {
  const bytes = readRegularFileBelow(
    repoRoot,
    LOOKBACK_REPO.routingScorecard,
    ROUTING_SCORECARD_MAX_BYTES,
  );
  if (bytes === null) return undefined;
  try {
    const parsed = RoutingScorecardSchema.safeParse(JSON.parse(new TextDecoder().decode(bytes)));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

/** Pure: whether a routing scorecard holds the cell a routing change is about (D-cn). */
const holdsCell = (
  card: RoutingScorecard,
  cell: { readonly role: string; readonly size: string; readonly risk: string },
): boolean =>
  card.cells.some((c) => c.role === cell.role && c.size === cell.size && c.risk === cell.risk);

/**
 * A routing change's snapshot (D-cn): the run's routing scorecard route serves exactly `card`, the
 * one checked to hold the change's cell, or nothing when there is none, so the page never charts a
 * scorecard of unrelated cells. Any other PR's snapshot is left as it is.
 */
const withRoutingRoute = (
  snapshot: AutoPrInput["evidence"]["snapshot"],
  run: string | undefined,
  routing: boolean,
  card: RoutingScorecard | undefined,
): AutoPrInput["evidence"]["snapshot"] => {
  if (!routing || run === undefined) return snapshot;
  const key = artifactRouteKey(run, LOOKBACK_REPO.routingScorecard);
  const routes = Object.fromEntries(Object.entries(snapshot.routes).filter(([k]) => k !== key));
  if (card !== undefined) routes[key] = jsonArtifact(run, LOOKBACK_REPO.routingScorecard, card);
  return { ...snapshot, routes };
};

const QUIET_COMMENT = (version: string): string =>
  `${QUIET_CLOSE_MARKER}\nNot seen for 14 days as of VTC ${version}. VTC reopens this issue if it recurs; label it \`${AUTO_LABELS.keep}\` to keep it open or \`${AUTO_LABELS.muted}\` to stop it for good.`;

export const createUpstream = (deps: UpstreamDeps): Upstream => {
  const now = deps.now ?? ((): Date => new Date());
  const stagingRoot = stagingRootFor(deps.guardDir);
  const gh = createGhServices({
    ...(deps.ghCommand === undefined ? {} : { command: deps.ghCommand }),
    stagingRoot,
    pacing: { root: deps.vtcHome, dir: join(upstreamStateDir(deps.vtcHome), "pacing") },
  });
  const ffmpegCommand =
    deps.ffmpegCommand ?? (deps.automation.ffmpeg ? createFfmpegCommand() : undefined);

  /**
   * One target repo's list → decide → write sequence at a time across every VTC process on the
   * machine (AD-27 rule 1; AD-12 runs one daemon per project, all reporting to one upstream repo).
   */
  const withRepoLock = <T>(repo: GitHubRepo, task: () => Promise<T>): Promise<T> => {
    const dir = ensureDirNoFollow(
      deps.vtcHome,
      join(upstreamStateDir(deps.vtcHome), "locks"),
      "the automation lock",
    );
    return withFileLock(join(dir, `${repoFileName(repo)}.lock`), task);
  };
  /**
   * Fetch and commit messages for a repo: the injected plumbing's own (`GitPlumbing.fetch` and
   * `message`, contracts 5.4.0), or none. Before every commit or push on a shared branch
   * (`vtc-evidence`, `vtc/auto/*`) the module fetches that branch, and it recognises a head another
   * VTC installation pushed by its `Generated-by: VTC` trailer. Without them VTC builds on the
   * remote-tracking refs as last fetched by the user's own git: a stale ref then makes the (never
   * forced) push fail, the PR is skipped and no "evidence capture failed" is raised; and a branch
   * head missing from this installation's ledger counts as someone else's. (The daemon's
   * `RemoteRefs` fallback is gone, spine §5 reading 233.)
   */
  const remoteRefsFor = (repoRoot: string): RemoteRefs | undefined => {
    const plumbing = deps.automation.plumbing?.({ repoRoot });
    const fetch = plumbing?.fetch?.bind(plumbing);
    const message = plumbing?.message?.bind(plumbing);
    return fetch !== undefined && message !== undefined ? { fetch, message } : undefined;
  };

  /**
   * D-ct (spine §5 reading 247(7)): the flow an automatic UI PR records, chosen from the head's
   * `.vtc/design/flows.yaml` by the paths the head changes against the run's cut point; none
   * without a git reader, a flows file or a match.
   */
  const flowOfChange = (
    repoRoot: string,
    change: { readonly base: GitSha; readonly head: GitSha; readonly screens?: readonly string[] },
  ) => {
    const reader = deps.gitOps?.(repoRoot);
    if (reader === undefined) return Promise.resolve(undefined);
    const plumbing = deps.automation.plumbing?.({ repoRoot });
    return changedFlow({
      readFlowsFile: () => reader.readFileAtCommit(change.head, DESIGN_FLOWS_PATH),
      changedPaths: () => plumbing?.changedPaths?.(change.base, change.head) ?? Promise.resolve([]),
      screens: change.screens,
    });
  };

  const issues = deps.automation.issues ?? gh.issues;
  const pullRequests = deps.automation.pullRequests ?? gh.pullRequests;
  const defaultBranch = deps.defaultBranch ?? gh.defaultBranch;

  const emit = <K extends UpstreamEventType>(type: K, payload: z.input<Schemas[K]>): void => {
    const parsed = UPSTREAM_EVENT_PAYLOAD_SCHEMAS[type].parse(payload) as z.infer<Schemas[K]>;
    deps.emit({ type, payload: parsed } as UpstreamEvent);
  };

  const repoOf = (target: "upstream" | "project", ctx: ProjectContext): GitHubRepo | null =>
    target === "upstream" ? deps.automation.upstream.repo : ctx.repo;

  /** The engine's guard dir, created 0700 if the engine has not yet (the project ledger's root). */
  const privateGuardDir = (): string => {
    mkdirSync(deps.guardDir, { recursive: true, mode: 0o700 });
    return deps.guardDir;
  };

  const ledgerFor = (target: "upstream" | "project", ctx: ProjectContext): Ledger =>
    target === "upstream"
      ? openLedger(
          ledgerPath({ kind: "upstream", vtcHome: deps.vtcHome }),
          ctx.knownValues,
          deps.vtcHome,
        )
      : openLedger(
          ledgerPath({ kind: "project", guardDir: privateGuardDir() }),
          ctx.knownValues,
          deps.guardDir,
        );

  /** The opt-outs and controls; checked when an item is queued and again when it is sent. */
  const gate = (
    target: "upstream" | "project",
    what: "issues" | "prs",
    ctx: ProjectContext,
  ): void => {
    const { settings, context } = ctx.state();
    if (context.paused) throw new AutomationSkip("paused", "vtc pause is in effect");
    if (!context.ghLoggedIn) throw new AutomationSkip("gh_unavailable", "gh is not logged in");
    if (target === "upstream") {
      if (!settings.upstream || !deps.automation.upstream.share) {
        throw new AutomationSkip("share_off", "upstream reports are off");
      }
      return;
    }
    if (!context.githubRemote || ctx.repo === null) {
      throw new AutomationSkip("no_github_remote", "the project has no GitHub remote");
    }
    if (!settings[what]) throw new AutomationSkip("disabled", `automation.${what} is off`);
  };

  const skipped = (
    error: AutomationSkip,
    meta: { target?: "upstream" | "project"; kind?: AutoKind; fingerprint?: string },
    ctx: ProjectContext,
  ): AutomationOutcome => {
    const repo = meta.target === undefined ? null : repoOf(meta.target, ctx);
    emit("automation.skipped", {
      reason: error.reason,
      detail: error.detail.slice(0, 500),
      ...(meta.target === undefined || repo === null
        ? {}
        : { target: { kind: meta.target, repo } }),
      ...(meta.kind === undefined ? {} : { kind: meta.kind }),
      ...(meta.fingerprint === undefined ? {} : { fingerprint: meta.fingerprint }),
    });
    return { status: "skipped", reason: error.reason, detail: error.detail };
  };

  /**
   * An unexpected failure (AD-27 rule 7; contracts 5.4.0): visible as `automation.skipped` with
   * reason `error` and the message through the shared redaction, and answered as `error` so the
   * daemon can retry the action.
   */
  const failure = (
    error: unknown,
    meta: { target?: "upstream" | "project"; kind?: AutoKind; fingerprint?: string },
    ctx: ProjectContext,
  ): AutomationOutcome => {
    const raw = error instanceof Error ? error.message : String(error);
    const detail =
      redactSecrets(raw, ctx.knownValues).trim().slice(0, 500) || "an automatic action failed";
    skipped(new AutomationSkip("error", detail), meta, ctx);
    return { status: "error", detail };
  };

  const guarded = async (
    meta: { target?: "upstream" | "project"; kind?: AutoKind; fingerprint?: string },
    ctx: ProjectContext,
    body: () => Promise<AutomationOutcome>,
  ): Promise<AutomationOutcome> => {
    try {
      return await body();
    } catch (error) {
      if (isAutomationSkip(error)) return skipped(error, meta, ctx);
      return failure(error, meta, ctx);
    }
  };

  const withStaging = async <T>(body: (staging: Staging) => Promise<T>): Promise<T> => {
    const staging = createStaging(stagingRoot);
    try {
      return await body(staging);
    } finally {
      staging.dispose();
    }
  };

  /**
   * The project is the configured bs-vtc checkout, compared by real path as the daemon does (a
   * trailing slash or a symlinked spelling is the same checkout; reading 216). Only there does an
   * upstream item become a run, because the run's PR is built and pushed from that checkout, and
   * only there does a bs-vtc PR record its own run instead of the upstream-safe projection.
   */
  const onUpstreamCheckout = (ctx: ProjectContext): boolean => {
    const checkout = deps.automation.upstream.checkout;
    if (checkout === undefined) return false;
    try {
      return realpathSync(ctx.repoRoot) === realpathSync(checkout);
    } catch {
      return false;
    }
  };

  /**
   * "VTC builds VTC" (spine §5 reading 208 (1)): the project is VTC's own repo, so its public
   * identifiers are not project secrets in an upstream text or on screen.
   */
  const isSelf = (ctx: ProjectContext): boolean =>
    ctx.repo === deps.automation.upstream.repo || onUpstreamCheckout(ctx);

  const privacyCheck = (ctx: ProjectContext) => {
    const denylist = projectDenylist(ctx.identity);
    const upstreamRepo = deps.automation.upstream.repo;
    return {
      knownValues: ctx.knownValues,
      denylist: isSelf(ctx) ? selfDenylist(denylist, upstreamRepo) : denylist,
      upstreamRepo,
    };
  };

  const disclosure = (host?: string, model?: string) => ({
    vtcVersion: deps.vtcVersion,
    host,
    model,
  });

  /** The issue's title and body, rendered for its target (upstream: from the report only). */
  const renderIssue = (
    item: AutoWorkItem,
    record: LedgerRecord | undefined,
    ctx: ProjectContext,
    regressionOf: number | undefined,
  ): { title: string; body: string; report?: UpstreamReport } => {
    const template = loadAutoTemplate(deps.assets, "auto-issue");
    const at = item.at;
    const occurrences = Math.max(1, record?.count ?? 1);
    if (item.target === "upstream") {
      // D-cs, D-cn, reading 247(8): a tool, capability or config subject is projected into the
      // report's typed subject through its kind's pattern only, and rendered from there
      const report = projectUpstreamReport({
        ...item.facts,
        occurrences,
        firstSeen: record?.firstSeen ?? at,
        lastSeen: record?.lastSeen ?? at,
      });
      // D-cu (reading 241): only a producer's cell is a routing-table change
      if (report.subject?.kind === "routing") assertProducerCell(report.subject);
      const slots = upstreamIssueSlots(report, { regressionOf });
      const title = slots.title ?? renderTitle(item.kind, item.kind);
      const body = renderBody(template, slots);
      assertUpstreamSafe(report, [title, body], privacyCheck(ctx));
      return { title, body, report };
    }
    const clean = (text: string): string => redactSecrets(text, ctx.knownValues);
    const title = clean(renderTitle(item.kind, item.title));
    const slots: TemplateSlots = {
      marker: renderAutoMarker({ v: 1, kind: item.kind, fp: item.fingerprint }),
      note: renderNote({ kind: item.kind, pr: false, disclosure: disclosure() }),
      title,
      summary: clean(
        `${regressionOf === undefined ? "" : `Regression of #${String(regressionOf)}. `}${item.detail}`,
      ),
      why: [
        "| occurrences | first seen | last seen | VTC |",
        "|---|---|---|---|",
        `| ${String(occurrences)} | ${record?.firstSeen ?? at} | ${record?.lastSeen ?? at} | ${deps.vtcVersion} |`,
      ].join("\n"),
      evidence: UNAVAILABLE,
      provenance: clean(
        `<details><summary>Provenance</summary>\n\n- run: ${item.run ?? UNAVAILABLE}\n- VTC ${deps.vtcVersion}; generated by VTC (AI); human review required.\n\n</details>`,
      ),
      checklist: "- [ ] Confirm the problem\n- [ ] Fix it, or label `vtc:muted` to stop it",
    };
    return { title, body: renderBody(template, slots) };
  };

  /** One fingerprint's work at a time, so two occurrences never both create an issue or PR. */
  const serial = createKeyedSerial();

  const raise = (item: AutoWorkItem, ctx: ProjectContext): Promise<AutomationOutcome> => {
    const meta = { target: item.target, kind: item.kind, fingerprint: item.fingerprint };
    return serial(`issue:${item.target}:${item.fingerprint}`, () => raiseNow(item, ctx, meta));
  };

  const raiseNow = (
    item: AutoWorkItem,
    ctx: ProjectContext,
    meta: { target: "upstream" | "project"; kind: AutoKind; fingerprint: string },
  ): Promise<AutomationOutcome> => {
    return guarded(meta, ctx, async () => {
      gate(item.target, "issues", ctx);
      const repo = repoOf(item.target, ctx);
      if (repo === null) throw new AutomationSkip("no_github_remote", "no target repo");
      // work that must not hold the repo lock (a routing issue's PR takes it itself)
      const after: (() => Promise<unknown>)[] = [];
      const outcome = await withRepoLock(repo, () =>
        raiseLocked(item, ctx, repo, (task) => after.push(task)),
      );
      for (const task of after) await task();
      return outcome;
    });
  };

  const raiseLocked = async (
    item: AutoWorkItem,
    ctx: ProjectContext,
    repo: GitHubRepo,
    defer: (task: () => Promise<unknown>) => void,
  ): Promise<AutomationOutcome> => {
    const ledger = ledgerFor(item.target, ctx);
    ledger.append({
      repo,
      fp: item.fingerprint,
      kind: item.kind,
      event: "seen",
      at: item.at,
      version: deps.vtcVersion,
      // D-ct: kept for this machine's pickup, which then never reads it from the issue body
      ...(item.target === "upstream" ? { ui: framesTouchUi(item.facts.frames ?? []) } : {}),
    });
    const record = ledger.record(repo, item.fingerprint);
    if ((record?.count ?? 0) < item.minOccurrences) {
      return { status: "recorded", fingerprint: item.fingerprint };
    }
    const listed = await issues.listAutomatic(repo);
    const decision = decideIssue({
      fingerprint: item.fingerprint,
      issues: listed,
      record,
      now: now(),
      material: isMaterialChange(record, deps.vtcVersion),
    });
    if (decision.action === "skip") {
      throw new AutomationSkip(
        decision.reason,
        decision.reason === "muted"
          ? `issue #${String(decision.number)} is muted`
          : `issue #${String(decision.number)} was updated in the last 24 h`,
      );
    }
    const regressionOf = decision.action === "regression" ? decision.of : undefined;
    const rendered = renderIssue(item, record, ctx, regressionOf);
    return withStaging(async (staging) => {
      const request = {
        title: rendered.title,
        stagingDir: staging.dir,
        bodyFile: staging.write("body.md", rendered.body),
        labels: [
          AUTO_LABELS.auto,
          autoKindLabel(item.kind),
          ...(item.kind === "security" ? [AUTO_LABELS.security] : []),
          ...(regressionOf === undefined ? [] : [AUTO_LABELS.regression]),
          // VTC works on it itself: here, or on the bs-vtc checkout (`pickup`)
          ...(fixableItem(item) ? [AUTO_LABELS.fixable] : []),
        ],
      };
      const target = { kind: item.target, repo };
      const at = now().toISOString();
      gate(item.target, "issues", ctx);
      switch (decision.action) {
        case "create":
        case "regression": {
          if (issueCapReached(ledger, repo, now(), listed)) {
            throw new AutomationSkip("rate_limit", "5 new automatic issues today");
          }
          await issues.ensureLabels(repo, request.labels);
          const issue = await issues.create(repo, request);
          ledger.append({
            repo,
            fp: item.fingerprint,
            kind: item.kind,
            event: "issue_opened",
            number: issue.number,
            at,
          });
          emit("upstream.issue_opened", {
            target,
            kind: item.kind,
            fingerprint: item.fingerprint,
            number: issue.number,
            url: issue.url,
            ...(regressionOf === undefined ? {} : { regression_of: regressionOf }),
          });
          await startFixRun(item, repo, issue.number, rendered, ctx, defer);
          return { status: "issue", action: "opened", number: issue.number, url: issue.url };
        }
        case "update": {
          const url = listed.find((i) => i.number === decision.number)?.url ?? "";
          await issues.editBody(repo, decision.number, request);
          ledger.append({
            repo,
            fp: item.fingerprint,
            kind: item.kind,
            event: "issue_updated",
            number: decision.number,
            at,
          });
          let action: "edited" | "commented" = "edited";
          if (decision.comment) {
            const comment = {
              ...request,
              bodyFile: staging.write(
                "comment.md",
                `Seen again: ${String(record?.count ?? 1)} occurrences, last at ${record?.lastSeen ?? item.at}, VTC ${deps.vtcVersion}.`,
              ),
            };
            await issues.comment(repo, decision.number, comment);
            ledger.append({
              repo,
              fp: item.fingerprint,
              kind: item.kind,
              event: "commented",
              number: decision.number,
              at,
            });
            action = "commented";
          }
          emit("upstream.issue_updated", {
            target,
            kind: item.kind,
            fingerprint: item.fingerprint,
            number: decision.number,
            url,
            action,
          });
          // on the bs-vtc checkout, an open fixable issue another project's daemon raised: the
          // daemon starts its run once (a project's own issue asked when it opened)
          if (item.target === "upstream")
            await startFixRun(item, repo, decision.number, rendered, ctx, defer);
          return { status: "issue", action, number: decision.number, url };
        }
        case "reopen": {
          const url = listed.find((i) => i.number === decision.number)?.url ?? "";
          await issues.reopen(
            repo,
            decision.number,
            `Seen again (VTC ${deps.vtcVersion}); reopening the quiet issue.`,
          );
          await issues.editBody(repo, decision.number, request);
          ledger.append({
            repo,
            fp: item.fingerprint,
            kind: item.kind,
            event: "reopened",
            number: decision.number,
            at,
          });
          emit("upstream.issue_updated", {
            target,
            kind: item.kind,
            fingerprint: item.fingerprint,
            number: decision.number,
            url,
            action: "reopened",
          });
          if (item.target === "upstream")
            await startFixRun(item, repo, decision.number, rendered, ctx, defer);
          return { status: "issue", action: "reopened", number: decision.number, url };
        }
      }
    });
  };

  /**
   * Whether an automatic run may start here now: `automation.prs` on, not paused, and for a
   * VTC-repo issue only on the bs-vtc checkout itself with upstream reporting on (another
   * project's engine cannot build bs-vtc, and the PR is pushed from the checkout).
   */
  const mayStartRun = (target: "upstream" | "project", ctx: ProjectContext): boolean => {
    if (deps.startRun === undefined) return false;
    if (target === "upstream" && !onUpstreamCheckout(ctx)) return false;
    const { settings, context } = ctx.state();
    if (context.paused || !context.ghLoggedIn || !settings.prs) return false;
    return target === "project" || (settings.upstream && deps.automation.upstream.share);
  };

  /** The request of an automatic run: the issue is its spec (G1 and G2 skipped, AD-27 rule 2). */
  const runRequest = (issue: string, title: string, spec: string, kind: AutoKind): string =>
    [
      `Fix ${issue}: ${title}`,
      "",
      `VTC raised this issue itself and started this run from it; the issue is the spec (D-bv, D-cd).`,
      ...(kind === "new_agent"
        ? [
            "",
            "Build the proposed role with the new-role scaffold (`scaffoldRole` and `writeScaffold` in `packages/compiler/src/scaffold.ts`): it writes `roles/<id>/role.yaml`, `prompt.md` and the test stub, and proves the compiler wiring on both hosts.",
          ]
        : []),
      "",
      spec,
    ]
      .join("\n")
      .slice(0, RUN_REQUEST_MAX);

  /** Asks the daemon for an issue's run; one that cannot be started leaves the issue as it is. */
  const askRun = async (
    input: StartInput,
    ref: AutomationRunRef,
  ): Promise<AutomationRunRef | null> => {
    try {
      await deps.startRun?.(input, ref);
      return ref;
    } catch {
      // the issue stands; the daemon reports a run it could not start
      return null;
    }
  };

  /**
   * D-bv / D-cd (AD-27 rule 2): the issue of a fixable item becomes an automatic run, whose spec
   * is the issue (G1 and G2 skipped; the Spec Verifier checks the PR against it), when it opens
   * or is seen again while open ({@link mayStartRun}; the daemon starts one run per issue).
   */
  const startFixRun = async (
    item: AutoWorkItem,
    repo: GitHubRepo,
    number: number,
    rendered: { readonly title: string; readonly body: string; readonly report?: UpstreamReport },
    ctx: ProjectContext,
    defer: (task: () => Promise<unknown>) => void,
  ): Promise<void> => {
    if (!fixableItem(item)) return;
    // D-cn (reading 233): a routing-table change is the module's own PR, never a run; its cell
    // is the report's typed subject (reading 247(8))
    const report = rendered.report;
    if (item.target === "upstream" && report?.subject?.kind === "routing") {
      const move = routingMoveOfMetrics(report.metrics);
      // after the raise lets go of the repo lock, which opening the PR takes itself
      if (move !== null)
        defer(() =>
          answerRouting(repo, { move, fingerprint: item.fingerprint, issue: number, report }, ctx),
        );
      return;
    }
    if (!mayStartRun(item.target, ctx)) return;
    const spec =
      item.target === "project"
        ? `${rendered.title}\n\n${redactSecrets(item.detail, ctx.knownValues)}`
        : rendered.body;
    // D-ct: the paths the issue touches decide whether its PR records UI before/after
    const hasUi =
      item.target === "project"
        ? projectTouchesUi(item.paths)
        : framesTouchUi(item.facts.frames ?? []);
    await askRun(
      {
        request: runRequest(`${repo}#${String(number)}`, rendered.title, spec, item.kind),
        track: "quick_fix",
        repo: "existing",
        has_ui: hasUi,
        risk_hints: [],
      },
      {
        kind: item.kind,
        fingerprint: item.fingerprint,
        target: { kind: item.target, repo },
        issue: number,
      },
    );
  };

  /**
   * Whether the module may open a routing-table PR now (D-cn, reading 233): as for an automatic
   * run (`automation.prs` on, not paused, gh logged in, upstream reporting on), with a bs-vtc
   * checkout to read the table at and commit on.
   */
  const mayOpenRoutingPr = (ctx: ProjectContext): boolean => {
    if (deps.automation.upstream.checkout === undefined || deps.gitOps === undefined) return false;
    const { settings, context } = ctx.state();
    if (context.paused || !context.ghLoggedIn || !settings.prs) return false;
    return settings.upstream && deps.automation.upstream.share;
  };

  /**
   * The upstream report of a routing PR whose issue another installation opened (VTC-side only):
   * the cell as its typed subject, the move, and the graded replay the issue cites, if any.
   */
  const routingReport = (
    fingerprint: AutoFingerprint,
    cell: RoutingSubject,
    move: RoutingMove,
    replay: RoutingReplay | null,
  ): UpstreamReport => {
    const at = now().toISOString();
    return projectUpstreamReport({
      kind: "config",
      fingerprint,
      vtcVersion: deps.vtcVersion,
      role: cell.role,
      subject: upstreamSubjectKey(cell),
      metrics: {
        [ROUTING_FACT_METRICS.fromTier]: TIER_ORDER.indexOf(move.from),
        [ROUTING_FACT_METRICS.toTier]: TIER_ORDER.indexOf(move.to),
        [ROUTING_FACT_METRICS.shared]: move.scope === "shared" ? 1 : 0,
        ...(replay === null
          ? {}
          : {
              [ROUTING_FACT_METRICS.replayVerdict]: ROUTING_REPLAY_VERDICT_CODES[replay.verdict],
              [ROUTING_FACT_METRICS.replayTrials]: replay.trials,
            }),
      },
      occurrences: 1,
      firstSeen: at,
      lastSeen: at,
    });
  };

  /** A routing issue this installation raised or saw again: its PR, unless one answers it. */
  const answerRouting = async (
    repo: GitHubRepo,
    input: Parameters<typeof openRoutingPr>[0],
    ctx: ProjectContext,
  ): Promise<void> => {
    if (!mayOpenRoutingPr(ctx)) return;
    try {
      const open = await pullRequests.listOpenAutomatic(repo);
      if (open.some((p) => p.marker?.fp === input.fingerprint)) return;
    } catch (error) {
      failure(error, { target: "upstream", kind: "config", fingerprint: input.fingerprint }, ctx);
      return;
    }
    await openRoutingPr(input, ctx);
  };

  /**
   * D-cn (spine §5 reading 233): the routing issue's PR, made by the module itself like a Lookback
   * prompt PR: `DEFAULT_ROUTING_TABLE` read at the default branch's commit on the bs-vtc checkout,
   * the cell moved by one value (`buildRoutingPr`, which fails closed on a moved table or a move one
   * value cannot make), committed as the only change of `vtc/auto/config/<fp8>`, and opened with
   * the routing scorecard charts as its upstream-safe evidence. No automatic run makes it, so no
   * QA author tests, CHANGELOG entry or test edit rides along; the human merges it.
   */
  const openRoutingPr = (
    input: {
      readonly move: RoutingMove;
      readonly fingerprint: AutoFingerprint;
      readonly issue: number;
      /** Its typed `subject` is the cell; the body is rendered from it alone (reading 247(8)). */
      readonly report: UpstreamReport;
    },
    ctx: ProjectContext,
  ): Promise<AutomationOutcome> =>
    guarded(
      { target: "upstream", kind: "config", fingerprint: input.fingerprint },
      ctx,
      async () => {
        const subject = input.report.subject;
        if (subject?.kind !== "routing")
          throw new AutomationSkip("privacy", "a routing PR needs its report's routing cell");
        // D-cu (reading 241): only a producer's cell moves on the routing table
        assertProducerCell(subject);
        gate("upstream", "prs", ctx);
        const checkout = deps.automation.upstream.checkout;
        const gitOps = deps.gitOps;
        if (checkout === undefined || gitOps === undefined) {
          throw new AutomationSkip(
            "no_upstream_checkout",
            "no bs-vtc checkout VTC can read the routing table at is set up",
          );
        }
        const factory = deps.automation.plumbing;
        if (factory === undefined) throw new Error("no git plumbing was injected");
        const repo = deps.automation.upstream.repo;
        const base = await defaultBranch(repo);
        const plumbing = factory({ repoRoot: checkout });
        // the commit the PR's branch is built on (`autoBranchState` resolves the same one)
        const baseSha =
          (await plumbing.resolve(`refs/remotes/origin/${base}`)) ??
          (await plumbing.resolve(`refs/heads/${base}`));
        if (baseSha === null)
          throw new Error(`the default branch ${base} is not available locally`);
        const bytes = await gitOps(checkout).readFileAtCommit(baseSha, ROUTING_TABLE_FILE);
        if (bytes === undefined) throw new Error(`${ROUTING_TABLE_FILE} is missing on ${base}`);
        const parts = buildRoutingPr({
          subject,
          move: input.move,
          source: new TextDecoder().decode(bytes),
          vtcVersion: deps.vtcVersion,
          issue: input.issue,
          // reading 247(6): the graded tier replay, when the fact carries one
          replay: routingReplayOfMetrics(input.report.metrics),
        });
        return openPullRequest(
          {
            target: "upstream",
            kind: "config",
            fingerprint: input.fingerprint,
            summary: parts.summary,
            slots: parts.slots,
            source: {
              changes: [{ path: ROUTING_TABLE_FILE, bytes: new TextEncoder().encode(parts.text) }],
              message: parts.summary,
            },
            report: input.report,
            issue: input.issue,
            specVerifier: "none",
            evidence: {
              plan: { upstreamSafe: true, change: "config" },
              snapshot: { routes: {}, events: [] },
            },
          },
          ctx,
        );
      },
    );

  /**
   * "VTC builds VTC" for the issues other installations opened (reading 216): on the bs-vtc
   * checkout, every open fixable VTC-repo issue that no open PR answers asks for its run, with
   * the issue's title and body as listed as its spec; a routing issue gets the module's own PR
   * instead, never a run (reading 233).
   */
  const pickup = async (ctx: ProjectContext): Promise<readonly AutomationRunRef[]> => {
    const routingPrs = onUpstreamCheckout(ctx) && mayOpenRoutingPr(ctx);
    if (!mayStartRun("upstream", ctx) && !routingPrs) return [];
    const repo = deps.automation.upstream.repo;
    let listed: readonly AutoIssueRef[];
    let answered: ReadonlySet<string>;
    try {
      listed = await issues.listAutomatic(repo);
      answered = new Set(
        (await pullRequests.listOpenAutomatic(repo)).flatMap((p) =>
          p.marker === null ? [] : [p.marker.fp],
        ),
      );
    } catch (error) {
      failure(error, { target: "upstream" }, ctx);
      return [];
    }
    const ledger = ledgerFor("upstream", ctx);
    const asked: AutomationRunRef[] = [];
    for (const issue of listed) {
      const marker = issue.marker;
      if (marker === null || !fixableUpstreamIssue(issue) || answered.has(marker.fp)) continue;
      // D-cn (reading 233): a routing issue is answered by the module's own PR, never a run
      const cell = marker.kind === "config" ? routingSubjectOfBody(issue.body) : null;
      if (cell !== null) {
        const move = routingMoveOfBody(issue.body, cell);
        if (
          routingPrs &&
          move !== null &&
          autoFingerprint({ kind: "config", subject: upstreamSubjectKey(cell) }) === marker.fp
        )
          await openRoutingPr(
            {
              move,
              fingerprint: marker.fp,
              issue: issue.number,
              report: routingReport(marker.fp, cell, move, routingReplayOfBody(issue.body)),
            },
            ctx,
          );
        continue;
      }
      if (!mayStartRun("upstream", ctx)) continue;
      // the request is written into the checkout's run log: the shared redaction first
      const clean = (text: string): string => redactSecrets(text, ctx.knownValues);
      const ref = await askRun(
        {
          request: runRequest(
            `${repo}#${String(issue.number)}`,
            clean(issue.title ?? renderTitle(marker.kind, marker.kind)),
            clean(issue.body ?? issue.url),
            marker.kind,
          ),
          track: "quick_fix",
          repo: "existing",
          // D-ct: whether its PR records UI before/after, from this machine's ledger when this
          // installation raised the issue; only another installation's issue is read from the
          // VTC frames its body lists (as listed, so a frame only ever decides this)
          has_ui:
            ledger.record(repo, marker.fp)?.ui ?? framesTouchUi(framesFromIssueBody(issue.body)),
          risk_hints: [],
        },
        {
          kind: marker.kind,
          fingerprint: marker.fp,
          target: { kind: "upstream", repo },
          issue: issue.number,
        },
      );
      if (ref !== null) asked.push(ref);
    }
    return asked;
  };

  /** "evidence capture failed" (D-ce): a VTC defect in VTC's own repo. */
  const raiseEvidenceFailure = (
    kind: AutoKind,
    ctx: ProjectContext,
  ): Promise<AutomationOutcome> => {
    const fingerprint = autoFingerprint({
      kind: "defect",
      errorClass: "evidence.capture_failed",
      frames: [],
    });
    return raise(
      {
        target: "upstream",
        kind: "defect",
        fingerprint,
        minOccurrences: 1,
        facts: {
          kind: "defect",
          fingerprint,
          vtcVersion: deps.vtcVersion,
          errorClass: "evidence.capture_failed",
          metrics: { [`pr_kind.${kind}`]: 1 },
        },
        at: now().toISOString(),
      },
      ctx,
    );
  };

  /**
   * Where `vtc/auto/<kind>/<fp8>` stands and what VTC's next commit on it descends from. It first
   * fetches every automatic branch (another installation may have pushed this one, or a human
   * closed its PR and left it). When the branch exists (the open PR this one supersedes, or the
   * fresh remote-tracking ref), the new commit descends from its head so the push is a
   * fast-forward, and only when that head is VTC's: one this installation pushed (its ledger) or
   * one carrying VTC's `Generated-by: VTC` trailer (another installation's). A branch whose head is
   * anyone else's is left alone and the PR skipped (`duplicate`). Run once before any evidence is
   * captured or published, and again right before the push.
   */
  const autoBranchState = async (
    input: AutoPrInput,
    repoRoot: string,
    base: string,
    at: { readonly repo: GitHubRepo; readonly ledger: Ledger; readonly open?: AutoPrRef },
  ): Promise<{
    readonly plumbing: ReturnType<NonNullable<AutomationDeps["plumbing"]>>;
    readonly baseSha: GitSha;
    readonly parents: GitSha[];
    readonly dst: string;
  }> => {
    const branch = autoBranchName(input.kind, input.fingerprint);
    const factory = deps.automation.plumbing;
    if (factory === undefined) throw new Error("no git plumbing was injected");
    const plumbing = factory({ repoRoot });
    const refs = remoteRefsFor(repoRoot);
    // Only the automatic branches: the base stays the commit a Lookback PR read its files at.
    await refreshRemote(refs, "origin", [AUTO_BRANCHES_REFSPEC]);
    const baseSha =
      (await plumbing.resolve(`refs/remotes/origin/${base}`)) ??
      (await plumbing.resolve(`refs/heads/${base}`));
    if (baseSha === null) throw new Error(`the default branch ${base} is not available locally`);
    const dst = `refs/heads/${branch}`;
    if (!autoPushRefAllowed(dst) || dst === `refs/heads/${base}`) {
      throw new Error("an automatic branch never names the default branch");
    }
    const current =
      at.open?.headSha !== undefined && at.open.headSha !== ""
        ? at.open.headSha
        : await plumbing.resolve(`refs/remotes/origin/${branch}`);
    let parents: GitSha[] = [baseSha];
    if (current !== null && current !== baseSha) {
      const ours = at.ledger.record(at.repo, input.fingerprint)?.pushedHeads ?? [];
      if (!ours.includes(current) && !(await vtcAuthored(refs, current))) {
        throw new AutomationSkip(
          "duplicate",
          `${branch} holds commits VTC did not push; VTC leaves the branch alone`,
        );
      }
      parents = [current, baseSha];
    }
    return { plumbing, baseSha, parents, dst };
  };

  /**
   * Commits `input.source.changes` on the default branch and pushes `vtc/auto/<kind>/<fp8>`
   * without force, on VTC's own head of the branch ({@link autoBranchState}). `title` is the PR's
   * title as checked (upstream) or redacted (project).
   */
  const commitAndPush = async (
    input: AutoPrInput,
    title: string,
    repoRoot: string,
    base: string,
    at: { readonly repo: GitHubRepo; readonly ledger: Ledger; readonly open?: AutoPrRef },
  ): Promise<GitSha> => {
    if (!("changes" in input.source)) return input.source.pushedHead;
    const state = await autoBranchState(input, repoRoot, base, at);
    const sha = await state.plumbing.commit({
      base: state.baseSha,
      parents: state.parents,
      changes: input.source.changes,
      message: `${title}\n\nGenerated-by: VTC ${deps.vtcVersion}`,
    });
    await state.plumbing.push("origin", sha, state.dst);
    return sha;
  };

  /**
   * Refuses (`out_of_scope`) a routing-table PR whose change touches any path but
   * {@link ROUTING_TABLE_FILE}: the paths the module would commit, or, for a run's pushed head,
   * the paths git lists against the run's cut point (else the remote default branch's tip).
   * Fails closed when the plumbing cannot list them.
   */
  const assertRoutingScope = async (
    source: PrSource,
    repoRoot: string,
    defaultName: string,
  ): Promise<void> => {
    let paths: readonly string[];
    if ("changes" in source) paths = source.changes.map((c) => c.path);
    else {
      const plumbing = deps.automation.plumbing?.({ repoRoot });
      const from =
        source.base ?? (await plumbing?.resolve(`refs/remotes/origin/${defaultName}`)) ?? null;
      if (plumbing?.changedPaths === undefined || from === null)
        throw new AutomationSkip(
          "out_of_scope",
          "a routing-table PR whose changed paths cannot be listed is not opened",
        );
      paths = await plumbing.changedPaths(from, source.pushedHead);
    }
    const others = [...new Set(paths)].filter((p) => p !== ROUTING_TABLE_FILE).sort();
    if (others.length > 0)
      throw new AutomationSkip(
        "out_of_scope",
        `a routing-table PR changes only ${ROUTING_TABLE_FILE}; this one also changes ${others
          .slice(0, 10)
          .join(", ")}${others.length > 10 ? ` and ${String(others.length - 10)} more` : ""}`,
      );
  };

  const openPullRequest = (input: AutoPrInput, ctx: ProjectContext): Promise<AutomationOutcome> =>
    serial(`pr:${input.target}:${input.fingerprint}`, () => openPullRequestNow(input, ctx));

  const openPullRequestNow = (
    input: AutoPrInput,
    ctx: ProjectContext,
  ): Promise<AutomationOutcome> => {
    const meta = { target: input.target, kind: input.kind, fingerprint: input.fingerprint };
    return guarded(meta, ctx, async () => {
      gate(input.target, "prs", ctx);
      const repo = repoOf(input.target, ctx);
      if (repo === null) throw new AutomationSkip("no_github_remote", "no target repo");
      const repoRoot =
        input.target === "upstream" ? deps.automation.upstream.checkout : ctx.repoRoot;
      if (repoRoot === undefined) {
        throw new AutomationSkip("no_upstream_checkout", "no bs-vtc checkout is set up for VTC");
      }
      const recorder = deps.automation.evidence;
      if (recorder === undefined) {
        throw new AutomationSkip("evidence_failed", "no evidence recorder is available");
      }
      const upstream = input.target === "upstream";
      const report = input.report;
      if (upstream && report === undefined) {
        throw new AutomationSkip("privacy", "an upstream PR needs its upstream report");
      }
      // Reading 208: a bs-vtc PR not built on the bs-vtc checkout itself was caused by a project
      // run, so its evidence is the upstream-safe projection only, whatever the caller passed;
      // a caller may also ask for it (a Lookback PR always does).
      const upstreamSafe =
        upstream && (!onUpstreamCheckout(ctx) || input.evidence.plan.upstreamSafe);
      // A project's `automation.evidence` settings apply to its own repo's PRs.
      const projectEvidence = upstream ? undefined : ctx.evidence;
      const listedIssues = await issues.listAutomatic(repo);
      // D-cn: a routing-table change charts the routing scorecard. Its cell is the report's typed
      // subject (reading 247(8)), else the one its issue names; the body is as listed, which
      // anyone may edit, so either counts only when it is the very subject the PR's fingerprint
      // was made from.
      const ownCell = (candidate: RoutingSubject | null): RoutingSubject | null =>
        candidate !== null &&
        autoFingerprint({ kind: "config", subject: upstreamSubjectKey(candidate) }) ===
          input.fingerprint
          ? candidate
          : null;
      const cell =
        input.kind !== "config"
          ? null
          : (ownCell(report?.subject?.kind === "routing" ? report.subject : null) ??
            ownCell(routingSubjectOfBody(ownIssue(listedIssues, input)?.body)));
      const routing = cell !== null;
      // D-cu (reading 241): only a producer's cell moves on the routing table
      if (cell !== null) assertProducerCell(cell);
      // the caller's VTC-side card, else the run's own checkout's: only one that holds the cell
      // (a project's Lookback may have raised it, so bs-vtc's own card can lack it)
      const routingCard =
        cell === null
          ? undefined
          : [input.evidence.upstream?.routingScorecard, readRoutingScorecard(ctx.repoRoot)].find(
              (card): card is RoutingScorecard => card !== undefined && holdsCell(card, cell),
            );
      // Reading 212(3): the upstream-safe page reads the dashboard's own frozen routes of a
      // synthetic run, built here from the report and VTC-side data only, never the caller's
      // routes or the run's events.
      const { routingScorecard: _unchecked, ...otherData } = input.evidence.upstream ?? {};
      const safeData: UpstreamEvidenceData | undefined = routing
        ? { ...otherData, ...(routingCard === undefined ? {} : { routingScorecard: routingCard }) }
        : input.evidence.upstream;
      const safeSnapshot =
        upstreamSafe && report !== undefined
          ? upstreamEvidenceSnapshot({
              report,
              ...(safeData === undefined ? {} : { data: safeData }),
              vtcVersion: deps.vtcVersion,
            })
          : undefined;
      const plan = {
        ...input.evidence.plan,
        ...(safeSnapshot === undefined ? {} : { upstreamSafe: true, run: safeSnapshot.run }),
        ...(projectEvidence?.video === false ? { video: false } : {}),
        ...(routing
          ? { routing: true, ...(routingCard === undefined ? { routingUnavailable: true } : {}) }
          : {}),
      };
      const snapshot =
        safeSnapshot === undefined
          ? withRoutingRoute(input.evidence.snapshot, input.evidence.plan.run, routing, routingCard)
          : { routes: safeSnapshot.routes, events: safeSnapshot.events };
      const early = planPrCap({
        open: await pullRequests.listOpenAutomatic(repo),
        kind: input.kind,
        fingerprint: input.fingerprint,
        ...(input.role === undefined ? {} : { role: input.role }),
      });
      if (early.action === "skip") throw new AutomationSkip(early.reason, early.detail);
      const ledger = ledgerFor(input.target, ctx);
      // AD-27 rule 4: a fingerprint a human muted is never raised again, as an issue or a PR.
      const issueState = decideIssue({
        fingerprint: input.fingerprint,
        issues: listedIssues,
        record: ledger.record(repo, input.fingerprint),
        now: now(),
        material: false,
      });
      if (issueState.action === "skip" && issueState.reason === "muted") {
        throw new AutomationSkip("muted", `issue #${String(issueState.number)} is muted`);
      }
      const template = loadAutoTemplate(deps.assets, "auto-pr");
      // AD-27 rule 5: a project-repo PR may hold project details, but its title, slots and body
      // still pass the shared redaction. An upstream PR is never redacted-and-sent: its texts are
      // checked below and refused with `privacy` on any hit.
      const clean = (text: string): string =>
        upstream ? text : redactProjectText(text, ctx.knownValues);
      const title = clean(renderTitle(input.kind, clean(input.summary)));
      const slots: TemplateSlots = upstream
        ? input.slots
        : Object.fromEntries(
            Object.entries(input.slots).map(([slot, text]) => [slot, clean(text)]),
          );
      const check = privacyCheck(ctx);
      const branch = autoBranchName(input.kind, input.fingerprint);
      const bodyWith = (evidence: string, status: "complete" | "partial"): string =>
        renderBody(template, {
          ...slots,
          marker: renderAutoMarker({
            v: 1,
            kind: input.kind,
            fp: input.fingerprint,
            ...(input.role === undefined ? {} : { role: input.role }),
          }),
          note: renderNote({
            kind: input.kind,
            pr: true,
            disclosure: disclosure(report?.host, report?.model),
            closes: input.issue,
            evidence: status,
          }),
          title,
          evidence,
        });
      if (upstream && report !== undefined) {
        // D-by: everything that will leave for the upstream repo is checked before anything
        // does: the texts, every committed file, and the body as it will read.
        const decoder = new TextDecoder();
        const committed =
          "changes" in input.source
            ? input.source.changes.flatMap((c) =>
                c.bytes === null ? [] : [decoder.decode(c.bytes)],
              )
            : [];
        const modelText = [title, ...Object.values(input.slots), ...(input.freeTexts ?? [])];
        assertUpstreamSafe(
          report,
          [
            ...modelText,
            ...(input.checkTexts ?? []),
            ...committed,
            ...(upstreamSafe ? [JSON.stringify(snapshot.routes)] : []),
            bodyWith(UNAVAILABLE, "complete"),
          ],
          check,
        );
        assertNoProjectPaths(modelText);
      }
      const base = await defaultBranch(repo);
      // D-cn (readings 219, 228(6)): a routing-table PR changes only the routing table's file,
      // checked from git before anything opens or is published (AD-8); the issue's instruction
      // to the run is no guard
      if (routing) await assertRoutingScope(input.source, repoRoot, base);
      // The branch is checked before any evidence is captured or published, so a branch VTC
      // must leave alone gets no media on the evidence branch either.
      if ("changes" in input.source) {
        const open = early.supersede.find((p) => p.headRefName === branch);
        await autoBranchState(input, repoRoot, base, {
          repo,
          ledger,
          ...(open === undefined ? {} : { open }),
        });
      }
      // D-ct: an automatic run's UI PR (Final Review of an automatic run only) has the gate
      // runner render its base and its head. The base is the commit the run's branch was cut
      // from, as the caller recorded it; never the default branch's tip, which may have moved.
      const pushed = "pushedHead" in input.source ? input.source : undefined;
      const cut = pushed?.base ?? null;
      const beforeAfter =
        pushed !== undefined && plan.change === "ui" && !plan.upstreamSafe
          ? {
              repoRoot,
              base: cut,
              head: pushed.pushedHead,
              ...(pushed.screens === undefined ? {} : { screens: pushed.screens }),
              // reading 247(7): the flow both sides script, from the head's flows file
              ...(cut === null
                ? {}
                : {
                    flow: await flowOfChange(repoRoot, {
                      base: cut,
                      head: pushed.pushedHead,
                      ...(pushed.screens === undefined ? {} : { screens: pushed.screens }),
                    }),
                  }),
            }
          : undefined;
      const hosting = deps.automation.hosting;
      return withStaging(async (staging) => {
        gate(input.target, "prs", ctx);
        const evidence = await prepareEvidence(
          staging.dir,
          {
            kind: input.kind,
            fingerprint: input.fingerprint,
            keep: upstream
              ? { kind: "upstream", vtcHome: deps.vtcHome }
              : { kind: "project", repoRoot: ctx.repoRoot },
            repo,
            plan,
            snapshot,
            gateReport: input.evidence.gateReport,
            ...(input.evidence.uiShots === undefined
              ? {}
              : { uiShots: input.evidence.uiShots, shotsRoot: repoRoot }),
            ...(ctx.redactSelectors === undefined ? {} : { redactSelectors: ctx.redactSelectors }),
            knownValues: ctx.knownValues,
            ...(upstream ? { denylist: check.denylist } : {}),
            ...(projectEvidence?.maxBytes === undefined
              ? {}
              : { maxBytes: projectEvidence.maxBytes }),
            ...(beforeAfter === undefined ? {} : { beforeAfter }),
          },
          {
            recorder,
            assets: deps.assets,
            hosting,
            ffmpeg: deps.automation.ffmpeg,
            ffmpegCommand,
            plumbing:
              hosting === "branch" && deps.automation.plumbing !== undefined
                ? deps.automation.plumbing({ repoRoot })
                : undefined,
            refs: remoteRefsFor(repoRoot),
            now,
            beforePublish: () => {
              gate(input.target, "prs", ctx);
            },
          },
        );
        if (!evidence.ok) {
          // A refused push of the shared evidence branch is a race with another installation,
          // not "evidence capture failed".
          if (evidence.pushRefused !== true) await raiseEvidenceFailure(input.kind, ctx);
          throw new AutomationSkip("evidence_failed", evidence.detail);
        }
        const status = evidence.partial ? "partial" : "complete";
        const body = clean(bodyWith(evidence.section, status));
        if (upstream && report !== undefined) assertUpstreamSafe(report, [body], check);
        const labels = [
          AUTO_LABELS.auto,
          autoKindLabel(input.kind),
          ...(evidence.partial ? [AUTO_LABELS.evidencePartial] : []),
          ...(input.extraLabels ?? []),
        ];
        return withRepoLock(repo, async () => {
          // Under the repo lock, against a fresh listing: another daemon may have opened or
          // superseded meanwhile.
          const cap = planPrCap({
            open: await pullRequests.listOpenAutomatic(repo),
            kind: input.kind,
            fingerprint: input.fingerprint,
            ...(input.role === undefined ? {} : { role: input.role }),
          });
          if (cap.action === "skip") throw new AutomationSkip(cap.reason, cap.detail);
          // The new head is pushed before the superseded PR is closed, so a refused push leaves
          // the older PR as it was.
          gate(input.target, "prs", ctx);
          const open = cap.supersede.find((p) => p.headRefName === branch);
          const head = await commitAndPush(input, title, repoRoot, base, {
            repo,
            ledger,
            ...(open === undefined ? {} : { open }),
          });
          for (const old of cap.supersede) {
            const fp = old.marker?.fp ?? input.fingerprint;
            await pullRequests.close(
              repo,
              old.number,
              `Superseded by a newer ${input.kind} proposal (VTC ${deps.vtcVersion}).`,
              // The new head now sits on a shared branch: never delete it.
              old.headRefName === branch
                ? undefined
                : (ledger.record(repo, fp)?.prHead ?? undefined),
            );
            ledger.append({
              repo,
              fp,
              kind: input.kind,
              event: "pr_closed",
              number: old.number,
              at: now().toISOString(),
            });
            emit("upstream.pr_closed", {
              target: { kind: input.target, repo },
              kind: input.kind,
              fingerprint: fp,
              number: old.number,
              url: old.url,
              reason: "superseded",
            });
          }
          gate(input.target, "prs", ctx);
          // An --attach upload that fails part-way is repaired with the `evidence: partial`
          // label, so the repo must have it whenever files are attached.
          await issues.ensureLabels(repo, [
            ...labels,
            ...(evidence.attach.length === 0 ? [] : [AUTO_LABELS.evidencePartial]),
          ]);
          const pr = await pullRequests.openDraft(repo, {
            title,
            stagingDir: staging.dir,
            bodyFile: staging.write("body.md", body),
            labels,
            ...(evidence.attach.length === 0 ? {} : { attach: evidence.attach }),
            kind: input.kind,
            fingerprint: input.fingerprint,
            branch,
            base,
          });
          const at = now().toISOString();
          ledger.append({
            repo,
            fp: input.fingerprint,
            kind: input.kind,
            event: "pr_opened",
            number: pr.number,
            head,
            at,
          });
          const finalStatus = pr.labels.includes(AUTO_LABELS.evidencePartial) ? "partial" : status;
          emit("upstream.pr_opened", {
            target: { kind: input.target, repo },
            kind: input.kind,
            fingerprint: input.fingerprint,
            number: pr.number,
            url: pr.url,
            branch,
            ...(input.issue === undefined ? {} : { issue: input.issue }),
            evidence: finalStatus,
            ...(finalStatus === "partial" && evidence.partialReason !== undefined
              ? { partial_reason: evidence.partialReason }
              : {}),
          });
          // AD-27 rule 2: ready only on the Spec Verifier's pass, or for a kind that has none
          // (never for a branch an automatic run pushed, which always has one).
          const ready =
            input.specVerifier === "pass" ||
            (input.specVerifier === "none" && !("pushedHead" in input.source));
          if (ready) await pullRequests.markReady(repo, pr.number);
          return { status: "pr", number: pr.number, url: pr.url, ready, evidence: finalStatus };
        });
      });
    });
  };

  const openLookbackPr = (
    input: {
      readonly replay: ReplayResult;
      readonly proposal: PromptProposal;
      readonly scorecards?: readonly Scorecard[];
    },
    ctx: ProjectContext,
  ): Promise<AutomationOutcome> =>
    guarded({ target: "upstream", kind: "lookback" }, ctx, async () => {
      if (input.replay.verdict !== "improve") return { status: "ignored" };
      gate("upstream", "prs", ctx);
      const checkout = deps.automation.upstream.checkout;
      if (checkout === undefined) {
        throw new AutomationSkip("no_upstream_checkout", "no bs-vtc checkout is set up for VTC");
      }
      const factory = deps.automation.plumbing;
      if (factory === undefined) throw new Error("no git plumbing was injected");
      const repo = deps.automation.upstream.repo;
      const base = await defaultBranch(repo);
      const plumbing = factory({ repoRoot: checkout });
      const baseSha =
        (await plumbing.resolve(`refs/remotes/origin/${base}`)) ??
        (await plumbing.resolve(`refs/heads/${base}`));
      if (baseSha === null) throw new Error(`the default branch ${base} is not available locally`);
      // The prompt and CHANGELOG are read at the commit the PR builds on, never from the work tree.
      const gitOps = deps.gitOps;
      if (gitOps === undefined) {
        throw new AutomationSkip(
          "no_upstream_checkout",
          "the bs-vtc checkout cannot be read at its default branch (no git reader is wired)",
        );
      }
      const read = async (path: string): Promise<string | null> => {
        const bytes = await gitOps(checkout).readFileAtCommit(baseSha, path);
        return bytes === undefined ? null : new TextDecoder().decode(bytes);
      };
      const promptPath = `roles/${input.replay.role}/prompt.md`;
      const prompt = await read(promptPath);
      if (prompt === null) throw new Error(`${promptPath} is missing on ${base}`);
      // The PR replaces the whole editable section, and its evidence measured the replay's
      // baseline: on any other base (an older VTC release, or a later merged change of the role)
      // the diff would silently revert that change under evidence it does not match.
      const profile = isEngineerProfileYaml(await read(roleYamlPath(input.replay.role)));
      const current = rolePromptIdentitySha(
        prompt,
        profile ? await read("roles/engineer/prompt.md") : null,
      );
      if (current !== input.replay.baseline) {
        throw new AutomationSkip(
          "stale_baseline",
          `the ${input.replay.role} prompt on ${base} (${current?.slice(0, 12) ?? "unreadable"}) is not the baseline the replay measured (${input.replay.baseline.slice(0, 12)})`,
        );
      }
      const parts = buildLookbackPr({
        replay: input.replay,
        proposal: input.proposal,
        prompt,
        changelog: await read("roles/CHANGELOG.md"),
        changelogTemplate: loadAutoTemplate(deps.assets, "changelog-entry"),
        vtcVersion: deps.vtcVersion,
      });
      const encoder = new TextEncoder();
      return openPullRequest(
        {
          target: "upstream",
          kind: "lookback",
          fingerprint: parts.fingerprint,
          role: input.replay.role,
          summary: parts.summary,
          slots: parts.slots,
          source: {
            changes: parts.changes.map((c) => ({ path: c.path, bytes: encoder.encode(c.text) })),
            message: parts.summary,
          },
          report: parts.report,
          checkTexts: [input.proposal.editable, input.proposal.id],
          freeTexts: parts.freeTexts,
          specVerifier: "none",
          evidence: {
            plan: { upstreamSafe: true, change: "prompt" },
            snapshot: { routes: {}, events: [] },
            upstream: {
              ...parts.evidence,
              ...(input.scorecards === undefined ? {} : { scorecards: input.scorecards }),
            },
          },
        },
        ctx,
      );
    });

  const completePullRequest = (
    target: "upstream" | "project",
    number: number,
    specVerifier: "pass" | "fail",
    ctx: ProjectContext,
  ): Promise<AutomationOutcome> =>
    guarded({ target }, ctx, async () => {
      gate(target, "prs", ctx);
      const repo = repoOf(target, ctx);
      if (repo === null) throw new AutomationSkip("no_github_remote", "no target repo");
      const pr = (await pullRequests.listOpenAutomatic(repo)).find((p) => p.number === number);
      if (pr === undefined) throw new Error(`PR #${String(number)} is not open`);
      const evidence = pr.labels.includes(AUTO_LABELS.evidencePartial) ? "partial" : "complete";
      if (specVerifier !== "pass") {
        return { status: "pr", number, url: pr.url, ready: false, evidence };
      }
      const ready = await pullRequests.markReady(repo, number);
      return { status: "pr", number, url: ready.url, ready: true, evidence };
    });

  const sweepTarget = async (
    target: "upstream" | "project",
    ctx: ProjectContext,
  ): Promise<AutomationOutcome[]> => {
    try {
      gate(target, "issues", ctx);
    } catch (error) {
      if (isAutomationSkip(error)) return [];
      throw error;
    }
    const repo = repoOf(target, ctx);
    if (repo === null) return [];
    return withRepoLock(repo, () => sweepLocked(target, repo, ctx));
  };

  const sweepLocked = async (
    target: "upstream" | "project",
    repo: GitHubRepo,
    ctx: ProjectContext,
  ): Promise<AutomationOutcome[]> => {
    const out: AutomationOutcome[] = [];
    const ledger = ledgerFor(target, ctx);
    const listed = await issues.listAutomatic(repo);
    const openPrs = await pullRequests.listOpenAutomatic(repo);
    for (const issue of planQuietSweep({ repo, issues: listed, openPrs, ledger, now: now() })) {
      const marker = issue.marker;
      if (marker === null) continue;
      out.push(
        await guarded({ target, kind: marker.kind, fingerprint: marker.fp }, ctx, async () => {
          gate(target, "issues", ctx);
          await issues.close(repo, issue.number, "not_planned", QUIET_COMMENT(deps.vtcVersion));
          ledger.append({
            repo,
            fp: marker.fp,
            kind: marker.kind,
            event: "closed_quiet",
            number: issue.number,
            at: now().toISOString(),
          });
          emit("upstream.issue_closed", {
            target: { kind: target, repo },
            kind: marker.kind,
            fingerprint: marker.fp,
            number: issue.number,
            url: issue.url,
            reason: "quiet",
          });
          return { status: "issue", action: "closed", number: issue.number, url: issue.url };
        }),
      );
    }
    for (const pr of planStalePrs({ issues: listed, openPrs })) {
      const marker = pr.marker;
      if (marker === null) continue;
      out.push(
        await guarded({ target, kind: marker.kind, fingerprint: marker.fp }, ctx, async () => {
          gate(target, "prs", ctx);
          await pullRequests.close(
            repo,
            pr.number,
            `The issue this PR answers is closed (VTC ${deps.vtcVersion}).`,
            ledger.record(repo, marker.fp)?.prHead ?? undefined,
          );
          ledger.append({
            repo,
            fp: marker.fp,
            kind: marker.kind,
            event: "pr_closed",
            number: pr.number,
            at: now().toISOString(),
          });
          emit("upstream.pr_closed", {
            target: { kind: target, repo },
            kind: marker.kind,
            fingerprint: marker.fp,
            number: pr.number,
            url: pr.url,
            reason: "issue_closed",
          });
          return { status: "pr_closed", number: pr.number, url: pr.url };
        }),
      );
    }
    return out;
  };

  return {
    services: { issues, pullRequests },
    report: (fact, ctx) => {
      const item = evaluateTrigger(fact, {
        vtcVersion: deps.vtcVersion,
        ...(deps.vtcRoots === undefined ? {} : { vtcRoots: deps.vtcRoots }),
      });
      if (item === null) return Promise.resolve({ status: "ignored" } as const);
      return raise(item, ctx);
    },
    raise,
    openPullRequest,
    openLookbackPr,
    completePullRequest,
    pickup,
    sweep: async (ctx) => {
      const results: AutomationOutcome[] = [];
      for (const target of ["upstream", "project"] as const) {
        try {
          results.push(...(await sweepTarget(target, ctx)));
        } catch (error) {
          results.push(failure(error, { target }, ctx));
        }
      }
      return results;
    },
  };
};

/**
 * The upstream module as the daemon drives it (AD-27 rule 8; spine §5 readings 189, 190 and 196).
 * The module (`upstream/`, the upstream team's) owns what to raise: its facts, fingerprints,
 * dedupe, caps, privacy projection and evidence. The daemon hands it engine facts in the module's
 * own vocabulary and a context to check them against, and turns what it reports into events:
 * - a VTC defect → `vtc_defect`; a cost regression → `cost_regression`; a project problem →
 *   `project_problem` (with the engine's stable `ruleId`);
 * - a replay verdict `improve` → `openLookbackPr` with the `ReplayResult` and its `PromptProposal`,
 *   whose editable section is the stored candidate version the replay measured, never the
 *   role-writable proposal file as it is now (D-cb);
 * - the module's `{ type, payload }` events → the engine's `upstream.*` / `automation.skipped`
 *   events, through the wiring's only sink;
 * - its sweep (auto-close, stale PRs) at most once a day, remembered across daemon restarts.
 *
 * The module is not imported here: {@link UpstreamModule} and {@link UpstreamModuleDeps} are the
 * structural shape of `createUpstream` (`upstream/upstream.ts`), and the daemon passes that factory
 * in (`../upstream/index.js` joins the engine at the round-4 merge, AD-13 rule 13), so a drift
 * between the two is a type error at that one call.
 */
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LOOKBACK_REPO,
  parsePersisted,
  PromptProposalSchema,
  ReplayResultSchema,
  type AssetBundle,
  type AutomationContext,
  type AutomationDeps,
  type AutomationSettings,
  type GitHubRepo,
  type PromptProposal,
  type ReplayResult,
  type ScorecardMetricId,
} from "@vtc/shared";
import {
  ensurePrivateDir,
  readPrivateFile,
  writePrivateFile,
  type AutomationFact,
  type CreateUpstream,
  type UpstreamWiring,
} from "../core/index.js";

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
}

/** What the module answers; `error` is a failure the daemon reports as an engine notice. */
export interface UpstreamModuleOutcome {
  readonly status: string;
  readonly detail?: string;
}

export interface LookbackPrInput {
  readonly replay: ReplayResult;
  readonly proposal: PromptProposal;
}

/** The module as the daemon calls it (`upstream/upstream.ts` `Upstream`). */
export interface UpstreamModule {
  report(fact: UpstreamModuleFact, ctx: UpstreamModuleContext): Promise<UpstreamModuleOutcome>;
  openLookbackPr(
    input: LookbackPrInput,
    ctx: UpstreamModuleContext,
  ): Promise<UpstreamModuleOutcome>;
  sweep(ctx: UpstreamModuleContext): Promise<readonly UpstreamModuleOutcome[]>;
}

/** What the module is built with (`upstream/upstream.ts` `UpstreamDeps`, the parts the daemon sets). */
export interface UpstreamModuleDeps {
  readonly automation: AutomationDeps;
  readonly vtcHome: string;
  readonly guardDir: string;
  readonly vtcVersion: string;
  readonly assets: AssetBundle;
  readonly emit: (event: { readonly type: string; readonly payload: unknown }) => void;
  readonly now?: () => Date;
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

// ------------------------------------------------------------- the Lookback PR input

/** The largest replay result file the bridge reads. */
const REPLAY_FILE_MAX_BYTES = 1024 * 1024;

/**
 * The `ReplayResult` and `PromptProposal` of a replay verdict `improve` (D-cb), or why there are
 * none. The replay file must be the one the event names, under `.vtc/lookback/replays/`, for
 * that proposal, saying `improve`; the proposal must be the one replayed; its editable section is
 * the candidate version Lookback stored and the replay measured (`candidateEditable`), because the
 * proposal files are role-writable and a later RETRO may have rewritten them.
 */
export const readLookbackPrInput = async (input: {
  readonly projectRoot: string;
  readonly proposal: string;
  readonly replayPath: string;
  readonly readProposal: (role: string) => Promise<unknown>;
  readonly candidateEditable: (replay: ReplayResult) => Promise<string | undefined>;
}): Promise<LookbackPrInput | string> => {
  const path = input.replayPath;
  if (!path.startsWith(`${LOOKBACK_REPO.replaysDir}/`) || path.split("/").includes(".."))
    return `the replay result ${path} is not under ${LOOKBACK_REPO.replaysDir}`;
  const file = join(input.projectRoot, path);
  let raw: unknown;
  try {
    // the engine writes it; a link or an oversized file is never read
    const stat = lstatSync(file);
    if (!stat.isFile()) return `the replay result ${path} is not a regular file`;
    if (stat.size > REPLAY_FILE_MAX_BYTES) return `the replay result ${path} is too large`;
    raw = JSON.parse(readFileSync(file, "utf8"));
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
  /** A replay verdict `improve`'s PR input, or why there is none ({@link readLookbackPrInput}). */
  readonly lookbackPr: (fact: AutomationFact) => Promise<LookbackPrInput | string>;
  /** The default plumbing when the cli injects none (`git.createGitPlumbing`). */
  readonly plumbing: NonNullable<AutomationDeps["plumbing"]>;
}

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
      now,
    });
    const repo = githubRepoOf(options.remoteUrl);
    const ctx = (): UpstreamModuleContext => {
      const selectors = options.redactSelectors();
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
    return {
      onFact: async (fact) => {
        if (fact.target === "upstream" && fact.kind === "lookback") {
          const input = await options.lookbackPr(fact);
          if (typeof input === "string") throw new Error(`no Lookback PR: ${input}`);
          failed(await module.openLookbackPr(input, ctx()), "the Lookback PR");
          return;
        }
        const mapped = upstreamModuleFact(fact);
        if (mapped === null) return;
        failed(await module.report(mapped, ctx()), `the ${fact.kind} report`);
      },
      sweep: async () => {
        const at = now();
        const last = lastSweep();
        if (!Number.isNaN(last) && at.getTime() - last < UPSTREAM_SWEEP_EVERY_MS) return;
        ensurePrivateDir(options.guardDir);
        writePrivateFile(sweepFile, `${JSON.stringify({ at: at.toISOString() })}\n`);
        const outcomes = await module.sweep(ctx());
        const errors = outcomes.filter((o) => o.status === "error");
        if (errors.length > 0)
          throw new Error(
            errors
              .map((o) => o.detail ?? "error")
              .join("; ")
              .slice(0, 500),
          );
      },
    };
  };

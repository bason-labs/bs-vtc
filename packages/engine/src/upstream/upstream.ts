/**
 * The upstream module (AD-27; D-bu): automatic issues and PRs in VTC's own repo and in the
 * project's repo, from the engine facts the daemon hands over. It reaches GitHub, git and capture
 * only through the `@vtc/shared` seams in `AutomationDeps`, checks the opt-outs when an item is
 * queued and again when it is sent, dedupes against the remote label listing, keeps the caps, fails
 * closed on privacy, opens no PR without evidence, and reports every action (or skip) as an event.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AUTO_LABELS,
  autoBranchName,
  autoKindLabel,
  autoPushRefAllowed,
  renderAutoMarker,
  redactSecrets,
  UPSTREAM_EVENT_PAYLOAD_SCHEMAS,
  type AssetBundle,
  type AutoFingerprint,
  type AutoKind,
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
} from "./decisions.js";
import type { FfmpegCommand } from "./evidence/gif.js";
import type { EvidencePlanInput } from "./evidence/plan.js";
import { prepareEvidence } from "./evidence/pipeline.js";
import { autoFingerprint } from "./fingerprint.js";
import { createGhServices } from "./gh-services.js";
import { ledgerPath, openLedger, type Ledger, type LedgerRecord } from "./ledger.js";
import {
  assertUpstreamSafe,
  projectDenylist,
  projectUpstreamReport,
  type ProjectIdentity,
} from "./privacy.js";
import { buildLookbackPr, UPSTREAM_EVIDENCE_ROUTE } from "./lookback-pr.js";
import { upstreamIssueSlots } from "./report-render.js";
import { AutomationSkip, isAutomationSkip } from "./skip.js";
import { createKeyedSerial } from "./queue.js";
import { createStaging, stagingRootFor, type Staging } from "./staging.js";
import { evaluateTrigger, type AutomationFact, type AutoWorkItem } from "./triggers.js";

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
}

export interface UpstreamDeps {
  readonly automation: AutomationDeps;
  readonly vtcHome: string;
  /** The engine's guard dir (`guardDirFor`); staging directories live under it. */
  readonly guardDir: string;
  readonly vtcVersion: string;
  /** The compiled plugins' templates and the dashboard export. */
  readonly assets: AssetBundle;
  readonly emit: (event: UpstreamEvent) => void;
  readonly now?: () => Date;
  /** The `gh` binary for the default services. */
  readonly ghCommand?: string;
  /** A repo's default branch; default `gh repo view`. */
  readonly defaultBranch?: (repo: GitHubRepo) => Promise<string>;
  readonly ffmpegCommand?: FfmpegCommand;
  /** Reads a file at a commit (engine git's `GitOps`); default: the checkout's work tree. */
  readonly gitOps?: (repoRoot: string) => Pick<GitOps, "readFileAtCommit">;
  /** Absolute directories VTC's own sources run from (stack frames outside them are dropped). */
  readonly vtcRoots?: readonly string[];
}

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

/** What an automatic PR changes: commit these files, or a branch the run already pushed. */
export type PrSource =
  | { readonly changes: readonly PlumbingChange[]; readonly message: string }
  | { readonly pushedHead: GitSha };

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
  /** Extra texts the privacy check reads (for upstream), e.g. committed file contents. */
  readonly checkTexts?: readonly string[];
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
  };
  /** Automatic runs: the Spec-Verifier verdict so far; the PR is marked ready only on `pass`. */
  readonly specVerifier?: "pending" | "pass" | "fail" | undefined;
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
    input: { readonly replay: ReplayResult; readonly proposal: PromptProposal },
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
  /** The services in use (the injected ones, or the gh-backed defaults). */
  readonly services: {
    readonly issues: IssueService;
    readonly pullRequests: AutoPullRequestService;
  };
}

const QUIET_COMMENT = (version: string): string =>
  `Not seen for 14 days as of VTC ${version}. VTC reopens this issue if it recurs; label it \`${AUTO_LABELS.keep}\` to keep it open or \`${AUTO_LABELS.muted}\` to stop it for good.`;

export const createUpstream = (deps: UpstreamDeps): Upstream => {
  const now = deps.now ?? ((): Date => new Date());
  const stagingRoot = stagingRootFor(deps.guardDir);
  const gh = createGhServices({
    ...(deps.ghCommand === undefined ? {} : { command: deps.ghCommand }),
    stagingRoot,
  });
  const issues = deps.automation.issues ?? gh.issues;
  const pullRequests = deps.automation.pullRequests ?? gh.pullRequests;
  const defaultBranch = deps.defaultBranch ?? gh.defaultBranch;

  const emit = <K extends UpstreamEventType>(type: K, payload: z.input<Schemas[K]>): void => {
    const parsed = UPSTREAM_EVENT_PAYLOAD_SCHEMAS[type].parse(payload) as z.infer<Schemas[K]>;
    deps.emit({ type, payload: parsed } as UpstreamEvent);
  };

  const repoOf = (target: "upstream" | "project", ctx: ProjectContext): GitHubRepo | null =>
    target === "upstream" ? deps.automation.upstream.repo : ctx.repo;

  const ledgerFor = (target: "upstream" | "project", ctx: ProjectContext): Ledger =>
    openLedger(
      target === "upstream"
        ? ledgerPath({ kind: "upstream", vtcHome: deps.vtcHome })
        : ledgerPath({ kind: "project", repoRoot: ctx.repoRoot }),
      ctx.knownValues,
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

  const guarded = async (
    meta: { target?: "upstream" | "project"; kind?: AutoKind; fingerprint?: string },
    ctx: ProjectContext,
    body: () => Promise<AutomationOutcome>,
  ): Promise<AutomationOutcome> => {
    try {
      return await body();
    } catch (error) {
      if (isAutomationSkip(error)) return skipped(error, meta, ctx);
      return { status: "error", detail: error instanceof Error ? error.message : String(error) };
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

  const privacyCheck = (ctx: ProjectContext) => ({
    knownValues: ctx.knownValues,
    denylist: projectDenylist(ctx.identity),
    upstreamRepo: deps.automation.upstream.repo,
  });

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
      const report = projectUpstreamReport({
        ...item.facts,
        occurrences,
        firstSeen: record?.firstSeen ?? at,
        lastSeen: record?.lastSeen ?? at,
      });
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
      const ledger = ledgerFor(item.target, ctx);
      ledger.append({
        repo,
        fp: item.fingerprint,
        kind: item.kind,
        event: "seen",
        at: item.at,
        version: deps.vtcVersion,
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
          ],
        };
        const target = { kind: item.target, repo };
        const at = now().toISOString();
        gate(item.target, "issues", ctx);
        switch (decision.action) {
          case "create":
          case "regression": {
            if (issueCapReached(ledger, repo, now())) {
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
            return { status: "issue", action: "reopened", number: decision.number, url };
          }
        }
      });
    });
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

  const commitAndPush = async (
    input: AutoPrInput,
    repoRoot: string,
    base: string,
  ): Promise<GitSha> => {
    const branch = autoBranchName(input.kind, input.fingerprint);
    if ("pushedHead" in input.source) return input.source.pushedHead;
    const factory = deps.automation.plumbing;
    if (factory === undefined) throw new Error("no git plumbing was injected");
    const plumbing = factory({ repoRoot });
    const baseSha =
      (await plumbing.resolve(`refs/remotes/origin/${base}`)) ??
      (await plumbing.resolve(`refs/heads/${base}`));
    if (baseSha === null) throw new Error(`the default branch ${base} is not available locally`);
    const sha = await plumbing.commit({
      base: baseSha,
      parents: [baseSha],
      changes: input.source.changes,
      message: `${renderTitle(input.kind, input.summary)}\n\nGenerated-by: VTC ${deps.vtcVersion}`,
    });
    const dst = `refs/heads/${branch}`;
    if (!autoPushRefAllowed(dst) || dst === `refs/heads/${base}`) {
      throw new Error("an automatic branch never names the default branch");
    }
    await plumbing.push("origin", sha, dst);
    return sha;
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
      if (upstream && input.report === undefined) {
        throw new AutomationSkip("privacy", "an upstream PR needs its upstream report");
      }
      // Reading 208: a bs-vtc PR not built on the bs-vtc checkout itself was caused by a project
      // run, so its evidence is the upstream-safe projection only, whatever the caller passed.
      const upstreamSafe = upstream && ctx.repoRoot !== deps.automation.upstream.checkout;
      const plan = upstreamSafe
        ? { ...input.evidence.plan, upstreamSafe: true }
        : input.evidence.plan;
      const snapshot = upstreamSafe
        ? {
            routes: {
              [UPSTREAM_EVIDENCE_ROUTE]: input.evidence.snapshot.routes[
                UPSTREAM_EVIDENCE_ROUTE
              ] ?? {
                report: input.report,
              },
            },
            events: [],
          }
        : input.evidence.snapshot;
      const cap = planPrCap({
        open: await pullRequests.listOpenAutomatic(repo),
        kind: input.kind,
        fingerprint: input.fingerprint,
        ...(input.role === undefined ? {} : { role: input.role }),
      });
      if (cap.action === "skip") throw new AutomationSkip(cap.reason, cap.detail);
      const template = loadAutoTemplate(deps.assets, "auto-pr");
      const title = renderTitle(input.kind, input.summary);
      const check = privacyCheck(ctx);
      const texts = [
        title,
        ...Object.values(input.slots),
        ...(input.checkTexts ?? []),
        ...(upstreamSafe ? [JSON.stringify(snapshot.routes)] : []),
      ];
      if (upstream && input.report !== undefined) assertUpstreamSafe(input.report, texts, check);
      const ledger = ledgerFor(input.target, ctx);
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
            ...(input.evidence.uiShots === undefined ? {} : { uiShots: input.evidence.uiShots }),
            ...(ctx.redactSelectors === undefined ? {} : { redactSelectors: ctx.redactSelectors }),
            knownValues: ctx.knownValues,
            ...(upstream ? { denylist: check.denylist } : {}),
          },
          {
            recorder,
            assets: deps.assets,
            hosting,
            ffmpeg: deps.automation.ffmpeg,
            ffmpegCommand: deps.ffmpegCommand,
            plumbing:
              hosting === "branch" && deps.automation.plumbing !== undefined
                ? deps.automation.plumbing({ repoRoot })
                : undefined,
            now,
          },
        );
        if (!evidence.ok) {
          await raiseEvidenceFailure(input.kind, ctx);
          throw new AutomationSkip("evidence_failed", evidence.detail);
        }
        const status = evidence.partial ? "partial" : "complete";
        for (const old of cap.supersede) {
          const fp = old.marker?.fp ?? input.fingerprint;
          await pullRequests.close(
            repo,
            old.number,
            `Superseded by a newer ${input.kind} proposal (VTC ${deps.vtcVersion}).`,
            ledger.record(repo, fp)?.prHead ?? undefined,
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
        const base = await defaultBranch(repo);
        const head = await commitAndPush(input, repoRoot, base);
        const slots: TemplateSlots = {
          ...input.slots,
          marker: renderAutoMarker({
            v: 1,
            kind: input.kind,
            fp: input.fingerprint,
            ...(input.role === undefined ? {} : { role: input.role }),
          }),
          note: renderNote({
            kind: input.kind,
            pr: true,
            disclosure: disclosure(input.report?.host, input.report?.model),
            closes: input.issue,
            evidence: status,
          }),
          title,
          evidence: evidence.section,
        };
        const body = renderBody(template, slots);
        if (upstream && input.report !== undefined) assertUpstreamSafe(input.report, [body], check);
        const labels = [
          AUTO_LABELS.auto,
          autoKindLabel(input.kind),
          ...(evidence.partial ? [AUTO_LABELS.evidencePartial] : []),
          ...(input.extraLabels ?? []),
        ];
        gate(input.target, "prs", ctx);
        await issues.ensureLabels(repo, labels);
        const branch = autoBranchName(input.kind, input.fingerprint);
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
        });
        const ready = input.specVerifier === undefined || input.specVerifier === "pass";
        if (ready) await pullRequests.markReady(repo, pr.number);
        return { status: "pr", number: pr.number, url: pr.url, ready, evidence: finalStatus };
      });
    });
  };

  const openLookbackPr = (
    input: { readonly replay: ReplayResult; readonly proposal: PromptProposal },
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
      const read = async (path: string): Promise<string | null> => {
        if (deps.gitOps !== undefined) {
          const bytes = await deps.gitOps(checkout).readFileAtCommit(baseSha, path);
          return bytes === undefined ? null : new TextDecoder().decode(bytes);
        }
        const file = join(checkout, path);
        return existsSync(file) ? readFileSync(file, "utf8") : null;
      };
      const promptPath = `roles/${input.replay.role}/prompt.md`;
      const prompt = await read(promptPath);
      if (prompt === null) throw new Error(`${promptPath} is missing on ${base}`);
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
          evidence: {
            plan: { upstreamSafe: true, change: "prompt" },
            snapshot: parts.snapshot,
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
      if (pr === undefined) return { status: "error", detail: `PR #${String(number)} is not open` };
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
    const out: AutomationOutcome[] = [];
    try {
      gate(target, "issues", ctx);
    } catch (error) {
      if (isAutomationSkip(error)) return [];
      throw error;
    }
    const repo = repoOf(target, ctx);
    if (repo === null) return [];
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
    sweep: async (ctx) => {
      const results: AutomationOutcome[] = [];
      for (const target of ["upstream", "project"] as const) {
        try {
          results.push(...(await sweepTarget(target, ctx)));
        } catch (error) {
          results.push({
            status: "error",
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return results;
    },
  };
};

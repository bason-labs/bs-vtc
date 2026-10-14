/**
 * The Automation read model (`GET /api/automation`, `AutomationReport`; D-ca, AD-27 rule 7): what
 * automation is set to for this project and why not (`automationFor` and its notes), the issues
 * and PRs VTC opened, from the `upstream.*` events of every run of the repo, and the latest
 * `automation.skipped`. A pure projection of the logs, so a snapshot (`vtc dashboard`) serves it
 * the same way.
 */
import {
  AutomationReportSchema,
  DEFAULT_UPSTREAM_REPO,
  EVENT_PAYLOAD_SCHEMAS,
  EVIDENCE_HOSTING_DEFAULT,
  LOOKBACK_LIMITS,
  type AutoKind,
  type AutomationContext,
  type AutomationDeps,
  type AutomationItem,
  type AutomationReport,
  type AutomationRunRef,
  type AutomationSettings,
  type AutoTargetKind,
  type HostId,
  type ParkReason,
  type Scorecard,
  type ScorecardMetricId,
  type StartInput,
  type VtcEvent,
} from "@vtc/shared";
import type { z } from "zod";
import type { EventDraft } from "./event-log.js";
import { PARSE_FAILURE_PREFIX, type RunState } from "./state.js";

/** Upper bounds of the report (`AutomationReportSchema`). */
const MAX_ITEMS = 500;
const MAX_SKIPPED = 200;
const MAX_NOTES = 20;

/** The note when no automation wiring is present (`EngineDeps.automation` absent, D-bz). */
export const AUTOMATION_OFF_NOTE =
  "automatic issues and PRs are off: this engine was started without automation (run VTC through the vtc cli with gh logged in)";

/** The note of a committed snapshot (`vtc dashboard`): its settings are not known there. */
export const AUTOMATION_SNAPSHOT_NOTE =
  "a snapshot shows the automatic issues and PRs its committed run logs record; the project's automation settings are not known in a snapshot";

type Payload<T extends keyof typeof EVENT_PAYLOAD_SCHEMAS> = z.infer<
  (typeof EVENT_PAYLOAD_SCHEMAS)[T]
>;

const parse = <T extends keyof typeof EVENT_PAYLOAD_SCHEMAS>(
  type: T,
  event: VtcEvent,
): Payload<T> | null => {
  const parsed = EVENT_PAYLOAD_SCHEMAS[type].safeParse(event.data);
  return parsed.success ? (parsed.data as Payload<T>) : null;
};

const itemKey = (v: { target: { repo: string }; kind: string; fingerprint: string }): string =>
  `${v.target.repo} ${v.kind} ${v.fingerprint}`;

/**
 * Pure: the `AutomationReport` of a repo from its runs' events (any order; applied by time) and
 * the resolved settings (`null`: no automation wiring, everything off with a note).
 */
export const automationReportView = (
  events: readonly VtcEvent[],
  settings: AutomationSettings | null,
  offNote: string = AUTOMATION_OFF_NOTE,
): AutomationReport => {
  const items = new Map<string, AutomationItem>();
  const skipped: AutomationReport["skipped"][number][] = [];
  const ordered = [...events].sort((a, b) =>
    a.ts === b.ts ? a.seq - b.seq : a.ts < b.ts ? -1 : 1,
  );
  const touch = (
    v: { target: AutomationItem["target"]; kind: AutomationItem["kind"]; fingerprint: string },
    at: string,
    change: (item: AutomationItem) => AutomationItem,
  ): void => {
    const key = itemKey(v);
    const item = items.get(key) ?? {
      target: v.target,
      kind: v.kind,
      fingerprint: v.fingerprint,
      issue: null,
      pr: null,
      first_at: at,
      last_at: at,
    };
    items.set(key, { ...change(item), last_at: at });
  };
  for (const event of ordered) {
    switch (event.type) {
      case "upstream.issue_opened": {
        const v = parse("upstream.issue_opened", event);
        if (v !== null)
          touch(v, event.ts, (item) => ({
            ...item,
            issue: { number: v.number, url: v.url, state: "open" },
          }));
        break;
      }
      case "upstream.issue_updated": {
        const v = parse("upstream.issue_updated", event);
        if (v !== null)
          touch(v, event.ts, (item) => ({
            ...item,
            issue: { number: v.number, url: v.url, state: "open" },
          }));
        break;
      }
      case "upstream.issue_closed": {
        const v = parse("upstream.issue_closed", event);
        if (v !== null)
          touch(v, event.ts, (item) => ({
            ...item,
            issue: { number: v.number, url: v.url, state: "closed" },
          }));
        break;
      }
      case "upstream.pr_opened": {
        const v = parse("upstream.pr_opened", event);
        if (v !== null)
          touch(v, event.ts, (item) => ({
            ...item,
            // VTC opens every automatic PR as a draft (D-bw)
            pr: { number: v.number, url: v.url, state: "draft", evidence: v.evidence },
          }));
        break;
      }
      case "upstream.pr_closed": {
        const v = parse("upstream.pr_closed", event);
        if (v !== null)
          touch(v, event.ts, (item) => ({
            ...item,
            pr: {
              number: v.number,
              url: v.url,
              state: "closed",
              evidence: item.pr?.evidence ?? "partial",
            },
          }));
        break;
      }
      case "automation.skipped": {
        const v = parse("automation.skipped", event);
        if (v !== null)
          skipped.push({
            at: event.ts,
            reason: v.reason,
            ...(v.kind === undefined ? {} : { kind: v.kind }),
            detail: v.detail,
          });
        break;
      }
      default:
        break;
    }
  }
  const latest = <T extends { readonly at?: string; readonly last_at?: string }>(
    list: readonly T[],
  ): T[] =>
    [...list].sort((a, b) => {
      const x = a.last_at ?? a.at ?? "";
      const y = b.last_at ?? b.at ?? "";
      return x === y ? 0 : x < y ? 1 : -1;
    });
  return AutomationReportSchema.parse({
    issues: settings?.issues ?? false,
    prs: settings?.prs ?? false,
    upstream: settings?.upstream ?? false,
    upstream_repo: settings?.upstreamRepo ?? DEFAULT_UPSTREAM_REPO,
    evidence_hosting: settings?.evidenceHosting ?? EVIDENCE_HOSTING_DEFAULT,
    notes: (settings === null ? [offNote] : settings.notes)
      .slice(0, MAX_NOTES)
      .map((n) => n.slice(0, 300)),
    items: latest([...items.values()]).slice(0, MAX_ITEMS),
    skipped: latest(skipped).slice(0, MAX_SKIPPED),
  });
};

// ------------------------------------------------------------------ triggers

/**
 * One engine fact that may raise an automatic issue or PR (D-bv; AD-27): the daemon reads it from
 * the run's events and hands it to the upstream module, which owns the fingerprint, dedupe, caps,
 * the privacy projection (`UpstreamReport` for an upstream target) and what to raise. A fact holds
 * what the engine knows; for an `upstream` target the upstream module sends only the allowlisted
 * projection of it (D-by), never `detail`, `task`, `feature` or paths.
 */
export interface AutomationFact {
  readonly target: AutoTargetKind;
  readonly kind: AutoKind;
  /** The run whose log holds the triggering event. */
  readonly run: string;
  /** The triggering event's type and time. */
  readonly source: string;
  readonly at: string;
  /** The error class of a VTC defect (`incident.gate_infra`, `adapter.parse_failure`, …). */
  readonly errorClass?: string;
  readonly role?: string;
  readonly mode?: string;
  readonly host?: HostId;
  readonly model?: string;
  readonly promptSha?: string;
  readonly task?: string;
  readonly feature?: string;
  /** The engine's own text about it (project details; never sent upstream as is). */
  readonly detail: string;
  /**
   * A project problem's stable identity, which the upstream module fingerprints (D-bx dedupe): the
   * same problem seen again names the same `ruleId`. Project facts only.
   */
  readonly ruleId?: string;
  /** A project issue's title (project details allowed; it stays in the project's repo). */
  readonly title?: string;
  /** The project-relative path a project problem cites, when it has one. */
  readonly path?: string;
  /** A cost regression (`kind` `cost`): the scorecard metric that worsened. */
  readonly metric?: ScorecardMetricId;
  /** A cost regression: the metric under the baseline version and under the current one. */
  readonly baseline?: number;
  readonly current?: number;
  /** A cost regression: the baseline version's effective prompt SHA (`promptSha` is the current). */
  readonly baselinePromptSha?: string;
  /** A Lookback proposal and its replay result (`lookback.replay_finished`). */
  readonly proposal?: string;
  readonly replayPath?: string;
  readonly mergeCommit?: string;
}

/** Park reasons that wait on the human by design, so VTC raises no issue for them. */
const HUMAN_PARKS: ReadonlySet<ParkReason> = new Set([
  "risk_rule",
  "budget",
  "change_request",
  "spec_question",
]);

/** An issue title, cut to fit. */
const clip = (text: string): string => (text.length > 200 ? `${text.slice(0, 199)}…` : text);

/** A finding's stable identity (its engine fingerprint), the path it cites and its title. */
const findingIdentity = (finding: {
  readonly fingerprint: string;
  readonly category: string;
  readonly title: string;
  readonly location: { readonly path?: string | undefined };
}): Pick<AutomationFact, "ruleId" | "title" | "path"> => ({
  ruleId: `finding/${finding.fingerprint}`,
  title: clip(`${finding.category} finding: ${finding.title}`),
  ...(finding.location.path === undefined ? {} : { path: finding.location.path }),
});

/**
 * Pure (D-bv): the automation facts one event of `state` raises. VTC side: an incident
 * (`gate_infra`, `crash`), an adapter parse failure, a stuck loop and a replay verdict `improve`;
 * project side: a parked task VTC cannot resolve, a red post-merge CI run, a revert or a Lookback
 * escaped defect, an out-of-scope finding, and the Final Review leftovers a finished run left open.
 * A cost regression comes from Lookback's scorecards, not an event ({@link costRegressionFacts}).
 */
export const automationFacts = (state: RunState, event: VtcEvent): AutomationFact[] => {
  const base = { run: state.id, source: event.type, at: event.ts };
  const roleOf = (actionId: string | undefined): Partial<AutomationFact> => {
    const run = actionId === undefined ? undefined : state.roleRuns.get(actionId);
    return run === undefined
      ? {}
      : {
          role: run.role,
          ...(run.mode === undefined ? {} : { mode: run.mode }),
          host: run.host,
          model: run.model,
          promptSha: run.prompt_sha,
        };
  };
  switch (event.type) {
    case "incident.recorded": {
      const v = parse("incident.recorded", event);
      if (v === null || (v.kind !== "gate_infra" && v.kind !== "crash")) return [];
      return [
        {
          ...base,
          target: "upstream",
          kind: "defect",
          errorClass: `incident.${v.kind}`,
          detail: v.detail,
        },
      ];
    }
    case "role.failed": {
      const v = parse("role.failed", event);
      // only the engine opens a message with the prefix (`reportedFailureMessage`, AD-8)
      if (v === null || !v.message.startsWith(PARSE_FAILURE_PREFIX)) return [];
      return [
        {
          ...base,
          ...roleOf(v.action_id),
          target: "upstream",
          kind: "defect",
          errorClass: "adapter.parse_failure",
          ...(event.task === undefined ? {} : { task: event.task }),
          detail: v.message,
        },
      ];
    }
    case "task.status_changed": {
      const v = parse("task.status_changed", event);
      if (v?.to !== "parked" || v.park_reason === undefined || HUMAN_PARKS.has(v.park_reason))
        return [];
      const task = event.task ?? "";
      const known = state.tasks.get(task);
      const feature = known?.feature;
      const project: AutomationFact = {
        ...base,
        target: "project",
        kind: "parked",
        task,
        ...(feature === undefined ? {} : { feature }),
        // a task id repeats across runs: the run names the problem
        ruleId: `parked/${v.park_reason}/${state.id}/${task}`,
        title: clip(
          `Task ${task} parked (${v.park_reason})${known === undefined ? "" : `: ${known.title}`}`,
        ),
        detail: `task ${task} parked (${v.park_reason}) after round ${String(v.round)}`,
      };
      if (v.park_reason !== "stuck") return [project];
      // a stuck loop is VTC's own defect too, attributed to the role that kept failing
      const last = [...state.roleRuns.values()]
        .filter((r) => r.task === task && (r.status === "failed" || r.status === "rejected"))
        .at(-1);
      return [
        project,
        {
          ...base,
          ...roleOf(last?.action_id),
          target: "upstream",
          kind: "defect",
          errorClass: "engine.stuck_loop",
          task,
          detail: `a role failed or was rejected repeatedly on task ${task}`,
        },
      ];
    }
    case "lookback.replay_finished": {
      const v = parse("lookback.replay_finished", event);
      if (v?.verdict !== "improve") return [];
      return [
        {
          ...base,
          target: "upstream",
          kind: "lookback",
          proposal: v.proposal,
          replayPath: v.path,
          detail: `the replay of proposal ${v.proposal} says improve`,
        },
      ];
    }
    case "feature.post_merge_ci": {
      const v = parse("feature.post_merge_ci", event);
      if (v?.status !== "red") return [];
      return [
        {
          ...base,
          target: "project",
          kind: "ci_failure",
          ...(event.feature === undefined ? {} : { feature: event.feature }),
          mergeCommit: v.merge_commit,
          ruleId: `post_merge_ci/${v.merge_commit}`,
          title: `Required checks red after merge ${v.merge_commit.slice(0, 12)}`,
          detail: `the required checks on the base are red after merge ${v.merge_commit.slice(0, 12)}`,
        },
      ];
    }
    case "feature.reverted": {
      const v = parse("feature.reverted", event);
      if (v === null) return [];
      return [
        {
          ...base,
          target: "project",
          kind: "escaped_defect",
          ...(event.feature === undefined ? {} : { feature: event.feature }),
          mergeCommit: v.merge_commit,
          // a revert and Lookback's escaped defect of one merge are one problem
          ruleId: `escaped_defect/${v.merge_commit}`,
          title: `Escaped defect in merge ${v.merge_commit.slice(0, 12)}`,
          detail: v.detail,
        },
      ];
    }
    case "lookback.escaped_defect": {
      const v = parse("lookback.escaped_defect", event);
      if (v === null) return [];
      return [
        {
          ...base,
          target: "project",
          kind: "escaped_defect",
          ...(event.feature === undefined ? {} : { feature: event.feature }),
          mergeCommit: v.merge_commit,
          // a revert and Lookback's escaped defect of one merge are one problem
          ruleId: `escaped_defect/${v.merge_commit}`,
          title: `Escaped defect in merge ${v.merge_commit.slice(0, 12)}`,
          detail: `an escaped defect (${v.kind}) of merge ${v.merge_commit.slice(0, 12)}${v.tasks.length === 0 ? "" : ` in ${v.tasks.join(", ")}`}`,
        },
      ];
    }
    case "finding.recorded": {
      const v = parse("finding.recorded", event);
      if (v?.finding.route !== "out_of_scope") return [];
      return [
        {
          ...base,
          target: "project",
          kind: "finding",
          ...(v.finding.task === undefined ? {} : { task: v.finding.task }),
          ...(v.finding.feature === undefined ? {} : { feature: v.finding.feature }),
          ...findingIdentity(v.finding),
          detail: `${v.finding.category} finding outside its task's scope: ${v.finding.title}`,
        },
      ];
    }
    case "run.finished":
      // Final Review leftovers: the feature findings the finished run left open or deferred
      return [...state.findings.values()]
        .map((r) => r.finding)
        .filter(
          (f) =>
            f.feature !== undefined &&
            f.task === undefined &&
            (f.status === "open" || f.status === "deferred"),
        )
        .map((f) => ({
          ...base,
          target: "project" as const,
          kind: "final_review" as const,
          ...(f.feature === undefined ? {} : { feature: f.feature }),
          ...findingIdentity(f),
          detail: `a Final Review finding left ${f.status}: ${f.title}`,
        }));
    default:
      return [];
  }
};

// ------------------------------------------------------------ cost regression

/** The scorecard metrics a cost regression is judged on (D-bv: quality per token, cost per task). */
const COST_METRICS: readonly ScorecardMetricId[] = [
  "tokens_per_success",
  "escalations_per_100",
  "cap_hits_per_100",
];

/**
 * Pure: whether `current` is worse than `baseline` beyond `LOOKBACK_LIMITS` (the canary rollback
 * limits, §13 step 6): tokens per success up more than `maxTokenRisePct`, or the escalation or
 * cap-hit rate at `rollbackRateRatio` times its baseline or more.
 */
export const costWorsened = (
  metric: ScorecardMetricId,
  baseline: number,
  current: number,
): boolean => {
  if (metric === "tokens_per_success")
    return baseline > 0 && current > baseline * (1 + LOOKBACK_LIMITS.maxTokenRisePct / 100);
  if (metric === "escalations_per_100" || metric === "cap_hits_per_100")
    return baseline > 0 && current >= baseline * LOOKBACK_LIMITS.rollbackRateRatio;
  return false;
};

/**
 * Pure (D-bv "cost regression"): for each role, mode and host, its newest prompt version (by the
 * start of its scorecard window) against the version before it; one `cost` fact per metric that
 * worsened beyond `LOOKBACK_LIMITS`. A metric without enough data (`value` null) on either side is
 * not compared. The upstream module owns the fingerprint, the dedupe and the report.
 */
export const costRegressionFacts = (
  cards: readonly Scorecard[],
  meta: { readonly run: string; readonly at: string },
): AutomationFact[] => {
  const groups = new Map<string, Scorecard[]>();
  for (const card of cards) {
    const p = card.prompt;
    const key = `${p.role}\u0000${p.mode ?? ""}\u0000${p.host}`;
    groups.set(key, [...(groups.get(key) ?? []), card]);
  }
  const out: AutomationFact[] = [];
  for (const group of groups.values()) {
    const versions = [...group].sort((a, b) =>
      a.window.from === b.window.from ? 0 : a.window.from < b.window.from ? -1 : 1,
    );
    const current = versions.at(-1);
    const baseline = [...versions]
      .reverse()
      .find((c) => c.prompt.effective_sha256 !== current?.prompt.effective_sha256);
    if (current === undefined || baseline === undefined) continue;
    for (const metric of COST_METRICS) {
      const before = baseline.metrics[metric]?.value;
      const now = current.metrics[metric]?.value;
      if (before === undefined || before === null || now === undefined || now === null) continue;
      if (!costWorsened(metric, before, now)) continue;
      const p = current.prompt;
      out.push({
        target: "upstream",
        kind: "cost",
        run: meta.run,
        source: "lookback.scorecards",
        at: meta.at,
        role: p.role,
        ...(p.mode === undefined ? {} : { mode: p.mode }),
        host: p.host,
        promptSha: p.effective_sha256,
        baselinePromptSha: baseline.prompt.effective_sha256,
        metric,
        baseline: before,
        current: now,
        detail: `${p.role} on ${p.host}: ${metric} went from ${String(before)} to ${String(now)} against its previous prompt version`,
      });
    }
  }
  return out;
};

// ------------------------------------------------------------- daily summary

/** The `upstream.*` and `automation.skipped` events (D-ca). */
export const isAutomationEvent = (type: string): boolean =>
  type.startsWith("upstream.") || type === "automation.skipped";

/**
 * Pure (D-ca, AD-27 rule 7): the Lead's daily summary of what automation did in `events` (already
 * the window to summarise): issues and PRs opened, updated and closed, with links, and what was
 * skipped by reason. `null` when nothing happened.
 */
export const automationDailySummary = (events: readonly VtcEvent[], day: string): string | null => {
  const of = (type: string): VtcEvent[] => events.filter((e) => e.type === type);
  const links = (type: "upstream.issue_opened" | "upstream.pr_opened"): string[] =>
    of(type).flatMap((e) => {
      const v = parse(type, e);
      return v === null ? [] : [`#${String(v.number)} ${v.url}`];
    });
  const issues = links("upstream.issue_opened");
  const prs = links("upstream.pr_opened");
  const updated = of("upstream.issue_updated").length;
  const closed = of("upstream.issue_closed").length + of("upstream.pr_closed").length;
  const reasons = new Map<string, number>();
  for (const e of of("automation.skipped")) {
    const v = parse("automation.skipped", e);
    if (v !== null) reasons.set(v.reason, (reasons.get(v.reason) ?? 0) + 1);
  }
  if (issues.length + prs.length + updated + closed + reasons.size === 0) return null;
  const parts = [
    `Automation on ${day} (UTC): ${String(issues.length)} issue(s) and ${String(prs.length)} draft PR(s) opened, ${String(updated)} issue update(s), ${String(closed)} closed.`,
    ...(issues.length === 0 ? [] : [`Issues: ${issues.slice(0, 5).join("; ")}.`]),
    ...(prs.length === 0 ? [] : [`PRs for your review: ${prs.slice(0, 5).join("; ")}.`]),
    ...(reasons.size === 0
      ? []
      : [`Skipped: ${[...reasons].map(([reason, n]) => `${reason} ${String(n)}`).join(", ")}.`]),
  ];
  return parts.join(" ").slice(0, 2000);
};

// ------------------------------------------------------------------- the seam

/** What the daemon hands the upstream module (AD-27 rule 8; D-bu): engine facts in, events out. */
export interface UpstreamWiringDeps {
  readonly projectRoot: string;
  readonly vtcHome: string;
  /** The cli's `gh`, plumbing and evidence seams and the user's upstream settings. */
  readonly automation: AutomationDeps;
  /** The project's resolved settings now (`automationFor`, with `vtc pause`). */
  readonly settings: () => AutomationSettings;
  /** What the settings were resolved from now: the GitHub remote, the gh login, `vtc pause`. */
  readonly context: () => AutomationContext;
  /**
   * The only way the module records what it did: an `upstream.*` or `automation.skipped` event,
   * in `run`'s log (absent: the active run, else the next run to start).
   */
  readonly emit: (draft: EventDraft, run?: string) => void;
  /** Starts an automatic run from an issue (a fixable project finding, D-bv; AD-27 rule 2). */
  readonly startRun: (input: StartInput, issue: AutomationRunRef) => Promise<void>;
  readonly now: () => Date;
}

/** The upstream module as the daemon drives it. */
export interface UpstreamWiring {
  /** One fact that may raise an issue or PR; the module decides (dedupe, caps, privacy). */
  onFact(fact: AutomationFact): Promise<void>;
  /** The periodic sweep (auto-close of quiet issues, the write queue); optional. */
  sweep?(): Promise<void>;
  close?(): Promise<void>;
}

/** The upstream module's factory (`upstream.createUpstream` at the round-4 merge). */
export type CreateUpstream = (deps: UpstreamWiringDeps) => UpstreamWiring;

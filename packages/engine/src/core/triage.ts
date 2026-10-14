/**
 * Triage (§6.3 step 8; AD-8 rules 6–7, AD-13 rule 9). Pure: turns reviewer finding drafts,
 * Gate Runner tool findings, failed gates, failing verdicts and write-scope violations into
 * `Finding`s with an engine fingerprint, an engine severity (reviewer claims are ignored) and an
 * engine route; dedupes by fingerprint and tracks rounds; detects reappearing findings.
 */
import {
  fingerprintFinding,
  normalizeSeverity,
  routeForFinding,
  weightedSeverity,
  type Evidence,
  type Finding,
  type FindingCategory,
  type FindingDraft,
  type GateResult,
  type RoleVerdict,
  type ToolFinding,
  type WriteScopeReport,
} from "@vtc/shared";

export interface TriageContext {
  readonly task?: string;
  readonly feature?: string;
  /** The task round (or feature Final Review round) being verified. */
  readonly round: number;
}

const scope = (ctx: TriageContext): Pick<Finding, "task" | "feature"> => ({
  ...(ctx.task === undefined ? {} : { task: ctx.task }),
  ...(ctx.feature === undefined ? {} : { feature: ctx.feature }),
});

export const findingFromDraft = (
  draft: FindingDraft,
  sourceName: string,
  ctx: TriageContext,
): Finding => {
  const severity = normalizeSeverity({ source: "role", category: draft.category });
  return {
    fingerprint: fingerprintFinding({
      rule_id: draft.rule_id,
      path: draft.location.path,
      symbol: draft.location.symbol,
      snippet: draft.snippet,
      line: draft.location.line,
    }),
    source: "role",
    source_name: sourceName,
    rule_id: draft.rule_id,
    category: draft.category,
    kind: draft.kind,
    title: draft.title,
    ...(draft.message === undefined ? {} : { message: draft.message }),
    severity,
    ...(draft.claimed_severity === undefined ? {} : { claimed_severity: draft.claimed_severity }),
    confidence: draft.confidence,
    location: draft.location,
    evidence: draft.evidence,
    req_ids: draft.req_ids,
    ...(draft.snippet === undefined ? {} : { snippet: draft.snippet }),
    ...(draft.cwe === undefined ? {} : { cwe: draft.cwe }),
    route: routeForFinding({
      source: "role",
      category: draft.category,
      kind: draft.kind,
      severity,
    }),
    ...scope(ctx),
    round_first_seen: ctx.round,
    status: "open",
  };
};

export const findingFromTool = (tool: ToolFinding, ctx: TriageContext): Finding => {
  // AD-8 rule 7, spine §5 reading 46a: outside the security class a tool finding caps at medium
  const severity = normalizeSeverity({
    source: "tool",
    category: tool.category,
    ...(tool.score === undefined ? {} : { score: tool.score }),
    ...(tool.label === undefined ? {} : { label: tool.label }),
    ...(tool.sarif_level === undefined ? {} : { sarifLevel: tool.sarif_level }),
  });
  return {
    fingerprint: fingerprintFinding({
      rule_id: tool.rule_id,
      path: tool.location.path,
      symbol: tool.location.symbol,
      snippet: tool.snippet,
      line: tool.location.line,
    }),
    source: "tool",
    source_name: tool.tool,
    rule_id: tool.rule_id,
    category: tool.category,
    title: tool.title,
    ...(tool.message === undefined ? {} : { message: tool.message }),
    severity,
    confidence: 1,
    location: tool.location,
    evidence: tool.evidence,
    req_ids: [],
    ...(tool.snippet === undefined ? {} : { snippet: tool.snippet }),
    ...(tool.cwe === undefined ? {} : { cwe: tool.cwe }),
    // a design-slop detector finding (`vtc-design/…`) goes to the Designer (§9.1, AD-24 rule 4)
    route: routeForFinding({
      source: "tool",
      category: tool.category,
      severity,
      ruleId: tool.rule_id,
    }),
    ...scope(ctx),
    round_first_seen: ctx.round,
    status: "open",
  };
};

/**
 * A failed blocking gate that reported no parsed findings (e.g. failing tests): one finding per
 * gate, so the Engineer sees it and stuck detection can track it.
 */
export const findingFromGateFailure = (result: GateResult, ctx: TriageContext): Finding => {
  const path = result.report?.path ?? `.vtc/evidence/gates/${result.gate_id}`;
  const evidence: Evidence = result.evidence[0] ?? { type: "command_output", ref: path };
  const category: FindingCategory = result.layer === "L5" ? "test_integrity" : "correctness";
  const severity = normalizeSeverity({ source: "role", category });
  const rule = `gate.${result.gate_id}`;
  return {
    fingerprint: fingerprintFinding({ rule_id: rule, path: `gates/${result.gate_id}` }),
    source: "tool",
    source_name: result.gate_id,
    rule_id: rule,
    category,
    title: `Gate ${result.gate_id} (${result.layer}) ${result.status === "error" ? "errored" : "failed"}`,
    ...(result.monotonic.length > 0
      ? {
          message:
            `metrics got worse: ${result.monotonic.map((m) => `${m.kind}${m.test === undefined ? "" : ` ${m.test}`}`).join(", ")}`.slice(
              0,
              4000,
            ),
        }
      : {}),
    severity,
    confidence: 1,
    location: { path },
    evidence,
    req_ids: [],
    route: routeForFinding({ source: "tool", category, severity }),
    ...scope(ctx),
    round_first_seen: ctx.round,
    status: "open",
  };
};

/** One failing test of an L2 run (from the Gate Runner's test inventory). */
export const findingFromFailingTest = (
  result: GateResult,
  testId: string,
  inventory: string,
  ctx: TriageContext,
): Finding => {
  const severity = normalizeSeverity({ source: "role", category: "correctness" });
  const rule = `test.${result.gate_id}`;
  return {
    fingerprint: fingerprintFinding({
      rule_id: rule,
      path: `tests/${result.gate_id}`,
      symbol: testId,
    }),
    source: "tool",
    source_name: result.gate_id,
    rule_id: rule,
    category: "correctness",
    title: `Failing test: ${testId}`.slice(0, 200),
    severity,
    confidence: 1,
    location: { path: inventory, symbol: testId.slice(0, 512) },
    evidence: { type: "test", ref: testId },
    req_ids: [],
    route: routeForFinding({ source: "tool", category: "correctness", severity }),
    ...scope(ctx),
    round_first_seen: ctx.round,
    status: "open",
  };
};

const VERDICT_CATEGORY: Readonly<Record<string, FindingCategory>> = {
  spec_verifier: "spec_mismatch",
  qa: "test_adequacy",
  security: "security",
  visual_qa: "design",
};

const pathOfEvidence = (evidence: Evidence): string | undefined => {
  if (evidence.type === "file") return evidence.ref;
  if (evidence.type === "file_line") return evidence.ref.replace(/:\d+(-\d+)?$/, "");
  return undefined;
};

/**
 * A verdict other than `pass` on a subject (`fail`, `unknown`, or `unchecked`: unreached is not
 * clean, §7.5) that came without a finding: it still blocks the round as one finding.
 */
export const findingFromVerdict = (
  verdict: RoleVerdict,
  role: string,
  ctx: TriageContext & { readonly fallbackPath: string },
): Finding => {
  const category = VERDICT_CATEGORY[role] ?? "spec_mismatch";
  const severity = normalizeSeverity({ source: "role", category });
  const evidence = verdict.evidence[0] ?? { type: "spec_ref", ref: verdict.subject };
  const path =
    verdict.evidence.map(pathOfEvidence).find((p) => p !== undefined) ?? ctx.fallbackPath;
  const rule = `verdict.${verdict.subject}`;
  return {
    fingerprint: fingerprintFinding({ rule_id: rule, path, symbol: verdict.subject }),
    source: "role",
    source_name: role,
    rule_id: rule,
    category,
    kind: "implementation_deviation",
    title: `${verdict.subject}: verdict ${verdict.verdict}`,
    severity,
    confidence: 1,
    location: { path, symbol: verdict.subject },
    evidence,
    req_ids: /^(REQ|SEC)-/.test(verdict.subject) ? [verdict.subject] : [],
    route: routeForFinding({
      source: "role",
      category,
      kind: "implementation_deviation",
      severity,
    }),
    ...scope(ctx),
    round_first_seen: ctx.round,
    status: "open",
  };
};

/** Write-scope and test-integrity violations (§6.3 step 4): each is a test-integrity hit. */
export const findingsFromWriteScope = (report: WriteScopeReport, ctx: TriageContext): Finding[] =>
  report.violations.map((violation) => {
    const rule = `write_scope.${violation.kind}`;
    const severity = normalizeSeverity({ source: "role", category: "test_integrity" });
    return {
      fingerprint: fingerprintFinding({ rule_id: rule, path: violation.path }),
      source: "tool",
      source_name: "write_scope",
      rule_id: rule,
      category: "test_integrity",
      title: `${violation.kind.replace(/_/g, " ")}: ${violation.path}`.slice(0, 200),
      severity,
      confidence: 1,
      location: { path: violation.path },
      evidence: { type: "file", ref: violation.path },
      req_ids: [],
      route: routeForFinding({ source: "tool", category: "test_integrity", severity }),
      ...scope(ctx),
      round_first_seen: ctx.round,
      status: "open",
    };
  });

/** Dedupes by fingerprint within one batch (§6.3 step 8); the first report wins. */
export const dedupe = (findings: readonly Finding[]): Finding[] => {
  const seen = new Map<string, Finding>();
  for (const f of findings) if (!seen.has(f.fingerprint)) seen.set(f.fingerprint, f);
  return [...seen.values()];
};

export interface RoundMerge {
  /** New or updated findings to record (`finding.recorded`). */
  readonly recorded: Finding[];
  /** Findings that were open, whose source ran this round and did not report them again. */
  readonly resolved: Finding[];
  /** A previously resolved fingerprint came back (stuck signal, §6.3 step 9). */
  readonly reappeared: boolean;
}

/**
 * Merges one round's fresh findings into the task's history. `ranSources` are the source names
 * that verified this round: only their open findings can be resolved by silence.
 */
export const mergeRound = (
  existing: readonly Finding[],
  fresh: readonly Finding[],
  ranSources: ReadonlySet<string>,
  round: number,
): RoundMerge => {
  const byPrint = new Map(existing.map((f) => [f.fingerprint, f]));
  const recorded: Finding[] = [];
  let reappeared = false;
  for (const finding of dedupe(fresh)) {
    const prior = byPrint.get(finding.fingerprint);
    if (prior === undefined) {
      recorded.push(finding);
      continue;
    }
    if (prior.status === "waived" || prior.status === "deferred") continue;
    if (prior.status === "resolved") reappeared = true;
    recorded.push({
      ...prior,
      status: prior.status === "discarded" ? finding.status : "open",
      round_last_seen: Math.max(round, prior.round_first_seen),
    });
  }
  const seenNow = new Set(fresh.map((f) => f.fingerprint));
  const resolved = existing.filter(
    (f) => f.status === "open" && ranSources.has(f.source_name) && !seenNow.has(f.fingerprint),
  );
  return { recorded, resolved, reappeared };
};

/** The last round a finding was seen in. */
export const lastSeen = (f: Pick<Finding, "round_first_seen" | "round_last_seen">): number =>
  f.round_last_seen ?? f.round_first_seen;

/** Weighted severity of the findings seen in round `round` (stuck detection, §6.3 step 9). */
export const weightedSeverityOfRound = (findings: readonly Finding[], round: number): number =>
  weightedSeverity(
    findings
      .filter(
        (f) => f.status !== "discarded" && f.round_first_seen <= round && lastSeen(f) >= round,
      )
      .map((f) => f.severity),
  );

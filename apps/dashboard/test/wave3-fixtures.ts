import {
  EVENT_PAYLOAD_SCHEMAS,
  EventSchema,
  FactRowSchema,
  ScorecardIndexSchema,
  ScorecardSchema,
  VisualReportSchema,
  VisualSummarySchema,
  type CoreEventType,
  type VtcEvent,
  type VtcEventInput,
} from "@vtc/shared";
import { artifactContent } from "../scripts/dev-fixtures.ts";
import { GOLDEN_RUN } from "../scripts/fixture-routes.ts";
import { readFixture } from "./fixtures";

/**
 * Wave-3 samples (contracts 4.5.0) the golden run does not record yet: every payload is checked
 * against its contract here, so a sample can never drift from what the engine may write.
 */
export const w3Event = (
  seq: number,
  type: CoreEventType,
  data: Record<string, unknown>,
  extra: Partial<VtcEventInput> = {},
): VtcEvent => {
  EVENT_PAYLOAD_SCHEMAS[type].parse(data);
  return EventSchema.parse({
    v: 1,
    seq,
    ts: `2026-10-13T11:${String(seq % 60).padStart(2, "0")}:00.000Z`,
    run: GOLDEN_RUN,
    type,
    actor: "engine",
    data,
    ...extra,
  });
};

export const SHA = (c: string): string => c.repeat(40);
export const SHA256 = (c: string): string => c.repeat(64);

const frozen = [{ path: ".vtc/architecture/spine.md", sha256: SHA256("3") }];

export const GATE_EVENTS: readonly VtcEvent[] = [
  w3Event(60, "gate.requested", {
    gates: ["G2"],
    artifacts: frozen,
    design_directions: ["calm-ledger", "night-shift"],
    unverified_facts: ["f-0123456789abcdef", "f-fedcba9876543210"],
    directions: [
      {
        id: "calm-ledger",
        title: "Calm ledger",
        thesis: "Quiet tables, one accent, numbers first.",
        prototype: ".vtc/design/prototype/calm-ledger/index.html",
        first_viewport: ".vtc/design/prototype/calm-ledger/first-viewport.png",
        novelty: "novel",
      },
      {
        id: "night-shift",
        title: "Night shift",
        thesis: "Dark surfaces with a warm signal colour.",
        prototype: ".vtc/design/prototype/night-shift/index.html",
        novelty: "too_similar",
      },
    ],
    facts: [
      {
        id: "f-0123456789abcdef",
        subject: "npm:react@19.3.0",
        predicate: "license",
        status: "unverified",
        reason: "quote not found in the source",
        source_url: "https://registry.npmjs.org/react",
      },
      {
        id: "f-fedcba9876543210",
        subject: "nodejs@22",
        predicate: "eol_date",
        status: "stale",
        reason: "served stale after a failed revalidation",
      },
    ],
    design_coverage: {
      reqs_without_screen: ["REQ-4"],
      screens_without_req: [],
      components_unregistered: ["date-picker"],
      ok: false,
    },
  }),
  w3Event(61, "fact.waived", { id: "f-fedcba9876543210", reason: "EOL date checked by hand" }),
  w3Event(62, "gate.approved", {
    gates: ["G2"],
    frozen,
    design_direction: "calm-ledger",
    waived_facts: ["f-0123456789abcdef", "f-fedcba9876543210"],
    fact_waivers: [{ id: "f-0123456789abcdef", reason: "MIT per the package page" }],
  }),
];

const CHECKLIST_ITEMS = [
  ["final_review", false, "Final Review pass; gates green; visual skipped"],
  ["reviewers", true, "0 open findings at or above the threshold"],
  ["coverage", true, "0 requirement gaps"],
  ["test_integrity", true, "clean"],
  ["risk_rules", true, "none fired"],
  ["waivers", true, "0 waivers, 0 parked dependencies"],
  ["remote_ci", true, "2/2 required checks green"],
] as const;

export const LEVEL3_EVENTS: readonly VtcEvent[] = [
  w3Event(63, "merge.preflight", {
    configured_level: 3,
    effective_level: 2,
    ok: false,
    failed: ["no_required_checks", "auto_merge_disallowed"],
    policy: {
      base: "main",
      auto_merge_allowed: false,
      required_checks: [],
      merge_methods: ["squash"],
      merge_queue: false,
      requires_review: false,
      signatures_required: false,
    },
  }),
  w3Event(
    64,
    "final_review.step_finished",
    { step: 1, status: "pass", evidence: [{ type: "file", ref: ".vtc/evidence/F-1/gates.json" }] },
    { feature: "F-1" },
  ),
  w3Event(
    65,
    "final_review.step_finished",
    { step: 5, status: "skipped", reason: "no browser for the visual gates" },
    { feature: "F-1" },
  ),
  w3Event(
    66,
    "final_review.step_finished",
    { step: 2, status: "unchecked", reason: "hidden tests did not start" },
    { feature: "F-1" },
  ),
  w3Event(
    67,
    "feature.checklist",
    {
      ok: false,
      items: CHECKLIST_ITEMS.map(([id, ok, detail]) => ({
        id,
        ok,
        detail,
        evidence: id === "remote_ci" ? [{ type: "url", ref: "https://github.com/o/r/pull/7" }] : [],
      })),
    },
    { feature: "F-1" },
  ),
  w3Event(
    68,
    "feature.auto_merge_enabled",
    { pr_number: 7, head_sha: SHA("b"), method: "squash", merge_queue: false },
    { feature: "F-1" },
  ),
  w3Event(
    69,
    "feature.auto_merge_disabled",
    { reason: "head_moved", detail: "the PR head moved past the gated commit" },
    { feature: "F-1" },
  ),
  w3Event(
    70,
    "feature.post_merge_ci",
    {
      merge_commit: SHA("c"),
      status: "red",
      runs: [{ name: "ci / test", conclusion: "failure", required: true }],
    },
    { feature: "F-1" },
  ),
  w3Event(
    71,
    "feature.reverted",
    {
      merge_commit: SHA("c"),
      revert: { commit: SHA("d"), detected_by: "git_log" },
      detail: "Revert of the F-1 merge found on main",
    },
    { feature: "F-1" },
  ),
];

export const HEADLESS_EVENTS: readonly VtcEvent[] = [
  w3Event(72, "headless.preflight", { host: "codex", purpose: "role", ok: true }),
  w3Event(
    73,
    "headless.started",
    {
      action_id: "a-12",
      pid: 4242,
      resume: null,
      wall_timeout_ms: 3_600_000,
      idle_timeout_ms: 600_000,
    },
    { role: "engineer", host: "codex", task: "T-1" },
  ),
  w3Event(
    74,
    "headless.ended",
    { action_id: "a-12", outcome: "error", cause: "idle", exit_code: null, duration_ms: 615_000 },
    { role: "engineer", host: "codex", task: "T-1" },
  ),
  w3Event(
    75,
    "headless.started",
    {
      action_id: "a-13",
      pid: null,
      resume: { host: "codex", id: "sess-9" },
      wall_timeout_ms: 3_600_000,
      idle_timeout_ms: 600_000,
    },
    { role: "qa", host: "codex", task: "T-2" },
  ),
  w3Event(76, "headless.preflight", {
    host: "codex",
    purpose: "auto_resume",
    ok: false,
    failed: "auth",
    detail: "codex login status: not logged in",
  }),
];

export const LOOKBACK_EVENTS: readonly VtcEvent[] = [
  w3Event(77, "lookback.dispatched", {
    target_role: "engineer",
    target_host: "claude-code",
    train_failures: 6,
  }),
  w3Event(78, "lookback.proposal_recorded", {
    proposal: "engineer-p1",
    path: ".vtc/lookback/proposals/engineer/proposal.json",
    changes: 2,
  }),
  w3Event(79, "lookback.replay_finished", {
    proposal: "engineer-p1",
    verdict: "inconclusive",
    path: ".vtc/lookback/replays/engineer-p1.json",
  }),
  w3Event(80, "lookback.canary_evaluated", {
    role: "engineer",
    host: "claude-code",
    repo_key: "0123456789abcdef",
    candidate: SHA256("a"),
    baseline: SHA256("b"),
    started_at: "2026-10-12T10:00:00.000Z",
    arms: {
      candidate: { dispatches: 6, escalations: 3, cap_hits: 1, tokens: 60_000 },
      baseline: { dispatches: 6, escalations: 1, cap_hits: 0, tokens: 58_000 },
    },
    verdict: "rollback",
    reason: "escalations and cap hits at 2x the baseline or more",
  }),
  w3Event(81, "lookback.rolled_back", {
    target_role: "engineer",
    target_host: "claude-code",
    from: SHA256("a"),
    to: SHA256("b"),
    reason: "escalations and cap hits at 2x the baseline or more",
  }),
  w3Event(
    82,
    "lookback.escaped_defect",
    { merge_commit: SHA("c"), kind: "revert", tasks: ["T-1"] },
    { feature: "F-1" },
  ),
];

export const FACT_EVENTS: readonly VtcEvent[] = [
  w3Event(83, "fact.verified", { id: "f-0123456789abcdef", status: "verified" }),
];

export const WAVE3_EVENTS: readonly VtcEvent[] = [
  ...GATE_EVENTS,
  ...LEVEL3_EVENTS,
  ...HEADLESS_EVENTS,
  ...LOOKBACK_EVENTS,
  ...FACT_EVENTS,
];

/** The golden run's event page with {@link WAVE3_EVENTS} appended. */
export const eventPageWithWave3 = (): unknown => {
  const page = readFixture("events") as { run: string; events: unknown[]; next_after: null };
  return { ...page, events: [...page.events, ...WAVE3_EVENTS] };
};

// ------------------------------------------------------------------ files

const prompt = (role: string, host: string, c: string) => ({
  role,
  host,
  locked_sha256: SHA256("1"),
  editable_sha256: SHA256(c),
  effective_sha256: SHA256(c === "2" ? "e" : "f"),
});

export const SCORECARD_INDEX = ScorecardIndexSchema.parse({
  v: 1,
  scorecards: [
    {
      prompt: prompt("engineer", "claude-code", "2"),
      path: ".vtc/lookback/scorecards/engineer/claude-code/eeeeeeee/scorecard.json",
      written_at: "2026-10-13T08:00:00.000Z",
    },
    {
      prompt: prompt("qa", "codex", "3"),
      path: ".vtc/lookback/scorecards/qa/codex/ffffffff/scorecard.json",
      written_at: "2026-10-12T08:00:00.000Z",
    },
  ],
});

export const ENGINEER_SCORECARD = ScorecardSchema.parse({
  v: 1,
  prompt: prompt("engineer", "claude-code", "2"),
  grader_bundle_sha: SHA256("9"),
  window: { from: "2026-10-01T00:00:00.000Z", to: "2026-10-13T00:00:00.000Z" },
  metrics: {
    first_round_gate_pass: { value: 0.625, ci_low: 0.4, ci_high: 0.81, n: 24 },
    review_pass: { value: null, ci_low: null, ci_high: null, n: 4 },
    rounds_to_done: { value: 1.8, ci_low: null, ci_high: null, n: 24 },
    tokens_per_success: { value: 41250, ci_low: null, ci_high: null, n: 15 },
  },
  breakdown: [
    {
      discipline: "frontend",
      stack_pack: "nextjs",
      host: "claude-code",
      metrics: { first_round_gate_pass: { value: null, ci_low: null, ci_high: null, n: 3 } },
    },
  ],
  written_at: "2026-10-13T08:00:00.000Z",
});

const FACT_SOURCE = {
  fetcher: "registry",
  url: "https://registry.npmjs.org/react",
  retrieved_at: "2026-10-12T09:00:00.000Z",
  content_sha256: SHA256("4"),
  locator: { kind: "json_pointer", pointer: "/license" },
} as const;

export const FACT_ROWS = [
  {
    v: 1,
    id: "f-0123456789abcdef",
    subject: "npm:react@19.3.0",
    predicate: "license",
    value: "MIT",
    status: "unverified",
    source: FACT_SOURCE,
    recorded_by: "research",
    recorded_at: "2026-10-12T09:00:00.000Z",
  },
  {
    v: 1,
    id: "f-1111111111111111",
    subject: "npm:react@19.3.0",
    predicate: "license",
    value: "MIT",
    status: "verified",
    source: FACT_SOURCE,
    supersedes: "f-0123456789abcdef",
    recorded_by: "engine",
    recorded_at: "2026-10-12T09:05:00.000Z",
  },
  {
    v: 1,
    id: "f-fedcba9876543210",
    subject: "nodejs@22",
    predicate: "eol_date",
    value: "2027-04-30",
    status: "stale",
    source: {
      fetcher: "eol",
      url: "https://endoflife.date/api/nodejs/22.json",
      retrieved_at: "2026-09-01T09:00:00.000Z",
      content_sha256: SHA256("5"),
      locator: { kind: "json_pointer", pointer: "/eol" },
    },
    expires_at: "2026-09-08T09:00:00.000Z",
    recorded_by: "engine",
    recorded_at: "2026-09-01T09:00:00.000Z",
  },
  {
    v: 1,
    id: "f-2222222222222222",
    subject: "vendor-sdk",
    predicate: "latest_version",
    value: "4.2.0",
    status: "unverified",
    source: null,
    recorded_by: "architect",
    recorded_at: "2026-10-12T10:00:00.000Z",
  },
].map((row) => FactRowSchema.parse(row));

export const FACTS_JSONL = `${FACT_ROWS.map((r) => JSON.stringify(r)).join("\n")}\n`;

const K = (state: string, width: number, theme: string) =>
  `login:${state}:${String(width)}:${theme}`;

export const VISUAL_REPORT = VisualReportSchema.parse({
  v: 1,
  run: GOLDEN_RUN,
  task: "T-1",
  status: "unchecked",
  browser: { name: "chromium-headless-shell", version: "141.0", executable_sha256: SHA256("6") },
  renders: [
    {
      key: K("default", 390, "light"),
      status: "rendered",
      screenshot: ".vtc/evidence/T-1/visual/login-default-390-light.png",
      reference: ".vtc/evidence/T-1/visual/ref-login-default-390-light.png",
      source_hash: SHA256("7"),
    },
    {
      key: K("default", 1440, "dark"),
      status: "rendered",
      screenshot: ".vtc/evidence/T-1/visual/login-default-1440-dark.png",
      source_hash: SHA256("7"),
    },
    {
      key: K("error", 390, "light"),
      status: "unreached",
      source_hash: SHA256("7"),
      detail: "state=error never rendered: the route redirected",
    },
  ],
  axe: [
    {
      key: K("default", 1440, "dark"),
      violations: [
        {
          rule: "color-contrast",
          impact: "serious",
          help: "Elements must meet contrast",
          nodes: 2,
        },
      ],
      incomplete: [
        { rule: "aria-hidden-focus", impact: null, help: "Hidden content focusable", nodes: 1 },
      ],
    },
  ],
  computed_style: [
    {
      key: K("default", 390, "light"),
      selector: ".btn-primary",
      property: "background-color",
      value: "oklch(0.6 0.2 30)",
      nearest_token: "color.brand.500",
      delta: 0.05,
    },
  ],
  diffs: [
    {
      key: K("default", 390, "light"),
      region: "header",
      mismatch_px: 1200,
      ratio_pct: 1.4,
      budget_pct: 0.5,
      diff_image: ".vtc/evidence/T-1/visual/diff-login-default-390-light-header.png",
    },
    {
      key: K("default", 390, "light"),
      region: "form",
      mismatch_px: 10,
      ratio_pct: 0.1,
      budget_pct: 0.5,
    },
  ],
  findings: [
    {
      tool: "axe",
      rule_id: "axe/color-contrast",
      category: "accessibility",
      title: "Elements must meet contrast",
      location: { path: "src/app/login/page.tsx" },
      evidence: { type: "file", ref: ".vtc/evidence/T-1/visual/report.json" },
    },
  ],
  written_at: "2026-10-13T11:00:00.000Z",
});

export const VISUAL_REPORT_PATH = ".vtc/evidence/T-1/visual/report.json";

export const VISUAL_SUMMARY_SKIPPED = VisualSummarySchema.parse({
  status: "skipped",
  report: null,
  skipped_reason:
    "no browser for the visual gates: install Playwright in the project, or run vtc doctor --install-browser",
  counts: {
    renders: 0,
    unreached: 0,
    axe_violations: 0,
    axe_incomplete: 0,
    style_mismatches: 0,
    diffs_over_budget: 0,
    token_lint: 0,
    detector: 0,
  },
});

export const VISUAL_SUMMARY_UNCHECKED = VisualSummarySchema.parse({
  status: "unchecked",
  report: VISUAL_REPORT_PATH,
  counts: {
    renders: 3,
    unreached: 1,
    axe_violations: 1,
    axe_incomplete: 1,
    style_mismatches: 1,
    diffs_over_budget: 1,
    token_lint: 0,
    detector: 0,
  },
  findings: VISUAL_REPORT.findings,
});

/** A JSON artifact as the artifacts route returns it. */
export const jsonArtifact = (path: string, value: unknown) =>
  artifactContent(GOLDEN_RUN, path, JSON.stringify(value, null, 2));

/** A 1×1 PNG, base64, as the artifacts route returns a binary file. */
export const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export const pngArtifact = (path: string) => ({
  run: GOLDEN_RUN,
  path,
  sha256: SHA256("8"),
  size: 68,
  media_type: "image/png",
  encoding: "base64" as const,
  content: PNG_BASE64,
});

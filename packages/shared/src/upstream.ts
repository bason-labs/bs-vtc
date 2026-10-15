/**
 * Automatic issues and PRs (spine AD-27; human decisions H-4..H-8, Lead decisions D-bu..D-ce;
 * spine §5 readings 184–209). New in contracts 5.0.0.
 *
 * When something in VTC is wrong, or Lookback finds a way to improve quality, security or cost,
 * VTC raises a GitHub issue and opens a pull request for human review, in VTC's own repo
 * (`upstream`, default `bason-labs/bs-vtc`) or in the user's project repo (`project`). It uses the
 * user's own `gh` login and never reads a token (AD-9). It never merges what it opens (D-bw).
 *
 * This file holds the pure, runtime-agnostic part: the kinds, the identity marker, labels,
 * branch names, limits, the privacy allowlist of an upstream report, the evidence manifest, the
 * event payloads and the Automation read model. The `gh`, git and capture seams are in
 * `interfaces/automation.ts`.
 */
import { z } from "zod";
import {
  HostIdSchema,
  IsoDateTimeSchema,
  RoleIdSchema,
  Sha256HexSchema,
  SlugSchema,
} from "./primitives.js";

// -------------------------------------------------------------------- kinds

/**
 * What an automatic issue or PR is about (D-bv, D-cd). The first group targets VTC's own repo, the
 * second the user's project repo ({@link AUTO_KINDS_BY_TARGET}).
 * - `lookback`: a replay verdict `improve` (a prompt edit plus a CHANGELOG entry, D-cb);
 * - `defect`: a recurring VTC defect (engine incident, `gate_infra` error, adapter parse failure,
 *   crash or stuck loop attributed to a VTC role or prompt), including "evidence capture failed";
 * - `cost`: a role's quality per token or cost per task worse than its baseline;
 * - `security`: an OSV or scanner finding in VTC's own dependencies (with a dependency-bump PR);
 * - `new_agent`, `tool`, `config`, `capability`: the improvement kinds of D-cd;
 * - `parked`, `ci_failure`, `escaped_defect`, `finding`, `final_review`: problems VTC finds in the
 *   app it builds (a parked task it cannot resolve, a post-merge CI failure, a revert or Lookback
 *   escaped defect, an out-of-scope security or quality finding, a Final Review leftover).
 */
export const UPSTREAM_AUTO_KINDS = [
  "lookback",
  "defect",
  "cost",
  "security",
  "new_agent",
  "tool",
  "config",
  "capability",
] as const;
export const PROJECT_AUTO_KINDS = [
  "parked",
  "ci_failure",
  "escaped_defect",
  "finding",
  "final_review",
] as const;
export const AutoKindSchema = z.enum([...UPSTREAM_AUTO_KINDS, ...PROJECT_AUTO_KINDS]);
export type AutoKind = z.infer<typeof AutoKindSchema>;

/** Where an automatic issue or PR goes: VTC's own repo, or the project the run belongs to. */
export const AutoTargetKindSchema = z.enum(["upstream", "project"]);
export type AutoTargetKind = z.infer<typeof AutoTargetKindSchema>;

/** Which kinds each target takes (D-bv). A kind outside its target's list is never raised. */
export const AUTO_KINDS_BY_TARGET: Readonly<Record<AutoTargetKind, readonly AutoKind[]>> = {
  upstream: UPSTREAM_AUTO_KINDS,
  project: PROJECT_AUTO_KINDS,
};

/** `owner/name` of a GitHub repo; neither part may start with a dot. */
export const GitHubRepoSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9_-][A-Za-z0-9_.-]{0,99}$/,
    "expected owner/name, neither starting with a dot",
  );
export type GitHubRepo = z.infer<typeof GitHubRepoSchema>;

/** The default upstream repo (D-bz, H-6): a user-level setting with this built-in default. */
export const DEFAULT_UPSTREAM_REPO = "bason-labs/bs-vtc";

/** A target as events and the Automation view name it. */
export const AutoTargetRefSchema = z.strictObject({
  kind: AutoTargetKindSchema,
  repo: GitHubRepoSchema,
});
export type AutoTargetRef = z.infer<typeof AutoTargetRefSchema>;

// ------------------------------------------------------------------ identity

/**
 * A finding's stable identity across occurrences (D-bx): the first 16 hex characters of a SHA-256
 * over the kind's stable fields (the upstream module defines them per kind; never a line number,
 * an absolute path or a version).
 */
export const AutoFingerprintSchema = z.string().regex(/^[a-f0-9]{16}$/, "expected 16 hex");
export type AutoFingerprint = z.infer<typeof AutoFingerprintSchema>;

/** Branch prefix of every automatic PR (D-bw). Nothing is ever pushed to a default branch. */
export const AUTO_BRANCH_PREFIX = "vtc/auto/";

/** The orphan branch that holds PR media when evidence hosting is `branch` (D-ce). */
export const EVIDENCE_BRANCH = "vtc-evidence";

/** Pure: `vtc/auto/<kind>/<fingerprint8>` (D-bw). */
export const autoBranchName = (kind: AutoKind, fingerprint: AutoFingerprint): string => {
  AutoKindSchema.parse(kind);
  AutoFingerprintSchema.parse(fingerprint);
  return `${AUTO_BRANCH_PREFIX}${kind}/${fingerprint.slice(0, 8)}`;
};

/**
 * Pure: whether VTC may push to remote ref `ref` (`refs/heads/...`). Only an automatic branch
 * (`refs/heads/vtc/auto/<kind>/<fp8>`) or, in `branch` evidence hosting, `refs/heads/vtc-evidence`.
 * The pushing code also compares the repo's default branch and never force-pushes (AD-27 rule 1).
 */
export const autoPushRefAllowed = (ref: string): boolean => {
  if (ref === `refs/heads/${EVIDENCE_BRANCH}`) return true;
  const match = /^refs\/heads\/vtc\/auto\/([a-z_]+)\/([a-f0-9]{8})$/.exec(ref);
  return match !== null && AutoKindSchema.safeParse(match[1]).success;
};

/**
 * The hidden marker every automatic issue and PR body starts with (AD-27 rule 3). Dedupe matches
 * it in a label listing, never through GitHub search (whose index lags).
 */
export interface AutoMarker {
  readonly v: 1;
  readonly kind: AutoKind;
  readonly fp: AutoFingerprint;
  /** The Lookback or cost target role, when the kind has one. */
  readonly role?: string;
}

/** The hidden marker of every comment VTC writes; a comment without it is human activity. */
export const AUTO_COMMENT_MARKER = "<!-- vtc:comment -->";

/**
 * The hidden marker of the comment VTC's quiet sweep closes an issue with (beside
 * {@link AUTO_COMMENT_MARKER}), so every installation can tell VTC's quiet close (reopen when the
 * fingerprint recurs) from a human's not-planned close (never raised again), AD-27 rule 4. New in
 * 5.1.0 (it was the upstream module's own constant).
 */
export const QUIET_CLOSE_MARKER = "<!-- vtc:quiet-close -->";

/** Pure: `<!-- vtc:auto v=1 kind=<kind> fp=<fp>[ role=<role>] -->`. */
export const renderAutoMarker = (marker: AutoMarker): string => {
  AutoKindSchema.parse(marker.kind);
  AutoFingerprintSchema.parse(marker.fp);
  if (marker.role !== undefined) RoleIdSchema.parse(marker.role);
  return `<!-- vtc:auto v=1 kind=${marker.kind} fp=${marker.fp}${marker.role === undefined ? "" : ` role=${marker.role}`} -->`;
};

/** Pure: the first well-formed marker in `body`, or `null`. */
export const parseAutoMarker = (body: string): AutoMarker | null => {
  const match =
    /<!-- vtc:auto v=1 kind=([a-z_]+) fp=([a-f0-9]{16})(?: role=([a-z][a-z0-9_-]{0,47}))? -->/.exec(
      body,
    );
  if (match === null) return null;
  const kind = AutoKindSchema.safeParse(match[1]);
  if (!kind.success) return null;
  const fp = match[2] ?? "";
  return match[3] === undefined
    ? { v: 1, kind: kind.data, fp }
    : { v: 1, kind: kind.data, fp, role: match[3] };
};

// -------------------------------------------------------------------- labels

/**
 * Labels (D-bx, D-cd, D-cc, D-ce). VTC creates the missing ones idempotently. `muted` and `keep`
 * are set by humans: a muted fingerprint is never raised again, a kept issue is never auto-closed.
 */
export const AUTO_LABELS = {
  auto: "vtc:auto",
  regression: "vtc:regression",
  muted: "vtc:muted",
  keep: "vtc:keep",
  security: "vtc:security",
  evidencePartial: "evidence: partial",
  needsEval: "needs-eval",
  test: "vtc:test",
  /**
   * An automatic issue VTC will work on itself (`fixableItem`): its run starts once the issue
   * opens, and an upstream one waits for the bs-vtc checkout's engine, which picks up every open
   * `vtc:fixable` issue no run has worked on (D-bv (2), D-cd). New in 5.3.0.
   */
  fixable: "vtc:fixable",
} as const;

/** Pure: the kind label every automatic issue and PR carries beside `vtc:auto` (D-bx). */
export const autoKindLabel = (kind: AutoKind): string => `vtc:kind/${AutoKindSchema.parse(kind)}`;

// -------------------------------------------------------------------- limits

/**
 * Noise control (D-bx, plus the pacing of spine §5 reading 208). Counted per target repo from the
 * remote listing (the local ledger is a cache).
 */
export const AUTOMATION_LIMITS = {
  /** New issues per repo per UTC day (the evidence-capture-failed issue counts). */
  newIssuesPerDay: 5,
  /** Open automatic PRs per repo per kind. */
  openPrsPerKind: 3,
  /** Open Lookback PRs per repo per role. */
  openLookbackPrsPerRole: 1,
  /** An open issue whose fingerprint has not recurred this long is closed with a comment. */
  autoCloseQuietDays: 14,
  /** At most one comment per issue in this window, and only on a material change. */
  commentIntervalHours: 24,
  /** Mutating `gh` calls per repo per hour (GitHub's secondary limits are far higher). */
  mutatingCallsPerHour: 30,
  /** Minimum gap between two mutating `gh` calls to one repo, in milliseconds. */
  minWriteIntervalMs: 1000,
  /** GitHub refuses bodies over 65,536 characters; VTC truncates below this. */
  maxBodyChars: 60_000,
} as const;

// ---------------------------------------------------------------- privacy

/**
 * One VTC stack frame as an upstream report may carry it (D-by): `<package>/<relative file>:<function>`,
 * with no line or column, no absolute path and no project frame.
 */
export const VtcFrameSchema = z
  .string()
  .max(300)
  .regex(
    /^(shared|engine|adapters|compiler|cli|dashboard)\/(?!.*\.\.)[a-z0-9_./-]+:[A-Za-z0-9_$.<>-]{1,120}$/,
    "expected <package>/<file>:<function>",
  );

/** A metric name in an upstream report (`scorecard.pass_rate`, `tokens.per_task`, …). */
export const UpstreamMetricNameSchema = z.string().regex(/^[a-z][a-z0-9_.]{0,63}$/);

/**
 * Everything VTC may send to the upstream repo about one finding (D-by): VTC-side data only. The
 * upstream module builds it with an allowlist projection, never by deleting fields from a richer
 * object; the issue and PR bodies, the CHANGELOG entry and the evidence for an upstream target are
 * rendered from it alone. It holds no project code, file path, repo, client or user name, no task
 * or feature title and no prompt filled with project content; every string still passes the
 * shared redaction and the project-identifier denylist before it is sent (AD-27 rule 5).
 */
export const UpstreamReportSchema = z.strictObject({
  v: z.literal(1),
  kind: z.enum(UPSTREAM_AUTO_KINDS),
  fingerprint: AutoFingerprintSchema,
  /** The VTC release that saw it. */
  vtc_version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
  role: RoleIdSchema.optional(),
  mode: SlugSchema.optional(),
  host: HostIdSchema.optional(),
  /**
   * The model id the host reported (no account or project data): a public model id, or `custom`
   * for any other (the upstream module maps an inference-profile ARN, a deployment path or a
   * gateway alias to `custom`, D-by). Never an ARN, and never a run of 12 digits (an AWS account
   * id). Narrowed in 5.2.0.
   */
  model: z
    .string()
    .regex(/^(?![Aa][Rr][Nn]:)(?!.*\d{12})[A-Za-z0-9][A-Za-z0-9._:/@-]{0,199}$/)
    .optional(),
  /** `effective_sha256` of the prompt version involved. */
  prompt_sha: Sha256HexSchema.optional(),
  /** An error class, e.g. `adapter.parse_failure`, `incident.gate_infra`, `engine.stuck_loop`. */
  error_class: z
    .string()
    .regex(/^[a-z][a-z0-9_.]{0,79}$/)
    .optional(),
  vtc_frames: z.array(VtcFrameSchema).max(3).default([]),
  /** Numbers only: scorecard deltas, replay stats, the A/A flip rate, tokens, cost. */
  metrics: z.record(UpstreamMetricNameSchema, z.number()).default({}),
  occurrences: z.int().positive(),
  first_seen: IsoDateTimeSchema,
  last_seen: IsoDateTimeSchema,
  /** For an OSV or scanner finding: the advisory id and package name (never the lock file). */
  advisory: z
    .strictObject({
      id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/),
      package: z.string().regex(/^(@[a-z0-9._-]+\/)?[a-z0-9._-]{1,214}$/),
    })
    .optional(),
});
export type UpstreamReport = z.infer<typeof UpstreamReportSchema>;
export type UpstreamReportInput = z.input<typeof UpstreamReportSchema>;

// ---------------------------------------------------------------- evidence

/**
 * Where PR media live (D-ce; spine §5 reading 196). `branch`: committed to the orphan
 * {@link EVIDENCE_BRANCH} and embedded by commit-pinned URL (D-ce's default). `attach`: uploaded
 * with `gh … --attach` (gh ≥ {@link GH_ATTACH_MIN_VERSION}, github.com only), which the round-4
 * research recommends as the primary path; the Lead decides (spine §5 reading 196).
 */
export const EvidenceHostingSchema = z.enum(["branch", "attach"]);
export type EvidenceHosting = z.infer<typeof EvidenceHostingSchema>;
export const EVIDENCE_HOSTING_DEFAULT: EvidenceHosting = "branch";
/**
 * The hosting VTC asks for when the user set none (D-cc's live check, spine §5 reading 225): `gh
 * --attach` is confirmed as the primary evidence path, so an unset `automation.evidence_hosting`
 * requests `attach`; the cli's resolution falls back to {@link EVIDENCE_HOSTING_DEFAULT} when gh is
 * older than {@link GH_ATTACH_MIN_VERSION} or the remote is not github.com. New in 5.4.0.
 */
export const EVIDENCE_HOSTING_PREFERRED: EvidenceHosting = "attach";
/** The first gh release with `--attach` on `pr|issue create|edit|comment` (2026-09-01). */
export const GH_ATTACH_MIN_VERSION = "2.99.0";

/**
 * Evidence budget per PR (D-ce): bytes and files uploaded or committed for one PR, and the per-file
 * caps that keep a PR inside them.
 */
export const EVIDENCE_LIMITS = {
  maxBytesPerPr: 10 * 1024 * 1024,
  maxFilesPerPr: 12,
  maxVideoBytes: 8 * 1024 * 1024,
  maxGifBytes: 5 * 1024 * 1024,
  maxPngBytes: 1.5 * 1024 * 1024,
  /** Dashboard replay recordings stay within this. */
  maxReplaySeconds: 30,
  /** A changed-flow recording stays within this. */
  maxFlowSeconds: 20,
  /** Capture is retried once; a second failure raises "evidence capture failed" (D-ce). */
  captureAttempts: 2,
} as const;

/**
 * What one evidence file shows (D-ce): the dashboard replay of the producing run (video, its GIF),
 * key screenshots, UI before/after at the Visual QA viewports and a changed-flow video, scorecard
 * and replay charts, and the gate report and test results.
 */
export const EvidenceFileKindSchema = z.enum([
  "replay_video",
  "replay_gif",
  "screenshot",
  "ui_before",
  "ui_after",
  "flow_video",
  "chart",
  "gate_report",
]);
export type EvidenceFileKind = z.infer<typeof EvidenceFileKindSchema>;

/** An evidence file name: neutral, relative, `NN-<slug>.<ext>`; never a user path. */
export const EvidenceFileNameSchema = z
  .string()
  .regex(/^\d{2}-[a-z0-9-]{1,60}\.(png|gif|webm|mp4)$/, "expected NN-<slug>.<png|gif|webm|mp4>");

/**
 * Why a PR's evidence is `partial` (D-ct; spine §5 reading 223): the base commit did not build or
 * serve in the gate sandbox, so there is no "before"; the project has no `visual.app` to render;
 * no doctor-installed browser; video turned off (`automation.evidence.video: false`) or no
 * ffmpeg under `branch` hosting; or a capture failed past its retry. New in 5.4.0.
 */
export const EvidencePartialReasonSchema = z.enum([
  "base_build_failed",
  "base_serve_failed",
  "no_visual_app",
  "no_browser",
  "video_off",
  "no_ffmpeg",
  "capture_failed",
]);
export type EvidencePartialReason = z.infer<typeof EvidencePartialReasonSchema>;

/**
 * `manifest.json` of one PR's evidence (D-ce): every file with its hash, size and redaction verdict,
 * and the URL it was published under. `complete` is false when a kind D-ce asks for is missing
 * (no ffmpeg in `branch` hosting: the WebM link and screenshots only), which labels the PR
 * `evidence: partial`. A PR with no file is never opened.
 */
export const EvidenceManifestSchema = z.strictObject({
  v: z.literal(1),
  kind: AutoKindSchema,
  fingerprint: AutoFingerprintSchema,
  hosting: EvidenceHostingSchema,
  files: z
    .array(
      z.strictObject({
        name: EvidenceFileNameSchema,
        kind: EvidenceFileKindSchema,
        bytes: z.int().positive().max(EVIDENCE_LIMITS.maxBytesPerPr),
        sha256: Sha256HexSchema,
        /** Every file passed the redaction scan before it left the machine (AD-27 rule 6). */
        redaction: z.literal("passed"),
        alt: z.string().min(1).max(200),
        url: z.url().max(1000).optional(),
      }),
    )
    .min(1)
    .max(EVIDENCE_LIMITS.maxFilesPerPr),
  complete: z.boolean(),
  /** Why `complete` is false, when the cause is known (D-ct). New in 5.4.0. */
  partial_reason: EvidencePartialReasonSchema.optional(),
  captured_at: IsoDateTimeSchema,
});
export type EvidenceManifest = z.infer<typeof EvidenceManifestSchema>;

// ------------------------------------------------------------- templates

/**
 * The PR, issue and CHANGELOG templates (roles-compiler writes them, the upstream module renders
 * them; D-bv, D-cd): Markdown with `{{slot}}` placeholders, shipped in each compiled plugin under
 * this directory (`AssetBundle` namespace `plugin:<host>`).
 */
export const AUTO_TEMPLATES_ASSET_DIR = "vtc/templates";
export const AUTO_TEMPLATE_NAMES = ["auto-pr", "auto-issue", "changelog-entry"] as const;
export type AutoTemplateName = (typeof AUTO_TEMPLATE_NAMES)[number];
/** Pure: the plugin asset path of one template. */
export const autoTemplateAssetPath = (name: AutoTemplateName): string =>
  `${AUTO_TEMPLATES_ASSET_DIR}/${name}.md`;

/**
 * The slots a template may use; the renderer fills each one (or "unavailable") and refuses a
 * template that names any other. Order in a PR body: marker, note, summary, why, changes,
 * evidence, verification, risk, provenance, checklist (spine §5 reading 208).
 *
 * What two slot values hold (5.1.0, spine §5 reading 212): `note` is the whole NOTE callout,
 * `> [!NOTE]` header included, and in a PR it says "For human review only: VTC never merges
 * automatic PRs." (D-bw); `provenance` is the whole `<details>` block, `<summary>` included.
 * Templates wrap neither. `diff` is a prompt PR's fenced diff, used by the CHANGELOG entry; a PR
 * body has no `diff` slot (the PR's own files and its CHANGELOG entry carry it, 5.5.0 doc). An
 * issue body ends with `checklist`. Every slot except `title`, `hypothesis` and `trace_ids` stands
 * on a line of its own.
 */
export const AUTO_TEMPLATE_SLOTS = [
  "marker",
  "note",
  "title",
  "summary",
  "why",
  "changes",
  "evidence",
  "verification",
  "risk",
  "provenance",
  "checklist",
  "hypothesis",
  "trace_ids",
  "diff",
  "evaluation",
] as const;
export type AutoTemplateSlot = (typeof AUTO_TEMPLATE_SLOTS)[number];

/** VTC's own CHANGELOG of role prompt changes, in the bs-vtc repo (D-bv). */
export const ROLES_CHANGELOG = "roles/CHANGELOG.md";

/**
 * The line of {@link ROLES_CHANGELOG} directly below which each new entry is inserted, newest
 * first, below the file's explanatory header. The compiler requires it exactly once, on its own
 * line. New in 5.1.0.
 */
export const ROLES_CHANGELOG_ANCHOR = "<!-- vtc:changelog-entries -->";

/**
 * The dashboard's evidence mode (AD-27 rule 6; spine §5 readings 208 and 212): the query
 * parameter the evidence recorder opens the dashboard with on the loopback snapshot server, and
 * its values. `full` (`?evidence=1`) shows a run's own replay, read-only; `upstream`
 * (`?evidence=upstream`) shows only the upstream-safe projection for a bs-vtc PR caused by a
 * project run. In both the dashboard reads the frozen read routes the snapshot server serves.
 * New in 5.1.0.
 */
export const EVIDENCE_MODE_PARAM = "evidence";
export const EVIDENCE_MODE_VALUES = { full: "1", upstream: "upstream" } as const;

// ------------------------------------------------------------------ events

/** Why an automatic action did not happen (`automation.skipped`, D-ca). */
export const AutomationSkipReasonSchema = z.enum([
  /** `vtc pause` (D-bz). */
  "paused",
  /** `automation.issues` / `automation.prs` is false. */
  "disabled",
  /** The project has no GitHub remote (automation is off with a visible note, D-bz). */
  "no_github_remote",
  /** `gh auth status` failed, or `gh` is missing. */
  "gh_unavailable",
  /** `upstream.share: false` in the project, or upstream reporting off for the user (D-by). */
  "share_off",
  /** An upstream PR needs a local bs-vtc checkout (`upstream.checkout`) and there is none. */
  "no_upstream_checkout",
  /** A D-bx cap: the daily issue cap, open PRs per kind, or one Lookback PR per role. */
  "rate_limit",
  /** GitHub's secondary rate limit, after the backoff. */
  "github_rate_limit",
  /** An open issue already has the fingerprint and was commented on within the interval. */
  "duplicate",
  /** A human closed the fingerprint as not planned, or labelled it `vtc:muted`. */
  "muted",
  /** The privacy allowlist, redaction or the project-identifier denylist refused the content. */
  "privacy",
  /** Evidence capture failed twice; the PR is not opened (D-ce). */
  "evidence_failed",
  /** Replay trials (D-cg): the Lead host's weekly window is below the Lookback floor. */
  "weekly_window",
  /** Replay trials (D-cg): the Lookback budget is spent. */
  "budget",
  /** Replay trials (D-cg): the per-RETRO trial cap is reached; the rest wait for the next RETRO. */
  "trial_cap",
  /** A replay arm's plugin did not load (a managed-settings lock shadowed it, spine §5 reading 201). */
  "plugin_locked",
  /**
   * A Lookback PR's replay measured another prompt than the one on the upstream repo's default
   * branch (an older VTC release, or a later merged change of the role): its diff would revert
   * that change, so it is not opened. New in 5.2.0.
   */
  "stale_baseline",
  /**
   * An automatic action failed for a reason none of the above names (a `gh` or git error, a
   * crash in the module); `detail` is the redacted message. New in 5.4.0.
   */
  "error",
  /**
   * An automatic PR changes files its kind may not change, or the plumbing cannot list them: a
   * routing-table PR (D-cn) changes only `packages/shared/src/tier-routing.ts` (spine §5 readings
   * 219 and 228(6)). It is refused before it opens (AD-8); `detail` names the other paths. New in
   * 5.6.0.
   */
  "out_of_scope",
]);
export type AutomationSkipReason = z.infer<typeof AutomationSkipReasonSchema>;

const IssueOrPrSchema = z.strictObject({
  target: AutoTargetRefSchema,
  kind: AutoKindSchema,
  fingerprint: AutoFingerprintSchema,
  number: z.int().positive(),
  url: z.url().max(500),
});

/** Payloads of the automation events (D-ca); `EVENT_PAYLOAD_SCHEMAS` registers them. */
export const UPSTREAM_EVENT_PAYLOAD_SCHEMAS = {
  /** VTC opened an issue. */
  "upstream.issue_opened": IssueOrPrSchema.extend({
    /** `Regression of #N`: a closed-as-completed fingerprint came back. */
    regression_of: z.int().positive().optional(),
  }),
  /** VTC commented on, reopened or refreshed the occurrence table of its own open issue. */
  "upstream.issue_updated": IssueOrPrSchema.extend({
    action: z.enum(["commented", "reopened", "edited"]),
  }),
  /** VTC closed its own issue (`quiet`: the 14-day auto-close; `completed`: its fix PR merged). */
  "upstream.issue_closed": IssueOrPrSchema.extend({
    reason: z.enum(["quiet", "completed"]),
  }),
  /** VTC opened a draft PR on `vtc/auto/<kind>/<fp8>`; it marks it ready once evidence is complete. */
  "upstream.pr_opened": IssueOrPrSchema.extend({
    branch: z.string().regex(/^vtc\/auto\/[a-z_]+\/[a-f0-9]{8}$/),
    issue: z.int().positive().optional(),
    evidence: z.enum(["complete", "partial"]),
    /** Why the evidence is partial, when it is and the cause is known (D-ct). New in 5.4.0. */
    partial_reason: EvidencePartialReasonSchema.optional(),
  }),
  /** VTC closed its own PR (a newer proposal superseded it, its issue closed, or it went stale). */
  "upstream.pr_closed": IssueOrPrSchema.extend({
    reason: z.enum(["superseded", "issue_closed", "stale"]),
  }),
  /** An automatic action that did not happen, and why (D-ca). */
  "automation.skipped": z.strictObject({
    reason: AutomationSkipReasonSchema,
    target: AutoTargetRefSchema.optional(),
    kind: AutoKindSchema.optional(),
    fingerprint: AutoFingerprintSchema.optional(),
    detail: z.string().min(1).max(500),
  }),
} as const;

// -------------------------------------------------------------- read model

/** One automatic issue or PR as the Automation view lists it (D-ca). */
export const AutomationItemSchema = z.strictObject({
  target: AutoTargetRefSchema,
  kind: AutoKindSchema,
  fingerprint: AutoFingerprintSchema,
  issue: z
    .strictObject({
      number: z.int().positive(),
      url: z.url().max(500),
      state: z.enum(["open", "closed"]),
    })
    .nullable(),
  pr: z
    .strictObject({
      number: z.int().positive(),
      url: z.url().max(500),
      state: z.enum(["draft", "open", "closed", "merged"]),
      evidence: z.enum(["complete", "partial"]),
      /**
       * Why the evidence is partial, when it is and the cause is known (D-ct), from the PR's
       * `upstream.pr_opened`. New in 5.5.0.
       */
      partial_reason: EvidencePartialReasonSchema.optional(),
    })
    .nullable(),
  first_at: IsoDateTimeSchema,
  last_at: IsoDateTimeSchema,
});
export type AutomationItem = z.infer<typeof AutomationItemSchema>;

/**
 * `GET /api/automation` (D-ca): whether automation is on for this project and why not, what VTC
 * opened (from the `upstream.*` events of every run of the repo), and the latest skips.
 */
export const AutomationReportSchema = z.strictObject({
  issues: z.boolean(),
  prs: z.boolean(),
  /** Upstream reporting to {@link DEFAULT_UPSTREAM_REPO} (or the user's `upstream.repo`). */
  upstream: z.boolean(),
  upstream_repo: GitHubRepoSchema,
  /**
   * The hosting the daemon resolved (`AutomationDeps.hosting`: `attach` unless gh is older than
   * 2.99.0 or the remote is not github.com, reading 225), not the raw setting (5.5.0 doc).
   */
  evidence_hosting: EvidenceHostingSchema,
  /** Visible notes: no GitHub remote, gh logged out, paused, sharing off, no ffmpeg. */
  notes: z.array(z.string().min(1).max(300)).max(20),
  items: z.array(AutomationItemSchema).max(500),
  skipped: z
    .array(
      z.strictObject({
        at: IsoDateTimeSchema,
        reason: AutomationSkipReasonSchema,
        kind: AutoKindSchema.optional(),
        detail: z.string().min(1).max(500),
      }),
    )
    .max(200),
});
export type AutomationReport = z.infer<typeof AutomationReportSchema>;

/**
 * The marker an automatic run carries (`run.started.automation`, D-cd): the issue it works on.
 * Such a run skips G1 and G2 (the issue is the spec, the Spec Verifier checks the PR against it),
 * keeps every gate, review and risk rule, and never runs at merge Level 3 (D-bw,
 * `effectiveMergeLevel`'s `automatic`).
 */
export const AutomationRunRefSchema = z.strictObject({
  kind: AutoKindSchema,
  fingerprint: AutoFingerprintSchema,
  target: AutoTargetRefSchema,
  issue: z.int().positive(),
});
export type AutomationRunRef = z.infer<typeof AutomationRunRefSchema>;

/**
 * Seams of automatic issues and PRs (spine AD-27; D-bu, D-bw, D-ce). New in contracts 5.0.0.
 *
 * - {@link IssueService} and {@link AutoPullRequestService}: GitHub through the user's own `gh`
 *   login. The upstream team implements both in `@vtc/engine` (`upstream/`) with an injectable
 *   command, like `createGhPullRequests`; tests inject fakes and never run the real `gh` (D-cc).
 * - {@link GitPlumbing}: the local git plumbing the orphan evidence branch and the automatic
 *   branches are written through, with no checkout and no work-tree change. Engine core implements
 *   it in `git/` (AD-13 rule 4: git code stays there); the upstream module builds the writers on it.
 * - {@link EvidenceRecorder}: Playwright capture in the gate sandbox with the pinned visual
 *   toolchain (AD-24), implemented by the gate-runner team in `gates/`; the upstream module
 *   orchestrates what to capture.
 * - {@link AutomationDeps}: what the cli injects (`EngineDeps.automation`).
 *
 * Every implementation: never reads a token, sets `GH_PROMPT_DISABLED=1`, passes bodies with
 * `--body-file`, refuses `GH_FORBIDDEN_ARGS`, merges, auto-merge, force pushes, repo-setting
 * changes and any push outside `autoPushRefAllowed` (AD-27 rule 1).
 */
import type { GateReport } from "../gate-result.js";
import type { GitSha, RelPath } from "../primitives.js";
import type {
  AutoFingerprint,
  AutoKind,
  AutoMarker,
  EvidenceFileKind,
  EvidenceHosting,
  GitHubRepo,
} from "../upstream.js";

/** One file to attach or embed, by its neutral name inside the per-action staging directory. */
export interface EvidenceAttachment {
  /** `NN-<slug>.<ext>` (`EvidenceFileNameSchema`), relative to `stagingDir`. */
  readonly name: string;
  readonly alt: string;
}

/** An issue as VTC reads it back from a label listing (`gh issue list --label vtc:auto`). */
export interface AutoIssueRef {
  readonly number: number;
  readonly url: string;
  readonly state: "open" | "closed";
  readonly stateReason: "completed" | "not_planned" | "reopened" | null;
  readonly labels: readonly string[];
  readonly marker: AutoMarker | null;
  readonly updatedAt: string;
  /** A comment without `AUTO_COMMENT_MARKER` exists (VTC posts as the user, so not by author). */
  readonly humanActivity: boolean;
  /**
   * When the issue was opened (`gh --json createdAt`), so the daily cap counts from the remote
   * listing (reading 208). Absent from a service that does not report it: the ledger decides.
   * New in 5.1.0.
   */
  readonly createdAt?: string;
  /**
   * VTC's quiet sweep closed it: closed as not planned, right after a comment carrying
   * `QUIET_CLOSE_MARKER`. Absent from a service that does not report it. New in 5.1.0.
   */
  readonly closedQuietByVtc?: boolean;
}

export interface AutoIssueRequest {
  readonly title: string;
  /** Absolute staging directory holding `body.md` and the attachments; `gh` runs with it as cwd. */
  readonly stagingDir: string;
  /** The body file, relative to `stagingDir` (always `--body-file`, never `--body`). */
  readonly bodyFile: string;
  readonly labels: readonly string[];
  readonly attach?: readonly EvidenceAttachment[];
}

/** GitHub issues for one repo (D-bu). Every write is queued serially per repo (AD-27 rule 1). */
export interface IssueService {
  /** `gh label create … --force` for each missing label (idempotent). */
  ensureLabels(repo: GitHubRepo, labels: readonly string[]): Promise<void>;
  /** Every `vtc:auto` issue, open and closed, from the issues API (never search). */
  listAutomatic(repo: GitHubRepo): Promise<readonly AutoIssueRef[]>;
  create(repo: GitHubRepo, request: AutoIssueRequest): Promise<AutoIssueRef>;
  /** Replaces the body (the occurrence table) through `--body-file`. */
  editBody(repo: GitHubRepo, number: number, request: AutoIssueRequest): Promise<void>;
  /** A comment that carries `AUTO_COMMENT_MARKER`. */
  comment(repo: GitHubRepo, number: number, request: AutoIssueRequest): Promise<void>;
  reopen(repo: GitHubRepo, number: number, comment: string): Promise<void>;
  close(
    repo: GitHubRepo,
    number: number,
    reason: "completed" | "not_planned",
    comment: string,
  ): Promise<void>;
}

/** An automatic PR as VTC reads it back. */
export interface AutoPrRef {
  readonly number: number;
  readonly url: string;
  readonly headRefName: string;
  readonly headSha: string;
  readonly isDraft: boolean;
  readonly state: "open" | "closed" | "merged";
  readonly labels: readonly string[];
  readonly marker: AutoMarker | null;
}

export interface AutoPrRequest extends AutoIssueRequest {
  readonly kind: AutoKind;
  readonly fingerprint: AutoFingerprint;
  /** `autoBranchName(kind, fingerprint)`, already pushed through {@link GitPlumbing.push}. */
  readonly branch: string;
  /** The repo's default branch (`gh repo view --json defaultBranchRef`). */
  readonly base: string;
}

/**
 * Automatic PRs for one repo (D-bw): always opened as draft, marked ready only once evidence and
 * the Spec-Verifier verdict are complete, never merged, never auto-merged, never self-reviewed.
 */
export interface AutoPullRequestService {
  listOpenAutomatic(repo: GitHubRepo): Promise<readonly AutoPrRef[]>;
  openDraft(repo: GitHubRepo, request: AutoPrRequest): Promise<AutoPrRef>;
  editBody(repo: GitHubRepo, number: number, request: AutoIssueRequest): Promise<AutoPrRef>;
  markReady(repo: GitHubRepo, number: number): Promise<AutoPrRef>;
  /**
   * Closes with a comment. Deletes the branch only when its remote head is still `deleteIfHead`
   * (the last commit VTC pushed), so a human's commits are never deleted.
   */
  close(repo: GitHubRepo, number: number, comment: string, deleteIfHead?: string): Promise<void>;
}

/** One file of a plumbing commit: new bytes, or `null` to delete the path. */
export interface PlumbingChange {
  readonly path: RelPath;
  readonly bytes: Uint8Array | null;
}

/**
 * Local git plumbing for one repo directory (engine core's `git.createGitPlumbing`). It writes
 * objects and refs only: no checkout, no work-tree or index change (a temporary index), the
 * user's own git and credentials, no signing override, never `--force`.
 */
export interface GitPlumbing {
  /** The commit `ref` names locally, or `null`. */
  resolve(ref: string): Promise<GitSha | null>;
  /**
   * A new commit whose tree is `base`'s tree with `changes` applied (`base` null: an empty tree,
   * for the orphan evidence branch), with `parents` and `message`; returns its id.
   */
  commit(request: {
    readonly base: GitSha | null;
    readonly parents: readonly GitSha[];
    readonly changes: readonly PlumbingChange[];
    readonly message: string;
  }): Promise<GitSha>;
  /** `git update-ref <ref> <sha> <expected>`; fails when the ref moved (`expected` null = new). */
  updateRef(ref: string, sha: GitSha, expected: GitSha | null): Promise<void>;
  /**
   * `git push <remote> <sha>:<dst>` without force. Refuses a `dst` that `autoPushRefAllowed`
   * rejects or that names the default branch.
   */
  push(remote: string, sha: GitSha, dst: string): Promise<void>;
}

/** Engine core implements it as `git.createGitPlumbing`. */
export type CreateGitPlumbing = (deps: { readonly repoRoot: string }) => GitPlumbing;

/** One thing to capture from a loopback page (the evidence snapshot server, AD-27 rule 6). */
export interface EvidenceShot {
  /** The output file name (`EvidenceFileNameSchema`). */
  readonly name: string;
  readonly kind: EvidenceFileKind;
  /** Path and query on the capture origin, e.g. `/runs/R1?evidence=upstream#replay`. */
  readonly path: string;
  readonly viewport: { readonly width: number; readonly height: number };
  /** Video: record this long at most; absent = a screenshot. */
  readonly videoSeconds?: number;
  /** A selector that must be visible before capture starts. */
  readonly waitFor?: string;
}

export interface EvidenceCaptureRequest {
  /** `http://127.0.0.1:<port>`: the only origin the browser may reach; every other request aborts. */
  readonly origin: string;
  /** Absolute output directory (the per-action staging directory). */
  readonly outDir: string;
  readonly shots: readonly EvidenceShot[];
  /** Painted as solid blocks before any frame (video too) and masked on screenshots. */
  readonly redactSelectors: readonly string[];
  /**
   * Values that must not be visible: known secret values and, for an upstream target, the
   * project-identifier denylist. A visible hit discards the file (never the matched text in
   * any report).
   */
  readonly denyText: readonly string[];
}

export interface EvidenceCaptureResult {
  readonly files: readonly {
    readonly name: string;
    readonly kind: EvidenceFileKind;
    readonly bytes: number;
  }[];
  /** Shots that failed or were discarded by the redaction scan, with a reason that holds no matched text. */
  readonly failed: readonly { readonly name: string; readonly reason: string }[];
}

/**
 * Evidence capture (D-ce), implemented by the gate-runner team over the visual toolchain and the
 * gate sandbox (AD-24); nothing is downloaded at capture time.
 */
export interface EvidenceRecorder {
  capture(request: EvidenceCaptureRequest): Promise<EvidenceCaptureResult>;
  /**
   * Renders a gate report and its test results to self-contained HTML in `outDir` (the non-UI
   * evidence of D-ce) and returns its file name, for `capture` to screenshot.
   */
  renderGateReport(request: {
    readonly report: GateReport;
    readonly outDir: string;
  }): Promise<{ readonly html: string }>;
}

/**
 * What the cli hands the daemon for automation (`EngineDeps.automation`). Absent: automation is
 * off with a visible note. The cli reads the user settings from `~/.vtc/config.yaml`; the project
 * settings come from `project.yaml` at the run's commit.
 */
export interface AutomationDeps {
  /** Default: the upstream module's `gh`-backed services. */
  readonly issues?: IssueService;
  readonly pullRequests?: AutoPullRequestService;
  /** Absent: no capture is possible, so no automatic PR opens (issues still do). */
  readonly evidence?: EvidenceRecorder;
  readonly plumbing?: CreateGitPlumbing;
  /**
   * `~/.vtc/config.yaml` `upstream` (D-bz, D-by). The cli supplies live getters for `repo`,
   * `share` and `checkout`: consumers read each field at each use and never spread, clone or parse
   * the object once, so a `share: false` set between queueing and sending an item still stops it
   * (AD-27 rule 5).
   */
  readonly upstream: {
    readonly repo: GitHubRepo;
    /** The user-level switch for all projects; default true. */
    readonly share: boolean;
    /** Absolute path of a local bs-vtc clone set up for VTC, for upstream PRs; absent: issues only. */
    readonly checkout?: string;
  };
  /**
   * Resolved by the cli when the daemon starts (`gh --version` and the remote host); the user's
   * `automation.evidence_hosting` is read live.
   */
  readonly hosting: EvidenceHosting;
  /** ffmpeg is on PATH (GIF previews; without it, `branch` hosting marks evidence partial). */
  readonly ffmpeg: boolean;
}

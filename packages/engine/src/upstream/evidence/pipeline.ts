/**
 * One PR's evidence, end to end (D-ce, H-8; AD-27 rule 6): render the gate report when the change
 * is not a UI one, serve a redacted snapshot on the loopback, capture the planned shots through the
 * injected `EvidenceRecorder` (retrying failed shots once), add the visual gate's before/after
 * screenshots, or, for an automatic run's UI PR, have the gate runner render the base and the head
 * (`EvidenceRecorder.captureBeforeAfter`, D-ct), make a GIF when ffmpeg is present, apply the
 * budget, publish (`branch` or `attach`), and write the manifest. A partial set says why
 * (`EvidencePartialReason`) when the cause is known. No file at all, a gate report that does not render, or an
 * evidence branch that cannot be pushed (each tried twice; each push attempt fetches the shared
 * branch and rebuilds first) fails the step and no PR opens. A capture failure makes the caller
 * raise "evidence capture failed"; a refused push (`pushRefused`) does not, since another
 * installation pushing the shared branch is not a VTC defect. The opt-outs are checked again
 * right before the evidence branch is pushed (`beforePublish`).
 */
import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, isAbsolute } from "node:path";
import {
  redactSecrets,
  EVIDENCE_LIMITS,
  EvidenceFileNameSchema,
  type AssetBundle,
  type AutoFingerprint,
  type AutoKind,
  type EvidenceAttachment,
  type EvidenceFileKind,
  type EvidenceHosting,
  type EvidenceManifest,
  type EvidencePartialReason,
  type EvidenceRecorder,
  type EvidenceShot,
  type GateReport,
  type GitHubRepo,
  type GitPlumbing,
  type GitSha,
} from "@vtc/shared";
import type { RemoteRefs } from "../remote-refs.js";
import { createExclusive, ensureDirNoFollow, readRegularFileNoFollow } from "../safe-fs.js";
import { isAutomationSkip } from "../skip.js";
import { makeGif, type FfmpegCommand } from "./gif.js";
import {
  attachmentsFor,
  publishToEvidenceBranch,
  renderEvidenceSection,
  type MissingEvidence,
} from "./hosting.js";
import {
  applyEvidenceBudget,
  buildManifest,
  evidenceComplete,
  writeManifest,
  type EvidenceFile,
} from "./manifest.js";
import {
  BASE_REDACT_SELECTORS,
  GATE_REPORT_PAGE,
  planEvidenceShots,
  requiredEvidenceKinds,
  type EvidencePlanInput,
} from "./plan.js";
import { replayIntervalMs, startSnapshotServer } from "./snapshot-server.js";

const ALT: Readonly<Record<EvidenceFileKind, string>> = {
  replay_video: "Flow Studio replay of the run that produced this PR",
  replay_gif: "Replay preview",
  screenshot: "Final state in Flow Studio",
  ui_before: "Before",
  ui_after: "After",
  flow_video: "The changed flow",
  chart: "Scorecard and replay chart",
  gate_report: "Gate report and test results",
};

/**
 * The caption of a before/after `flow_video` (D-ct): `BeforeAfterRequest` names no flow steps yet,
 * so the gate runner records each side's first rendered screen loading and then left idle (its
 * known limit, spine §5 reading 233). The caption says so, never "the changed flow", until a run
 * can name its changed flow (`BeforeAfterRequest.flow`, a question to the human).
 */
export const BEFORE_AFTER_FLOW_ALT =
  "First rendered screen, loading then idle (no changed-flow steps are recorded yet)";

export interface EvidenceRequest {
  readonly kind: AutoKind;
  readonly fingerprint: AutoFingerprint;
  /** Where the manifest is kept. */
  readonly keep:
    | { readonly kind: "upstream"; readonly vtcHome: string }
    | { readonly kind: "project"; readonly repoRoot: string };
  /** The repo the PR goes to (the evidence branch's URLs name it). */
  readonly repo: GitHubRepo;
  readonly plan: EvidencePlanInput;
  /** The snapshot the browser sees: read routes and the run's events (upstream: the projection). */
  readonly snapshot: {
    readonly routes: Readonly<Record<string, unknown>>;
    readonly events: readonly unknown[];
  };
  /** Non-UI fixes: the gate report to render and screenshot. */
  readonly gateReport?: GateReport | undefined;
  /**
   * UI changes: the visual gate's redacted before/after PNGs (absolute paths, inside `shotsRoot`).
   * They live in the project checkout, where a role could plant a symlink, so each is read
   * `O_NOFOLLOW`, must be a regular PNG file within `EVIDENCE_LIMITS.maxPngBytes`, and its
   * directory must resolve inside `shotsRoot`; any other is left out (the set goes partial).
   */
  readonly uiShots?: readonly {
    readonly before: string;
    readonly after: string;
    readonly label: string;
  }[];
  /** The checkout the UI shots come from; without it no UI shot is read. */
  readonly shotsRoot?: string | undefined;
  /**
   * D-ct: an automatic run's UI PR at its release. The recorder checks `base` out a second time
   * in the gate sandbox, builds and serves it, and renders the Visual QA screens of both commits
   * (`captureBeforeAfter`), with the changed flow recorded for at most `flowSeconds`
   * (≤ `EVIDENCE_LIMITS.maxFlowSeconds`) unless recordings are off. `base` is the commit the
   * automatic branch was cut from; `null`: the caller does not know it, so nothing is rendered and
   * the set is partial (`capture_failed`), never a "before" of some other commit.
   */
  readonly beforeAfter?:
    | {
        readonly repoRoot: string;
        readonly base: GitSha | null;
        readonly head: GitSha;
        readonly screens?: readonly string[] | undefined;
        readonly flowSeconds?: number | undefined;
      }
    | undefined;
  /** `visual.redact_selectors` of the project. */
  readonly redactSelectors?: readonly string[];
  /** Known secret values (redacted from the snapshot, refused on screen). */
  readonly knownValues: readonly string[];
  /** Upstream: the project-identifier denylist (refused on screen). */
  readonly denylist?: readonly string[];
  /** A project's `automation.evidence.max_mb` in bytes (never above `EVIDENCE_LIMITS`). */
  readonly maxBytes?: number | undefined;
}

export interface EvidenceDeps {
  readonly recorder: EvidenceRecorder;
  readonly assets: AssetBundle;
  readonly hosting: EvidenceHosting;
  readonly ffmpeg: boolean;
  readonly ffmpegCommand?: FfmpegCommand | undefined;
  /** `branch` hosting: plumbing of the repo the PR goes to. */
  readonly plumbing?: GitPlumbing | undefined;
  /** `branch` hosting: fetches the shared evidence branch before each push attempt. */
  readonly refs?: RemoteRefs | undefined;
  readonly now: () => Date;
  /** Runs right before the evidence branch is pushed (the opt-outs, again); may throw a skip. */
  readonly beforePublish?: () => void;
}

export type EvidenceOutcome =
  | {
      readonly ok: true;
      readonly manifest: EvidenceManifest;
      /** The body's Evidence section. */
      readonly section: string;
      /** `attach` hosting: the files to pass as `--attach`. */
      readonly attach: readonly EvidenceAttachment[];
      readonly partial: boolean;
      /** Why the set is partial, when the cause is known (D-ct). */
      readonly partialReason?: EvidencePartialReason;
    }
  | {
      readonly ok: false;
      readonly detail: string;
      /** The evidence was captured but the shared branch refused both pushes. */
      readonly pushRefused?: true;
    };

const capturedFiles = (
  dir: string,
  shots: readonly EvidenceShot[],
  files: readonly { readonly name: string }[],
): EvidenceFile[] =>
  files.flatMap((f) => {
    const shot = shots.find((s) => s.name === f.name);
    const path = join(dir, f.name);
    if (shot === undefined || !existsSync(path)) return [];
    return [{ name: f.name, kind: shot.kind, bytes: statSync(path).size, alt: ALT[shot.kind] }];
  });

/** Captures, retrying the shots that failed (at most `EVIDENCE_LIMITS.captureAttempts` tries). */
const capture = async (
  recorder: EvidenceRecorder,
  request: { origin: string; outDir: string; redactSelectors: string[]; denyText: string[] },
  shots: readonly EvidenceShot[],
): Promise<{ files: EvidenceFile[]; reasons: string[] }> => {
  const files: EvidenceFile[] = [];
  const reasons: string[] = [];
  let pending = [...shots];
  for (
    let attempt = 0;
    attempt < EVIDENCE_LIMITS.captureAttempts && pending.length > 0;
    attempt += 1
  ) {
    try {
      const result = await recorder.capture({ ...request, shots: pending });
      const got = capturedFiles(request.outDir, pending, result.files);
      files.push(...got);
      reasons.push(...result.failed.map((f) => f.reason));
      pending = pending.filter((s) => !got.some((g) => g.name === s.name));
    } catch (error) {
      reasons.push(error instanceof Error ? error.name : "capture error");
    }
  }
  return { files, reasons };
};

/** Runs `step` up to `EVIDENCE_LIMITS.captureAttempts` times; `null` when every try threw. */
const twice = async <T>(step: () => Promise<T>, failures: unknown[] = []): Promise<T | null> => {
  for (let attempt = 0; attempt < EVIDENCE_LIMITS.captureAttempts; attempt += 1) {
    try {
      return await step();
    } catch (error) {
      if (isAutomationSkip(error)) throw error;
      failures.push(error);
    }
  }
  return null;
};

/**
 * Whether a publish failure was a race with another writer of the shared evidence branch: git
 * refused the push as not a fast-forward (`[rejected]`, `non-fast-forward`, `fetch first`, a stale
 * lease), or the local ref moved under `update-ref`. Anything else (no remote, an auth failure, a
 * plumbing error) is an evidence capture failure (D-ce), which raises its issue.
 */
export const isPublishRace = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /\[rejected\]|non-fast-forward|fetch first|stale info|\bref moved\b|cannot lock ref|but expected/i.test(
    message,
  );
};

/** The PNG signature. */
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const isPng = (bytes: Uint8Array): boolean => PNG_MAGIC.every((b, i) => bytes[i] === b);

/** WebM's EBML header. */
const WEBM_MAGIC = [0x1a, 0x45, 0xdf, 0xa3];
/** MP4's `ftyp` box type, at offset 4. */
const MP4_FTYP = [0x66, 0x74, 0x79, 0x70];

/** Whether `bytes` open as the container `ext` names (`webm` or `mp4`). */
const isVideo = (bytes: Uint8Array, ext: string): boolean =>
  ext === "webm"
    ? WEBM_MAGIC.every((b, i) => bytes[i] === b)
    : ext === "mp4" && MP4_FTYP.every((b, i) => bytes[i + 4] === b);

/** A name a recorder returns for a file in its output directory: one plain segment. */
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

/** Whether `path`'s directory resolves inside `root` (both through their real paths). */
const insideRoot = (path: string, root: string): boolean => {
  try {
    const rel = relative(realpathSync(root), realpathSync(dirname(path)));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  } catch {
    return false;
  }
};

/**
 * A UI shot's bytes when it is safe to publish: inside `root`, a regular PNG file (never through
 * a symlink) within the PNG budget; else `null`.
 */
const readUiShot = (path: string, root: string | undefined): Uint8Array | null => {
  if (root === undefined || !isAbsolute(path) || !insideRoot(path, root)) return null;
  const bytes = readRegularFileNoFollow(path, EVIDENCE_LIMITS.maxPngBytes);
  return bytes !== null && isPng(bytes) ? bytes : null;
};

const nextName = (files: readonly EvidenceFile[], slug: string, ext: string): string => {
  const used = files.map((f) => Number(f.name.slice(0, 2)));
  const n = Math.max(0, ...used) + 1;
  return EvidenceFileNameSchema.parse(`${String(n).padStart(2, "0")}-${slug}.${ext}`);
};

/** The kinds a before/after capture returns (D-ct). */
const BEFORE_AFTER_KINDS: ReadonlySet<EvidenceFileKind> = new Set([
  "ui_before",
  "ui_after",
  "flow_video",
]);

/**
 * D-ct: the gate runner's before/after of an automatic run's UI PR, copied into the staging
 * directory under fresh neutral names. The recorder writes into a directory of its own, and each
 * file it names must be a neutral name of a before/after kind, a regular file (never through a
 * symlink) within its kind's cap, a PNG or a WebM/MP4 as its kind says; any other is left out.
 * Returns the files and, when a side is missing, why.
 */
const captureBeforeAfter = async (
  stagingDir: string,
  request: EvidenceRequest,
  recorder: EvidenceRecorder,
  existing: readonly EvidenceFile[],
): Promise<{ files: EvidenceFile[]; reason?: EvidencePartialReason }> => {
  const target = request.beforeAfter;
  if (target === undefined) return { files: [] };
  // a recorder from before 5.4.0 cannot render the base: no before/after at all
  const method = recorder.captureBeforeAfter?.bind(recorder);
  if (method === undefined) return { files: [], reason: "capture_failed" };
  // no known cut point: nothing was built, and a "before" of another commit would mislead
  const base = target.base;
  if (base === null) return { files: [], reason: "capture_failed" };
  const video = request.plan.video !== false;
  const outDir = ensureDirNoFollow(stagingDir, join(stagingDir, "before-after"), "the evidence");
  const flowSeconds = Math.min(
    EVIDENCE_LIMITS.maxFlowSeconds,
    target.flowSeconds ?? EVIDENCE_LIMITS.maxFlowSeconds,
  );
  const result = await twice(() =>
    method({
      repoRoot: target.repoRoot,
      base,
      head: target.head,
      outDir,
      ...(target.screens === undefined ? {} : { screens: target.screens }),
      ...(video && flowSeconds > 0 ? { flowSeconds } : {}),
      redactSelectors: [...BASE_REDACT_SELECTORS, ...(request.redactSelectors ?? [])],
      denyText: [...request.knownValues, ...(request.denylist ?? [])],
    }),
  );
  if (result === null) return { files: [], reason: "capture_failed" };
  const files: EvidenceFile[] = [];
  for (const file of result.files) {
    if (!BEFORE_AFTER_KINDS.has(file.kind) || (!video && file.kind === "flow_video")) continue;
    if (!EvidenceFileNameSchema.safeParse(file.name).success) continue;
    const dot = file.name.lastIndexOf(".");
    const ext = file.name.slice(dot + 1);
    const motion = file.kind === "flow_video";
    if (motion ? ext !== "webm" && ext !== "mp4" : ext !== "png") continue;
    const bytes = readRegularFileNoFollow(
      join(outDir, file.name),
      motion ? EVIDENCE_LIMITS.maxVideoBytes : EVIDENCE_LIMITS.maxPngBytes,
    );
    if (bytes === null || !(motion ? isVideo(bytes, ext) : isPng(bytes))) continue;
    const name = nextName([...existing, ...files], file.name.slice(3, dot), ext);
    if (!createExclusive(join(stagingDir, name), bytes)) continue;
    const side = /-before$/.test(file.name.slice(0, dot))
      ? " (before)"
      : /-after$/.test(file.name.slice(0, dot))
        ? " (after)"
        : "";
    const alt = motion ? `${BEFORE_AFTER_FLOW_ALT}${side}` : ALT[file.kind];
    files.push({ name, kind: file.kind, bytes: bytes.length, alt });
  }
  const has = (kind: EvidenceFileKind): boolean => files.some((f) => f.kind === kind);
  const missing = !has("ui_before") || !has("ui_after") || (video && !has("flow_video"));
  const reason = result.partial?.reason ?? (missing ? "capture_failed" : undefined);
  return { files, ...(reason === undefined ? {} : { reason }) };
};

/**
 * Pure: why an incomplete set is partial, from what it lacks: recordings off, then no ffmpeg
 * under `branch` hosting, then a capture that failed; a set cut by the budget alone has no reason.
 */
const partialReasonOf = (
  missing: readonly MissingEvidence[],
): EvidencePartialReason | undefined => {
  const reasons = new Set(missing.map((m) => m.reason));
  if (reasons.has("video_off")) return "video_off";
  if (reasons.has("no_ffmpeg")) return "no_ffmpeg";
  if (reasons.has("not_captured")) return "capture_failed";
  return undefined;
};

/** Runs the pipeline in `stagingDir` (the per-action staging directory the PR is opened from). */
export const prepareEvidence = async (
  stagingDir: string,
  request: EvidenceRequest,
  deps: EvidenceDeps,
): Promise<EvidenceOutcome> => {
  const pages: Record<string, Uint8Array> = {};
  if (request.plan.change === "non_ui" && request.gateReport !== undefined) {
    const reportDir = join(stagingDir, "report");
    mkdirSync(reportDir, { recursive: true, mode: 0o700 });
    const gateReport = request.gateReport;
    const page = await twice(async () => {
      const { html } = await deps.recorder.renderGateReport({
        report: gateReport,
        outDir: reportDir,
      });
      if (!PLAIN_NAME.test(html)) throw new Error("the gate report name is not a plain file name");
      const bytes = readRegularFileNoFollow(join(reportDir, html), EVIDENCE_LIMITS.maxBytesPerPr);
      if (bytes === null) throw new Error("the gate report is not a readable file");
      return bytes;
    });
    if (page === null) return { ok: false, detail: "the gate report did not render (2 tries)" };
    pages[GATE_REPORT_PAGE] = page;
  }
  const shots = planEvidenceShots(request.plan).filter(
    (s) => s.kind !== "gate_report" || pages[GATE_REPORT_PAGE] !== undefined,
  );
  const server = await startSnapshotServer({
    assets: deps.assets,
    routes: request.snapshot.routes,
    events: request.snapshot.events,
    replayMs: replayIntervalMs(request.snapshot.events.length),
    knownValues: request.knownValues,
    files: pages,
  });
  let captured: { files: EvidenceFile[]; reasons: string[] };
  try {
    captured = await capture(
      deps.recorder,
      {
        origin: server.origin,
        outDir: stagingDir,
        redactSelectors: [...BASE_REDACT_SELECTORS, ...(request.redactSelectors ?? [])],
        denyText: [...request.knownValues, ...(request.denylist ?? [])],
      },
      shots,
    );
  } finally {
    await server.close();
  }
  const files = [...captured.files];
  if (!request.plan.upstreamSafe) {
    for (const shot of request.uiShots ?? []) {
      for (const [kind, source] of [
        ["ui_before", shot.before],
        ["ui_after", shot.after],
      ] as const) {
        const bytes = readUiShot(source, request.shotsRoot);
        if (bytes === null) continue;
        const slug = `${kind === "ui_before" ? "ui-before" : "ui-after"}-${shot.label
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, "-")
          .slice(0, 30)}`;
        const name = nextName(files, slug, "png");
        if (!createExclusive(join(stagingDir, name), bytes)) continue;
        files.push({
          name,
          kind,
          bytes: bytes.length,
          alt: `${ALT[kind]} (${shot.label})`,
        });
      }
    }
  }
  const beforeAfter =
    request.beforeAfter !== undefined && request.plan.change === "ui" && !request.plan.upstreamSafe;
  let beforeAfterReason: EvidencePartialReason | undefined;
  if (beforeAfter) {
    const got = await captureBeforeAfter(stagingDir, request, deps.recorder, files);
    files.push(...got.files);
    beforeAfterReason = got.reason;
  }
  const video = files.find((f) => f.kind === "replay_video");
  if (deps.ffmpeg && deps.ffmpegCommand !== undefined && video !== undefined) {
    const output = nextName(files, "replay-preview", "gif");
    const bytes = await makeGif({
      ffmpeg: deps.ffmpegCommand,
      dir: stagingDir,
      video: video.name,
      output,
    });
    if (bytes !== null)
      files.push({ name: output, kind: "replay_gif", bytes, alt: ALT.replay_gif });
  }
  const { kept } = applyEvidenceBudget(files, request.maxBytes);
  if (kept.length === 0) {
    return {
      ok: false,
      detail: `no evidence file was captured (${String(captured.reasons.length)} failed shot(s))`,
    };
  }
  const required = requiredEvidenceKinds(request.plan, deps.hosting, { beforeAfter });
  const missing: MissingEvidence[] = required
    .filter((kind) => !kept.some((f) => f.kind === kind))
    .map((kind) => ({
      kind,
      reason: files.some((f) => f.kind === kind)
        ? "budget"
        : request.plan.video === false &&
            (kind === "replay_video" || kind === "flow_video" || kind === "replay_gif")
          ? "video_off"
          : kind === "replay_gif" && (!deps.ffmpeg || deps.ffmpegCommand === undefined)
            ? "no_ffmpeg"
            : "not_captured",
    }));
  // the recorder's own reason (the base did not build, …) says more than the missing kinds
  const partialReason = beforeAfterReason ?? partialReasonOf(missing);
  const complete = evidenceComplete(kept, required) && beforeAfterReason === undefined;
  let urls: Map<string, string> | undefined;
  if (deps.hosting === "branch") {
    const plumbing = deps.plumbing;
    if (plumbing === undefined) return { ok: false, detail: "branch hosting needs git plumbing" };
    const failures: unknown[] = [];
    const published = await twice(() => {
      deps.beforePublish?.();
      return publishToEvidenceBranch({
        plumbing,
        repo: request.repo,
        dir: stagingDir,
        files: kept,
        kind: request.kind,
        fingerprint: request.fingerprint,
        at: deps.now(),
        refs: deps.refs,
      });
    }, failures);
    if (published === null) {
      // only a race with another installation is a refused push; every other failure is the
      // evidence capture failing, which raises "evidence capture failed" (D-ce)
      if (failures.length > 0 && failures.every(isPublishRace)) {
        return {
          ok: false,
          detail: "the evidence branch could not be pushed (2 tries, each after a fetch)",
          pushRefused: true,
        };
      }
      const last = failures.at(-1);
      return {
        ok: false,
        detail: `the evidence branch could not be published: ${redactSecrets(
          last instanceof Error ? last.message : String(last),
          request.knownValues,
        ).slice(0, 300)}`,
      };
    }
    urls = published;
  }
  const manifest = buildManifest({
    dir: stagingDir,
    kind: request.kind,
    fingerprint: request.fingerprint,
    hosting: deps.hosting,
    files: kept,
    ...(urls === undefined ? {} : { urls }),
    complete,
    ...(complete || partialReason === undefined ? {} : { partialReason }),
    capturedAt: deps.now().toISOString(),
  });
  writeManifest(manifest, request.keep, request.knownValues);
  return {
    ok: true,
    manifest,
    section: renderEvidenceSection({
      hosting: deps.hosting,
      files: kept,
      ...(urls === undefined ? {} : { urls }),
      partial: !complete,
      missing,
      reason: complete ? undefined : partialReason,
    }),
    attach: attachmentsFor(deps.hosting, kept),
    partial: !complete,
    ...(complete || partialReason === undefined ? {} : { partialReason }),
  };
};

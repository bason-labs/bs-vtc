/**
 * One PR's evidence, end to end (D-ce, H-8; AD-27 rule 6): render the gate report when the change
 * is not a UI one, serve a redacted snapshot on the loopback, capture the planned shots through the
 * injected `EvidenceRecorder` (retrying failed shots once), add the visual gate's before/after
 * screenshots, make a GIF when ffmpeg is present, apply the budget, publish (`branch` or
 * `attach`), and write the manifest. No file at all, a gate report that does not render, or an
 * evidence branch that cannot be pushed (each tried twice; each push attempt fetches the shared
 * branch and rebuilds first) fails the step and no PR opens. A capture failure makes the caller
 * raise "evidence capture failed"; a refused push (`pushRefused`) does not, since another
 * installation pushing the shared branch is not a VTC defect. The opt-outs are checked again
 * right before the evidence branch is pushed (`beforePublish`).
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  EVIDENCE_LIMITS,
  EvidenceFileNameSchema,
  type AssetBundle,
  type AutoFingerprint,
  type AutoKind,
  type EvidenceAttachment,
  type EvidenceFileKind,
  type EvidenceHosting,
  type EvidenceManifest,
  type EvidenceRecorder,
  type EvidenceShot,
  type GateReport,
  type GitHubRepo,
  type GitPlumbing,
} from "@vtc/shared";
import type { RemoteRefs } from "../remote-refs.js";
import { isAutomationSkip } from "../skip.js";
import { makeGif, type FfmpegCommand } from "./gif.js";
import { attachmentsFor, publishToEvidenceBranch, renderEvidenceSection } from "./hosting.js";
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
  /** UI changes: the visual gate's redacted before/after PNGs (absolute paths). */
  readonly uiShots?: readonly {
    readonly before: string;
    readonly after: string;
    readonly label: string;
  }[];
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
const twice = async <T>(step: () => Promise<T>): Promise<T | null> => {
  for (let attempt = 0; attempt < EVIDENCE_LIMITS.captureAttempts; attempt += 1) {
    try {
      return await step();
    } catch (error) {
      if (isAutomationSkip(error)) throw error;
    }
  }
  return null;
};

const nextName = (files: readonly EvidenceFile[], slug: string, ext: string): string => {
  const used = files.map((f) => Number(f.name.slice(0, 2)));
  const n = Math.max(0, ...used) + 1;
  return EvidenceFileNameSchema.parse(`${String(n).padStart(2, "0")}-${slug}.${ext}`);
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
      return new Uint8Array(readFileSync(join(reportDir, html)));
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
        if (!existsSync(source)) continue;
        const slug = `${kind === "ui_before" ? "ui-before" : "ui-after"}-${shot.label
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, "-")
          .slice(0, 30)}`;
        const name = nextName(files, slug, "png");
        copyFileSync(source, join(stagingDir, name));
        files.push({
          name,
          kind,
          bytes: statSync(join(stagingDir, name)).size,
          alt: `${ALT[kind]} (${shot.label})`,
        });
      }
    }
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
  const complete = evidenceComplete(kept, requiredEvidenceKinds(request.plan, deps.hosting));
  let urls: Map<string, string> | undefined;
  if (deps.hosting === "branch") {
    const plumbing = deps.plumbing;
    if (plumbing === undefined) return { ok: false, detail: "branch hosting needs git plumbing" };
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
    });
    if (published === null) {
      return {
        ok: false,
        detail: "the evidence branch could not be pushed (2 tries, each after a fetch)",
        pushRefused: true,
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
    }),
    attach: attachmentsFor(deps.hosting, kept),
    partial: !complete,
  };
};

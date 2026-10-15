/**
 * What evidence an automatic PR records (D-ce, H-8; spine §5 readings 199 and 208):
 * - every PR: a dashboard replay video of the producing run plus a key screenshot (for a bs-vtc
 *   PR caused by a project run, the upstream-safe projection instead of that run's replay);
 * - UI changes: the visual gate's before/after screenshots and a changed-flow video of at most
 *   `EVIDENCE_LIMITS.maxFlowSeconds`;
 * - prompt, agent or cost changes: the scorecard and replay charts;
 * - non-UI fixes: the gate report (`EvidenceRecorder.renderGateReport`), screenshotted.
 * A project's `automation.evidence.video: false` drops the recordings (screenshots only, which
 * leaves the set incomplete: `evidence: partial`).
 */
import {
  EVIDENCE_MODE_PARAM,
  EVIDENCE_MODE_VALUES,
  EVIDENCE_LIMITS,
  type EvidenceFileKind,
  type EvidenceHosting,
  type EvidenceShot,
} from "@vtc/shared";

/** What changed, which decides the evidence beyond the replay. */
export type ChangeClass = "ui" | "prompt" | "agent" | "cost" | "non_ui";

export const DESKTOP_VIEWPORT = { width: 1280, height: 800 } as const;

/** Selectors painted out in every frame and masked on screenshots (AD-27 rule 6, layer 2). */
export const BASE_REDACT_SELECTORS: readonly string[] = [
  "[data-vtc-redact]",
  "[data-vtc-secret]",
  "input[type=password]",
];

/** Where the rendered gate report is served on the snapshot origin. */
export const GATE_REPORT_PAGE = "gate-report.html";

export interface EvidencePlanInput {
  /** The producing run, for its replay; absent with `upstreamSafe`. */
  readonly run?: string | undefined;
  /** A bs-vtc PR caused by a project run: record the upstream-safe projection only (reading 208). */
  readonly upstreamSafe: boolean;
  readonly change: ChangeClass;
  /** UI changes: the snapshot path of the changed flow to record. */
  readonly flowPath?: string | undefined;
  /** `false`: no recordings, screenshots only (a project's `automation.evidence.video`). */
  readonly video?: boolean | undefined;
}

/** The page a replay or a chart is recorded from on the snapshot origin. */
const pagePath = (input: EvidencePlanInput, hash = ""): string =>
  input.upstreamSafe || input.run === undefined
    ? `/lookback/?${EVIDENCE_MODE_PARAM}=${EVIDENCE_MODE_VALUES.upstream}${hash}`
    : `/run/?run=${encodeURIComponent(input.run)}&${EVIDENCE_MODE_PARAM}=${EVIDENCE_MODE_VALUES.full}${hash}`;

/** Pure: the shots to capture, with neutral `NN-<slug>.<ext>` names. */
export const planEvidenceShots = (input: EvidencePlanInput): EvidenceShot[] => {
  const shots: Omit<EvidenceShot, "name">[] = [];
  const add = (shot: Omit<EvidenceShot, "name">): void => {
    if (input.video === false && shot.videoSeconds !== undefined) return;
    shots.push(shot);
  };
  add({
    kind: "replay_video",
    path: pagePath(input, "#replay"),
    viewport: DESKTOP_VIEWPORT,
    videoSeconds: EVIDENCE_LIMITS.maxReplaySeconds,
  });
  add({ kind: "screenshot", path: pagePath(input), viewport: DESKTOP_VIEWPORT });
  if (input.change === "ui" && !input.upstreamSafe && input.flowPath !== undefined) {
    add({
      kind: "flow_video",
      path: input.flowPath,
      viewport: DESKTOP_VIEWPORT,
      videoSeconds: EVIDENCE_LIMITS.maxFlowSeconds,
    });
  }
  if (input.change === "prompt" || input.change === "agent" || input.change === "cost") {
    add({ kind: "chart", path: pagePath(input, "#scorecard"), viewport: DESKTOP_VIEWPORT });
    add({ kind: "chart", path: pagePath(input, "#replay-stats"), viewport: DESKTOP_VIEWPORT });
  }
  if (input.change === "non_ui") {
    add({ kind: "gate_report", path: `/evidence/${GATE_REPORT_PAGE}`, viewport: DESKTOP_VIEWPORT });
  }
  const slug: Record<EvidenceFileKind, string> = {
    replay_video: "replay",
    replay_gif: "replay",
    screenshot: "final-state",
    ui_before: "ui-before",
    ui_after: "ui-after",
    flow_video: "changed-flow",
    chart: "chart",
    gate_report: "gate-report",
  };
  return shots.map((shot, i) => {
    const video = shot.videoSeconds !== undefined;
    const suffix = shot.kind === "chart" ? `-${String(i)}` : "";
    return {
      ...shot,
      name: `${String(i + 1).padStart(2, "0")}-${slug[shot.kind]}${suffix}.${video ? "webm" : "png"}`,
    };
  });
};

/** Pure: the kinds a complete evidence set holds for `change` (D-ce). */
export const requiredEvidenceKinds = (
  input: Pick<EvidencePlanInput, "change" | "upstreamSafe" | "flowPath">,
  hosting: EvidenceHosting,
): EvidenceFileKind[] => {
  const kinds: EvidenceFileKind[] = ["replay_video", "screenshot"];
  // `branch` hosting cannot play a WebM inline, so the GIF is its motion evidence; with
  // `attach` the WebM plays inline and a GIF is optional (spine §5 reading 196).
  if (hosting === "branch") kinds.push("replay_gif");
  if (input.change === "ui" && !input.upstreamSafe) {
    kinds.push("ui_before", "ui_after");
    if (input.flowPath !== undefined) kinds.push("flow_video");
  }
  if (input.change === "prompt" || input.change === "agent" || input.change === "cost") {
    kinds.push("chart");
  }
  if (input.change === "non_ui") kinds.push("gate_report");
  return kinds;
};

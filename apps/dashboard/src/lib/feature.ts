import {
  FINAL_REVIEW_CAP,
  type Feature,
  type FeatureStatus,
  type PullRequestRef,
} from "@vtc/shared";
import { featureStatusMeta, type Tone } from "./states";

/**
 * Feature view (§6.7a): `building → integrating → final_review ⇄ fixing(n/3) → ready_to_ship →
 * shipped`, side state `parked(reason)`; and the feature's PR (§6.7 Level 2/3).
 */
const PATH = ["building", "integrating", "final_review", "ready_to_ship", "shipped"] as const;
type PathStatus = (typeof PATH)[number];

const LABELS: Readonly<Record<PathStatus, string>> = {
  building: "Building",
  integrating: "Integrating",
  final_review: "Final Review",
  ready_to_ship: "Ready to ship",
  shipped: "Shipped",
};

export type StepState = "done" | "current" | "todo";

export interface FinalReviewModel {
  readonly steps: readonly { key: PathStatus; label: string; state: StepState }[];
  /** Final Review round as `n/3`. */
  readonly round: string;
  /** `Parked: <reason>` when the feature is parked, else `null`. */
  readonly parked: string | null;
}

const pathIndex = (status: FeatureStatus): number => {
  if (status === "fixing") return PATH.indexOf("final_review");
  if (status === "parked") return -1;
  return PATH.indexOf(status);
};

export const finalReviewSteps = (feature: Feature): FinalReviewModel => {
  const at = pathIndex(feature.status);
  const shipped = feature.status === "shipped";
  return {
    steps: PATH.map((key, i) => {
      const state: StepState =
        at < 0 ? "todo" : i < at || shipped ? "done" : i === at ? "current" : "todo";
      const label =
        key === "final_review" && feature.status === "fixing"
          ? `Final Review ⇄ fixing ${String(feature.round)}/${String(FINAL_REVIEW_CAP)}`
          : LABELS[key];
      return { key, label, state };
    }),
    round: `${String(feature.round)}/${String(FINAL_REVIEW_CAP)}`,
    parked: feature.status === "parked" ? featureStatusMeta(feature).label : null,
  };
};

export interface PullRequestModel {
  /** `null` unless the URL is http(s): a PR link never runs script on this origin. */
  readonly url: string | null;
  readonly stateLabel: string;
  readonly stateTone: Tone;
  readonly ciLabel: string;
  readonly ciTone: Tone;
  readonly head: string;
  readonly mergeCommit: string | null;
}

const CI_TONES: Readonly<Record<PullRequestRef["ci"], Tone>> = {
  pending: "accent",
  green: "ok",
  red: "danger",
  unknown: "neutral",
};

const short = (sha: string): string => sha.slice(0, 7);

const webUrl = (url: string): string | null => {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:" ? url : null;
  } catch {
    return null;
  }
};

export const pullRequestModel = (pr: PullRequestRef): PullRequestModel => {
  const [stateLabel, stateTone]: [string, Tone] =
    pr.state === "merged"
      ? ["Merged", "ok"]
      : pr.state === "closed"
        ? ["Closed", "neutral"]
        : pr.draft
          ? ["Draft", "neutral"]
          : ["Ready for review", "brand"];
  return {
    url: webUrl(pr.url),
    stateLabel,
    stateTone,
    ciLabel: `CI ${pr.ci}`,
    ciTone: CI_TONES[pr.ci],
    head: short(pr.head_sha),
    mergeCommit: pr.merge_commit === undefined ? null : short(pr.merge_commit),
  };
};

import {
  isServableArtifactPath,
  LOOKBACK_REPO,
  ReplayResultSchema,
  type ArtifactContent,
  type ReplayGrader,
  type ReplayIsolation,
  type ReplayResult,
  type ReplayVerdict,
} from "@vtc/shared";
import { readJsonArtifact, type Read } from "./read-json";
import type { StatusMeta } from "./states";

/**
 * Lookback replays (spec §13 step 3, spine AD-21): a `ReplayResult` from
 * `.vtc/lookback/replays/<proposal>.json`, read through the artifacts route. Shows which grader
 * scored it (`ReplayResult.grader`, D-ch, spine §5 reading 202: absent means `gates`), both arms
 * per replayed task, the sign test, the A/A flip rate and the token change. A verdict `improve`
 * opens a pull request to VTC's own repo; the human's merge of it is the promotion, shipped in the
 * next VTC release (D-cb, reading 196).
 */
export const REPLAY_VERDICTS: Readonly<Record<ReplayVerdict, StatusMeta>> = {
  improve: { label: "improves", tone: "ok" },
  regress: { label: "regresses", tone: "danger" },
  no_change: { label: "no change", tone: "neutral" },
  inconclusive: { label: "inconclusive, not an improvement", tone: "warn" },
};

/** What happens after a verdict `improve` (D-cb). */
export const IMPROVE_NEXT =
  "VTC opens a pull request to VTC's own repo with this change; the next VTC release ships the change once a human merges it. vtc lookback approve still starts a canary on this machine only.";

const GRADERS: Readonly<Record<ReplayGrader, { label: string; detail: string }>> = {
  gates: {
    label: "Graded by the gates",
    detail:
      "Each trial's head went through the Gate Runner, with the gates.yml at the trial's base.",
  },
  verdict: {
    label: "Graded by the verdict grader",
    detail:
      "Each trial's verdict was scored against the recorded outcome of the replayed dispatch: the human's G-gate or PR verdict, the gate result and any later escaped defect.",
  },
};

const ISOLATION: Readonly<Record<ReplayIsolation, string>> = {
  paths_only: "paths only: the host sandbox denied no reads",
  read_denied: "reads of the repo denied by the host sandbox",
};

/** Whether `path` is a replay result the dashboard may read (under the replays directory). */
export const isReplayPath = (path: string): boolean =>
  isServableArtifactPath(path) &&
  !path.split("/").includes("..") &&
  path.startsWith(`${LOOKBACK_REPO.replaysDir}/`) &&
  path.endsWith(".json");

export const readReplayResult = (artifact: ArtifactContent): Read<ReplayResult> =>
  readJsonArtifact(ReplayResultSchema, artifact);

export interface ReplayTaskRow {
  /** The replayed task (`<run>:<task>`), or its ordinal in upstream mode. */
  readonly label: string;
  /** Arm `a` (the baseline). */
  readonly baseline: string;
  /** Arm `b` (the candidate). */
  readonly candidate: string;
  readonly regression: boolean;
}

export interface ReplayView {
  readonly proposal: string;
  readonly target: string;
  readonly verdict: StatusMeta;
  readonly grader: { readonly label: string; readonly detail: string };
  readonly tasks: readonly ReplayTaskRow[];
  /** Label and value pairs. */
  readonly stats: readonly (readonly [string, string])[];
  /** What happens next ({@link IMPROVE_NEXT}), or `null`. */
  readonly next: string | null;
}

const passed = (trials: readonly boolean[]): string =>
  `${String(trials.filter(Boolean).length)}/${String(trials.length)} passed`;

const signed = (pct: number): string =>
  `${pct > 0 ? "+" : ""}${String(Math.round(pct * 10) / 10)}%`;

/** The display model of a replay; `ordinals` shows tasks as `task n` (upstream mode, D-by). */
export const replayView = (
  r: ReplayResult,
  options: { readonly ordinals?: boolean } = {},
): ReplayView => ({
  proposal: r.proposal,
  target: `${r.mode === undefined ? r.role : `${r.role} (${r.mode})`} · ${r.host}`,
  verdict: REPLAY_VERDICTS[r.verdict],
  grader: GRADERS[r.grader ?? "gates"],
  tasks: r.per_task.map((t, i) => ({
    label: options.ordinals === true ? `task ${String(i + 1)}` : t.task,
    baseline: passed(t.a),
    candidate: passed(t.b),
    regression: t.regression_set,
  })),
  stats: [
    ["Trials per task and arm", String(r.k)],
    [
      "Sign test",
      `${String(r.sign_test.wins_b)} of ${String(r.sign_test.n_discordant)} discordant tasks favour the candidate (p = ${String(Math.round(r.sign_test.p * 1000) / 1000)})`,
    ],
    ["A/A flip rate", `${String(Math.round(r.aa_flip_rate * 100))}%`],
    ["Tokens, candidate vs baseline", signed(r.tokens_delta_pct)],
    ["Isolation", ISOLATION[r.isolation ?? "paths_only"]],
  ],
  next: r.verdict === "improve" ? IMPROVE_NEXT : null,
});

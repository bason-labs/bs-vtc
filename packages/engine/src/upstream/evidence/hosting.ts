/**
 * Where PR media live and how a body embeds them (D-ce; AD-27 rule 6; spine §5 reading 196):
 * - `branch` (the default): committed through `GitPlumbing` to the orphan `vtc-evidence` branch
 *   (no checkout; the parent is the previous evidence commit as the remote shows it right after a
 *   fetch, never the default branch), pushed without force, and embedded by commit-pinned
 *   `https://github.com/<o>/<r>/blob/<sha>/<path>?raw=true` URLs; a WebM is a link, not a player;
 * - `attach`: `gh … --attach <name>` from the staging directory, with body references that are the
 *   same relative neutral names, so gh rewrites each one to its upload.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  autoPushRefAllowed,
  EVIDENCE_BRANCH,
  type AutoFingerprint,
  type AutoKind,
  type EvidenceAttachment,
  type EvidenceFileKind,
  type EvidenceHosting,
  type GitHubRepo,
  type GitPlumbing,
} from "@vtc/shared";
import { refreshRemote, trackingRefspec, type RemoteRefs } from "../remote-refs.js";
import type { EvidenceFile } from "./manifest.js";

export const EVIDENCE_REF = `refs/heads/${EVIDENCE_BRANCH}`;

const pad = (n: number): string => String(n).padStart(2, "0");

/** Pure: `<kind>/<fp8>/<yyyymmdd-hhmm>` (UTC), the folder of one PR's media on the branch. */
export const evidenceFolder = (kind: AutoKind, fingerprint: AutoFingerprint, at: Date): string =>
  `${kind}/${fingerprint.slice(0, 8)}/${String(at.getUTCFullYear())}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}-${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}`;

/**
 * Commits `files` (in `dir`) to the evidence branch and pushes it; returns each file's
 * commit-pinned URL. Every VTC installation reporting to the repo pushes to this one branch, so
 * it first fetches the remote's `vtc-evidence` (`refs`, when wired) and builds on the
 * remote-tracking `refs/remotes/<remote>/vtc-evidence` when the clone has one, else on the local
 * branch. Throws when the local branch moved meanwhile (`updateRef` compares) or the push is
 * refused (never forced, e.g. another installation pushed between the fetch and the push); the
 * caller retries once, which fetches and rebuilds.
 */
export const publishToEvidenceBranch = async (input: {
  readonly plumbing: GitPlumbing;
  readonly repo: GitHubRepo;
  readonly dir: string;
  readonly files: readonly EvidenceFile[];
  readonly kind: AutoKind;
  readonly fingerprint: AutoFingerprint;
  readonly at: Date;
  readonly remote?: string;
  /** Fetches the remote's branch first (`UpstreamDeps.remoteRefs`). */
  readonly refs?: RemoteRefs | undefined;
}): Promise<Map<string, string>> => {
  if (!autoPushRefAllowed(EVIDENCE_REF)) throw new Error("evidence ref refused");
  const folder = evidenceFolder(input.kind, input.fingerprint, input.at);
  const remote = input.remote ?? "origin";
  await refreshRemote(input.refs, remote, [trackingRefspec(remote, EVIDENCE_BRANCH)]);
  const local = await input.plumbing.resolve(EVIDENCE_REF);
  const previous =
    (await input.plumbing.resolve(`refs/remotes/${remote}/${EVIDENCE_BRANCH}`)) ?? local;
  const sha = await input.plumbing.commit({
    base: previous,
    parents: previous === null ? [] : [previous],
    changes: input.files.map((f) => ({
      path: `${folder}/${f.name}`,
      bytes: new Uint8Array(readFileSync(join(input.dir, f.name))),
    })),
    message: `vtc-evidence: ${input.kind}/${input.fingerprint.slice(0, 8)}`,
  });
  await input.plumbing.updateRef(EVIDENCE_REF, sha, local);
  await input.plumbing.push(remote, sha, EVIDENCE_REF);
  return new Map(
    input.files.map((f) => [
      f.name,
      `https://github.com/${input.repo}/blob/${sha}/${folder}/${f.name}?raw=true`,
    ]),
  );
};

const isVideo = (name: string): boolean => /\.(webm|mp4)$/.test(name);
const escapeAlt = (alt: string): string => alt.replace(/[[\]\n]/g, " ");

/**
 * Pure: the body's Evidence section. Motion first (GIF, then video), then screenshots and charts.
 * In `branch` hosting `urls` holds each file's pinned URL; in `attach` hosting every reference is
 * the file's relative name, which `gh --attach` rewrites.
 */
export const renderEvidenceSection = (input: {
  readonly hosting: EvidenceHosting;
  readonly files: readonly EvidenceFile[];
  readonly urls?: ReadonlyMap<string, string>;
  readonly partial: boolean;
  /** What a partial set lacks, and why; the note names each (absent: a plain "partial" note). */
  readonly missing?: readonly MissingEvidence[];
}): string => {
  const order = (f: EvidenceFile): number =>
    f.kind === "replay_gif" ? 0 : isVideo(f.name) ? 1 : 2;
  const lines = [...input.files]
    .sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
    .map((f) => {
      const target = input.hosting === "branch" ? (input.urls?.get(f.name) ?? f.name) : f.name;
      const alt = escapeAlt(f.alt);
      if (input.hosting === "branch" && isVideo(f.name))
        return `- [${alt} (WebM video)](${target})`;
      return `![${alt}](${target})`;
    });
  if (input.partial) {
    const missing = input.missing ?? [];
    lines.push(
      "",
      missing.length === 0
        ? "_Evidence is partial._"
        : `_Evidence is partial: ${missing.map((m) => `no ${MISSING_LABEL[m.kind]} (${MISSING_REASON[m.reason]})`).join("; ")}._`,
    );
  }
  return lines.join("\n\n");
};

/** Why a required evidence file is missing from the published set. */
export type MissingEvidenceReason = "no_ffmpeg" | "video_off" | "budget" | "not_captured";

export interface MissingEvidence {
  readonly kind: EvidenceFileKind;
  readonly reason: MissingEvidenceReason;
}

const MISSING_LABEL: Readonly<Record<EvidenceFileKind, string>> = {
  replay_video: "replay recording",
  replay_gif: "inline motion preview",
  screenshot: "final-state screenshot",
  ui_before: "UI before screenshot",
  ui_after: "UI after screenshot",
  flow_video: "changed-flow recording",
  chart: "chart",
  gate_report: "gate report",
};

const MISSING_REASON: Readonly<Record<MissingEvidenceReason, string>> = {
  no_ffmpeg: "install ffmpeg for GIF previews",
  video_off: "recordings are off in `automation.evidence.video`",
  budget: "left out to stay within the evidence size budget",
  not_captured: "it could not be captured",
};

/** Pure: the `--attach` list of `attach` hosting (empty for `branch`). */
export const attachmentsFor = (
  hosting: EvidenceHosting,
  files: readonly EvidenceFile[],
): EvidenceAttachment[] =>
  hosting === "attach" ? files.map((f) => ({ name: f.name, alt: f.alt })) : [];

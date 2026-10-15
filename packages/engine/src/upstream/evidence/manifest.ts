/**
 * The evidence budget and manifest (D-ce; AD-27 rule 6): per-file caps by kind, then at most
 * `EVIDENCE_LIMITS.maxBytesPerPr` and `maxFilesPerPr` in priority order (motion first), and the
 * `EvidenceManifest` that lists every file with its hash, size, redaction verdict and URL. The
 * manifest is kept, redacted, at `<vtcHome>/guard/_upstream/evidence/<fp8>/` (VTC's repo) or
 * `.vtc/evidence/auto/<fp8>/` (a project), never through a symlink: a project's `.vtc/evidence/` is
 * tracked by git, so a role could plant one there.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  EVIDENCE_LIMITS,
  EvidenceManifestSchema,
  redactJson,
  type AutoFingerprint,
  type AutoKind,
  type EvidenceFileKind,
  type EvidenceHosting,
  type EvidenceManifest,
  type EvidencePartialReason,
} from "@vtc/shared";
import { ensureDirNoFollow, writeFileNoFollow } from "../safe-fs.js";
import { upstreamStateDir } from "../state-dir.js";

export interface EvidenceFile {
  readonly name: string;
  readonly kind: EvidenceFileKind;
  readonly bytes: number;
  readonly alt: string;
}

/** The order files are kept in when the budget is tight. */
const PRIORITY: readonly EvidenceFileKind[] = [
  "replay_video",
  "replay_gif",
  "screenshot",
  "ui_before",
  "ui_after",
  "flow_video",
  "chart",
  "gate_report",
];

const capFor = (kind: EvidenceFileKind): number => {
  switch (kind) {
    case "replay_video":
    case "flow_video":
      return EVIDENCE_LIMITS.maxVideoBytes;
    case "replay_gif":
      return EVIDENCE_LIMITS.maxGifBytes;
    default:
      return EVIDENCE_LIMITS.maxPngBytes;
  }
};

/**
 * Pure: the files that fit the per-file caps and the per-PR budget, and those dropped. `maxBytes`
 * (a project's `automation.evidence.max_mb`) lowers the per-PR budget, never above
 * `EVIDENCE_LIMITS.maxBytesPerPr`.
 */
export const applyEvidenceBudget = (
  files: readonly EvidenceFile[],
  maxBytes?: number,
): { readonly kept: EvidenceFile[]; readonly dropped: EvidenceFile[] } => {
  const budget = Math.min(maxBytes ?? EVIDENCE_LIMITS.maxBytesPerPr, EVIDENCE_LIMITS.maxBytesPerPr);
  const ordered = [...files].sort(
    (a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind) || a.name.localeCompare(b.name),
  );
  const kept: EvidenceFile[] = [];
  const dropped: EvidenceFile[] = [];
  let total = 0;
  for (const file of ordered) {
    const fits =
      file.bytes > 0 &&
      file.bytes <= capFor(file.kind) &&
      total + file.bytes <= budget &&
      kept.length < EVIDENCE_LIMITS.maxFilesPerPr;
    if (fits) {
      kept.push(file);
      total += file.bytes;
    } else {
      dropped.push(file);
    }
  }
  kept.sort((a, b) => a.name.localeCompare(b.name));
  return { kept, dropped };
};

/** Pure: whether `files` hold every kind in `required`. */
export const evidenceComplete = (
  files: readonly EvidenceFile[],
  required: readonly EvidenceFileKind[],
): boolean => required.every((kind) => files.some((f) => f.kind === kind));

/** The manifest of `files` in `dir`, hashed from disk and validated against the contract. */
export const buildManifest = (input: {
  readonly dir: string;
  readonly kind: AutoKind;
  readonly fingerprint: AutoFingerprint;
  readonly hosting: EvidenceHosting;
  readonly files: readonly EvidenceFile[];
  readonly urls?: ReadonlyMap<string, string>;
  readonly complete: boolean;
  /** Why `complete` is false, when known (D-ct). */
  readonly partialReason?: EvidencePartialReason | undefined;
  readonly capturedAt: string;
}): EvidenceManifest =>
  EvidenceManifestSchema.parse({
    v: 1,
    kind: input.kind,
    fingerprint: input.fingerprint,
    hosting: input.hosting,
    files: input.files.map((f) => {
      const bytes = readFileSync(join(input.dir, f.name));
      const url = input.urls?.get(f.name);
      return {
        name: f.name,
        kind: f.kind,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        redaction: "passed",
        alt: f.alt,
        ...(url === undefined ? {} : { url }),
      };
    }),
    complete: input.complete,
    ...(input.complete || input.partialReason === undefined
      ? {}
      : { partial_reason: input.partialReason }),
    captured_at: input.capturedAt,
  });

type ManifestTarget =
  | { readonly kind: "upstream"; readonly vtcHome: string }
  | { readonly kind: "project"; readonly repoRoot: string };

/** Where a target keeps its manifests. */
export const manifestDir = (target: ManifestTarget, fingerprint: AutoFingerprint): string =>
  target.kind === "upstream"
    ? join(upstreamStateDir(target.vtcHome), "evidence", fingerprint.slice(0, 8))
    : join(target.repoRoot, ".vtc", "evidence", "auto", fingerprint.slice(0, 8));

/**
 * Writes `manifest.json` (redacted) into the target's manifest directory: every directory below
 * VTC's home or the project root is checked for symlinks, and the file goes through a fresh
 * `O_EXCL|O_NOFOLLOW` temporary file renamed into place.
 */
export const writeManifest = (
  manifest: EvidenceManifest,
  target: ManifestTarget,
  knownValues: readonly string[] = [],
): void => {
  const text = `${JSON.stringify(redactJson(manifest, knownValues), null, 2)}\n`;
  const root = target.kind === "upstream" ? target.vtcHome : target.repoRoot;
  const dir = ensureDirNoFollow(
    root,
    manifestDir(target, manifest.fingerprint),
    "the evidence manifest",
  );
  writeFileNoFollow(dir, "manifest.json", text);
};

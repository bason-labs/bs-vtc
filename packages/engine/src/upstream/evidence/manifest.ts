/**
 * The evidence budget and manifest (D-ce; AD-27 rule 6): per-file caps by kind, then at most
 * `EVIDENCE_LIMITS.maxBytesPerPr` and `maxFilesPerPr` in priority order (motion first), and the
 * `EvidenceManifest` that lists every file with its hash, size, redaction verdict and URL. The
 * manifest is kept, redacted, at `<vtcHome>/upstream/evidence/<fp8>/` (VTC's repo) or
 * `.vtc/evidence/auto/<fp8>/` (a project).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
} from "@vtc/shared";

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

/** Pure: the files that fit the per-file caps and the per-PR budget, and those dropped. */
export const applyEvidenceBudget = (
  files: readonly EvidenceFile[],
): { readonly kept: EvidenceFile[]; readonly dropped: EvidenceFile[] } => {
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
      total + file.bytes <= EVIDENCE_LIMITS.maxBytesPerPr &&
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
    captured_at: input.capturedAt,
  });

/** Where a target keeps its manifests. */
export const manifestDir = (
  target:
    | { readonly kind: "upstream"; readonly vtcHome: string }
    | { readonly kind: "project"; readonly repoRoot: string },
  fingerprint: AutoFingerprint,
): string =>
  target.kind === "upstream"
    ? join(target.vtcHome, "upstream", "evidence", fingerprint.slice(0, 8))
    : join(target.repoRoot, ".vtc", "evidence", "auto", fingerprint.slice(0, 8));

/** Writes `manifest.json` (redacted) into each of `dirs`. */
export const writeManifest = (
  manifest: EvidenceManifest,
  dirs: readonly string[],
  knownValues: readonly string[] = [],
): void => {
  const text = `${JSON.stringify(redactJson(manifest, knownValues), null, 2)}\n`;
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "manifest.json"), text, { mode: 0o600 });
  }
};

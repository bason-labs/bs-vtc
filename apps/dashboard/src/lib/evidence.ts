import {
  EvidenceBundleSchema,
  parsePersisted,
  TraceabilityReportSchema,
  type ArtifactContent,
  type EvidenceBundle,
  type TraceabilityReport,
  type TraceTest,
  type TraceTestStatus,
} from "@vtc/shared";
import type { StatusMeta } from "./states";

/**
 * Evidence through the artifacts route (AD-18 rules 3–4): the evidence bundle at
 * `evidenceBundlePath(id)` and the Gate Runner's traceability report, both JSON under
 * `.vtc/evidence/<T-n|F-n>/`. Anything else, or anything that breaks the contract, is shown as
 * plain text instead.
 */
export type EvidenceDoc =
  | { readonly kind: "bundle"; readonly bundle: EvidenceBundle }
  | { readonly kind: "traceability"; readonly report: TraceabilityReport };

const EVIDENCE_PATH = /^\.vtc\/evidence\/[TF]-[1-9]\d*\/(bundle|traceability)\.json$/;

export const readEvidence = (artifact: ArtifactContent): EvidenceDoc | null => {
  const match = EVIDENCE_PATH.exec(artifact.path);
  if (match === null || artifact.encoding !== "utf8") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(artifact.content);
  } catch {
    return null;
  }
  if (match[1] === "bundle") {
    const parsed = parsePersisted(EvidenceBundleSchema, raw);
    return parsed.success ? { kind: "bundle", bundle: parsed.data } : null;
  }
  const parsed = parsePersisted(TraceabilityReportSchema, raw);
  return parsed.success ? { kind: "traceability", report: parsed.data } : null;
};

// ------------------------------------------------------------------ matrix

const TEST_STATUS: Readonly<Record<TraceTestStatus, StatusMeta>> = {
  pass: { label: "Pass", tone: "ok" },
  fail: { label: "Fail", tone: "danger" },
  error: { label: "Error", tone: "warn" },
  skipped: { label: "Skipped", tone: "neutral" },
};

const PROVENANCE: Readonly<Record<TraceTest["provenance"], string>> = {
  spec: "spec",
  observed: "observed only",
  mixed: "spec and observed",
  unknown: "unknown",
};

export interface MatrixTest {
  readonly id: string;
  readonly status: StatusMeta;
  readonly hidden: boolean;
  readonly provenance: string;
}

export interface MatrixRow {
  readonly req: string;
  readonly covered: boolean;
  readonly tests: readonly MatrixTest[];
}

export interface TraceMatrix {
  readonly rows: readonly MatrixRow[];
  readonly gaps: readonly string[];
  readonly scopeCreep: readonly string[];
  readonly summary: {
    readonly reqs: number;
    readonly covered: number;
    readonly tests: number;
    readonly passing: number;
    readonly failing: number;
  };
}

/** `REQ-2` before `REQ-2.AC-1` before `REQ-10`; `SEC-*` after `REQ-*`. */
const compareReq = (a: string, b: string): number =>
  a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });

/** The REQ → test → result matrix (§7.4, §6.7a evidence): one row per requirement or AC. */
export const traceMatrix = (report: TraceabilityReport): TraceMatrix => {
  const rows = [...report.rows]
    .sort((a, b) => compareReq(a.req, b.req))
    .map((r) => ({
      req: r.req,
      covered: r.covered,
      tests: r.tests.map((t) => ({
        id: t.id,
        status: TEST_STATUS[t.status],
        hidden: t.hidden,
        provenance: PROVENANCE[t.provenance],
      })),
    }));
  const tests = report.rows.flatMap((r) => r.tests);
  return {
    rows,
    gaps: [...report.gaps].sort(compareReq),
    scopeCreep: report.scope_creep,
    summary: {
      reqs: rows.length,
      covered: rows.filter((r) => r.covered).length,
      tests: tests.length,
      passing: tests.filter((t) => t.status === "pass").length,
      failing: tests.filter((t) => t.status === "fail" || t.status === "error").length,
    },
  };
};

// ------------------------------------------------------------------ facts

export interface BundleFacts {
  readonly title: string;
  readonly stats: readonly { readonly label: string; readonly value: string }[];
  readonly verdicts: readonly {
    readonly role: string;
    readonly subject: string;
    readonly verdict: string;
    /** First 12 hex chars of the prompt version. */
    readonly prompt: string;
  }[];
  readonly gateReports: readonly string[];
  readonly tasks: readonly { readonly task: string; readonly detail: string }[];
  /** Short fingerprints of deferred findings (§6.7a step 3). */
  readonly deferred: readonly string[];
}

const usd = (value: number | null): string =>
  value === null ? "unknown (model not priced)" : `$${value.toFixed(2)}`;

const findingsText = (f: EvidenceBundle["findings"]): string =>
  [
    `${String(f.open)} open`,
    `${String(f.resolved)} resolved`,
    ...(["deferred", "waived", "discarded"] as const)
      .filter((k) => f[k] > 0)
      .map((k) => `${String(f[k])} ${k}`),
  ].join(" · ");

const tokensText = (t: EvidenceBundle["spend"]["tokens"]): string =>
  `${t.in.toLocaleString("en-US")} in · ${t.out.toLocaleString("en-US")} out`;

const rounds = (n: number): string => `${String(n)} round${n === 1 ? "" : "s"}`;

/** Header facts of a bundle: rounds, spend, findings, verdicts (task) or tasks and Final Review (feature). */
export const bundleFacts = (bundle: EvidenceBundle): BundleFacts => {
  if (bundle.kind === "task") {
    return {
      title: `Task ${bundle.task} evidence`,
      stats: [
        { label: "Discipline", value: bundle.discipline },
        { label: "Rounds", value: `${String(bundle.rounds)}/${String(bundle.cap)}` },
        { label: "Spend", value: usd(bundle.spend.usd) },
        { label: "Tokens", value: tokensText(bundle.spend.tokens) },
        { label: "Findings", value: findingsText(bundle.findings) },
      ],
      verdicts: bundle.verdicts.map((v) => ({
        role: v.role,
        subject: v.subject,
        verdict: v.verdict,
        prompt: v.prompt_sha.slice(0, 12),
      })),
      gateReports: bundle.gate_reports,
      tasks: [],
      deferred: [],
    };
  }
  return {
    title: `Feature ${bundle.feature} evidence`,
    stats: [
      {
        label: "Final Review",
        value: `${bundle.final_review.verdict} · round ${String(bundle.final_review.rounds)}/3`,
      },
      { label: "Spend", value: usd(bundle.spend.usd) },
      { label: "Tokens", value: tokensText(bundle.spend.tokens) },
      { label: "Findings", value: findingsText(bundle.findings) },
    ],
    verdicts: [],
    gateReports: [],
    tasks: bundle.tasks.map((t) => ({
      task: t.task,
      detail: `${t.discipline} · ${rounds(t.rounds)} · ${t.spend.usd === null ? "spend unknown" : usd(t.spend.usd)}`,
    })),
    deferred: bundle.deferred.map((d) => d.slice(0, 12)),
  };
};

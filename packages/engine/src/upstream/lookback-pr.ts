/**
 * The Lookback PR (H-4, D-cb; spine §5 readings 190 and 196): a replay verdict `improve` becomes a
 * PR to VTC's own repo that edits only the editable section of `roles/<role>/prompt.md` and adds a
 * `ROLES_CHANGELOG` entry (hypothesis, trace ids, diff, evaluation). Its body, CHANGELOG entry and
 * evidence come from VTC-side data only (D-by): the upstream report, the proposal's prompt text and
 * the replay statistics with tasks as ordinals.
 */
import {
  effectivePromptSha,
  engineerProfileLockedSection,
  PROMPT_MARKERS,
  ROLES_CHANGELOG,
  ROLES_CHANGELOG_ANCHOR,
  splitRolePrompt,
  type PromptProposal,
  type ReplayResult,
  type UpstreamReport,
} from "@vtc/shared";
import { fillTemplate, type TemplateSlots } from "./body.js";
import type { UpstreamEvidenceData } from "./evidence/upstream-snapshot.js";
import { autoFingerprint } from "./fingerprint.js";
import { projectUpstreamReport } from "./privacy.js";

/** The path of a role's prompt in VTC's repo. */
export const rolePromptPath = (role: string): string => `roles/${role}/prompt.md`;

/** The path of a role's contract in VTC's repo. */
export const roleYamlPath = (role: string): string => `roles/${role}/role.yaml`;

/** Pure: whether a `role.yaml` declares an engineer profile (§5.2a). */
export const isEngineerProfileYaml = (yaml: string | null): boolean =>
  yaml !== null && /^kind:\s*["']?engineer_profile["']?\s*(?:#.*)?$/m.test(yaml);

/**
 * Pure: the prompt identity Lookback measures for a role (`effectivePromptSha` of its sections,
 * AD-21 rule 1; the compiler's `prompt-parts.ts`), from `roles/<role>/prompt.md` as read: an
 * engineer profile's locked section opens with the Engineer's whole prompt
 * (`engineerProfileLockedSection`), so `engineerPrompt` is `roles/engineer/prompt.md` for a
 * profile and `null` for any other role. `null` when a prompt does not split.
 */
export const rolePromptIdentitySha = (
  prompt: string,
  engineerPrompt: string | null,
): string | null => {
  const own = splitRolePrompt(prompt);
  if (!own.ok) return null;
  if (engineerPrompt === null) return effectivePromptSha(own.locked, own.editable);
  const engineer = splitRolePrompt(engineerPrompt);
  if (!engineer.ok) return null;
  return effectivePromptSha(engineerProfileLockedSection(engineer, own.locked), own.editable);
};

/**
 * Pure: `prompt` with everything after the editable marker replaced by `editable`; the locked core
 * is byte-for-byte unchanged. Throws when the prompt's sections are broken.
 */
export const spliceEditable = (prompt: string, editable: string): string => {
  const split = splitRolePrompt(prompt);
  if (!split.ok) throw new Error(`the role prompt is not editable: ${split.errors.join("; ")}`);
  const normalized = prompt.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const at = lines.findIndex((line) => line.trim() === PROMPT_MARKERS.editable);
  const next = `${lines.slice(0, at + 1).join("\n")}\n\n${editable.trim()}\n`;
  const check = splitRolePrompt(next);
  if (!check.ok || check.locked !== split.locked) {
    throw new Error("the proposal would change the locked core");
  }
  return next;
};

/** Pure: a line diff of `before` → `after` (` `, `-`, `+` prefixes), by longest common subsequence. */
export const lineDiff = (before: string, after: string): string => {
  const a = before.split("\n");
  const b = after.split("\n");
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const row = lcs[i] ?? [];
      row[j] =
        a[i] === b[j]
          ? (lcs[i + 1]?.[j + 1] ?? 0) + 1
          : Math.max(lcs[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push(` ${a[i] ?? ""}`);
      i += 1;
      j += 1;
    } else if (j < m && (i >= n || (lcs[i]?.[j + 1] ?? 0) >= (lcs[i + 1]?.[j] ?? 0))) {
      out.push(`+${b[j] ?? ""}`);
      j += 1;
    } else {
      out.push(`-${a[i] ?? ""}`);
      i += 1;
    }
  }
  return out.join("\n");
};

/**
 * Pure: `existing` CHANGELOG with `entry` first (newest first): directly below the
 * `ROLES_CHANGELOG_ANCHOR` line, so the file's explanatory header stays on top; a file without the
 * anchor takes it after its `# ` title.
 */
export const insertChangelogEntry = (existing: string | null, entry: string): string => {
  const block = `${entry.trim()}\n`;
  if (existing === null || existing.trim() === "") return `# Role prompt changes\n\n${block}`;
  const lines = existing.split("\n");
  const anchor = lines.findIndex((line) => line.trim() === ROLES_CHANGELOG_ANCHOR);
  if (anchor >= 0) {
    const rest = lines
      .slice(anchor + 1)
      .join("\n")
      .replace(/^\n+/, "");
    return `${lines.slice(0, anchor + 1).join("\n")}\n\n${block}${rest === "" ? "" : `\n${rest}`}`;
  }
  if (lines[0]?.startsWith("# ") === true) {
    const rest = lines.slice(1).join("\n").replace(/^\n+/, "");
    return `${lines[0]}\n\n${block}${rest === "" ? "" : `\n${rest}`}`;
  }
  return `${block}\n${existing}`;
};

const passRate = (arms: readonly boolean[][]): number => {
  const all = arms.flat();
  return all.length === 0 ? 0 : Math.round((all.filter(Boolean).length / all.length) * 1000) / 1000;
};

/** Pure: the replay's numbers as upstream report metrics. */
export const replayMetrics = (replay: ReplayResult): Record<string, number> => ({
  "replay.k": replay.k,
  "replay.tasks": replay.per_task.length,
  "replay.a_pass_rate": passRate(replay.per_task.map((t) => t.a)),
  "replay.b_pass_rate": passRate(replay.per_task.map((t) => t.b)),
  "replay.aa_flip_rate": replay.aa_flip_rate,
  "replay.sign_p": replay.sign_test.p,
  "replay.discordant": replay.sign_test.n_discordant,
  "replay.wins_b": replay.sign_test.wins_b,
  "tokens.delta_pct": replay.tokens_delta_pct,
});

export interface LookbackPrParts {
  readonly fingerprint: string;
  readonly report: UpstreamReport;
  readonly summary: string;
  readonly slots: TemplateSlots;
  readonly changes: readonly { readonly path: string; readonly text: string }[];
  /**
   * The model-written text this PR adds (the proposal's summaries, hypotheses, target metrics and
   * trace ids, and the prompt lines it adds), which the path-shape check reads (D-by).
   */
  readonly freeTexts: readonly string[];
  /**
   * What the upstream-safe evidence page shows beyond the report (reading 212(3)): the replay,
   * which the module projects to ordinals with the scorecards it is given.
   */
  readonly evidence: UpstreamEvidenceData;
}

const table = (rows: readonly (readonly [string, string])[]): string =>
  ["| | |", "|---|---|", ...rows.map(([k, v]) => `| ${k} | ${v} |`)].join("\n");

/**
 * Pure: everything a Lookback PR needs from an `improve` replay, the proposal, the role's current
 * prompt and CHANGELOG, and the CHANGELOG entry template.
 */
export const buildLookbackPr = (input: {
  readonly replay: ReplayResult;
  readonly proposal: PromptProposal;
  readonly prompt: string;
  readonly changelog: string | null;
  readonly changelogTemplate: string;
  readonly vtcVersion: string;
}): LookbackPrParts => {
  const { replay, proposal } = input;
  if (replay.verdict !== "improve") throw new Error("only an improve verdict opens a PR");
  if (proposal.base.role !== replay.role) throw new Error("the proposal is for another role");
  const fingerprint = autoFingerprint({
    kind: "lookback",
    subject: replay.role,
    proposalKind: "prompt",
  });
  const metrics = replayMetrics(replay);
  const report = projectUpstreamReport({
    kind: "lookback",
    fingerprint,
    vtcVersion: input.vtcVersion,
    role: replay.role,
    mode: replay.mode,
    host: replay.host,
    promptSha: replay.baseline,
    metrics,
    occurrences: 1,
    firstSeen: replay.finished_at,
    lastSeen: replay.finished_at,
  });
  const before = splitRolePrompt(input.prompt);
  if (!before.ok) throw new Error(`the role prompt is not editable: ${before.errors.join("; ")}`);
  const nextPrompt = spliceEditable(input.prompt, proposal.editable);
  const diff = `\`\`\`diff\n${lineDiff(before.editable, proposal.editable.trim())}\n\`\`\``;
  const traceIds = proposal.changes.flatMap((c) => c.trace_ids);
  const oldLines = new Set(before.editable.split("\n").map((l) => l.trim()));
  const freeTexts = [
    ...proposal.changes.flatMap((c) => [c.summary, c.hypothesis, c.target_metric]),
    ...traceIds,
    ...proposal.editable.split("\n").filter((l) => !oldLines.has(l.trim())),
  ];
  const evaluation = table([
    ["verdict", "improve"],
    ["trials per task (k)", String(replay.k)],
    ["tasks", String(replay.per_task.length)],
    [
      "pass rate A → B",
      `${String(metrics["replay.a_pass_rate"])} → ${String(metrics["replay.b_pass_rate"])}`,
    ],
    ["A/A flip rate", String(replay.aa_flip_rate)],
    [
      "sign test",
      `p = ${String(replay.sign_test.p)} (${String(replay.sign_test.wins_b)}/${String(replay.sign_test.n_discordant)} discordant won by B)`,
    ],
    ["tokens", `${replay.tokens_delta_pct >= 0 ? "+" : ""}${String(replay.tokens_delta_pct)}%`],
    ["grader", replay.grader ?? "gates"],
    ["isolation", replay.isolation ?? "paths_only"],
  ]);
  const summary = `improve the ${replay.role} prompt`;
  const hypotheses = proposal.changes
    .map((c) => `- ${c.hypothesis} (target: \`${c.target_metric}\`)`)
    .join("\n");
  const entry = fillTemplate(input.changelogTemplate, {
    title: `${replay.finished_at.slice(0, 10)} ${replay.role}: ${proposal.changes.map((c) => c.summary).join("; ")}`,
    hypothesis: proposal.changes.map((c) => c.hypothesis).join(" / "),
    trace_ids: traceIds.map((t) => `\`${t}\``).join(", "),
    diff,
    evaluation,
  });
  const slots: TemplateSlots = {
    summary: `Lookback's replay found that this edit of the \`${replay.role}\` prompt's editable section improves its results on ${replay.host}: ${proposal.changes.map((c) => c.summary).join("; ")}.`,
    why: `${hypotheses}\n\n${evaluation}`,
    changes: [
      `- \`${rolePromptPath(replay.role)}\`: the editable section only (the locked core is unchanged)`,
      `- \`${ROLES_CHANGELOG}\`: an entry with the hypothesis, trace ids, diff and evaluation`,
    ].join("\n"),
    diff,
    verification: evaluation,
    risk: "A prompt-only change to one role's editable section. Revert this PR to roll back; after the release, Lookback's canary and auto-rollback watch the role's escalation, cap-hit and token rates.",
    provenance: [
      "<details><summary>Provenance</summary>",
      "",
      `- role: \`${replay.role}\`, host: \`${replay.host}\``,
      `- prompt before: \`${replay.baseline}\``,
      `- prompt after: \`${replay.candidate}\``,
      `- grader bundle: \`${replay.grader_bundle_sha}\``,
      `- trace ids: ${traceIds.map((t) => `\`${t}\``).join(", ")}`,
      `- VTC ${input.vtcVersion}; generated by VTC (AI); human review required.`,
      "",
      "</details>",
    ].join("\n"),
    checklist: [
      "- [ ] The diff touches the editable section only",
      "- [ ] The hypothesis matches the evaluation",
      "- [ ] The A/A flip rate is below the improvement",
    ].join("\n"),
    hypothesis: hypotheses,
    trace_ids: traceIds.join(", "),
    evaluation,
  };
  return {
    fingerprint,
    report,
    summary,
    slots,
    freeTexts,
    changes: [
      { path: rolePromptPath(replay.role), text: nextPrompt },
      { path: ROLES_CHANGELOG, text: insertChangelogEntry(input.changelog, entry) },
    ],
    evidence: { replay },
  };
};

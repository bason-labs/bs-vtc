/**
 * Slots of an upstream issue (D-by; AD-27 rule 5): rendered from an `UpstreamReport` alone, so
 * nothing but VTC-side data can reach VTC's own repo.
 */
import { renderAutoMarker, type UpstreamReport } from "@vtc/shared";
import { renderNote, renderTitle, UNAVAILABLE, type TemplateSlots } from "./body.js";
import { routingCellLine, routingChangeRule, type UpstreamSubject } from "./subject.js";

const code = (value: string | undefined): string =>
  value === undefined ? UNAVAILABLE : `\`${value}\``;

const RISK_LABEL: Readonly<Record<string, string>> = {
  none: "no risk tag",
  tagged: "a risk tag",
  high: "high risk",
};

/** Pure: the one-line symptom of an improvement with a rendered subject (D-cs, D-cn). */
const subjectSymptom = (subject: UpstreamSubject): string => {
  switch (subject.kind) {
    case "tool":
      return `promote the recurring command \`${subject.shape.program}${subject.shape.subcommand === undefined ? "" : ` ${subject.shape.subcommand}`}\` to an engine tool`;
    case "capability":
      return `missing capability \`${subject.slug}\``;
    case "routing":
      return `routing: ${subject.role} start tier for ${subject.size} tasks, ${RISK_LABEL[subject.risk] ?? subject.risk}`;
    case "config":
      return `config change \`${subject.key}\``;
  }
};

/** Pure: the issue's lines that say what the subject is, in VTC's vocabulary only. */
const subjectLines = (subject: UpstreamSubject): string[] => {
  switch (subject.kind) {
    case "tool":
      return [
        `Command shape: \`${subject.shape.program}\`, subcommand \`${subject.shape.subcommand ?? "-"}\`, flag set \`${subject.shape.flags}\` (no argument value or path is recorded).`,
      ];
    case "capability":
      return [`Missing capability: \`${subject.slug}\` (the escalations' reasons stay local).`];
    case "routing":
      return [routingCellLine(subject), "", routingChangeRule(subject)];
    case "config":
      return [`Config key: \`${subject.key}\``];
  }
};

/** Pure: the one-line symptom of an upstream report, for its title. */
export const reportSymptom = (report: UpstreamReport, subject?: UpstreamSubject): string => {
  if (subject !== undefined) return subjectSymptom(subject);
  switch (report.kind) {
    case "defect":
      return `${report.error_class ?? "defect"} in ${report.role ?? "the engine"}`;
    case "cost":
      return `${report.role ?? "a role"} costs more than its baseline`;
    case "security":
      return report.advisory === undefined
        ? "security advisory in a dependency"
        : `${report.advisory.id} in ${report.advisory.package}`;
    case "lookback":
      return `improve the ${report.role ?? "role"} prompt`;
    default:
      return `${report.kind.replace("_", " ")} proposal${report.role === undefined ? "" : ` for ${report.role}`}`;
  }
};

const CHECKLISTS: Readonly<Record<UpstreamReport["kind"], readonly string[]>> = {
  defect: ["Reproduce from the frames and error class", "Fix or label `vtc:muted`"],
  cost: ["Check the metric against the baseline prompt", "Review the Lookback proposal it raised"],
  security: ["Check the advisory applies", "Review the dependency-bump PR"],
  lookback: ["Read the editable-section diff", "Check the replay evaluation and A/A rate"],
  new_agent: ["Check the missing discipline is real", "Review the role scaffold"],
  tool: ["Check the script recurs across tasks", "Review the promoted tool"],
  config: ["Check the cap, budget or routing change"],
  capability: ["Check the escalations that asked for it"],
};

/** A routing-table change (D-cn). */
const ROUTING_CHECKLIST: readonly string[] = [
  "Check the routing scorecard charts for the cell",
  "Check that the PR changes only the values of `DEFAULT_ROUTING_TABLE`",
];

/**
 * Pure: the issue slots of `report` (`regressionOf`: the closed issue it recurs after; `subject`:
 * the improvement's projected subject, see `subject.ts`).
 */
export const upstreamIssueSlots = (
  report: UpstreamReport,
  options: {
    readonly regressionOf?: number | undefined;
    readonly subject?: UpstreamSubject | undefined;
  } = {},
): TemplateSlots => {
  const { subject } = options;
  const metrics = Object.entries(report.metrics);
  const evidence = [
    ...(subject === undefined ? [] : [...subjectLines(subject), ""]),
    ...(report.vtc_frames.length === 0 ? [] : ["VTC frames:", "```", ...report.vtc_frames, "```"]),
    ...(metrics.length === 0
      ? []
      : ["| metric | value |", "|---|---|", ...metrics.map(([k, v]) => `| ${k} | ${String(v)} |`)]),
  ].join("\n");
  return {
    marker: renderAutoMarker({
      v: 1,
      kind: report.kind,
      fp: report.fingerprint,
      ...(report.role === undefined ? {} : { role: report.role }),
    }),
    note: renderNote({
      kind: report.kind,
      pr: false,
      disclosure: { vtcVersion: report.vtc_version, host: report.host, model: report.model },
    }),
    title: renderTitle(report.kind, reportSymptom(report, subject)),
    summary: [
      ...(options.regressionOf === undefined
        ? []
        : [`Regression of #${String(options.regressionOf)}.`]),
      `${reportSymptom(report, subject)}.`,
    ].join(" "),
    why: [
      "| occurrences | first seen | last seen | VTC |",
      "|---|---|---|---|",
      `| ${String(report.occurrences)} | ${report.first_seen} | ${report.last_seen} | ${report.vtc_version} |`,
    ].join("\n"),
    evidence: evidence === "" ? UNAVAILABLE : evidence,
    provenance: [
      "<details><summary>Provenance</summary>",
      "",
      `- role: ${code(report.role)}${report.mode === undefined ? "" : ` (mode ${code(report.mode)})`}`,
      `- host: ${code(report.host)}, model: ${code(report.model)}`,
      `- prompt: ${code(report.prompt_sha)}`,
      `- error class: ${code(report.error_class)}`,
      `- VTC ${report.vtc_version}; generated by VTC (AI); human review required.`,
      "",
      "</details>",
    ].join("\n"),
    checklist: (subject?.kind === "routing" ? ROUTING_CHECKLIST : CHECKLISTS[report.kind])
      .map((item) => `- [ ] ${item}`)
      .join("\n"),
  };
};

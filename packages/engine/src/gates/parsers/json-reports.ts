/**
 * Tool JSON reports (AD-13 rule 9), recognised by shape so a gate needs no parser setting:
 * ESLint (`-f json`), Ruff (`--output-format json`), golangci-lint (`--out-format json`),
 * Gitleaks (`--report-format json`), osv-scanner (`--format json`) and diff-cover
 * (`--json-report`, metrics only). Pure.
 */
import {
  categoryForTool,
  clipMessage,
  clipRule,
  clipTitle,
  relativeLocation,
  type ParseContext,
  type ParsedFinding,
  type ParsedFindings,
} from "./types.js";

type Json = Record<string, unknown>;

const obj = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const line = (value: unknown): number | undefined => {
  const n = num(value);
  return n !== undefined && Number.isInteger(n) && n > 0 ? n : undefined;
};

export type JsonReportKind =
  "eslint" | "ruff" | "golangci" | "gitleaks" | "osv" | "diff_cover" | "unknown";

export const detectJsonReport = (doc: unknown): JsonReportKind => {
  if (Array.isArray(doc)) {
    if (doc.length === 0) return "eslint";
    const first = obj(doc[0]);
    if ("filePath" in first && "messages" in first) return "eslint";
    if ("RuleID" in first && "File" in first) return "gitleaks";
    if ("code" in first && "filename" in first && "location" in first) return "ruff";
    return "unknown";
  }
  const o = obj(doc);
  if ("src_stats" in o && "total_percent_covered" in o) return "diff_cover";
  if (Array.isArray(o.Issues)) return "golangci";
  if (Array.isArray(o.results) && arr(o.results).every((r) => "packages" in obj(r))) return "osv";
  return "unknown";
};

const base = (
  tool: string,
  ctx: ParseContext,
  index: number,
  fields: {
    rule: string;
    title: string;
    message?: string | undefined;
    path?: string | undefined;
    line?: number | undefined;
    endLine?: number | undefined;
    symbol?: string | undefined;
    snippet?: string | undefined;
  },
): ParsedFinding => {
  const start = fields.line;
  const end =
    fields.endLine !== undefined && start !== undefined && fields.endLine >= start
      ? fields.endLine
      : undefined;
  return {
    tool,
    rule_id: clipRule(fields.rule),
    category: categoryForTool(tool, ctx.defaultCategory),
    title: clipTitle(fields.title),
    ...(fields.message === undefined || fields.message === ""
      ? {}
      : { message: clipMessage(fields.message) }),
    location: {
      path: relativeLocation(fields.path, ctx),
      ...(fields.symbol === undefined ? {} : { symbol: fields.symbol.slice(0, 512) }),
      ...(start === undefined ? {} : { line: start }),
      ...(end === undefined ? {} : { end_line: end }),
    },
    ...(fields.snippet === undefined || fields.snippet === ""
      ? {}
      : { snippet: clipMessage(fields.snippet) }),
    index,
  };
};

const eslint = (doc: unknown[], ctx: ParseContext): ParsedFindings => {
  const findings: ParsedFinding[] = [];
  for (const fileValue of doc) {
    const file = obj(fileValue);
    for (const messageValue of arr(file.messages)) {
      const m = obj(messageValue);
      // "File ignored because…" notices for paths ESLint does not lint are not violations.
      if (m.ruleId === null && /^File ignored\b/.test(str(m.message) ?? "")) continue;
      const severity = num(m.severity);
      const text = str(m.message) ?? "";
      findings.push({
        ...base("eslint", ctx, findings.length, {
          rule: str(m.ruleId) ?? (m.fatal === true ? "parse-error" : "unknown"),
          title: text,
          message: text,
          path: str(file.filePath),
          line: line(m.line),
          endLine: line(m.endLine),
        }),
        label: severity === 2 ? "error" : "warning",
      });
    }
  }
  return { findings, secrets: [] };
};

const ruff = (doc: unknown[], ctx: ParseContext): ParsedFindings => ({
  findings: doc.map((value, index) => {
    const v = obj(value);
    const text = str(v.message) ?? "";
    return base("ruff", ctx, index, {
      rule: str(v.code) ?? "unknown",
      title: text,
      message: text,
      path: str(v.filename),
      line: line(obj(v.location).row),
      endLine: line(obj(v.end_location).row),
    });
  }),
  secrets: [],
});

const golangci = (doc: Json, ctx: ParseContext): ParsedFindings => ({
  findings: arr(doc.Issues).map((value, index) => {
    const v = obj(value);
    const pos = obj(v.Pos);
    const text = str(v.Text) ?? "";
    const severity = str(v.Severity);
    return {
      ...base("golangci-lint", ctx, index, {
        rule: str(v.FromLinter) ?? "unknown",
        title: text,
        message: text,
        path: str(pos.Filename),
        line: line(pos.Line),
        snippet: arr(v.SourceLines)
          .filter((s) => typeof s === "string")
          .join("\n"),
      }),
      ...(severity === undefined || severity === "" ? {} : { label: severity.slice(0, 50) }),
    };
  }),
  secrets: [],
});

const gitleaks = (doc: unknown[], ctx: ParseContext): ParsedFindings => {
  const secrets: string[] = [];
  const findings = doc.map((value, index) => {
    const v = obj(value);
    const secret = str(v.Secret);
    const match = str(v.Match);
    for (const s of [secret, match]) if (s !== undefined && s.trim() !== "") secrets.push(s);
    return base("gitleaks", ctx, index, {
      rule: str(v.RuleID) ?? "unknown",
      title: str(v.Description) ?? "secret",
      path: str(v.File),
      line: line(v.StartLine),
      endLine: line(v.EndLine),
      // The match is the snippet: redacted with the secrets before anything is written.
      snippet: match,
    });
  });
  return { findings, secrets };
};

const osv = (doc: Json, ctx: ParseContext): ParsedFindings => {
  const findings: ParsedFinding[] = [];
  for (const resultValue of arr(doc.results)) {
    const result = obj(resultValue);
    const source = str(obj(result.source).path);
    for (const pkgValue of arr(result.packages)) {
      const pkg = obj(pkgValue);
      const info = obj(pkg.package);
      const symbol = `${str(info.name) ?? "?"}@${str(info.version) ?? "?"}`;
      const groups = arr(pkg.groups).map(obj);
      for (const vulnValue of arr(pkg.vulnerabilities)) {
        const vuln = obj(vulnValue);
        const id = str(vuln.id) ?? "unknown";
        const group = groups.find((g) => arr(g.ids).includes(id) || arr(g.aliases).includes(id));
        const maxSeverity = Number(str(group?.max_severity) ?? Number.NaN);
        const label = str(obj(vuln.database_specific).severity);
        findings.push({
          ...base("osv-scanner", ctx, findings.length, {
            rule: id,
            title: `${symbol}: ${str(vuln.summary) ?? id}`,
            message: str(vuln.details)?.slice(0, 4000),
            path: source,
            symbol,
          }),
          category: "supply_chain",
          ...(Number.isFinite(maxSeverity) && maxSeverity >= 0 && maxSeverity <= 10
            ? { score: maxSeverity }
            : {}),
          ...(label === undefined || label === "" ? {} : { label: label.slice(0, 50) }),
        });
      }
    }
  }
  return { findings, secrets: [] };
};

/** Findings of a tool JSON report; diff-cover and unknown shapes have none. */
export const parseJsonFindings = (doc: unknown, ctx: ParseContext): ParsedFindings => {
  switch (detectJsonReport(doc)) {
    case "eslint":
      return eslint(doc as unknown[], ctx);
    case "ruff":
      return ruff(doc as unknown[], ctx);
    case "golangci":
      return golangci(obj(doc), ctx);
    case "gitleaks":
      return gitleaks(doc as unknown[], ctx);
    case "osv":
      return osv(obj(doc), ctx);
    case "diff_cover":
    case "unknown":
      return { findings: [], secrets: [] };
  }
};

/** diff-cover's total diff coverage in percent, or `null` when the report has none. */
export const diffCoveragePct = (doc: unknown): number | null => {
  if (detectJsonReport(doc) !== "diff_cover") return null;
  const pct = num(obj(doc).total_percent_covered);
  return pct === undefined ? null : Math.min(100, Math.max(0, pct));
};

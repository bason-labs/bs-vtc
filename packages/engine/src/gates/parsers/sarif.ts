/**
 * SARIF 2.1.0 reports (Opengrep, Checkov, Gitleaks, osv-scanner, any linter with a SARIF
 * formatter) → tool findings with the raw severity signals `normalizeSeverity` reads: the rule's
 * `security-severity` score, a tool label and the SARIF level (AD-13 rule 9). Pure.
 */
import { SarifLevelSchema, type FindingCategory } from "@vtc/shared";
import {
  categoryForTool,
  clipMessage,
  clipRule,
  clipTitle,
  cweFrom,
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

export const isSarif = (doc: unknown): boolean => {
  const o = obj(doc);
  return Array.isArray(o.runs) && (o.version === "2.1.0" || typeof o.$schema === "string");
};

const scoreOf = (value: unknown): number | undefined => {
  const n = typeof value === "number" ? value : Number(str(value) ?? Number.NaN);
  return Number.isFinite(n) && n >= 0 && n <= 10 ? n : undefined;
};

const labelOf = (value: unknown): string | undefined => {
  const s = str(value)?.trim();
  return s === undefined || s === "" ? undefined : s.slice(0, 50);
};

const SECURITY_TAG = /^(security|vulnerability|cwe|owasp)/i;

/** Parses a SARIF document (already JSON-decoded). */
export const parseSarif = (doc: unknown, ctx: ParseContext): ParsedFindings => {
  const findings: ParsedFinding[] = [];
  const secrets: string[] = [];
  let index = 0;
  for (const runValue of arr(obj(doc).runs)) {
    const run = obj(runValue);
    const driver = obj(obj(run.tool).driver);
    const tool = (str(driver.name) ?? "sarif").trim().slice(0, 100) || "sarif";
    const rules = arr(driver.rules).map(obj);
    const ruleById = new Map(rules.map((r) => [str(r.id) ?? "", r]));
    for (const resultValue of arr(run.results)) {
      const result = obj(resultValue);
      const ruleIndex = typeof result.ruleIndex === "number" ? result.ruleIndex : -1;
      const ruleId = str(result.ruleId) ?? str(obj(result.rule).id) ?? "";
      const rule = ruleById.get(ruleId) ?? rules[ruleIndex] ?? {};
      const props = obj(rule.properties);
      const resultProps = obj(result.properties);
      const tags = [...arr(props.tags), ...arr(resultProps.tags)];
      const location = obj(obj(arr(result.locations)[0]).physicalLocation);
      const region = obj(location.region);
      const uri = str(obj(location.artifactLocation).uri);
      const message = str(obj(result.message).text) ?? "";
      const title =
        str(obj(rule.shortDescription).text) ?? str(obj(rule.fullDescription).text) ?? message;
      const level = SarifLevelSchema.safeParse(
        result.level ?? obj(rule.defaultConfiguration).level,
      );
      const fallback: FindingCategory = tags.some(
        (t) => typeof t === "string" && SECURITY_TAG.test(t),
      )
        ? "security"
        : ctx.defaultCategory;
      const category = categoryForTool(tool, fallback);
      const snippet = str(obj(region.snippet).text);
      const line =
        typeof region.startLine === "number" && region.startLine > 0 ? region.startLine : undefined;
      const end =
        typeof region.endLine === "number" && line !== undefined && region.endLine >= line
          ? region.endLine
          : undefined;
      const cwe = cweFrom(tags);
      const score = scoreOf(props["security-severity"] ?? resultProps["security-severity"]);
      const label = labelOf(resultProps.severity ?? props.severity ?? props.problem_severity);
      if (category === "secret" && snippet !== undefined && snippet.trim() !== "") {
        secrets.push(snippet.trim());
      }
      findings.push({
        tool,
        rule_id: clipRule(ruleId === "" ? (str(rule.id) ?? "unknown") : ruleId),
        category,
        title: clipTitle(title),
        ...(message === "" ? {} : { message: clipMessage(message) }),
        location: {
          path: relativeLocation(uri, ctx),
          ...(line === undefined ? {} : { line }),
          ...(end === undefined ? {} : { end_line: end }),
        },
        ...(snippet === undefined ? {} : { snippet: clipMessage(snippet) }),
        ...(cwe === undefined ? {} : { cwe }),
        ...(score === undefined ? {} : { score }),
        ...(label === undefined ? {} : { label }),
        ...(level.success ? { sarif_level: level.data } : {}),
        index,
      });
      index += 1;
    }
  }
  return { findings, secrets };
};

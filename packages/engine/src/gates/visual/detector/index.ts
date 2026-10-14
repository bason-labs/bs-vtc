/**
 * The design detector (§9.1, AD-24 rule 7): slop rules ported from Apache-2.0 impeccable
 * (`THIRD_PARTY/impeccable/`), run on the changed UI source of a gate run with no browser, no
 * network and no telemetry. A hit the same file already had at the base commit is baseline
 * (§7.1) and is not reported. Findings carry `vtc-design/<id>` (`VISUAL_RULE_PREFIX.detector`)
 * and category `design`; triage routes them to the Designer (`routeForFinding`).
 */
import { VISUAL_RULE_PREFIX, type ToolFinding } from "@vtc/shared";
import { isUiSource } from "../token-lint.js";
import { detectorRule } from "./catalog.js";
import { matchLine } from "./line-rules.js";
import { STYLE_ANALYZERS, TEXT_ANALYZERS } from "./page-rules.js";

export { DETECTOR_RULES, detectorRule, type DetectorRule } from "./catalog.js";

export const DETECTOR_TOOL = "vtc-design-detector";

const STYLESHEET = /\.(css|scss|sass|less|pcss|styl)$/i;

export interface DetectorHit {
  readonly rule: string;
  readonly snippet: string;
  readonly line?: number;
  /** Page-level hits are compared with the base by rule alone (their counts move). */
  readonly page: boolean;
}

/** Every hit in one file's content. */
export const detect = (path: string, content: string): DetectorHit[] => {
  const hits: DetectorHit[] = [];
  const seen = new Set<string>();
  content.split("\n").forEach((text, i) => {
    for (const hit of matchLine(text)) {
      const key = `${hit.rule}\u0000${String(i)}\u0000${hit.snippet}`;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push({ ...hit, line: i + 1, page: false });
    }
  });
  const analyzers = STYLESHEET.test(path)
    ? STYLE_ANALYZERS
    : [...STYLE_ANALYZERS, ...TEXT_ANALYZERS];
  for (const analyze of analyzers) {
    const hit = analyze(content);
    if (hit !== null) hits.push({ ...hit, page: true });
  }
  return hits;
};

const keyOf = (hit: DetectorHit): string =>
  hit.page ? `page\u0000${hit.rule}` : `line\u0000${hit.rule}\u0000${hit.snippet}`;

export interface DetectorFile {
  readonly path: string;
  /** The file at the head commit. */
  readonly head: string;
  /** The file at the base commit; absent for an added file. */
  readonly base?: string | undefined;
}

/** The new hits of changed UI files as tool findings, sorted by path and line. */
export const detectorFindings = (files: readonly DetectorFile[]): ToolFinding[] => {
  const findings: ToolFinding[] = [];
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    if (!isUiSource(file.path)) continue;
    const baseline = new Map<string, number>();
    for (const hit of file.base === undefined ? [] : detect(file.path, file.base)) {
      baseline.set(keyOf(hit), (baseline.get(keyOf(hit)) ?? 0) + 1);
    }
    for (const hit of detect(file.path, file.head)) {
      const left = baseline.get(keyOf(hit)) ?? 0;
      if (left > 0) {
        baseline.set(keyOf(hit), left - 1);
        continue;
      }
      const rule = detectorRule(hit.rule);
      const line = hit.line;
      findings.push({
        tool: DETECTOR_TOOL,
        rule_id: `${VISUAL_RULE_PREFIX.detector}${hit.rule}`,
        category: "design",
        title: `${rule?.name ?? hit.rule}: ${hit.snippet}`.slice(0, 200),
        ...(rule === undefined ? {} : { message: rule.description }),
        location: { path: file.path, ...(line === undefined ? {} : { line }) },
        evidence:
          line === undefined
            ? { type: "file", ref: file.path }
            : { type: "file_line", ref: `${file.path}:${String(line)}` },
        snippet: hit.snippet,
        sarif_level: rule?.advisory === true ? "note" : "warning",
      });
    }
  }
  return findings;
};

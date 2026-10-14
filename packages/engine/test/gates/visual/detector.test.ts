import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { routeForFinding, ToolFindingSchema, VISUAL_RULE_PREFIX } from "@vtc/shared";
import {
  detect,
  DETECTOR_RULES,
  detectorFindings,
} from "../../../src/gates/visual/detector/index.js";
import { googleFontFamilies } from "../../../src/gates/visual/detector/line-rules.js";

const DIR = join(import.meta.dirname, "fixtures", "detector");
const fixtures = readdirSync(DIR);
const fixture = (rule: string, kind: "flag" | "pass"): { path: string; content: string } => {
  // `<rule>.<flag|pass>.<ext>.fixture`: the suffix keeps formatters away from the fixtures.
  const name = fixtures.find((f) => f.startsWith(`${rule}.${kind}.`));
  if (name === undefined) throw new Error(`no ${kind} fixture for ${rule}`);
  return {
    path: `web/${name.replace(/\.fixture$/, "")}`,
    content: readFileSync(join(DIR, name), "utf8"),
  };
};

describe("design detector: one fixture pair per rule", () => {
  for (const rule of DETECTOR_RULES) {
    it(`${rule.id} flags its fixture and passes the clean one`, () => {
      const flag = fixture(rule.id, "flag");
      const pass = fixture(rule.id, "pass");
      expect(detect(flag.path, flag.content).map((h) => h.rule)).toContain(rule.id);
      expect(detect(pass.path, pass.content).map((h) => h.rule)).not.toContain(rule.id);
    });
  }

  it("has no fixture for a rule it does not have", () => {
    const ids = new Set(DETECTOR_RULES.map((r) => r.id));
    for (const name of fixtures) expect(ids.has(name.split(".")[0] ?? "")).toBe(true);
  });

  it("names every rule's upstream origin without using the upstream brand in rule ids", () => {
    for (const rule of DETECTOR_RULES) {
      expect(rule.derivedFrom).toBe(`impeccable:${rule.id}`);
      expect(rule.id).toMatch(/^[a-z0-9-]+$/);
    }
  });
});

describe("detector findings", () => {
  it("reports only hits the base version of the file did not have, as Designer findings", () => {
    const head = [
      '<div class="card border-l-4 p-4">old</div>',
      '<h2 class="text-4xl text-violet-600">new</h2>',
    ].join("\n");
    const base = '<div class="card border-l-4 p-4">old</div>\n';
    const findings = detectorFindings([
      { path: "web/page.html", head, base },
      { path: "src/server.ts", head: "border-l-4" },
    ]);
    expect(findings).toHaveLength(1);
    const [f] = findings;
    expect(ToolFindingSchema.parse(f)).toEqual(f);
    expect(f).toMatchObject({
      tool: "vtc-design-detector",
      rule_id: `${VISUAL_RULE_PREFIX.detector}ai-color-palette`,
      category: "design",
      location: { path: "web/page.html", line: 2 },
      evidence: { type: "file_line", ref: "web/page.html:2" },
      sarif_level: "warning",
    });
    expect(
      routeForFinding({
        source: "tool",
        category: "design",
        severity: "medium",
        ruleId: f?.rule_id,
      }),
    ).toBe("design_gap");
  });

  it("reports advisory rules as notes and page-level hits without a line", () => {
    const em = fixture("em-dash-overuse", "flag");
    const [f] = detectorFindings([{ path: em.path, head: em.content }]);
    expect(f).toMatchObject({ sarif_level: "note", evidence: { type: "file", ref: em.path } });
    expect(f?.location.line).toBeUndefined();
  });

  it("reads Google Fonts family parameters", () => {
    expect(
      googleFontFamilies(
        "fonts.googleapis.com/css2?family=Inter:wght@400;700&amp;family=Playfair+Display&display=swap",
      ),
    ).toEqual(["inter", "playfair display"]);
    expect(googleFontFamilies("fonts.googleapis.com/css?family=Roboto|Open+Sans:400,700")).toEqual([
      "roboto",
      "open sans",
    ]);
  });
});

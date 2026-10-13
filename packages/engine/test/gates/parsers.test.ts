/** Report parsers (§18: unit tests for every parser; AD-13 rule 9). */
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { ToolFindingSchema, normalizeSeverity, TestRecordSchema } from "@vtc/shared";
import { describe, expect, it } from "vitest";
import {
  detectJsonReport,
  diffCoveragePct,
  parseJsonFindings,
  parseJunit,
  parseSarif,
  parseXml,
} from "../../src/gates/index.js";
import { relativeLocation } from "../../src/gates/parsers/types.js";
import { cleanupDirs, tempDir, writeFile } from "../helpers/repo.js";

const ctx = {
  checkoutAbs: "/repo/.vtc/state/checkouts/abc",
  defaultCategory: "security" as const,
  fallbackPath: ".vtc/state/gates/report.json",
};

const withEvidence = ({ index, ...f }: { index: number }): unknown => ({
  ...f,
  evidence: { type: "sarif", ref: `.vtc/evidence/T-1/r.sarif#${String(index)}` },
});

describe("parseXml", () => {
  it("decodes entities, CDATA and skips comments and doctypes without resolving them", () => {
    const root = parseXml(
      '<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><!-- c --><a b="1 &amp; 2"><c>x &lt; y &#65;&e;</c><![CDATA[<raw>]]></a>',
    );
    expect(root.attrs.b).toBe("1 & 2");
    expect(root.children[0]?.text).toBe("x < y A&e;");
    expect(root.text).toBe("<raw>");
  });
  it("rejects mismatched and unclosed tags", () => {
    expect(() => parseXml("<a><b></a>")).toThrow(/does not match/);
    expect(() => parseXml("<a>")).toThrow(/unclosed/);
    expect(() => parseXml("text only")).toThrow(/no root/);
  });
});

describe("parseJunit (§7.2 L2)", () => {
  const vitest = `<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="4" failures="1" errors="0" time="0.1">
  <testsuite name="tests/api.test.ts" tests="4">
    <testcase classname="tests/api.test.ts" name="reset &gt; [REQ-3.AC-2] sends the email" time="0.01" assertions="3"/>
    <testcase classname="tests/api.test.ts" name="reset &gt; rejects unknown users" time="0.01">
      <failure message="expected 404 to be 400" type="AssertionError">at tests/api.test.ts:12:5</failure>
    </testcase>
    <testcase classname="tests/api.test.ts" name="reset &gt; todo" time="0"><skipped/></testcase>
    <testcase classname="tests/api.test.ts" name="reset &gt; crashes" time="0"><error message="boom"/></testcase>
  </testsuite>
</testsuites>`;
  it("reads ids with the classname, statuses, assertions and messages, sorted", () => {
    const cases = parseJunit(vitest);
    expect(cases.map((c) => [c.id, c.status, c.assertions])).toEqual([
      ["tests/api.test.ts > reset > [REQ-3.AC-2] sends the email", "pass", 3],
      ["tests/api.test.ts > reset > crashes", "error", null],
      ["tests/api.test.ts > reset > rejects unknown users", "fail", null],
      ["tests/api.test.ts > reset > todo", "skipped", null],
    ]);
    expect(cases[2]?.message).toContain("expected 404 to be 400");
    expect(cases[0]?.file).toBe("tests/api.test.ts");
    for (const c of cases)
      TestRecordSchema.parse({ id: c.id, status: c.status, assertions: c.assertions });
  });
  it("reads a bare pytest testsuite and keeps the worst status of a retried test", () => {
    const pytest = `<testsuite name="pytest"><testcase classname="tests.test_auth" name="test_login" file="tests/test_auth.py"/>
      <testcase classname="tests.test_auth" name="test_login"><failure message="no"/></testcase></testsuite>`;
    const cases = parseJunit(pytest);
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      id: "tests.test_auth > test_login",
      status: "fail",
      file: "tests/test_auth.py",
    });
  });
  it("refuses a document that is not JUnit", () => {
    expect(() => parseJunit("<html></html>")).toThrow(/not a JUnit report/);
  });
});

describe("parseSarif", () => {
  const sarif = {
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: "opengrep",
            rules: [
              {
                id: "js.eval",
                shortDescription: { text: "Use of eval" },
                properties: {
                  tags: ["security", "CWE-95: eval injection"],
                  "security-severity": "8.1",
                },
              },
              { id: "style.x", defaultConfiguration: { level: "note" } },
            ],
          },
        },
        results: [
          {
            ruleId: "js.eval",
            level: "error",
            message: { text: "eval of user input" },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "file:///repo/.vtc/state/checkouts/abc/src/a.ts" },
                  region: { startLine: 4, endLine: 5, snippet: { text: "eval(x)" } },
                },
              },
            ],
          },
          {
            ruleIndex: 1,
            ruleId: "style.x",
            message: { text: "style" },
            locations: [{ physicalLocation: { artifactLocation: { uri: "/etc/passwd" } } }],
          },
        ],
      },
      {
        tool: { driver: { name: "gitleaks" } },
        results: [
          {
            ruleId: "aws-access-key",
            message: { text: "AWS key" },
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: "config/prod.env" },
                  region: { startLine: 2, snippet: { text: "AKIAABCDEFGHIJKLMNOP" } },
                },
              },
            ],
          },
        ],
      },
    ],
  };
  it("extracts raw severity signals, CWE, location and categories", () => {
    const { findings, secrets } = parseSarif(sarif, ctx);
    expect(findings).toHaveLength(3);
    const [evalFinding, style, leak] = findings;
    expect(evalFinding).toMatchObject({
      tool: "opengrep",
      rule_id: "js.eval",
      category: "security",
      title: "Use of eval",
      cwe: "CWE-95",
      score: 8.1,
      sarif_level: "error",
      location: { path: "src/a.ts", line: 4, end_line: 5 },
      snippet: "eval(x)",
      index: 0,
    });
    expect(style).toMatchObject({ sarif_level: "note", location: { path: ctx.fallbackPath } });
    expect(leak).toMatchObject({
      category: "secret",
      location: { path: "config/prod.env" },
      index: 2,
    });
    expect(secrets).toEqual(["AKIAABCDEFGHIJKLMNOP"]);
    for (const f of findings) ToolFindingSchema.parse(withEvidence(f));
    expect(
      normalizeSeverity({
        source: "tool",
        score: evalFinding!.score!,
        sarifLevel: evalFinding!.sarif_level!,
      }),
    ).toBe("high");
  });
});

describe("tool JSON reports", () => {
  it("reads ESLint output", () => {
    const doc = [
      {
        filePath: "/repo/.vtc/state/checkouts/abc/src/a.ts",
        messages: [
          { ruleId: "no-unused-vars", severity: 2, message: "x is unused", line: 3, endLine: 3 },
        ],
      },
    ];
    expect(detectJsonReport(doc)).toBe("eslint");
    const { findings } = parseJsonFindings(doc, { ...ctx, defaultCategory: "maintainability" });
    expect(findings[0]).toMatchObject({
      tool: "eslint",
      rule_id: "no-unused-vars",
      category: "maintainability",
      label: "error",
      location: { path: "src/a.ts", line: 3 },
    });
  });
  it("reads Gitleaks output and returns the secrets for redaction", () => {
    const doc = [
      {
        Description: "GitHub token",
        StartLine: 7,
        EndLine: 7,
        Match: "token = ghp_secretvalue",
        Secret: "ghp_secretvalue",
        File: "src/config.ts",
        RuleID: "github-pat",
      },
    ];
    const { findings, secrets } = parseJsonFindings(doc, ctx);
    expect(findings[0]).toMatchObject({
      category: "secret",
      rule_id: "github-pat",
      location: { path: "src/config.ts", line: 7 },
    });
    expect(secrets).toEqual(["ghp_secretvalue", "token = ghp_secretvalue"]);
  });
  it("reads osv-scanner output with the group's max severity as score", () => {
    const doc = {
      results: [
        {
          source: { path: "/repo/.vtc/state/checkouts/abc/pnpm-lock.yaml", type: "lockfile" },
          packages: [
            {
              package: { name: "lodash", version: "4.17.15", ecosystem: "npm" },
              vulnerabilities: [
                {
                  id: "GHSA-p6mc-m468-83gw",
                  summary: "Prototype pollution",
                  database_specific: { severity: "HIGH" },
                },
              ],
              groups: [{ ids: ["GHSA-p6mc-m468-83gw"], max_severity: "7.4" }],
            },
          ],
        },
      ],
    };
    expect(detectJsonReport(doc)).toBe("osv");
    const { findings } = parseJsonFindings(doc, ctx);
    expect(findings[0]).toMatchObject({
      tool: "osv-scanner",
      category: "supply_chain",
      rule_id: "GHSA-p6mc-m468-83gw",
      score: 7.4,
      label: "HIGH",
      location: { path: "pnpm-lock.yaml", symbol: "lodash@4.17.15" },
    });
  });
  it("reads Ruff and golangci-lint output", () => {
    const ruffDoc = [
      {
        code: "F401",
        message: "unused import",
        filename: "app/x.py",
        location: { row: 1, column: 1 },
        end_location: { row: 1, column: 9 },
      },
    ];
    expect(parseJsonFindings(ruffDoc, ctx).findings[0]).toMatchObject({
      tool: "ruff",
      rule_id: "F401",
      location: { path: "app/x.py", line: 1 },
    });
    const go = {
      Issues: [
        {
          FromLinter: "errcheck",
          Text: "unchecked",
          Pos: { Filename: "main.go", Line: 9 },
          SourceLines: ["f()"],
        },
      ],
    };
    expect(parseJsonFindings(go, ctx).findings[0]).toMatchObject({
      tool: "golangci-lint",
      rule_id: "errcheck",
      snippet: "f()",
    });
  });
  it("reads diff-cover's total and finds nothing in unknown documents", () => {
    const doc = {
      report_name: "XML",
      src_stats: {},
      total_percent_covered: 81,
      total_num_lines: 10,
    };
    expect(diffCoveragePct(doc)).toBe(81);
    expect(diffCoveragePct({})).toBeNull();
    expect(parseJsonFindings({ whatever: 1 }, ctx).findings).toEqual([]);
  });
});

describe("tool-reported locations", () => {
  it("falls back for paths RelPathSchema would reject, so the report stays valid", () => {
    expect(relativeLocation("a/".repeat(600), ctx)).toBe(ctx.fallbackPath);
    expect(relativeLocation("src/a\0.ts", ctx)).toBe(ctx.fallbackPath);
    expect(relativeLocation("/etc/passwd", ctx)).toBe(ctx.fallbackPath);
    expect(relativeLocation("src/a.ts", ctx)).toBe("src/a.ts");
  });

  it("anchors snippet-less lint findings on their source line, read inside the checkout only", () => {
    const root = tempDir("vtc-src-");
    writeFile(root, "src/a.ts", "const a = 1;\n  // TODO later  \n");
    const outside = tempDir("vtc-outside-");
    writeFile(outside, "secret.ts", "line one\n");
    symlinkSync(join(outside, "secret.ts"), join(root, "src/link.ts"));
    const local = { ...ctx, checkoutAbs: root };
    const doc = [
      {
        filePath: join(root, "src/a.ts"),
        messages: [{ ruleId: "no-todo", severity: 2, message: "TODO", line: 2 }],
      },
      {
        filePath: "src/link.ts",
        messages: [{ ruleId: "no-todo", severity: 2, message: "TODO", line: 1 }],
      },
    ];
    const [inside, linked] = parseJsonFindings(doc, local).findings;
    expect(inside?.snippet).toBe("// TODO later");
    expect(linked?.snippet).toBeUndefined();
    cleanupDirs();
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GateReportSchema,
  routeForFinding,
  normalizeSeverity,
  SCOPE_CREEP_RULE_ID,
  ToolFindingSchema,
  TraceabilityReportSchema,
} from "@vtc/shared";
import { parseJunit } from "../../src/gates/parsers/junit.js";
import { computeScopeCreep, scopeCreepFindings } from "../../src/gates/scope-creep.js";
import { commitAll, config, harness, testsGate, cases } from "./fixture.js";
import { cleanupDirs, writeFile } from "../helpers/repo.js";

afterEach(cleanupDirs);

const FILES: Record<string, string> = {
  "tests/a.test.ts": 'import { a } from "../src/a";\nit("[REQ-1] a", () => a());\n',
  "tests/untagged.test.ts": 'import { c } from "../src/c";\nit("c", () => c());\n',
  "src/a.ts": 'import { b } from "./b";\nexport const a = () => b();\n',
  "src/b.ts": "export const b = () => 1;\n",
  "src/c.ts": "export const c = () => 2;\n",
  "app/models.py": "X = 1\n",
  "app/test_models.py": "from .models import X\n",
  "README.md": "docs\n",
};

const changed = (paths: string[]) => paths.map((path) => ({ path, status: "modified" as const }));
const input = (reqTags: string[], extraCases: { id: string; file?: string }[] = []) => ({
  changed: changed(Object.keys(FILES)),
  cases: [
    { id: "[REQ-1] a", file: "/ck/tests/a.test.ts" },
    { id: "c", file: "tests/untagged.test.ts" },
    ...extraCases,
  ],
  reqTags,
  checkoutAbs: "/ck",
  readHead: (p: string) => Promise.resolve(FILES[p]),
  exists: (p: string) => FILES[p] !== undefined,
});

describe("computeScopeCreep", () => {
  it("covers files a tagged test is in or reaches through imports; flags the rest", async () => {
    const result = await computeScopeCreep(input([]));
    expect(result.paths).toEqual([
      "app/models.py",
      "app/test_models.py",
      "src/c.ts",
      "tests/untagged.test.ts",
    ]);
    expect(result.unjudged).toEqual(["README.md"]);
  });

  it("follows Python relative imports from a tagged test", async () => {
    const result = await computeScopeCreep(
      input([], [{ id: "app/test_models.py::test_x[REQ-1]", file: "app/test_models.py" }]),
    );
    expect(result.paths).toEqual(["src/c.ts", "tests/untagged.test.ts"]);
  });

  it("finds a pytest test's file from its dotted classname (xunit2, no file attribute)", async () => {
    // What `pytest --junitxml` writes by default (junit_family=xunit2).
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<testsuites><testsuite name="pytest" errors="0" failures="0" skipped="0" tests="2">
<testcase classname="app.test_models" name="test_x[REQ-1]" time="0.001" />
<testcase classname="app.test_models.TestModel" name="test_y[REQ-1]" time="0.001" />
</testsuite></testsuites>`;
    const pytest = parseJunit(xml);
    expect(pytest.every((c) => c.file === undefined)).toBe(true);
    const result = await computeScopeCreep(input([], pytest));
    expect(result.paths).toEqual(["src/c.ts", "tests/untagged.test.ts"]);
  });

  it("flags nothing when a tagged test's file cannot be found: the files are unjudged", async () => {
    const result = await computeScopeCreep(input([], [{ id: "Suite > [REQ-1] somewhere" }]));
    expect(result.paths).toEqual([]);
    expect(result.unjudged).toEqual([
      "README.md",
      "app/models.py",
      "app/test_models.py",
      "src/c.ts",
      "tests/untagged.test.ts",
    ]);
  });

  it("counts only tests tagged with the run's requirements", async () => {
    const result = await computeScopeCreep(input(["REQ-2"]));
    expect(result.paths).toContain("src/a.ts");
    expect((await computeScopeCreep(input(["REQ-1"]))).paths).not.toContain("src/a.ts");
  });

  it("makes one info-level, deferred spec_mismatch finding per path", () => {
    const [f] = scopeCreepFindings(["src/c.ts"], ".vtc/evidence/T-1/traceability.json");
    expect(ToolFindingSchema.parse(f)).toEqual(f);
    expect(f).toMatchObject({
      rule_id: SCOPE_CREEP_RULE_ID,
      category: "spec_mismatch",
      sarif_level: "none",
    });
    const severity = normalizeSeverity({
      source: "tool",
      category: "spec_mismatch",
      sarifLevel: "none",
    });
    expect(severity).toBe("info");
    expect(
      routeForFinding({ source: "tool", category: "spec_mismatch", severity, ruleId: f?.rule_id }),
    ).toBe("defer");
  });
});

describe("scope creep in a gate run", () => {
  it("lists uncovered changed files in traceability and flags them without failing L2", async () => {
    const h = harness({ "tests/a.json": cases([{ name: "[REQ-1] works" }]) }, config([testsGate]));
    writeFile(h.repo, "src/extra.ts", "export const extra = 1;\n");
    writeFile(h.repo, "docs/notes.md", "notes\n");
    const head = commitAll(h.repo, "creep");
    const report = GateReportSchema.parse(
      await h.run({ head, files_scope: ["src/**", "docs/**"], req_tags: ["REQ-1"] }),
    );
    const l2 = report.results.find((r) => r.layer === "L2");
    expect(l2?.status).toBe("pass");
    expect(l2?.findings.map((f) => [f.rule_id, f.location.path])).toEqual([
      [SCOPE_CREEP_RULE_ID, "src/extra.ts"],
    ]);
    expect(report.verdict).toBe("pass");
    const trace = TraceabilityReportSchema.parse(
      JSON.parse(readFileSync(join(h.repo, report.traceability ?? ""), "utf8")),
    );
    expect(trace.scope_creep).toEqual(["src/extra.ts"]);
  });
});

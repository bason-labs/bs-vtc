import { describe, expect, it } from "vitest";
import { finalReviewStepsCovered, GateReportSchema, ToolFindingSchema } from "@vtc/shared";
import {
  dependenciesOf,
  evaluateAdCheck,
  importsOf,
  parseAdChecks,
} from "../../src/gates/arch/index.js";
import { patternProblem } from "../../src/gates/arch/checks.js";
import { PatternTimeoutError } from "../../src/gates/arch/evaluate.js";
import { commitAll, config, harness, testsGate, cases } from "./fixture.js";
import { writeFile } from "../helpers/repo.js";

const SPINE = `# Spine

### AD-3 Search module owns its tables

- **Rule:** only the search module reads the search tables.
- **Check:** an import-boundary rule, blocking.

\`\`\`vtc-check
kind: import-boundary
mode: blocking
from: ["src/**"]
except: ["src/search/**"]
forbid: ["src/search/internal/**"]
forbid_packages: ["pg"]
\`\`\`

\`\`\`bash
# a comment in a shell block is not a heading
npm run check
\`\`\`

\`\`\`vtc-check
kind: forbidden-pattern
mode: warn
paths: ["src/**/*.ts"]
pattern: "SELECT .* FROM search_"
except: ["src/search/**"]
\`\`\`

**AD-4 No ORM.**

\`\`\`vtc-check
kind: forbidden-dependency
packages: ["typeorm", "sqlalchemy"]
\`\`\`

## Other section

\`\`\`vtc-check
kind: nonsense
\`\`\`
`;

describe("parseAdChecks", () => {
  it("compiles every vtc-check block under its AD and reports the ones it cannot", () => {
    const { checks, invalid } = parseAdChecks(SPINE);
    expect(checks.map((c) => [c.ad, c.id, c.spec.kind, c.spec.mode])).toEqual([
      ["AD-3", "vtc-ad-3", "import-boundary", "blocking"],
      ["AD-3", "vtc-ad-3-2", "forbidden-pattern", "warn"],
      ["AD-4", "vtc-ad-4", "forbidden-dependency", "blocking"],
    ]);
    expect(checks[0]?.title).toBe("Search module owns its tables");
    expect(invalid).toHaveLength(1);
    expect(invalid[0]?.ad).toBe("AD-?");
    expect(invalid[0]?.problem).toMatch(/outside any AD-n/);
    const bad = parseAdChecks("### AD-1 X\n```vtc-check\nkind: import-boundary\nfrom: []\n```\n");
    expect(bad.invalid[0]).toMatchObject({ ad: "AD-1", id: "vtc-ad-1" });
  });
});

describe("AD Check evaluation", () => {
  const [boundary, pattern, deps] = parseAdChecks(SPINE).checks;

  it("reads JS/TS and Python imports", () => {
    expect(
      importsOf(
        "src/a.ts",
        'import { x } from "../search/internal/db";\nconst y = require("pg");\nexport * from "./b";\nimport "./side";',
      ).map((i) => i.spec),
    ).toEqual(["../search/internal/db", "pg", "./b", "./side"]);
    expect(
      importsOf("app/a.py", "from .models import X\nimport os, json").map((i) => i.spec),
    ).toEqual([".models", "os", "json"]);
  });

  it("flags only new boundary violations, with the forbidden target", () => {
    const head =
      'import { q } from "./search/internal/db";\nimport pg from "pg";\nimport { ok } from "./search";\n';
    const base = 'import pg from "pg";\n';
    const { fresh, baseline } = evaluateAdCheck(boundary!.spec, [
      { path: "src/app.ts", head, base },
      { path: "src/search/service.ts", head },
    ]);
    expect(fresh.map((v) => [v.line, v.detail])).toEqual([
      [1, "imports ./search/internal/db (src/search/internal/db)"],
    ]);
    expect(baseline).toBe(1);
  });

  it("flags forbidden patterns and dependencies a manifest adds", () => {
    expect(
      evaluateAdCheck(pattern!.spec, [
        { path: "src/report.ts", head: 'db.query("SELECT * FROM search_index")' },
      ]).fresh,
    ).toHaveLength(1);
    const pkg = JSON.stringify({ dependencies: { typeorm: "1.0.0", zod: "4" } }, null, 2);
    expect(
      evaluateAdCheck(deps!.spec, [{ path: "package.json", head: pkg }]).fresh[0],
    ).toMatchObject({
      detail: "depends on typeorm",
      line: 3,
    });
    expect(dependenciesOf("requirements.txt", "SQLAlchemy==2.0\n# c\n-r base.txt\n")).toEqual([
      { name: "sqlalchemy", line: 1 },
    ]);
    expect(
      dependenciesOf("pyproject.toml", '[project]\ndependencies = [\n  "SQLAlchemy>=2",\n]\n'),
    ).toEqual([{ name: "sqlalchemy", line: 3 }]);
    expect(dependenciesOf("go.mod", "module x\nrequire (\n\tgithub.com/a/b v1.0.0\n)\n")).toEqual([
      { name: "github.com/a/b", line: 3 },
    ]);
  });

  it("refuses patterns that backtrack catastrophically, and accepts ordinary ones", () => {
    for (const bad of ["(a+)+$", "(a|ab)*c", "(\\w+\\s?)*$", "(x{1,9})+", "(a)\\1", "a.*b.*c.*d"]) {
      expect(patternProblem(bad), bad).not.toBeNull();
    }
    for (const ok of [
      "SELECT .* FROM search_",
      "console\\.log\\(",
      "(?:foo|bar)\\(",
      "[(+*]+x",
      "^import .* from ['\"]pg['\"]",
      "\\bTODO\\b(?=:)",
    ]) {
      expect(patternProblem(ok), ok).toBeNull();
    }
    const { invalid } = parseAdChecks(
      '### AD-2 X\n```vtc-check\nkind: forbidden-pattern\npaths: ["src/**"]\npattern: "(a+)+$"\n```\n',
    );
    expect(invalid[0]?.problem).toMatch(/catastrophic backtracking/);
  });

  it("stops a pattern Check that runs out of its time budget", () => {
    const spec = {
      kind: "forbidden-pattern" as const,
      mode: "blocking" as const,
      paths: ["src/**"],
      pattern: "forbidden",
      except: [],
    };
    const head = "fine\n".repeat(10_000);
    expect(() => evaluateAdCheck(spec, [{ path: "src/x.ts", head }], 0)).toThrow(
      PatternTimeoutError,
    );
    expect(evaluateAdCheck(spec, [{ path: "src/x.ts", head }]).fresh).toEqual([]);
  });
});

describe("compiled L6 in a gate run", () => {
  const files = {
    ".vtc/architecture/spine.md": SPINE.replace(/## Other section[\s\S]*$/, ""),
    "src/search/internal/db.ts": "export const q = 1;\n",
    "tests/a.json": cases([{ name: "[REQ-1] works" }]),
  };

  it("passes on a clean diff and fails a blocking Check with architecture findings", async () => {
    const h = harness(files, config([testsGate]));
    writeFile(h.repo, "src/ok.ts", 'import { x } from "./lib";\n');
    const clean = commitAll(h.repo, "clean");
    const pass = GateReportSchema.parse(await h.run({ head: clean, files_scope: ["src/**"] }));
    const l6 = pass.results.filter((r) => r.layer === "L6");
    expect(l6.map((r) => [r.gate_id, r.status, r.blocking])).toEqual([
      ["vtc-ad-3", "pass", true],
      ["vtc-ad-3-2", "pass", false],
      ["vtc-ad-4", "pass", true],
    ]);
    expect(
      finalReviewStepsCovered(
        { reason: "final_review", scope: "full", include_hidden: false },
        pass,
      ),
    ).toContain(6);

    writeFile(
      h.repo,
      "src/app.ts",
      'import { q } from "./search/internal/db";\nconst s = "SELECT a FROM search_x";\n',
    );
    const bad = commitAll(h.repo, "bad");
    const report = GateReportSchema.parse(await h.run({ head: bad, files_scope: ["src/**"] }));
    const ad3 = report.results.find((r) => r.gate_id === "vtc-ad-3");
    expect(ad3).toMatchObject({ status: "fail", failure_class: "product", new_violations: 1 });
    const f = ad3?.findings[0];
    expect(ToolFindingSchema.parse(f)).toEqual(f);
    expect(f).toMatchObject({
      tool: "vtc-arch",
      rule_id: "vtc-arch/AD-3",
      category: "architecture",
      location: { path: "src/app.ts", line: 1 },
      sarif_level: "error",
    });
    // The warn Check fails without failing the verdict on its own.
    expect(report.results.find((r) => r.gate_id === "vtc-ad-3-2")).toMatchObject({
      status: "fail",
      blocking: false,
    });
    expect(report.verdict).toBe("fail");
  });

  it("reads the spine at the base: a diff cannot loosen its own Checks", async () => {
    const h = harness(files, config([testsGate]));
    writeFile(h.repo, ".vtc/architecture/spine.md", "# no checks\n");
    writeFile(h.repo, "src/app.ts", 'import { q } from "./search/internal/db";\n');
    const head = commitAll(h.repo, "loosen");
    const report = await h.run({ head, files_scope: ["src/**", ".vtc/architecture/**"] });
    expect(report.results.find((r) => r.gate_id === "vtc-ad-3")?.status).toBe("fail");
  });

  it("parks an uncompilable Check as gate infrastructure, and runs nothing without a spine", async () => {
    const broken = harness(
      { ...files, ".vtc/architecture/spine.md": "### AD-1 X\n```vtc-check\nkind: nonsense\n```\n" },
      config([testsGate]),
    );
    const r1 = await broken.run({ head: broken.base });
    expect(r1.results.find((r) => r.gate_id === "vtc-ad-1")).toMatchObject({
      status: "error",
      failure_class: "infra",
    });
    expect(r1.verdict).toBe("infra_error");
    const none = harness({ "tests/a.json": cases([{ name: "x" }]) }, config([testsGate]));
    const r2 = await none.run({ head: none.base });
    expect(r2.results.some((r) => r.layer === "L6")).toBe(false);
  });

  it("reports a catastrophically backtracking pattern as gate infrastructure, never running it", async () => {
    const spine =
      '### AD-2 No a-runs\n```vtc-check\nkind: forbidden-pattern\npaths: ["src/**"]\npattern: "(a+)+$"\n```\n';
    const h = harness({ ...files, ".vtc/architecture/spine.md": spine }, config([testsGate]));
    writeFile(h.repo, "src/slow.ts", `// ${"a".repeat(40)}b\n`);
    const head = commitAll(h.repo, "slow");
    const started = Date.now();
    const report = await h.run({ head, files_scope: ["src/**"] });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(report.results.find((r) => r.gate_id === "vtc-ad-2")).toMatchObject({
      status: "error",
      failure_class: "infra",
    });
    expect(report.verdict).toBe("infra_error");
  });

  it("does not run for base_fail_check or when L6 is not requested", async () => {
    const h = harness(files, config([testsGate]));
    const report = await h.run({ head: h.base, layers: ["L2"] });
    expect(report.results.some((r) => r.layer === "L6")).toBe(false);
  });
});

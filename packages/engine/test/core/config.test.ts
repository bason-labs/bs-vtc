/** Config loading (`project.yaml`, `gates.yml`), the YAML reader, claim checks and graph states. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GatesConfigSchema, ProjectConfigSchema, type Task } from "@vtc/shared";
import {
  ConfigError,
  committedGatesConfig,
  gatesConfigHash,
  loadGatesConfig,
  parseGatesConfig,
  loadProjectConfig,
  parseYaml,
  pipelineConfigHash,
  taskNodeState,
  toYaml,
  YamlError,
} from "../../src/core/index.js";
import { resolves, unresolved, type EvidenceContext } from "../../src/core/evidence.js";
import { cleanupDirs, git, initRepo, tempDir, writeFile } from "../helpers/repo.js";
import { createGitOps } from "../../src/git/index.js";
import { DEFAULT_GATES_YML } from "../helpers/engine-harness.js";

afterEach(cleanupDirs);

const CALIBRATED = readFileSync(
  fileURLToPath(new URL("../fixtures/gates-calibrated.yml", import.meta.url)),
  "utf8",
);

describe("gates.yml as vtc calibrate writes it (the gate runner's real calibrate output)", () => {
  it("is the gate runner's fixture, byte for byte", () => {
    expect(CALIBRATED).toBe(
      readFileSync(
        fileURLToPath(new URL("../gates/fixtures/gates-calibrated.yml", import.meta.url)),
        "utf8",
      ),
    );
  });
  it("reads the calibrated fixture into the config it describes", () => {
    const repo = initRepo({ ".vtc/gates.yml": CALIBRATED });
    const config = loadGatesConfig(repo);
    expect(config).toEqual(GatesConfigSchema.parse(parseYaml(CALIBRATED)));
    expect(config?.baseline).toMatchObject({ confirmed: true, flaky_tests: [] });
    expect(config?.sources).toEqual(["agents_md", "task_runner", "ci"]);
    expect(config?.tests.acceptance_globs).toEqual(["tests/acceptance/**"]);
    // every lint, test and scanner config is protected
    expect(config?.tests.protected_configs).toEqual(
      expect.arrayContaining([
        "**/eslint.config.*",
        "**/vitest.config.*",
        "**/tsconfig*.json",
        "**/.gitleaks.toml",
      ]),
    );
    expect(config?.gates.map((g) => [g.id, g.layer])).toEqual([
      ["install", "L0"],
      ["build", "L0"],
      ["typecheck", "L0"],
      ["lint", "L1"],
      ["test", "L2"],
      ["arch", "L6"],
      ["secrets", "L4"],
      ["sast", "L4"],
      ["dependencies", "L4"],
      ["iac", "L4"],
    ]);
    expect(config?.gates.find((g) => g.id === "install")).toMatchObject({
      phase: "install",
      timeout_s: 1200,
    });
    expect(config?.gates.find((g) => g.id === "test")?.report).toEqual({
      format: "junit",
      path: ".vtc/state/gates/junit.xml",
    });
    expect(config?.gates.find((g) => g.id === "iac")?.when_changed).toContain("**/*.tf");
  });
  it("reads the same config from the commit (reading 46f) and hashes its bytes", async () => {
    const repo = initRepo({ ".vtc/gates.yml": CALIBRATED });
    const committed = await committedGatesConfig(
      createGitOps({ repoRoot: repo }),
      git(repo, "rev-parse", "HEAD"),
    );
    expect(committed?.config).toEqual(loadGatesConfig(repo));
    expect(committed?.sha256).toBe(gatesConfigHash(CALIBRATED));
    expect(
      await committedGatesConfig(
        createGitOps({ repoRoot: initRepo() }),
        git(repo, "rev-parse", "HEAD"),
      ),
    ).toBeNull();
  });
  it("keeps quoted values with '#', ':' and spaces (block YAML of a YAML library)", () => {
    const config = parseGatesConfig(
      [
        "version: 1",
        "baseline:",
        "  revision: 4f1c2a9e8b7d6c5f4e3d2c1b0a9f8e7d6c5b4a39",
        "  calibrated_at: 2026-10-13T08:00:00.000Z",
        "  confirmed: true",
        "  flaky_tests:",
        '    - "tests/api.test.ts > reset > retries: twice"',
        "tests:",
        "  acceptance_globs:",
        '    - "**/*.acceptance.test.ts"',
        "gates:",
        "  - id: tests",
        "    layer: L2",
        "    command:",
        "      - pnpm",
        '      - "--outputFile=.vtc/state/gates/junit #1.xml"',
        "",
      ].join("\n"),
    );
    expect(config.baseline.flaky_tests).toEqual(["tests/api.test.ts > reset > retries: twice"]);
    expect(config.tests.acceptance_globs).toEqual(["**/*.acceptance.test.ts"]);
    expect(config.gates[0]?.command).toEqual([
      "pnpm",
      "--outputFile=.vtc/state/gates/junit #1.xml",
    ]);
  });
});

describe("YAML reader", () => {
  it("reads block mappings, sequences, flow collections, quoting and comments", () => {
    const doc = [
      "version: 1   # the format",
      "merge_level: 1",
      "caps:",
      "  low: 3",
      "  high: 5",
      "risk_rules:",
      "  paths:",
      "    - src/auth/**",
      '    - "src/pay #1/**"',
      "  max_diff_lines: 400",
      "hosts: { preferred: codex, dispatch: plugin_only }",
      "list: [a, 'b c', 3, true, null]",
      "items:",
      "  - id: one",
      "    n: 1",
      "  - id: two",
      "empty:",
      "",
    ].join("\n");
    expect(parseYaml(doc)).toEqual({
      version: 1,
      merge_level: 1,
      caps: { low: 3, high: 5 },
      risk_rules: { paths: ["src/auth/**", "src/pay #1/**"], max_diff_lines: 400 },
      hosts: { preferred: "codex", dispatch: "plugin_only" },
      list: ["a", "b c", 3, true, null],
      items: [{ id: "one", n: 1 }, { id: "two" }],
      empty: null,
    });
  });
  it("accepts JSON and refuses what it does not support, with a line number", () => {
    expect(parseYaml('{"version": 1}')).toEqual({ version: 1 });
    expect(() => parseYaml("a: 1\na: 2")).toThrow(/line 2: Map keys must be unique/);
    expect(() => parseYaml("a:\n  b: 1\n c: 2")).toThrow(/line 3/);
    expect(() => parseYaml("a: 1\n---\nb: 2")).toThrow(/multiple documents/);
    expect(() => parseYaml("a: !!js/function x")).toThrow(YamlError);
    const bomb = ["a: &a [x, x, x, x, x, x, x, x, x, x]"];
    for (const n of ["b", "c", "d", "e", "f"])
      bomb.push(
        `${n}: &${n} [${Array(10)
          .fill(`*${String.fromCharCode(n.charCodeAt(0) - 1)}`)
          .join(", ")}]`,
      );
    expect(() => parseYaml(bomb.join("\n"))).toThrow(YamlError);
  });
  it("reads full YAML: block scalars, anchors and aliases (the yaml library, spine §5 reading 24)", () => {
    expect(parseYaml("a: &x [1, 2]\nb: *x\nnote: |\n  two\n  lines\n")).toEqual({
      a: [1, 2],
      b: [1, 2],
      note: "two\nlines\n",
    });
  });
  it("refuses a __proto__ key instead of replacing the object's prototype", () => {
    expect(() => parseYaml("__proto__:\n  polluted: true")).toThrow(/__proto__/);
    expect(() => parseYaml('a: { "__proto__": 1 }')).toThrow(/__proto__/);
    expect(() => parseYaml("caps:\n  __proto__: 1")).toThrow(YamlError);
    const parsed = parseYaml("constructor: 1") as Record<string, unknown>;
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it("round-trips its own output", () => {
    const value = {
      id: "T-1",
      covers: ["REQ-1"],
      after: [],
      intent: { statement: "a: b", io_matrix: [{ case: "x", input: "1", expected: "true" }] },
      cap: 4,
      flag: true,
    };
    expect(parseYaml(toYaml(value))).toEqual(value);
  });
});

describe("project.yaml and gates.yml (AD-3 rule 2 readers)", () => {
  it("defaults every field when project.yaml is missing; reads YAML; drops unknown keys", () => {
    const repo = tempDir();
    expect(loadProjectConfig(repo)).toEqual(ProjectConfigSchema.parse({ version: 1 }));
    writeFile(
      repo,
      ".vtc/project.yaml",
      "version: 1\nconcurrency: 3\nmerge_level: 1\nfuture_field: true\ncaps:\n  med: 5\n",
    );
    const config = loadProjectConfig(repo);
    expect([config.concurrency, config.merge_level, config.caps]).toEqual([
      3,
      1,
      { low: 3, med: 5, high: 5 },
    ]);
    expect(config.hosts.dispatch).toBe("plugin_only");
  });
  it("refuses a broken or invalid file instead of guessing", () => {
    const repo = tempDir();
    writeFile(repo, ".vtc/project.yaml", "version: 1\nconcurrency: 7\n");
    expect(() => loadProjectConfig(repo)).toThrow(ConfigError);
    writeFile(repo, ".vtc/project.yaml", "version: [1\n");
    expect(() => loadProjectConfig(repo)).toThrow(ConfigError);
  });
  it("reads gates.yml (null before calibration) and hashes the composed config", () => {
    const repo = tempDir();
    expect(loadGatesConfig(repo)).toBeNull();
    writeFile(repo, ".vtc/gates.yml", JSON.stringify(DEFAULT_GATES_YML));
    const gates = loadGatesConfig(repo);
    expect(gates?.tests.acceptance_globs).toEqual(["tests/acceptance/**"]);
    const config = loadProjectConfig(repo);
    expect(pipelineConfigHash(config, gates)).toMatch(/^[a-f0-9]{64}$/);
    expect(pipelineConfigHash(config, gates)).not.toBe(pipelineConfigHash(config, null));
  });
});

describe("claim checks (§4.2 step 3)", () => {
  it("resolves files and lines at a commit, spec refs, commits and diffs", async () => {
    const repo = initRepo({ "src/a.ts": "one\ntwo\n" });
    const head = git(repo, "rev-parse", "HEAD");
    writeFile(repo, ".vtc/evidence/T-1/junit.xml", "<testsuite/>");
    const ctx: EvidenceContext = {
      repoRoot: repo,
      git: createGitOps({ repoRoot: repo }),
      head,
      specIds: ["REQ-1", "REQ-1.AC-1"],
      commitExists: (sha) => Promise.resolve(sha === head),
    };
    expect(await resolves(ctx, { type: "file", ref: "src/a.ts" })).toBe(true);
    expect(await resolves(ctx, { type: "file_line", ref: "src/a.ts:2" })).toBe(true);
    expect(await resolves(ctx, { type: "file_line", ref: "src/a.ts:3" })).toBe(false);
    expect(await resolves(ctx, { type: "file_line", ref: "src/a.ts:1-2" })).toBe(true);
    expect(await resolves(ctx, { type: "file", ref: "../etc/passwd" })).toBe(false);
    expect(await resolves(ctx, { type: "junit", ref: ".vtc/evidence/T-1/junit.xml#t1" })).toBe(
      true,
    );
    expect(await resolves(ctx, { type: "junit", ref: "junit.xml#t1" })).toBe(false);
    expect(await resolves(ctx, { type: "spec_ref", ref: "REQ-1.AC-1" })).toBe(true);
    expect(await resolves(ctx, { type: "spec_ref", ref: "REQ-9" })).toBe(false);
    expect(await resolves(ctx, { type: "commit", ref: head })).toBe(true);
    expect(await resolves(ctx, { type: "diff", ref: `${head}..${"b".repeat(40)}` })).toBe(false);
    // diff refs are two full shas, never revision expressions handed to git
    const lenient = { ...ctx, commitExists: () => Promise.resolve(true) };
    expect(await resolves(lenient, { type: "diff", ref: `${head}..${head}` })).toBe(true);
    for (const ref of [`HEAD..${head}`, `${head}..--output=/tmp/x`, `${head}..${head}..${head}`])
      expect(await resolves(lenient, { type: "diff", ref })).toBe(false);
    expect(await resolves(ctx, { type: "url", ref: "http://x" })).toBe(false);
    expect(
      await unresolved(ctx, [
        { type: "file", ref: "src/a.ts" },
        { type: "file", ref: "nope.ts" },
      ]),
    ).toEqual(["file nope.ts"]);
  });
});

describe("workflow node states (WorkflowNodeStateSchema mapping)", () => {
  it("maps every task status", () => {
    const states = (
      [
        "draft",
        "ready",
        "waiting_dependency",
        "tests_authored",
        "building",
        "verifying",
        "fixing",
        "built",
        "queued",
        "merged",
        "done",
        "parked",
        "interrupted",
        "dropped",
      ] as Task["status"][]
    ).map(taskNodeState);
    expect(states).toEqual([
      "waiting",
      "waiting",
      "waiting",
      "running",
      "running",
      "running",
      "looping",
      "passed",
      "passed",
      "passed",
      "done",
      "parked",
      "interrupted",
      "dropped",
    ]);
  });
});

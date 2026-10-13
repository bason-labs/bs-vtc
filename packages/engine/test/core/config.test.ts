/** Config loading (`project.yaml`, `gates.yml`), the YAML reader, claim checks and graph states. */
import { afterEach, describe, expect, it } from "vitest";
import { ProjectConfigSchema, type Task } from "@vtc/shared";
import {
  ConfigError,
  loadGatesConfig,
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
    expect(() => parseYaml("a: &anchor 1")).toThrow(YamlError);
    expect(() => parseYaml("a: 1\na: 2")).toThrow(/duplicate key a/);
    expect(() => parseYaml("a:\n  b: 1\n c: 2")).toThrow(/line 3/);
    expect(() => parseYaml("a: 1\n---\nb: 2")).toThrow(/multiple documents/);
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

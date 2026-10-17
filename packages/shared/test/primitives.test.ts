import { describe, expect, it } from "vitest";
import {
  AcceptanceCriterionIdSchema,
  DisciplineSchema,
  EscalationIdSchema,
  FeatureIdSchema,
  GitShaSchema,
  GlobSchema,
  IsoDateTimeSchema,
  LocationSchema,
  RelPathSchema,
  PlatformSchema,
  RequirementIdSchema,
  RequirementRefSchema,
  RiskRuleIdSchema,
  RoleIdSchema,
  RunIdSchema,
  SessionRefSchema,
  Sha256HexSchema,
  SlugSchema,
  TaskIdSchema,
  TokenUsageSchema,
  WriteScopeGlobSchema,
} from "../src/index.js";
import { expectInvalid, expectValid } from "./helpers.js";

describe("identifiers", () => {
  it.each(["T-1", "T-42"])("accepts task id %s", (id) => {
    expectValid(TaskIdSchema, id);
  });
  it.each(["T-0", "t-1", "T-01", "T1", "T-", "F-1"])("rejects task id %s", (id) => {
    expectInvalid(TaskIdSchema, id);
  });
  it("validates feature and escalation ids", () => {
    expectValid(FeatureIdSchema, "F-3");
    expectInvalid(FeatureIdSchema, "T-3");
    expectValid(EscalationIdSchema, "E-9");
    expectInvalid(EscalationIdSchema, "E-0");
  });
  it.each(["REQ-1", "SEC-12"])("accepts requirement %s", (id) => {
    expectValid(RequirementIdSchema, id);
  });
  it.each(["REQ-0", "req-1", "AC-1", "REQ-1.AC1"])("rejects requirement %s", (id) => {
    expectInvalid(RequirementIdSchema, id);
  });
  it.each(["REQ-3.AC-2", "SEC-1.AC-10"])("accepts acceptance criterion %s", (id) => {
    expectValid(AcceptanceCriterionIdSchema, id);
    expectValid(RequirementRefSchema, id);
  });
  it.each(["AC-1", "REQ-3", "REQ-3.AC-0", "REQ-3.ac-1", "REQ-3.AC-1.AC-2"])(
    "rejects acceptance criterion %s",
    (id) => {
      expectInvalid(AcceptanceCriterionIdSchema, id);
    },
  );
  it("requirement refs accept a REQ or one of its ACs, nothing else", () => {
    expectValid(RequirementRefSchema, "REQ-3");
    expectInvalid(RequirementRefSchema, "AC-1");
    expectInvalid(RequirementRefSchema, "REQ-3.");
  });
  it("lists the 13 risk rules of §7.6 and the 5 download platforms of §4.4", () => {
    expect(RiskRuleIdSchema.options).toHaveLength(13);
    expect(PlatformSchema.options).toEqual([
      "darwin-arm64",
      "darwin-x64",
      "linux-x64",
      "linux-arm64",
      "windows-x64",
    ]);
  });
  it.each(["run-1", "2026-10-13_a.b"])("accepts run id %s", (id) => {
    expectValid(RunIdSchema, id);
  });
  it.each(["", "..", ".hidden", "a/b", "a b", "x".repeat(65)])("rejects run id %j", (id) => {
    expectInvalid(RunIdSchema, id);
  });
  it("validates role ids and slugs", () => {
    expectValid(RoleIdSchema, "spec_verifier");
    expectInvalid(RoleIdSchema, "Spec");
    expectInvalid(RoleIdSchema, "1qa");
    expectValid(SlugSchema, "node-nest");
    expectInvalid(SlugSchema, "Node Nest");
  });
});

describe("hashes and time", () => {
  it("validates sha256 and git sha", () => {
    expectValid(Sha256HexSchema, "f".repeat(64));
    expectInvalid(Sha256HexSchema, "F".repeat(64));
    expectInvalid(Sha256HexSchema, "f".repeat(63));
    expectValid(GitShaSchema, "a".repeat(40));
    expectValid(GitShaSchema, "b".repeat(64));
    expectInvalid(GitShaSchema, "abc1234");
    expectInvalid(GitShaSchema, "a".repeat(41));
    expectInvalid(GitShaSchema, "A".repeat(40));
  });
  it("requires ISO timestamps with zone", () => {
    expectValid(IsoDateTimeSchema, "2026-10-13T08:00:00Z");
    expectValid(IsoDateTimeSchema, "2026-10-13T08:00:00+07:00");
    expectInvalid(IsoDateTimeSchema, "2026-10-13");
    expectInvalid(IsoDateTimeSchema, "yesterday");
  });
});

describe("paths", () => {
  it.each(["src/a.ts", ".vtc/spec/**", "a/b..c/d"])("accepts %s", (p) => {
    expectValid(RelPathSchema, p);
  });
  it.each(["", "/etc/passwd", "../x", "a/../../b", "a\\b", "C:/x", "a\0b"])("rejects %j", (p) => {
    expectInvalid(RelPathSchema, p);
  });
  it("globs follow the same rules", () => {
    expectValid(GlobSchema, "src/**/*.ts");
    expectInvalid(GlobSchema, "../**");
  });
  it.each([
    "src/**",
    "packages/foo/tsconfig.json",
    ".vtc/state/hidden-staging/T-1/**",
    "a/[ab].ts",
  ])("accepts write-scope glob %s", (glob) => {
    expectValid(WriteScopeGlobSchema, glob);
  });
  it.each([
    "src/{a,b}/**",
    "src/**),Bash(*",
    "src/a b.ts",
    "src/'x'",
    'src/"x"',
    "src/`x`",
    "src/a\tb",
    "src/a\nb",
    "src/\u0007",
    "../**",
  ])("rejects write-scope glob %j (spine §5 reading 63)", (glob) => {
    expectInvalid(WriteScopeGlobSchema, glob);
  });
});

describe("value objects", () => {
  it("token usage is non-negative integers", () => {
    expectValid(TokenUsageSchema, { in: 0, out: 1, cache_r: 2, cache_w: 3 });
    expectInvalid(TokenUsageSchema, { in: -1, out: 1, cache_r: 2, cache_w: 3 }, "in");
    expectInvalid(TokenUsageSchema, { in: 1.5, out: 1, cache_r: 2, cache_w: 3 }, "in");
    expectInvalid(TokenUsageSchema, { in: 1, out: 1, cache_r: 2 }, "cache_w");
  });
  it("session refs need a known host", () => {
    expectValid(SessionRefSchema, { host: "codex", id: "x" });
    expectInvalid(SessionRefSchema, { host: "cursor", id: "x" }, "host");
  });
  it("location end_line requires line and ordering", () => {
    expectValid(LocationSchema, { path: "a.ts", line: 3, end_line: 5 });
    expectInvalid(LocationSchema, { path: "a.ts", end_line: 5 }, "end_line");
    expectInvalid(LocationSchema, { path: "a.ts", line: 5, end_line: 3 }, "end_line");
    expectInvalid(LocationSchema, { path: "a.ts", extra: 1 });
  });
  it("disciplines include core and domain packs", () => {
    expect(DisciplineSchema.options).toContain("ai_llm");
    expect(DisciplineSchema.options).toContain("wechat_mini_program");
    expectInvalid(DisciplineSchema, "fullstack");
  });
});

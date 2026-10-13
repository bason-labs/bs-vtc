/**
 * Pure policy helpers that define shared semantics (AD-3 rule 6): triage routing, severity and
 * rule 9, the single risk-rule encoding, dispatch mode, gate expectations and redaction.
 */
import { describe, expect, it } from "vitest";
import {
  dotenvValues,
  EscalationSchema,
  FindingDraftSchema,
  FindingSchema,
  gateExpectationMet,
  GateReportSchema,
  GateRunRequestSchema,
  normalizeSeverity,
  openHighRuleFires,
  ParkReasonSchema,
  planDispatch,
  redactJson,
  redactSecrets,
  RISK_RULE_REASON_RULES,
  RiskRuleIdSchema,
  riskRuleForPark,
  routeForFinding,
  type FindingCategory,
  type FindingKind,
} from "../src/index.js";
import {
  COMMIT,
  validEscalation,
  validFinding,
  validFindingDraft,
  validGateReport,
} from "./fixtures.js";
import { expectInvalid, expectValid } from "./helpers.js";

describe("routeForFinding (§6.3 step 8)", () => {
  const role = (category: FindingCategory, kind: FindingKind) =>
    routeForFinding({
      source: "role",
      category,
      kind,
      severity: normalizeSeverity({ source: "role", category }),
    });
  it.each([
    ["correctness", "implementation_deviation", "patch"],
    ["design", "implementation_deviation", "patch"],
    ["design", "design_ambiguity", "design_gap"],
    ["spec_mismatch", "observed_mismatch", "spec_gap"],
    ["spec_mismatch", "spec_ambiguity", "spec_gap"],
    ["correctness", "test_defect", "bad_test"],
    ["test_adequacy", "implementation_deviation", "bad_test"],
    ["secret", "implementation_deviation", "risky"],
    ["docs", "implementation_deviation", "defer"],
  ] as const)("%s + %s → %s", (category, kind, route) => {
    expect(role(category, kind)).toBe(route);
  });
  it("routes tool findings to the Engineer unless they are secrets or info", () => {
    expect(routeForFinding({ source: "tool", category: "security", severity: "high" })).toBe(
      "patch",
    );
    expect(routeForFinding({ source: "tool", category: "secret", severity: "critical" })).toBe(
      "risky",
    );
    expect(routeForFinding({ source: "tool", category: "maintainability", severity: "info" })).toBe(
      "defer",
    );
  });
  it("never produces out_of_scope (that route comes from a guarded Engineer exit)", () => {
    const kinds = FindingDraftSchema.shape.kind.options;
    const categories = FindingDraftSchema.shape.category.options;
    for (const category of categories)
      for (const kind of kinds) {
        expect(role(category, kind)).not.toBe("out_of_scope");
      }
  });
  it("role findings must carry a kind; tool findings need none", () => {
    expectInvalid(FindingDraftSchema, { ...validFindingDraft(), kind: undefined }, "kind");
    expectInvalid(FindingSchema, { ...validFinding(), kind: undefined }, "kind");
    const { kind: _k, ...tool } = { ...validFinding(), source: "tool", source_name: "opengrep" };
    expectValid(FindingSchema, tool);
  });
});

describe("severity and §7.6 rule 9", () => {
  it("only security-class categories are high or above", () => {
    expect(normalizeSeverity({ source: "role", category: "correctness" })).toBe("medium");
    for (const category of ["security", "supply_chain", "test_integrity"] as const) {
      expect(normalizeSeverity({ source: "role", category })).toBe("high");
    }
    expect(normalizeSeverity({ source: "role", category: "secret" })).toBe("critical");
  });
  it("a correctness finding can survive to the round cap without tripping rule 9", () => {
    const finding = {
      severity: normalizeSeverity({ source: "role", category: "correctness" }),
      status: "open",
      round_first_seen: 1,
    };
    for (let round = 1; round <= 5; round += 1)
      expect(openHighRuleFires(finding, round)).toBe(false);
  });
  it("a high finding still open after one fix round parks the task", () => {
    const finding = { severity: "high", status: "open", round_first_seen: 2 } as const;
    expect(openHighRuleFires(finding, 2)).toBe(false);
    expect(openHighRuleFires(finding, 3)).toBe(true);
    expect(openHighRuleFires({ ...finding, status: "resolved" }, 3)).toBe(false);
    expect(openHighRuleFires({ ...finding, severity: "critical" }, 3)).toBe(true);
  });
});

describe("one encoding per risk rule (§6.5, §7.6)", () => {
  it("reason risk_rule names only rules 1–9", () => {
    expect([...RISK_RULE_REASON_RULES]).toEqual(RiskRuleIdSchema.options.slice(0, 9));
    expectValid(EscalationSchema, {
      ...validEscalation(),
      reason: "risk_rule",
      risk_rule: "db_migration",
    });
    for (const rule of [
      "stuck_or_cap",
      "budget_exhausted",
      "gate_infra_or_sandbox",
      "unresolved_spec_conflict",
    ]) {
      expectInvalid(
        EscalationSchema,
        { ...validEscalation(), reason: "risk_rule", risk_rule: rule },
        "risk_rule",
      );
    }
  });
  it.each([
    ["cap", "stuck_or_cap"],
    ["stuck", "stuck_or_cap"],
    ["spec_conflict", "unresolved_spec_conflict"],
    ["change_request", "unresolved_spec_conflict"],
    ["gate_infra", "gate_infra_or_sandbox"],
    ["budget", "budget_exhausted"],
    ["spec_question", null],
    ["blocked", null],
  ] as const)("park reason %s is risk rule %s", (reason, rule) => {
    expect(riskRuleForPark(reason)).toBe(rule);
  });
  it("covers every park reason and every risk rule", () => {
    const rules = new Set<string | null>();
    for (const reason of ParkReasonSchema.options.filter((r) => r !== "risk_rule")) {
      rules.add(riskRuleForPark(reason));
    }
    for (const rule of RISK_RULE_REASON_RULES) rules.add(riskRuleForPark("risk_rule", rule));
    expect([...rules].filter((r) => r !== null).sort()).toEqual(
      [...RiskRuleIdSchema.options].sort(),
    );
    expect(() => riskRuleForPark("risk_rule")).toThrow();
  });
});

describe("planDispatch (plugin-only mode, §12.5)", () => {
  const both = { subagents: true, headless: true };
  it("plugin-only never starts a headless run", () => {
    for (const purpose of ["role", "auto_resume", "cross_family_review"] as const) {
      for (const caps of [both, { subagents: false, headless: true }]) {
        expect(planDispatch(purpose, "plugin_only", caps)).not.toBe("headless");
      }
    }
    expect(planDispatch("auto_resume", "plugin_only", both)).toBe("lead_redispatch");
    expect(planDispatch("cross_family_review", "plugin_only", both)).toBe("unavailable");
    expect(planDispatch("role", "plugin_only", both)).toBe("subagent");
  });
  it("headless_allowed uses headless runs only where the spec needs them", () => {
    expect(planDispatch("role", "headless_allowed", both)).toBe("subagent");
    expect(planDispatch("role", "headless_allowed", { subagents: false, headless: true })).toBe(
      "headless",
    );
    expect(planDispatch("auto_resume", "headless_allowed", both)).toBe("headless");
    expect(planDispatch("cross_family_review", "headless_allowed", both)).toBe("headless");
    expect(
      planDispatch("auto_resume", "headless_allowed", { subagents: true, headless: false }),
    ).toBe("lead_redispatch");
  });
});

describe("gate guards: base-fail check, fault repro, hidden tests", () => {
  const request = () => ({
    run: "r1",
    task: "T-7",
    reason: "base_fail_check",
    scope: "affected",
    base: COMMIT,
    head: COMMIT,
    checkout: ".vtc/state/checkouts/T-7",
    tests: ["reset expires [REQ-3.AC-2]"],
    expect: "fail",
    include_hidden: true,
  });
  it("accepts the guard requests", () => {
    expectValid(GateRunRequestSchema, request());
    const repro = expectValid(GateRunRequestSchema, {
      ...request(),
      reason: "fault_repro",
      expect: undefined,
      include_hidden: undefined,
    });
    expect([repro.expect, repro.include_hidden]).toEqual(["pass", false]);
  });
  it("expect fail belongs to base_fail_check, which names its tests", () => {
    expectInvalid(GateRunRequestSchema, { ...request(), reason: "round" }, "expect");
    expectInvalid(GateRunRequestSchema, { ...request(), expect: "pass" }, "expect");
    expectInvalid(GateRunRequestSchema, { ...request(), tests: [] }, "tests");
  });
  it("gateExpectationMet reads the raw verdict against the expectation", () => {
    const failing = GateReportSchema.parse(validGateReport());
    expect(gateExpectationMet(failing)).toBe(false);
    expect(gateExpectationMet({ ...failing, expect: "fail" })).toBe(true);
    const infra = {
      ...failing,
      verdict: "infra_error" as const,
    };
    expect(gateExpectationMet(infra)).toBeNull();
    const notProduct = {
      ...failing,
      expect: "fail" as const,
      results: failing.results.map((r) => ({
        ...r,
        failure_class: r.failure_class && ("flaky" as const),
      })),
    };
    expect(gateExpectationMet(notProduct)).toBe(false);
  });
});

describe("redactSecrets (§7.2)", () => {
  const planted = [
    ["ghp_" + "a1B2".repeat(9), "github_token"],
    ["AKIA" + "ABCDEFGHIJKLMNOP", "aws_access_key"],
    ["sk-ant-" + "api03-" + "x".repeat(30), "anthropic_key"],
    ["sk-proj-" + "y".repeat(40), "openai_key"],
    ["xoxb-" + "1234567890-abcdef", "slack_token"],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXZhbHVl", "jwt"],
  ] as const;
  it.each(planted)("redacts %s as %s", (secret, kind) => {
    const out = redactSecrets(`token=${secret} trailing`);
    expect(out).not.toContain(secret);
    expect(out).toContain(`[REDACTED:${kind}]`);
    expect(out).toContain("trailing");
  });
  it("keeps context around bearer tokens, URL credentials and private keys", () => {
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345")).toBe(
      "Authorization: Bearer [REDACTED:bearer_token]",
    );
    expect(redactSecrets("git clone https://bob:hunter2hunter2@github.com/acme/app")).toBe(
      "git clone https://[REDACTED:url_credentials]@github.com/acme/app",
    );
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----";
    expect(redactSecrets(`a ${key} b`)).toBe("a [REDACTED:private_key] b");
  });
  it("redacts known .env values, longest first, and ignores short ones", () => {
    const env =
      'export DB_PASSWORD="correct horse battery"\nPORT=3000\nAPI_TOKEN=tok_live_12345678 # c\n';
    const values = dotenvValues(env);
    expect(values).toEqual(["correct horse battery", "tok_live_12345678"]);
    expect(redactSecrets("pw correct horse battery on 3000 tok_live_12345678", values)).toBe(
      "pw [REDACTED:known_value] on 3000 [REDACTED:known_value]",
    );
  });
  it("leaves hashes, SHAs and ordinary text alone", () => {
    const text = `commit ${COMMIT} sha ${"a".repeat(64)} REQ-3.AC-2 src/auth/reset.ts:42`;
    expect(redactSecrets(text)).toBe(text);
  });
  it("redactJson walks nested event data", () => {
    const secret = "ghp_" + "Z9".repeat(18);
    expect(redactJson({ a: [{ b: `x ${secret}` }], n: 3, ok: true, none: null })).toEqual({
      a: [{ b: "x [REDACTED:github_token]" }],
      n: 3,
      ok: true,
      none: null,
    });
  });
});

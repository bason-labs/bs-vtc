import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  fingerprintFinding,
  isAtLeast,
  normalizeFindingPath,
  normalizeSeverity,
  normalizeSnippet,
  ROLE_CATEGORY_SEVERITY,
  FindingCategorySchema,
  severityFromScore,
  severityRank,
  sha256Hex,
  weightedSeverity,
} from "../src/index.js";

describe("fingerprintFinding", () => {
  const base = {
    rule_id: "sql-injection",
    path: "src/db.ts",
    symbol: "query",
    snippet: "db.run(`SELECT ${x}`)",
  };

  it("is a 64-char hex sha256 matching node:crypto", () => {
    expect(sha256Hex("abc")).toBe(createHash("sha256").update("abc").digest("hex"));
    expect(fingerprintFinding(base)).toMatch(/^[a-f0-9]{64}$/);
  });
  it("is deterministic", () => {
    expect(fingerprintFinding(base)).toBe(fingerprintFinding({ ...base }));
  });
  it("ignores whitespace in the snippet and line shifts", () => {
    const moved = { ...base, snippet: "  db.run(`SELECT ${x}`)\n", line: 99 };
    expect(fingerprintFinding(moved)).toBe(fingerprintFinding({ ...base, line: 3 }));
  });
  it("normalises path spellings", () => {
    expect(fingerprintFinding({ ...base, path: "./src//db.ts" })).toBe(fingerprintFinding(base));
    expect(fingerprintFinding({ ...base, path: "src\\db.ts" })).toBe(fingerprintFinding(base));
  });
  it("distinguishes rule, path, symbol and snippet", () => {
    const fp = fingerprintFinding(base);
    expect(fingerprintFinding({ ...base, rule_id: "xss" })).not.toBe(fp);
    expect(fingerprintFinding({ ...base, path: "src/Db.ts" })).not.toBe(fp);
    expect(fingerprintFinding({ ...base, symbol: "other" })).not.toBe(fp);
    expect(fingerprintFinding({ ...base, snippet: "db.run(x)" })).not.toBe(fp);
  });
  it("falls back to the line only when there is no symbol or snippet", () => {
    const bare = { rule_id: "r", path: "a.ts" };
    expect(fingerprintFinding({ ...bare, line: 1 })).not.toBe(
      fingerprintFinding({ ...bare, line: 2 }),
    );
    expect(fingerprintFinding({ ...bare, symbol: "f", line: 1 })).toBe(
      fingerprintFinding({ ...bare, symbol: "f", line: 2 }),
    );
  });
  it("does not let field boundaries collide", () => {
    expect(fingerprintFinding({ rule_id: "a", path: "b", symbol: "c d" })).not.toBe(
      fingerprintFinding({ rule_id: "a", path: "b", snippet: "c d" }),
    );
  });
  it("requires rule and path", () => {
    expect(() => fingerprintFinding({ rule_id: " ", path: "a" })).toThrow();
    expect(() => fingerprintFinding({ rule_id: "r", path: "./" })).toThrow();
  });
  it("exposes its normalisers", () => {
    expect(normalizeFindingPath("././a//b/")).toBe("a/b");
    expect(normalizeSnippet(" a \n\t b ")).toBe("a b");
  });
});

describe("normalizeSeverity", () => {
  it("ignores reviewer claims: role severity comes from the category", () => {
    expect(normalizeSeverity({ source: "role", category: "secret" })).toBe("critical");
    expect(normalizeSeverity({ source: "role", category: "docs" })).toBe("info");
    for (const category of FindingCategorySchema.options) {
      expect(ROLE_CATEGORY_SEVERITY[category]).toBeDefined();
    }
  });
  it("prefers score, then label, then SARIF level", () => {
    expect(
      normalizeSeverity({ source: "tool", score: 9.8, label: "low", sarifLevel: "note" }),
    ).toBe("critical");
    expect(normalizeSeverity({ source: "tool", label: "MODERATE", sarifLevel: "error" })).toBe(
      "medium",
    );
    expect(normalizeSeverity({ source: "tool", label: "weird", sarifLevel: "error" })).toBe("high");
    expect(normalizeSeverity({ source: "tool", sarifLevel: "note" })).toBe("low");
    expect(normalizeSeverity({ source: "tool", sarifLevel: "none" })).toBe("info");
  });
  it("treats unknown tool severities as medium (never silently passes)", () => {
    expect(normalizeSeverity({ source: "tool" })).toBe("medium");
    expect(normalizeSeverity({ source: "tool", label: "???" })).toBe("medium");
  });
  it.each([
    [10, "critical"],
    [9, "critical"],
    [8.9, "high"],
    [7, "high"],
    [6.9, "medium"],
    [4, "medium"],
    [3.9, "low"],
    [0.1, "low"],
    [0, "info"],
  ] as const)("score %d → %s", (score, expected) => {
    expect(severityFromScore(score)).toBe(expected);
  });
  it("rejects out-of-range scores", () => {
    expect(() => severityFromScore(11)).toThrow(RangeError);
    expect(() => severityFromScore(Number.NaN)).toThrow(RangeError);
  });
  it("orders and weights severities", () => {
    expect(severityRank("critical")).toBeGreaterThan(severityRank("high"));
    expect(isAtLeast("high", "medium")).toBe(true);
    expect(isAtLeast("low", "medium")).toBe(false);
    expect(isAtLeast("medium", "medium")).toBe(true);
    expect(weightedSeverity(["high", "low", "info"])).toBe(10);
    expect(weightedSeverity([])).toBe(0);
  });
});

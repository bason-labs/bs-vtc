import { describe, expect, it } from "vitest";
import { checkRoleContract, COMPILE_TARGETS } from "../src/index.js";

describe("@vtc/compiler smoke", () => {
  it("targets both hosts under dist/", () => {
    expect(COMPILE_TARGETS).toEqual({
      "claude-code": "dist/claude-plugin",
      codex: "dist/codex-plugin",
    });
  });
  it("reports role.yaml contract errors with paths", () => {
    const result = checkRoleContract({ id: "qa", version: "1" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.startsWith("version:"))).toBe(true);
  });
  it("accepts a valid role contract", () => {
    const result = checkRoleContract({
      id: "spec_verifier",
      version: "1.0.0",
      kind: "core",
      mission: "Judge one acceptance criterion against evidence.",
      inputs: ["acceptance_criterion", "evidence"],
      output: { verdicts: ["pass", "fail", "unknown"] },
      exits: ["done", "unknown"],
      reviewer: "engine",
      models: {
        "claude-code": { tier: "low", effort: "low" },
        codex: { tier: "low", effort: "low" },
      },
      tools: { profile: "read_only" },
      budget: { context_tokens: 8000 },
    });
    expect(result.ok).toBe(true);
  });
});

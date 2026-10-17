/**
 * Contracts 5.13.0 (MINOR; spine §5 readings 267, 268): a Codex Lead's consult launched headless
 * (`ConsultResult` is a union), and the human-only `cancel` tool (`CancelResult`).
 */
import { describe, expect, it } from "vitest";
import {
  CancelResultSchema,
  CONTRACTS_VERSION,
  ConsultResultSchema,
  ENGINE_MCP_TOOLS,
  isHumanOnlyTool,
} from "../src/index.js";

describe("contracts 5.13.0", () => {
  it("is MINOR over 5.12.0", () => {
    expect(CONTRACTS_VERSION.split(".")[0]).toBe("5");
  });

  it("a consult result is either the in-session action or the launched run", () => {
    const action = {
      type: "spawn_role",
      action_id: "a-3",
      role: "advisor_estimator",
      agent: "vtc-advisor-estimator",
      pack: ".vtc/state/packs/a-3.md",
      prompt: "x",
      background: false,
    };
    expect(ConsultResultSchema.safeParse({ run: "r1", action }).success).toBe(true);
    expect(
      ConsultResultSchema.safeParse({ run: "r1", launched: { action_id: "a-3", host: "codex" } })
        .success,
    ).toBe(true);
    expect(ConsultResultSchema.safeParse({ run: "r1" }).success).toBe(false);
    expect(
      ConsultResultSchema.safeParse({ run: "r1", launched: { action_id: "a-3", host: "gemini" } })
        .success,
    ).toBe(false);
  });

  it("cancel is an engine tool only a human channel may call", () => {
    const tool = ENGINE_MCP_TOOLS.find((t) => t.name === "cancel");
    expect(tool).toMatchObject({ input: "RunScopedInput", output: "CancelResult" });
    expect(isHumanOnlyTool("cancel")).toBe(true);
    expect(
      CancelResultSchema.safeParse({
        run: "r1",
        phase: "specify",
        stopped_runs: 1,
        closed_escalations: 4,
        worktrees_left: [],
      }).success,
    ).toBe(true);
    expect(
      CancelResultSchema.safeParse({
        run: "r1",
        phase: "specify",
        stopped_runs: -1,
        closed_escalations: 0,
        worktrees_left: [],
      }).success,
    ).toBe(false);
  });
});

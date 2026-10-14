/**
 * Which targets a Lookback replay can grade, and so which a canary can start for (AD-21 rule 6;
 * spine §5 readings 176, 180 and 182(8)). `vtc lookback approve` uses the same rule as RETRO.
 */
import { describe, expect, it } from "vitest";
import type { RoleContract } from "@vtc/shared";
import { roleChangesFiles } from "../../src/core/index.js";
import { ALL_FIXTURE_ROLES } from "../fixtures/roles.js";

const role = (id: string): RoleContract => {
  const contract = ALL_FIXTURE_ROLES.find((r) => r.id === id);
  if (contract === undefined) throw new Error(`no fixture role ${id}`);
  return contract;
};

describe("roleChangesFiles (reading 180)", () => {
  it("is true for a role that may write and names an artifact, in its effective mode", () => {
    expect(roleChangesFiles(role("engineer"))).toBe(true);
    expect(roleChangesFiles(role("ba"))).toBe(true);
    expect(roleChangesFiles(role("qa"), "author")).toBe(true);
  });

  it("is false for a verdict role or a read-only mode", () => {
    expect(roleChangesFiles(role("spec_verifier"))).toBe(false);
    expect(roleChangesFiles(role("qa"), "judge")).toBe(false);
    expect(roleChangesFiles(role("planner"))).toBe(false);
  });
});

/**
 * Which targets a Lookback replay can grade, and so which a canary can start for (AD-21 rule 6;
 * spine §5 readings 176, 180 and 182(8)). `vtc lookback approve` uses the same rule as RETRO.
 */
import { describe, expect, it } from "vitest";
import type { RoleContract } from "@vtc/shared";
import { replayReach, roleChangesFiles } from "../../src/core/index.js";
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

describe("replayReach: why no replay of a target can run on a run its host leads (readings 176, 180)", () => {
  it("refuses a verdict role on either host and cites reading 180, not a pending Lead decision", () => {
    for (const host of ["claude-code", "codex"] as const) {
      const why = replayReach(
        { agent: "vtc-spec-verifier", host },
        { editableInPack: true, changesFiles: false },
      );
      expect(why).toMatch(
        /vtc-spec-verifier changes no file, so the gates would grade the same base for both arms/,
      );
      expect(why).toMatch(/spine §5 reading 180/);
      expect(why).not.toMatch(/waiting for the Lead|pending/);
    }
  });

  it("refuses on Claude Code a role that is not editable_in_pack: a Claude-led trial loads its compiled agent", () => {
    expect(
      replayReach(
        { agent: "vtc-engineer", host: "claude-code" },
        { editableInPack: false, changesFiles: true },
      ),
    ).toMatch(
      /vtc-engineer replays only on a run led from claude-code, where every dispatch loads its compiled agent.*not editable_in_pack/,
    );
  });

  it("lets a role that changes files replay on a Codex-led headless run, and an editable_in_pack one on either host", () => {
    expect(
      replayReach(
        { agent: "vtc-engineer", host: "codex" },
        { editableInPack: false, changesFiles: true },
      ),
    ).toBeNull();
    expect(
      replayReach(
        { agent: "vtc-engineer", host: "claude-code" },
        { editableInPack: true, changesFiles: true },
      ),
    ).toBeNull();
  });
});

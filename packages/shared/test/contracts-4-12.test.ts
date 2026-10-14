/**
 * Contracts 4.12.0 (the closing-round fix round; spine §5 reading 182): the engine's private
 * directory is role-unwritable, the switched-role list is shared, and failures the attribution
 * tree leaves inconclusive are logged as `lookback.unattributed` while no AI tiebreak runs.
 */
import { describe, expect, it } from "vitest";
import {
  claudeSessionSandboxSettings,
  CLAUDE_LEAD_REPLAYABLE_ROLES,
  CONTRACTS_VERSION,
  EDITABLE_IN_PACK_ROLES,
  EVENT_PAYLOAD_SCHEMAS,
  ROLE_DENIED_VTC,
} from "../src/index.js";

describe("contracts 4.12.0", () => {
  it("was MINOR over 4.11.0; 5.0.0 follows it (contracts-5-0.test.ts)", () => {
    expect(CONTRACTS_VERSION.split(".")[0]).toBe("5");
  });
});

describe("the engine's private directory (guard-dir-not-role-write-denied)", () => {
  it("no role may write under <vtcHome>/guard/: the replay plan and grades, the engine-writes ledger, the dispatch records", () => {
    expect(ROLE_DENIED_VTC.homeWriteDeny).toContain("guard/**");
  });

  it("the Lead session that runs roles in-session denies it to the file tools and the sandbox", () => {
    const settings = claudeSessionSandboxSettings("/home/u/.vtc", {
      projectRoot: "/work/app",
      homeDir: "/home/u",
      hostConfigDirs: {},
    });
    expect(settings.sandbox.filesystem.denyWrite).toContain("/home/u/.vtc/guard");
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining(["Edit(//home/u/.vtc/guard)", "Edit(//home/u/.vtc/guard/**)"]),
    );
  });
});

describe("EDITABLE_IN_PACK_ROLES (D-bl, reading 166)", () => {
  it("is the one shared list, with the Spec Verifier switched", () => {
    expect(EDITABLE_IN_PACK_ROLES).toEqual(["spec_verifier"]);
  });
});

describe("CLAUDE_LEAD_REPLAYABLE_ROLES (readings 180 and 182(8))", () => {
  it("is empty in v1: the one switched role is a verdict role, which no replay grades", () => {
    expect(CLAUDE_LEAD_REPLAYABLE_ROLES).toEqual([]);
    for (const role of CLAUDE_LEAD_REPLAYABLE_ROLES) expect(EDITABLE_IN_PACK_ROLES).toContain(role);
  });
});

describe("lookback.unattributed (spec §13 attribution, reading 182)", () => {
  const schema = EVENT_PAYLOAD_SCHEMAS["lookback.unattributed"];
  it("counts the run's inconclusive failures and names their tasks", () => {
    expect(schema.parse({ failures: 2, tasks: ["T-1", "T-3"] })).toEqual({
      failures: 2,
      tasks: ["T-1", "T-3"],
    });
    expect(schema.parse({ failures: 1, tasks: [] }).tasks).toEqual([]);
  });
  it("refuses an empty count or a non-task id", () => {
    expect(() => schema.parse({ failures: 0, tasks: [] })).toThrow();
    expect(() => schema.parse({ failures: 1, tasks: ["../x"] })).toThrow();
    expect(() => schema.parse({ failures: 1, tasks: [], extra: true })).toThrow();
  });
});

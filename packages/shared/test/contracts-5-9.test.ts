/**
 * Contracts 5.9.0 (MINOR; spine §5 reading 250): the round-6 review fixes. A verify gate whose
 * `project` tool was hashed only after an install's scripts ran does not run unless the user opts
 * in with `~/.vtc/config.yaml` `gates.allow_tools_hashed_after_scripts` (H-14), never from
 * `project.yaml`.
 */
import { describe, expect, it } from "vitest";
import {
  CONTRACTS_VERSION,
  gatesAllowToolsHashedAfterScripts,
  ProjectConfigSchema,
  UserConfigSchema,
} from "../src/index.js";

describe("contracts 5.9.0", () => {
  it("is MINOR over 5.8.0", () => {
    expect(CONTRACTS_VERSION.split(".")[0]).toBe("5");
  });

  describe("gates.allow_tools_hashed_after_scripts (H-14, reading 250)", () => {
    it("is off unless the user config turns it on", () => {
      const none = UserConfigSchema.parse({ version: 1 });
      expect(gatesAllowToolsHashedAfterScripts(none)).toBe(false);
      const other = UserConfigSchema.parse({ version: 1, gates: { allow_unsandboxed: true } });
      expect(gatesAllowToolsHashedAfterScripts(other)).toBe(false);
      const on = UserConfigSchema.parse({
        version: 1,
        gates: { allow_tools_hashed_after_scripts: true },
      });
      expect(gatesAllowToolsHashedAfterScripts(on)).toBe(true);
      expect(
        UserConfigSchema.safeParse({
          version: 1,
          gates: { allow_tools_hashed_after_scripts: "yes" },
        }).success,
      ).toBe(false);
    });

    it("exists only in the user config: a project cannot accept its own unverified tools", () => {
      const project = ProjectConfigSchema.safeParse({
        version: 1,
        gates: { allow_tools_hashed_after_scripts: true },
      });
      expect(project.success).toBe(false);
    });
  });
});

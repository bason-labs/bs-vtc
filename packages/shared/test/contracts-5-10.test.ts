/**
 * Contracts 5.10.0 (MINOR; spine §5 reading 251): H-14 independent of command parsing. A
 * `project` gate's `ToolIntegrity` carries the hash of the workspace's tools it was checked
 * against (`workspace_sha256`), whatever its command runs.
 */
import { describe, expect, it } from "vitest";
import { CONTRACTS_VERSION, GateResultSchema, ToolIntegritySchema } from "../src/index.js";

const SHA = "ab".repeat(32);

describe("contracts 5.10.0", () => {
  it("is MINOR over 5.9.0", () => {
    expect(CONTRACTS_VERSION.split(".")[0]).toBe("5");
  });

  describe("ToolIntegrity.workspace_sha256 (H-14, reading 251)", () => {
    it("is an optional SHA-256 beside the command's own tool hash", () => {
      expect(
        ToolIntegritySchema.parse({ source: "project", sha256: SHA, workspace_sha256: SHA }),
      ).toEqual({ source: "project", sha256: SHA, workspace_sha256: SHA, tampered: [] });
      expect(ToolIntegritySchema.parse({ source: "pinned", sha256: SHA })).not.toHaveProperty(
        "workspace_sha256",
      );
      expect(
        ToolIntegritySchema.safeParse({ source: "project", sha256: SHA, workspace_sha256: "x" })
          .success,
      ).toBe(false);
    });

    it("still fails a gate whose workspace tools were tampered with as a product failure", () => {
      const result = {
        gate_id: "lint",
        layer: "L1",
        phase: "verify",
        blocking: true,
        new_violations: 1,
        baseline_violations: 0,
        duration_ms: 1,
        tool: {
          source: "project",
          sha256: SHA,
          workspace_sha256: SHA,
          tampered: ["packages/web/node_modules/.bin/node"],
          baseline: "after_scripts",
        },
      };
      expect(
        GateResultSchema.safeParse({ ...result, status: "fail", failure_class: "product" }).success,
      ).toBe(true);
      expect(GateResultSchema.safeParse({ ...result, status: "pass" }).success).toBe(false);
    });
  });
});

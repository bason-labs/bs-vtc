/**
 * Contracts 5.11.0 (MINOR; spine §5 reading 252): H-14 by a full dependency-tree diff. A
 * `project` gate's `ToolIntegrity` lists the packages whose own install script rebuilt them in
 * their own directory (`self_rebuilt`), which the check allows and the gate report shows as a
 * warning.
 */
import { describe, expect, it } from "vitest";
import { CONTRACTS_VERSION, GateResultSchema, ToolIntegritySchema } from "../src/index.js";

const SHA = "ab".repeat(32);

describe("contracts 5.11.0", () => {
  it("is MINOR over 5.10.0", () => {
    expect(CONTRACTS_VERSION.split(".")[0]).toBe("5");
  });

  describe("ToolIntegrity.self_rebuilt (H-14, reading 252)", () => {
    const rebuilt = {
      package: "node_modules/.pnpm/esbuild@0.25.0/node_modules/esbuild",
      files: ["node_modules/.pnpm/esbuild@0.25.0/node_modules/esbuild/bin/esbuild"],
      file_count: 1,
    };

    it("is optional, and absent when no package rebuilt itself", () => {
      expect(ToolIntegritySchema.parse({ source: "project", sha256: SHA })).not.toHaveProperty(
        "self_rebuilt",
      );
      expect(
        ToolIntegritySchema.parse({ source: "project", sha256: SHA, self_rebuilt: [rebuilt] }),
      ).toEqual({ source: "project", sha256: SHA, tampered: [], self_rebuilt: [rebuilt] });
    });

    it("names the checkout's root package as `.`, and refuses paths out of the checkout", () => {
      const root = { package: ".", files: ["dist/index.js"], file_count: 1 };
      expect(
        ToolIntegritySchema.safeParse({ source: "project", sha256: SHA, self_rebuilt: [root] })
          .success,
      ).toBe(true);
      for (const bad of [
        { ...rebuilt, package: "../outside" },
        { ...rebuilt, files: ["/etc/passwd"] },
        { ...rebuilt, file_count: -1 },
        { ...rebuilt, extra: true },
      ]) {
        expect(
          ToolIntegritySchema.safeParse({ source: "project", sha256: SHA, self_rebuilt: [bad] })
            .success,
        ).toBe(false);
      }
    });

    it("lets a gate pass with packages that rebuilt themselves, and still fails one tampered with", () => {
      const result = {
        gate_id: "test",
        layer: "L2",
        phase: "verify",
        blocking: true,
        new_violations: 0,
        baseline_violations: 0,
        duration_ms: 1,
      };
      const tool = {
        source: "project",
        sha256: SHA,
        workspace_sha256: SHA,
        self_rebuilt: [rebuilt],
      };
      expect(GateResultSchema.safeParse({ ...result, status: "pass", tool }).success).toBe(true);
      const tampered = { ...tool, tampered: ["node_modules/vitest/index.js"] };
      expect(
        GateResultSchema.safeParse({ ...result, status: "pass", tool: tampered }).success,
      ).toBe(false);
    });
  });
});

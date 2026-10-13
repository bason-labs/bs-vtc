/**
 * Reusable HostAdapter contract suite (AD-6, AD-9). Every adapter must pass it unchanged. The
 * adapters team runs it for both hosts as soon as each adapter implements `sandboxProfile`
 * (sub-project 3); until then `adapters.test.ts` lists it as a todo per host.
 */
import { describe, expect, it } from "vitest";
import { findForbiddenHostArgs, type HostAdapter, type RoleTools } from "@vtc/shared";

const PROFILES: readonly RoleTools[] = [
  { profile: "read_only", write_paths: [], engine_tools: [] },
  { profile: "write_scoped", write_paths: [".vtc/spec/**"], engine_tools: [] },
  { profile: "code_sandboxed", write_paths: [], engine_tools: [] },
];

export const runHostAdapterSafetyContract = (
  adapter: Pick<HostAdapter, "host" | "sandboxProfile">,
): void => {
  describe(`HostAdapter safety contract: ${adapter.host}`, () => {
    it.each(PROFILES.map((tools) => [tools.profile, tools] as const))(
      "sandboxProfile(%s).cliArgs never contain a bypass flag or credential path (AD-9)",
      (_profile, tools) => {
        for (const network of ["none", "registries"] as const) {
          const profile = adapter.sandboxProfile({
            tools,
            cwd: "/work/app/.vtc/state/worktrees/T-1",
            writablePaths: ["src/**"],
            protectedPaths: ["test/acceptance/**"],
            network,
          });
          expect(profile.host).toBe(adapter.host);
          expect(findForbiddenHostArgs(profile.cliArgs)).toEqual([]);
          expect(findForbiddenHostArgs([JSON.stringify(profile.settings)])).toEqual([]);
        }
      },
    );
  });
};

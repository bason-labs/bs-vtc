/**
 * Reusable HostAdapter safety contract (AD-6, AD-9). Every adapter must pass it unchanged; it
 * runs for every adapter registered in `ADAPTER_FACTORIES` (`adapters.test.ts`).
 *
 * It checks everything an adapter hands to a host: sandbox settings and CLI arguments, the exact
 * headless command (fresh and resumed, every tool profile), and every file `install` writes when
 * it installs a compiled plugin (a synthetic one in the compiler's layout) into a temp home and
 * project.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  findForbiddenHostArgs,
  findForbiddenInText,
  jsonSchemaFor,
  type HostAdapter,
  type RoleTools,
  type SpawnRoleRequest,
} from "@vtc/shared";
import { writeFixturePlugin } from "./support/plugin-fixture.js";

const PROFILES: readonly RoleTools[] = [
  { profile: "read_only", write_paths: [], engine_tools: [] },
  { profile: "write_scoped", write_paths: [".vtc/spec/**"], engine_tools: [] },
  { profile: "code_sandboxed", write_paths: [], engine_tools: [] },
];

export type SafetyContractAdapter = Pick<
  HostAdapter,
  "host" | "sandboxProfile" | "headlessCommand" | "install"
>;

export const runHostAdapterSafetyContract = (adapter: SafetyContractAdapter): void => {
  describe(`HostAdapter safety contract: ${adapter.host}`, () => {
    const dirs: string[] = [];
    afterAll(() => {
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    });
    const profileFor = (tools: RoleTools, network: "none" | "registries") =>
      adapter.sandboxProfile({
        tools,
        cwd: "/work/app/.vtc/state/worktrees/T-1",
        writablePaths: ["src/**"],
        protectedPaths: ["test/acceptance/**"],
        network,
      });

    it.each(PROFILES.map((tools) => [tools.profile, tools] as const))(
      "sandboxProfile(%s) never carries a bypass flag or credential marker (AD-9)",
      (_profile, tools) => {
        for (const network of ["none", "registries"] as const) {
          // a host may refuse a network it cannot scope (§7.2); what it returns must be clean
          let profile: ReturnType<typeof profileFor>;
          try {
            profile = profileFor(tools, network);
          } catch (error) {
            expect(network).toBe("registries");
            expect(String(error)).toMatch(/refusing/);
            continue;
          }
          expect(profile.host).toBe(adapter.host);
          expect(findForbiddenHostArgs(profile.cliArgs)).toEqual([]);
          expect(findForbiddenHostArgs([JSON.stringify(profile.settings)])).toEqual([]);
        }
      },
    );

    it.each(PROFILES.map((tools) => [tools.profile, tools] as const))(
      "headlessCommand(%s), fresh and resumed, is clean (AD-9)",
      (_profile, tools) => {
        const request: SpawnRoleRequest = {
          role: "engineer",
          model: { tier: "mid", effort: "medium", model: "model-under-test" },
          dispatch: "headless",
          cwd: "/work/app/.vtc/state/worktrees/T-1",
          prompt: "Read the task pack and follow it.",
          outputSchema: jsonSchemaFor("RoleResult", { target: "structured-output" }),
          sandbox: profileFor(tools, "none"),
          timeoutMs: 600_000,
        };
        for (const command of [
          adapter.headlessCommand(request),
          adapter.headlessCommand(request, { host: adapter.host, id: "session-1" }),
        ]) {
          expect(findForbiddenHostArgs([command.command, ...command.args])).toEqual([]);
          expect(
            findForbiddenHostArgs(Object.entries(command.env).flatMap(([k, v]) => [k, v])),
          ).toEqual([]);
        }
      },
    );

    it("install writes no bypass flag or credential marker into any file (AD-9)", async () => {
      const home = mkdtempSync(join(tmpdir(), "vtc-home-"));
      const project = mkdtempSync(join(tmpdir(), "vtc-project-"));
      const pluginDir = mkdtempSync(join(tmpdir(), "vtc-plugin-"));
      dirs.push(home, project, pluginDir);
      writeFixturePlugin(adapter.host, pluginDir);
      for (const scope of ["project", "user"] as const) {
        const result = await adapter.install({ projectRoot: project, pluginDir, scope, home });
        expect(result.written.length).toBeGreaterThan(0);
        for (const path of result.written) {
          expect(path.startsWith(home) || path.startsWith(project), path).toBe(true);
          expect(findForbiddenInText(readFileSync(path, "utf8")), path).toEqual([]);
        }
      }
    });
  });
};

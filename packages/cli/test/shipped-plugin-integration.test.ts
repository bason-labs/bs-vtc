/**
 * Integration across the compiler, the adapters and the engine on the plugins the repo really
 * ships (the real `roles/`, `skills/` and `plugins/` compiled with the production defaults), so a
 * change on one side that the other side relies on fails here, not in a live run:
 *
 * - A headless Claude role run is `--agent vtc:<agent>`, and under `--agent` the session's tools
 *   are cut to the agent's own frontmatter `tools` (live check 2026-10-14, spine §7). So every
 *   bare tool the adapter's profile allows (`--allowedTools` minus its path rules) must be in the
 *   compiled agent's `tools`: `StructuredOutput` (the `--json-schema` answer), `ToolSearch`, and
 *   each engine tool under the `--mcp-config` bridge's `mcp__vtc__<tool>` name as well as the
 *   plugin's. Without them the run ends with no `structured_output` and the engine rejects it.
 * - The roles the compiler switches to `editable_in_pack` are the shared `EDITABLE_IN_PACK_ROLES`
 *   the engine's own Lookback tests build their plugins from (D-bl, reading 166), and a pin
 *   reaches each such role through the engine's catalog of the real compiled plugin.
 * - An engineer profile's locked asset opens with the Engineer's prompt (D-br, reading 172).
 * - The roles a Claude-led run can replay are the list `replayGraderFor` derives (D-cg, D-ch;
 *   readings 201, 202 and 209(2), which retire `CLAUDE_LEAD_REPLAYABLE_ROLES`): every role that
 *   changes files, graded by the gates, and the verdict roles, graded by the verdict grader.
 * - Each compiled plugin carries the automatic PR, issue and CHANGELOG templates the upstream
 *   module renders (`AUTO_TEMPLATE_NAMES` under `AUTO_TEMPLATES_ASSET_DIR`, AD-27).
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createClaudeCodeAdapter } from "@vtc/adapters";
import { compilePlugins, readSources } from "@vtc/compiler";
import { core } from "@vtc/engine";
import {
  agentNameFor,
  AUTO_TEMPLATE_NAMES,
  autoTemplateAssetPath,
  EDITABLE_IN_PACK_ROLES,
  HUMAN_ONLY_TOOLS,
  replayGraderFor,
  rolePromptAssetPath,
  VERDICT_GRADED_ROLES,
  type AssetBundle,
  type AssetNamespace,
  type HostId,
  type RoleContract,
} from "@vtc/shared";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const compiled = (() => {
  const read = readSources(REPO_ROOT);
  const result = compilePlugins(read.files);
  if (read.errors.length > 0 || !result.ok)
    throw new Error(
      [...read.errors, ...(result.ok ? [] : result.errors)]
        .map((e) => `${e.path}: ${e.message}`)
        .join("\n"),
    );
  return result.output;
})();

const fileOf = (host: HostId, path: string): string | undefined =>
  compiled.targets[host].find((f) => f.path === path)?.text;

const bundle: AssetBundle = (() => {
  const files = new Map<AssetNamespace, Map<string, string>>(
    (["claude-code", "codex"] as const).map((host) => [
      `plugin:${host}` as const,
      new Map(compiled.targets[host].map((f) => [f.path, f.text])),
    ]),
  );
  return {
    read: (namespace, path) => {
      const text = files.get(namespace)?.get(path);
      return text === undefined ? undefined : new TextEncoder().encode(text);
    },
    list: (namespace) => [...(files.get(namespace)?.keys() ?? [])].sort(),
  };
})();

const contracts = new Map<string, RoleContract>(
  core.compiledRoleContracts(bundle).map((c) => [c.id, c]),
);

/** A frontmatter list field of a compiled Claude agent, split on its `, ` separators. */
const frontmatterList = (md: string, field: string): string[] => {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(md)?.[1] ?? "";
  const line = new RegExp(`^${field}: (.*)$`, "m").exec(front)?.[1];
  return line === undefined ? [] : line.split(", ").map((t) => t.trim());
};

const flag = (args: readonly string[], name: string): string[] => {
  const at = args.indexOf(name);
  const value = at < 0 ? undefined : args[at + 1];
  return value === undefined || value === "" ? [] : value.split(",");
};

const adapter = createClaudeCodeAdapter({
  // path strings for the deny rules only: nothing under them is read
  vtcHome: "/home/u/.vtc",
  codexHome: "/home/u/.codex",
  claudeConfigDir: "/home/u/.claude",
  homeDir: "/home/u",
  pluginDir: "/home/u/.vtc/plugins/claude-code",
});

const claudeAgents = core.pluginManifest(bundle, "claude-code")?.agents ?? [];

describe("a headless Claude role run can use every tool its profile allows (spine §7, live check 2026-10-14)", () => {
  it("covers every compiled agent", () => {
    expect(claudeAgents.length).toBeGreaterThan(20);
  });

  for (const agent of claudeAgents) {
    it(`${agent.name}: the adapter's allowed tools (minus path rules) are in the agent's own tools`, () => {
      const contract = contracts.get(agent.role);
      if (contract === undefined) throw new Error(`no contract for ${agent.role}`);
      const md = fileOf("claude-code", agent.file);
      if (md === undefined) throw new Error(`no agent file ${agent.file}`);
      const tools = new Set(frontmatterList(md, "tools"));
      const profile = adapter.sandboxProfile({
        tools: contract.tools,
        cwd: "/work/repo/.vtc/state/worktrees/t-1",
        writablePaths: contract.tools.write_paths,
        protectedPaths: [],
        network: "none",
      });
      const allowed = flag(profile.cliArgs, "--allowedTools").filter((t) => !t.includes("("));
      expect(allowed).toContain("StructuredOutput");
      for (const tool of allowed) expect(tools, `${agent.name} lacks ${tool}`).toContain(tool);
      // no human-only engine tool under either name, and the agent denies both names
      const denied = new Set(frontmatterList(md, "disallowedTools"));
      for (const tool of HUMAN_ONLY_TOOLS) {
        for (const name of [`mcp__plugin_vtc_vtc__${tool}`, `mcp__vtc__${tool}`]) {
          expect(tools).not.toContain(name);
          expect(denied, `${agent.name} must deny ${name}`).toContain(name);
        }
      }
    });
  }
});

describe("the compiled plugins switch exactly the shared EDITABLE_IN_PACK_ROLES (D-bl, reading 166)", () => {
  it("names at least the Spec Verifier", () => {
    expect(EDITABLE_IN_PACK_ROLES).toContain("spec_verifier");
  });

  for (const host of ["claude-code", "codex"] as const) {
    it(`${host}: the manifest's editable_in_pack agents are the shared list's, and a pin can reach each`, () => {
      const agents = core.pluginManifest(bundle, host)?.agents ?? [];
      const switched = [...new Set(agents.filter((a) => a.editable_in_pack).map((a) => a.role))];
      expect(switched.sort()).toEqual([...EDITABLE_IN_PACK_ROLES].sort());
      const catalog = core.pluginCatalogFrom(bundle);
      for (const role of EDITABLE_IN_PACK_ROLES) {
        const parts = catalog.promptParts?.(agentNameFor(role), host);
        expect(parts?.editableInPack, `${host}: ${role}`).toBe(true);
        expect(parts?.compiled?.editable.length ?? 0).toBeGreaterThan(0);
      }
    });
  }
});

describe("the roles a Claude-led run can replay are the list replayGraderFor derives (readings 201, 202, 209(2))", () => {
  const graded = claudeAgents.map((agent) => {
    const contract = contracts.get(agent.role);
    if (contract === undefined) throw new Error(`no contract for ${agent.role}`);
    const changesFiles = core.roleChangesFiles(contract, agent.mode ?? undefined);
    return { agent, changesFiles, grader: replayGraderFor(agent.role, changesFiles) };
  });
  const replayable = [...new Set(graded.filter((g) => g.grader !== null).map((g) => g.agent.role))];

  it("grades every agent that changes files by the gates, whether or not it is editable_in_pack (D-cg)", () => {
    const writers = graded.filter((g) => g.changesFiles);
    expect(writers.some((g) => g.agent.editable_in_pack !== true)).toBe(true);
    for (const g of writers) expect(g.grader, g.agent.name).toBe("gates");
    expect(replayable).toContain("engineer");
  });

  it("grades each verdict role by the verdict grader; it ships and changes no file (D-ch)", () => {
    for (const role of VERDICT_GRADED_ROLES) {
      const agents = graded.filter((g) => g.agent.role === role);
      expect(agents.length, role).toBeGreaterThan(0);
      for (const g of agents) {
        expect(g.changesFiles, g.agent.name).toBe(false);
        expect(g.grader, g.agent.name).toBe("verdict");
      }
    }
  });

  it("are exactly the file-changing roles and the verdict roles, and include every editable_in_pack role", () => {
    const expected = new Set([
      ...graded.filter((g) => g.changesFiles).map((g) => g.agent.role),
      ...VERDICT_GRADED_ROLES,
    ]);
    expect([...replayable].sort()).toEqual([...expected].sort());
    for (const role of EDITABLE_IN_PACK_ROLES) expect(replayable).toContain(role);
    // a role that writes nothing and has no verdict grader is never replayed
    const never = graded.filter((g) => g.grader === null);
    expect(never.length).toBeGreaterThan(0);
    for (const g of never) expect(VERDICT_GRADED_ROLES, g.agent.name).not.toContain(g.agent.role);
  });
});

/**
 * The templates are roles-compiler's this round (AD-27, reading 189): until any of them ships the
 * check is skipped, saying so in its name; once one does, every host must carry all three.
 */
const templatesShipped = (["claude-code", "codex"] as const).some((host) =>
  AUTO_TEMPLATE_NAMES.some((name) => fileOf(host, autoTemplateAssetPath(name)) !== undefined),
);

describe.skipIf(!templatesShipped)(
  `the compiled plugins carry the automatic PR, issue and CHANGELOG templates (AD-27)${templatesShipped ? "" : "; skipped: the compiler ships none yet"}`,
  () => {
    for (const host of ["claude-code", "codex"] as const)
      it(host, () => {
        for (const name of AUTO_TEMPLATE_NAMES) {
          const path = autoTemplateAssetPath(name);
          expect(path).toBe(`vtc/templates/${name}.md`);
          expect(fileOf(host, path)?.length ?? 0, `${host}: ${path}`).toBeGreaterThan(0);
        }
      });
  },
);

describe("an engineer profile's locked asset opens with the Engineer's prompt (D-br, reading 172)", () => {
  for (const host of ["claude-code", "codex"] as const) {
    it(host, () => {
      const engineer = (core.pluginManifest(bundle, host)?.agents ?? []).filter(
        (a) => a.kind === "engineer_profile",
      );
      expect(engineer.length).toBeGreaterThan(0);
      const base = fileOf(host, rolePromptAssetPath("vtc-engineer", "locked"));
      expect(base?.length ?? 0).toBeGreaterThan(0);
      for (const profile of engineer) {
        const locked = fileOf(host, rolePromptAssetPath(profile.name, "locked"));
        expect(locked?.startsWith(base ?? "\0"), `${host}: ${profile.name}`).toBe(true);
        expect(locked?.length ?? 0).toBeGreaterThan(base?.length ?? 0);
      }
    });
  }
});

/**
 * Replay arm plugins (D-cg, spine §5 reading 201; `ArmPluginCompiler` in @vtc/shared): a full
 * copy of the compiled Claude Code plugin in which only the agent's editable section differs,
 * named `vtc` and versioned `arm-<sha12 of the directory>`. Checked structurally: no test runs
 * the real `claude`.
 */
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  effectivePromptSha,
  PLUGIN_MANIFEST_ASSET,
  PluginManifestSchema,
  promptShaFor,
  rolePromptAssetPath,
  sha256Hex,
  type ArmPluginCompiler,
} from "@vtc/shared";
import {
  armPluginVersion,
  CLAUDE_PLUGIN_JSON,
  COMPILE_TARGETS,
  compilePlugins,
  createArmPluginCompiler,
  readSources,
  writeTargets,
  type CompileOptions,
} from "../src/index.js";
import { fixtureFiles } from "./fixtures.js";

const temps: string[] = [];
const temp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "vtc-arm-")));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Compiles the fixture sources and writes the Claude plugin to a temp repo; returns its dir. */
const basePlugin = (options: CompileOptions = {}): string => {
  const result = compilePlugins(fixtureFiles(), options);
  if (!result.ok) throw new Error(result.errors.map((e) => e.message).join("\n"));
  const root = temp();
  writeTargets(result.output, root);
  return join(root, COMPILE_TARGETS["claude-code"]);
};

/** Every regular file under `dir`, by POSIX path relative to it. */
const tree = (dir: string): Map<string, Buffer> => {
  const files = new Map<string, Buffer>();
  const walk = (rel: string): void => {
    for (const name of readdirSync(join(dir, rel)).sort()) {
      const path = rel === "" ? name : `${rel}/${name}`;
      const stat = lstatSync(join(dir, path));
      if (stat.isDirectory()) walk(path);
      else files.set(path, readFileSync(join(dir, path)));
    }
  };
  walk("");
  return files;
};

const bodyOf = (agentFile: string): string => agentFile.replace(/^---\n[\s\S]*?\n---\n\n/, "");
const frontOf = (agentFile: string): string => /^---\n[\s\S]*?\n---\n\n/.exec(agentFile)?.[0] ?? "";

const AGENT = "vtc-engineer";
const NEW = "Prefer the smallest diff that passes the acceptance tests.";

const compileArm = (
  compiler: ArmPluginCompiler,
  outDir: string,
  overrides: { agent?: string; editable?: string; host?: "claude-code" | "codex" } = {},
) =>
  compiler.compileArm({
    host: overrides.host ?? "claude-code",
    agent: overrides.agent ?? AGENT,
    editable: overrides.editable ?? NEW,
    outDir,
  });

describe("createArmPluginCompiler: the arm is a full copy with one editable section changed", () => {
  it("copies every file byte for byte except the agent, its section and the manifests", async () => {
    const base = basePlugin();
    const out = join(temp(), "trial-1", "b");
    const arm = await compileArm(createArmPluginCompiler({ pluginDir: base }), out);
    expect(arm.dir).toBe(out);
    const before = tree(base);
    const after = tree(out);
    expect([...after.keys()]).toEqual([...before.keys()]);
    const changed = [...after.keys()].filter(
      (p) => !after.get(p)?.equals(before.get(p) ?? Buffer.alloc(0)),
    );
    expect(changed.sort()).toEqual(
      [
        CLAUDE_PLUGIN_JSON,
        PLUGIN_MANIFEST_ASSET,
        `agents/${AGENT}.md`,
        rolePromptAssetPath(AGENT, "editable"),
      ].sort(),
    );
  });

  it("is self-consistent: the arm's manifest describes the arm's agent and section", async () => {
    const base = basePlugin();
    const out = join(temp(), "consistent");
    await compileArm(createArmPluginCompiler({ pluginDir: base }), out);
    const read = (dir: string) =>
      PluginManifestSchema.parse(
        JSON.parse(readFileSync(join(dir, PLUGIN_MANIFEST_ASSET), "utf8")),
      );
    const armed = read(out);
    for (const agent of armed.agents) {
      const body = bodyOf(readFileSync(join(out, agent.file), "utf8"));
      expect(promptShaFor(body), agent.name).toBe(agent.prompt_sha256);
      const editable = readFileSync(join(out, rolePromptAssetPath(agent.name, "editable")), "utf8");
      expect(sha256Hex(editable), agent.name).toBe(agent.editable_sha256);
    }
    expect(readFileSync(join(out, rolePromptAssetPath(AGENT, "editable")), "utf8")).toBe(NEW);
    const baseAgents = read(base).agents;
    expect(armed.agents.map(({ prompt_sha256: _p, editable_sha256: _e, ...rest }) => rest)).toEqual(
      baseAgents.map(({ prompt_sha256: _p, editable_sha256: _e, ...rest }) => rest),
    );
    expect(armed.agents.filter((a, i) => a.prompt_sha256 !== baseAgents[i]?.prompt_sha256)).toEqual(
      [armed.agents.find((a) => a.name === AGENT)],
    );
  });

  it("replaces only the editable section of the agent's instructions", async () => {
    const base = basePlugin();
    const out = join(temp(), "arm");
    await compileArm(createArmPluginCompiler({ pluginDir: base }), out);
    const original = readFileSync(join(base, `agents/${AGENT}.md`), "utf8");
    const armed = readFileSync(join(out, `agents/${AGENT}.md`), "utf8");
    const locked = bodyOf(original).slice(0, -"ENGINEER-EDITABLE".length);
    expect(bodyOf(original)).toBe(`${locked}ENGINEER-EDITABLE`);
    expect(frontOf(armed)).toBe(frontOf(original));
    expect(bodyOf(armed)).toBe(`${locked}${NEW}`);
  });

  it("keeps the name vtc and sets version arm-<sha12 of the directory>", async () => {
    const base = basePlugin();
    const out = join(temp(), "arm");
    const arm = await compileArm(createArmPluginCompiler({ pluginDir: base }), out);
    const manifest = JSON.parse(readFileSync(join(out, CLAUDE_PLUGIN_JSON), "utf8")) as {
      name: string;
      version: string;
    };
    const baseManifest = JSON.parse(readFileSync(join(base, CLAUDE_PLUGIN_JSON), "utf8")) as object;
    expect(manifest).toEqual({ ...baseManifest, version: arm.version });
    expect(manifest.name).toBe("vtc");
    expect(arm.version).toMatch(/^arm-[0-9a-f]{12}$/);
    const files = [...tree(out)].map(([path, bytes]) => ({ path, bytes }));
    expect(arm.version).toBe(armPluginVersion(files));
  });

  it("gives one editable section one version, and another a different one", async () => {
    const compiler = createArmPluginCompiler({ pluginDir: basePlugin() });
    const a = await compileArm(compiler, join(temp(), "a"));
    const aa = await compileArm(compiler, join(temp(), "aa"));
    const b = await compileArm(compiler, join(temp(), "b"), { editable: `${NEW}\nAlso run lint.` });
    expect(aa.version).toBe(a.version);
    expect(b.version).not.toBe(a.version);
  });

  it("reports the prompt version effectivePromptSha(locked, editable)", async () => {
    const base = basePlugin();
    const arm = await compileArm(createArmPluginCompiler({ pluginDir: base }), join(temp(), "x"));
    const locked = readFileSync(join(base, rolePromptAssetPath(AGENT, "locked")), "utf8");
    expect(arm.promptSha256).toBe(effectivePromptSha(locked, NEW));
  });

  it("changes an engineer profile's own section, never the Engineer's inside its locked part", async () => {
    const base = basePlugin();
    const out = join(temp(), "profile");
    await compileArm(createArmPluginCompiler({ pluginDir: base }), out, {
      agent: "vtc-engineer-frontend",
    });
    const body = bodyOf(readFileSync(join(out, "agents/vtc-engineer-frontend.md"), "utf8"));
    expect(body).toContain("ENGINEER-EDITABLE");
    expect(body).not.toContain("FRONTEND-EDITABLE");
    expect(body.endsWith(`\n${NEW}`)).toBe(true);
  });

  it("leaves an editable_in_pack agent's file alone: its section reaches it through the pack", async () => {
    const base = basePlugin({ editableInPack: ["lens_db"] });
    const out = join(temp(), "inpack");
    const arm = await compileArm(createArmPluginCompiler({ pluginDir: base }), out, {
      agent: "vtc-lens-db",
    });
    expect(readFileSync(join(out, "agents/vtc-lens-db.md"))).toEqual(
      readFileSync(join(base, "agents/vtc-lens-db.md")),
    );
    const locked = readFileSync(join(base, rolePromptAssetPath("vtc-lens-db", "locked")), "utf8");
    expect(arm.promptSha256).toBe(effectivePromptSha(locked, NEW));
  });

  it("writes only inside outDir, with no symbolic link", async () => {
    const out = join(temp(), "arm");
    await compileArm(createArmPluginCompiler({ pluginDir: basePlugin() }), out);
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const stat = lstatSync(path);
        expect(stat.isSymbolicLink(), path).toBe(false);
        expect(relative(out, realpathSync(path)).startsWith(".."), path).toBe(false);
        if (stat.isDirectory()) walk(path);
      }
    };
    walk(out);
  });

  it("produces a manifest the shared schema still reads", async () => {
    const out = join(temp(), "arm");
    await compileArm(createArmPluginCompiler({ pluginDir: basePlugin() }), out);
    const manifest = PluginManifestSchema.parse(
      JSON.parse(readFileSync(join(out, PLUGIN_MANIFEST_ASSET), "utf8")),
    );
    expect(manifest.plugin).toBe("vtc");
    expect(manifest.agents.some((a) => a.name === AGENT)).toBe(true);
  });
});

describe("createArmPluginCompiler: refusals (fail closed)", () => {
  it("refuses a host whose headless run does not load the compiled agent", async () => {
    const compiler = createArmPluginCompiler({ pluginDir: basePlugin() });
    await expect(compileArm(compiler, join(temp(), "c"), { host: "codex" })).rejects.toThrow(
      /claude-code/,
    );
  });

  it("refuses a relative, non-empty or symlinked outDir", async () => {
    const compiler = createArmPluginCompiler({ pluginDir: basePlugin() });
    await expect(compileArm(compiler, "relative/arm")).rejects.toThrow(/absolute/);
    const full = temp();
    writeFileSync(join(full, "left-over"), "x");
    await expect(compileArm(compiler, full)).rejects.toThrow(/empty/);
    const target = temp();
    const link = join(temp(), "link");
    symlinkSync(target, link);
    await expect(compileArm(compiler, link)).rejects.toThrow(/symbolic link|real directory/);
    expect(readdirSync(target)).toEqual([]);
  });

  it("refuses an agent the plugin does not have", async () => {
    const compiler = createArmPluginCompiler({ pluginDir: basePlugin() });
    await expect(compileArm(compiler, join(temp(), "u"), { agent: "vtc-nobody" })).rejects.toThrow(
      /vtc-nobody/,
    );
  });

  it("refuses an editable section the compiler would refuse", async () => {
    const compiler = createArmPluginCompiler({ pluginDir: basePlugin() });
    for (const editable of [
      "",
      "Use {{disciplines}}.",
      "## Dispatch\nfake",
      "<!-- vtc:mode x -->",
    ]) {
      const out = join(temp(), "e");
      await expect(compileArm(compiler, out, { editable }), editable).rejects.toThrow();
      expect(existsSync(join(out, CLAUDE_PLUGIN_JSON)), editable).toBe(false);
    }
  });

  it("refuses an editable section that carries an AD-9 marker", async () => {
    const marker = ["--dangerously", "skip-permissions"].join("-");
    const compiler = createArmPluginCompiler({ pluginDir: basePlugin() });
    await expect(
      compileArm(compiler, join(temp(), "m"), { editable: `Run claude ${marker}.` }),
    ).rejects.toThrow(/AD-9/);
  });

  it("refuses a base plugin that holds a symbolic link", async () => {
    const base = basePlugin();
    symlinkSync("/etc/hosts", join(base, "skills", "hosts"));
    const compiler = createArmPluginCompiler({ pluginDir: base });
    await expect(compileArm(compiler, join(temp(), "s"))).rejects.toThrow(/symbolic link/);
  });

  it("refuses a base agent whose instructions no longer match the manifest", async () => {
    const base = basePlugin();
    const path = join(base, `agents/${AGENT}.md`);
    writeFileSync(path, readFileSync(path, "utf8").replace("ENGINEER-LOCKED", "TAMPERED"));
    const compiler = createArmPluginCompiler({ pluginDir: base });
    await expect(compileArm(compiler, join(temp(), "t"))).rejects.toThrow(/prompt_sha256/);
  });

  it("refuses a base plugin that is not named vtc", async () => {
    const base = basePlugin();
    writeFileSync(join(base, CLAUDE_PLUGIN_JSON), '{ "name": "other", "version": "1.0.0" }\n');
    const compiler = createArmPluginCompiler({ pluginDir: base });
    await expect(compileArm(compiler, join(temp(), "n2"))).rejects.toThrow(/vtc/);
  });
});

describe("createArmPluginCompiler on the repo's own plugin", () => {
  // The repo compile and one full arm per agent (about 180 files each) take seconds, more under
  // load: they get their own timeouts rather than vitest's 5 s default.
  const HEAVY_MS = 120_000;
  let repo = "";
  beforeAll(() => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const result = compilePlugins(readSources(root).files);
    if (!result.ok) throw new Error(result.errors.map((e) => e.message).join("\n"));
    repo = realpathSync(mkdtempSync(join(tmpdir(), "vtc-arm-repo-")));
    writeTargets(result.output, repo);
  }, HEAVY_MS);
  afterAll(() => {
    if (repo !== "") rmSync(repo, { recursive: true, force: true });
  });

  it(
    "builds an arm for every compiled Claude agent",
    async () => {
      const base = join(repo, COMPILE_TARGETS["claude-code"]);
      const manifest = PluginManifestSchema.parse(
        JSON.parse(readFileSync(join(base, PLUGIN_MANIFEST_ASSET), "utf8")),
      );
      const compiler = createArmPluginCompiler({ pluginDir: base });
      for (const agent of manifest.agents) {
        const out = join(temp(), agent.name);
        const arm = await compileArm(compiler, out, { agent: agent.name });
        const body = bodyOf(readFileSync(join(arm.dir, agent.file), "utf8"));
        expect(body.endsWith(agent.editable_in_pack === true ? "" : `\n${NEW}`), agent.name).toBe(
          true,
        );
        rmSync(out, { recursive: true, force: true });
      }
    },
    HEAVY_MS,
  );
});

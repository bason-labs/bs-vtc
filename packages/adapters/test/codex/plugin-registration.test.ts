/**
 * `vtc install codex` registers the plugin (D-bn, spine §5 readings 168 and 213): a local
 * marketplace under the VTC home, then `codex plugin marketplace add <dir> --json` and
 * `codex plugin add vtc@vtc-local --json`, every one with the Codex home in `CODEX_HOME`. A fake
 * answers every `codex` command; no test starts the real binary.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findDisallowedHostArgs, findForbiddenHostArgs } from "@vtc/shared";
import { createCodexAdapter } from "../../src/index.js";
import { vtcHomeWriteDeniedPaths, within } from "../../src/common/homes.js";
import { answerCodexPlugin, codexFakeSpawner, type FakeProcess } from "../support/fake-spawner.js";
import { fixtureJson } from "../support/fixtures.js";
import { writeFixturePlugin } from "../support/plugin-fixture.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const temp = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
const setup = () => {
  const home = temp("vtc-home-");
  const projectRoot = temp("vtc-project-");
  const pluginDir = temp("vtc-plugin-");
  writeFixturePlugin("codex", pluginDir);
  return { home, projectRoot, pluginDir };
};
const CODEX_HOME = "/fake/codex-home";
const MOVED_SOURCE_STDERR = (
  fixtureJson("codex/plugin-reinstall.json") as { steps: { exit?: number; stderr?: string }[] }
).steps.find((step) => step.exit === 1)?.stderr;

const install = (
  options: { onPlugin?: (process: FakeProcess) => void; codexHome?: string | null } = {},
  request: Partial<Parameters<ReturnType<typeof createCodexAdapter>["install"]>[0]> = {},
) => {
  const env = setup();
  const fake = codexFakeSpawner(
    options.onPlugin === undefined ? {} : { onPlugin: options.onPlugin },
  );
  const adapter = createCodexAdapter({
    spawner: fake.spawner,
    ...(options.codexHome === null ? {} : { codexHome: options.codexHome ?? CODEX_HOME }),
  });
  const run = adapter.install({ ...env, scope: "project", ...request });
  return { env, fake, run, adapter };
};

describe("Codex install registers the plugin (D-bn, readings 168 and 213)", () => {
  it("lays out the marketplace codex-cli 0.162.1 accepted, then adds it and installs vtc from it", async () => {
    const { env, fake, run } = install();
    const result = await run;
    const root = join(env.home, ".vtc", "plugins", "codex-marketplace");
    // the index is the one the D-cl check recorded as accepted (plugin-add.json)
    const recorded = fixtureJson("codex/plugin-add.json") as { marketplace: unknown };
    expect(
      JSON.parse(readFileSync(join(root, ".agents", "plugins", "marketplace.json"), "utf8")),
    ).toEqual(recorded.marketplace);
    // the plugin itself sits at ./vtc, its root-level plugin.json included
    expect(readFileSync(join(root, "vtc", "plugin.json"), "utf8")).toBe(
      readFileSync(join(env.pluginDir, "plugin.json"), "utf8"),
    );
    expect(fake.plugins.map((p) => p.command)).toEqual([
      {
        command: "codex",
        args: ["plugin", "marketplace", "add", root, "--json"],
        env: { CODEX_HOME },
      },
      { command: "codex", args: ["plugin", "add", "vtc@vtc-local", "--json"], env: { CODEX_HOME } },
    ]);
    for (const process of fake.plugins) {
      // run from VTC's own directory, never the repo (whose .codex/ could hold project config)
      expect(process.options).toEqual({ cwd: root, stdin: "closed" });
      const { args, env: childEnv } = process.command;
      expect(findForbiddenHostArgs([...args, ...Object.values(childEnv)])).toEqual([]);
      expect(findDisallowedHostArgs(args)).toEqual([]);
    }
    expect(fake.processes).toEqual([]);
    const note = result.notes.find((n) => n.startsWith("Registered the vtc plugin"));
    expect(note).toContain("vtc@vtc-local");
    expect(note).toContain(root);
    expect(note).toContain(`${CODEX_HOME}/plugins/cache/vtc-local/vtc/0.1.0`);
    expect(note).toContain("version 0.1.0");
  });

  it("puts the marketplace under the VTC home, where no role may write (D-w)", async () => {
    const vtcHome = temp("vtc-vtchome-");
    const { fake, run } = install({}, { vtcHome });
    await run;
    const root = join(vtcHome, "plugins", "codex-marketplace");
    expect(existsSync(join(root, "vtc", "plugin.json"))).toBe(true);
    expect(fake.plugins[0]?.command.args[3]).toBe(root);
    expect(vtcHomeWriteDeniedPaths(vtcHome).some((denied) => within(denied, root))).toBe(true);
  });

  it("registers in $CODEX_HOME when it is set, else in <home>/.codex, where Codex itself looks", async () => {
    vi.stubEnv("CODEX_HOME", "");
    const unset = install({ codexHome: null });
    await unset.run;
    expect(unset.fake.plugins[0]?.command.env).toEqual({
      CODEX_HOME: join(unset.env.home, ".codex"),
    });
    vi.stubEnv("CODEX_HOME", "/elsewhere/codex");
    const set = install({ codexHome: null });
    await set.run;
    expect(set.fake.plugins.map((p) => p.command.env.CODEX_HOME)).toEqual([
      "/elsewhere/codex",
      "/elsewhere/codex",
    ]);
  });

  it("a re-install refreshes the marketplace copy, so a plugin file a newer build dropped is gone", async () => {
    const env = setup();
    const fake = codexFakeSpawner();
    const adapter = createCodexAdapter({ spawner: fake.spawner, codexHome: CODEX_HOME });
    await adapter.install({ ...env, scope: "user" });
    const stale = join(env.home, ".vtc", "plugins", "codex-marketplace", "vtc", "stale.txt");
    writeFileSync(stale, "old");
    await adapter.install({ ...env, scope: "user" });
    expect(existsSync(stale)).toBe(false);
    expect(fake.plugins.map((p) => p.command.args.slice(0, 3).join(" "))).toEqual([
      "plugin marketplace add",
      "plugin add vtc@vtc-local",
      "plugin marketplace add",
      "plugin add vtc@vtc-local",
    ]);
  });

  it("a marketplace of the same name from another directory (a moved VTC home) is removed, then added again", async () => {
    let refused = false;
    const { fake, run } = install({
      onPlugin: (process) => {
        if (!refused && process.command.args[2] === "add") {
          refused = true;
          // what codex-cli 0.162.1 said in a temporary CODEX_HOME (plugin-reinstall.json)
          process.writeStderr(`${MOVED_SOURCE_STDERR}\n`);
          process.exit(1);
        } else answerCodexPlugin(process);
      },
    });
    await run;
    expect(fake.plugins.map((p) => p.command.args.slice(0, 4).join(" "))).toEqual([
      expect.stringMatching(/^plugin marketplace add \//u),
      "plugin marketplace remove vtc-local",
      expect.stringMatching(/^plugin marketplace add \//u),
      "plugin add vtc@vtc-local --json",
    ]);
  });

  it("fails the install, naming the command and what was placed, when codex cannot run", async () => {
    const { env, run } = install({
      onPlugin: (process) => {
        process.failToStart(Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }));
      },
    });
    await expect(run).rejects.toThrow(
      /placed the vtc agents, skills and engine entry, but registering the vtc plugin with Codex failed: codex plugin marketplace add .* could not run \(is codex on PATH\?\)/u,
    );
    // the files were placed before the registration was tried
    expect(existsSync(join(env.projectRoot, ".codex", "agents", "vtc-engineer.toml"))).toBe(true);
  });

  it("fails on a refused plugin add with Codex's own message, and never reports a plugin Codex lacks", async () => {
    const { run } = install({
      onPlugin: (process) => {
        if (process.command.args[1] === "add") {
          process.writeStderr("Error: plugin `vtc` is not available in marketplace `vtc-local`\n");
          process.exit(1);
        } else answerCodexPlugin(process);
      },
    });
    await expect(run).rejects.toThrow(
      /codex plugin add vtc@vtc-local --json exited 1: Error: plugin `vtc` is not available/u,
    );
  });

  it("fails when codex reports another marketplace or plugin than the one VTC asked for", async () => {
    const other = install({
      onPlugin: (process) => {
        if (process.command.args[2] === "add") {
          process.emit(JSON.stringify({ marketplaceName: "someone-else" }));
          process.exit(0);
        } else answerCodexPlugin(process);
      },
    });
    await expect(other.run).rejects.toThrow(/as "someone-else", not vtc-local/u);
    const wrongPlugin = install({
      onPlugin: (process) => {
        if (process.command.args[1] === "add") {
          process.emit(JSON.stringify({ pluginId: "vtc@elsewhere", installedPath: "/x" }));
          process.exit(0);
        } else answerCodexPlugin(process);
      },
    });
    await expect(wrongPlugin.run).rejects.toThrow(/reported "vtc@elsewhere"/u);
    const notJson = install({
      onPlugin: (process) => {
        process.emit("ok");
        process.exit(0);
      },
    });
    await expect(notJson.run).rejects.toThrow(/printed no JSON object/u);
  });
});

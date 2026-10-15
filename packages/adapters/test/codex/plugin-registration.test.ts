/**
 * `vtc install codex` registers the plugin (D-bn, spine §5 readings 168 and 213): a local
 * marketplace under the VTC home, then `codex plugin marketplace add <dir> --json` and
 * `codex plugin add vtc@vtc-local --json`, every one with the Codex home in `CODEX_HOME`. A fake
 * answers every `codex` command; no test starts the real binary.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findDisallowedHostArgs, findForbiddenHostArgs } from "@vtc/shared";
import { ADAPTER_FACTORIES, createCodexAdapter } from "../../src/index.js";
import { codexMarketplaceSource } from "../../src/codex/plugin-registration.js";
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
  options: {
    onPlugin?: (process: FakeProcess) => void;
    codexHome?: string | null;
    installCommandTimeoutMs?: number;
  } = {},
  request: Partial<Parameters<ReturnType<typeof createCodexAdapter>["install"]>[0]> = {},
) => {
  const env = setup();
  const fake = codexFakeSpawner(
    options.onPlugin === undefined ? {} : { onPlugin: options.onPlugin },
  );
  const adapter = createCodexAdapter({
    spawner: fake.spawner,
    ...(options.codexHome === null ? {} : { codexHome: options.codexHome ?? CODEX_HOME }),
    ...(options.installCommandTimeoutMs === undefined
      ? {}
      : { installCommandTimeoutMs: options.installCommandTimeoutMs }),
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

  it("never reads $CODEX_HOME itself: without an injected Codex home everything goes to <home>/.codex", async () => {
    vi.stubEnv("CODEX_HOME", "/elsewhere/codex");
    const { env, fake, run } = install({ codexHome: null }, { scope: "user" });
    const result = await run;
    const codexHome = join(env.home, ".codex");
    expect(fake.plugins.map((p) => p.command.env.CODEX_HOME)).toEqual([codexHome, codexHome]);
    expect(readdirSync(join(codexHome, "agents")).sort()).toEqual([
      "vtc-engineer.toml",
      "vtc-qa-judge.toml",
    ]);
    expect(existsSync(join(codexHome, "config.toml"))).toBe(true);
    // nothing written outside the injected home
    for (const path of result.written) expect(path.startsWith(`${env.home}/`), path).toBe(true);
  });

  it("puts the user-scope agents, config.toml and the registration in one Codex home, the injected one", async () => {
    vi.stubEnv("CODEX_HOME", "/elsewhere/codex");
    const codexHome = temp("vtc-codex-home-");
    const { env, fake, run } = install({ codexHome }, { scope: "user" });
    const result = await run;
    expect(fake.plugins.map((p) => p.command.env.CODEX_HOME)).toEqual([codexHome, codexHome]);
    expect(result.written).toContain(join(codexHome, "agents", "vtc-engineer.toml"));
    expect(result.written).toContain(join(codexHome, "config.toml"));
    expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toContain("[mcp_servers.vtc]");
    expect(existsSync(join(env.home, ".codex"))).toBe(false);
    expect(result.notes.join(" ")).toContain(`(${codexHome};`);
  });

  it("the factory forwards the cli's Codex home to the install", async () => {
    const env = setup();
    const codexHome = temp("vtc-codex-home-");
    const fake = codexFakeSpawner();
    const adapter = ADAPTER_FACTORIES.codex?.({ spawner: fake.spawner, codexHome });
    await adapter?.install({ ...env, scope: "user" });
    expect(fake.plugins.map((p) => p.command.env.CODEX_HOME)).toEqual([codexHome, codexHome]);
    expect(existsSync(join(codexHome, "agents", "vtc-engineer.toml"))).toBe(true);
  });

  it("a re-install refreshes the marketplace copy, so a plugin file a newer build dropped is gone", async () => {
    const env = setup();
    const fake = codexFakeSpawner();
    const adapter = createCodexAdapter({
      spawner: fake.spawner,
      codexHome: temp("vtc-codex-home-"),
    });
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

  /** A fake that refuses the first `marketplace add` the way codex-cli 0.162.1 did. */
  const refuseFirstAdd = () => {
    let refused = false;
    return (process: FakeProcess) => {
      if (!refused && process.command.args[2] === "add") {
        refused = true;
        // what codex-cli 0.162.1 said in a temporary CODEX_HOME (plugin-reinstall.json)
        process.writeStderr(`${MOVED_SOURCE_STDERR}\n`);
        process.exit(1);
      } else answerCodexPlugin(process);
    };
  };
  /** A Codex home whose config.toml records `vtc-local` from `source`. */
  const codexHomeWith = (source: string): string => {
    const codexHome = temp("vtc-codex-home-");
    writeFileSync(
      join(codexHome, "config.toml"),
      `[marketplaces.vtc-local]\nsource_type = "local"\nsource = ${JSON.stringify(source)}\n`,
    );
    return codexHome;
  };

  it("a VTC marketplace of the same name from another VTC home is removed, then added again, and the note names it", async () => {
    const old = "/Users/dev/old-vtc/plugins/codex-marketplace";
    const { fake, run } = install({ onPlugin: refuseFirstAdd(), codexHome: codexHomeWith(old) });
    const result = await run;
    expect(fake.plugins.map((p) => p.command.args.slice(0, 4).join(" "))).toEqual([
      expect.stringMatching(/^plugin marketplace add \//u),
      "plugin marketplace remove vtc-local",
      expect.stringMatching(/^plugin marketplace add \//u),
      "plugin add vtc@vtc-local --json",
    ]);
    expect(result.notes.join(" ")).toContain(`registered (${old})`);
  });

  it("never removes a vtc-local marketplace that is not VTC's own, or whose source it cannot read", async () => {
    for (const codexHome of [codexHomeWith("/Users/dev/my-plugins"), temp("vtc-codex-home-")]) {
      const { fake, run } = install({ onPlugin: refuseFirstAdd(), codexHome });
      await expect(run).rejects.toThrow(
        /marketplace named vtc-local is already added from .*which is not a VTC marketplace; VTC leaves it alone/u,
      );
      expect(fake.plugins.map((p) => p.command.args[2])).toEqual(["add"]);
    }
  });

  it("reads the recorded marketplace source from config.toml, approximately", () => {
    const config = [
      "[marketplaces.other]",
      'source = "/x"',
      "",
      '[marketplaces."vtc-local"] # VTC',
      'source_type = "local"',
      "source = '/a/plugins/codex-marketplace' # added by vtc",
      "",
    ].join("\n");
    expect(codexMarketplaceSource(config, "vtc-local")).toBe("/a/plugins/codex-marketplace");
    expect(
      codexMarketplaceSource('[marketplaces.vtc-local]\nsource = "/a \\"b\\""\n', "vtc-local"),
    ).toBe('/a "b"');
    expect(codexMarketplaceSource("[marketplaces.vtc-local]\nsource = [1]\n", "vtc-local")).toBe(
      null,
    );
    expect(codexMarketplaceSource('source = "/x"\n', "vtc-local")).toBe(null);
  });

  it("never writes the marketplace index through a link planted at its path", async () => {
    const vtcHome = temp("vtc-vtchome-");
    const victim = join(temp("vtc-victim-"), "target.json");
    writeFileSync(victim, "untouched");
    const dir = join(vtcHome, "plugins", "codex-marketplace", ".agents", "plugins");
    mkdirSync(dir, { recursive: true });
    symlinkSync(victim, join(dir, "marketplace.json"));
    const { run } = install({}, { vtcHome });
    await expect(run).rejects.toThrow();
    expect(readFileSync(victim, "utf8")).toBe("untouched");
  });

  it("says a codex plugin command that hung was stopped, not that codex is missing", async () => {
    const { run } = install({ onPlugin: () => undefined, installCommandTimeoutMs: 10 });
    await expect(run).rejects.toThrow(
      /codex plugin marketplace add .* did not finish in time and was stopped/u,
    );
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

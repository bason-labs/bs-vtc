/**
 * Keeping the user's own MCP servers out of Codex role runs (D-cf, AD-25 rule 1, §7 H-3 row):
 * before every headless start or resume the adapter asks Codex which MCP servers the run would
 * load (`codex mcp list --json` with the run's own overrides, in the role's cwd), turns every one
 * but the engine bridge off in the command, and checks again that none is left on.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { jsonSchemaFor, type RoleTools, type SpawnRoleRequest } from "@vtc/shared";
import {
  codexConfigArgs,
  codexMcpListCommand,
  codexMcpServersOffOverride,
  parseCodexMcpList,
} from "../../src/codex/mcp-servers.js";
import { codexHeadlessCommand, codexSandboxProfile } from "../../src/codex/command.js";
import { createCodexAdapter } from "../../src/index.js";
import { codexFakeSpawner, fakeMcpList } from "../support/fake-spawner.js";
import { fixtureJson } from "../support/fixtures.js";

const CWD = "/work/app/.vtc/state/worktrees/T-1";
const VTC_HOME = "/users-dev/.vtc";
const RESEARCH: RoleTools = {
  profile: "write_scoped",
  write_paths: [".vtc/research/briefs/**"],
  engine_tools: ["research_fetch"],
  host_web: true,
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "vtc-codex-mcp-"));
  dirs.push(dir);
  return dir;
};

const request = (tools: RoleTools = RESEARCH): SpawnRoleRequest => ({
  role: "research_analyst",
  model: { tier: "mid", effort: "medium", model: "engine-model-id" },
  dispatch: "headless",
  cwd: CWD,
  prompt: "Read the task pack and follow it.",
  outputSchema: jsonSchemaFor("RoleResult", { target: "structured-output" }),
  sandbox: codexSandboxProfile(
    { tools, cwd: CWD, writablePaths: [], protectedPaths: [], network: "none" },
    { vtcHome: VTC_HOME, platform: "darwin" },
  ),
  timeoutMs: 60_000,
});

/** The `--config`/`-c` values of argv, in order. */
const configValues = (args: readonly string[]): string[] =>
  args.filter((_, i) => i > 0 && (args[i - 1] === "--config" || args[i - 1] === "-c"));

describe("codex mcp list (pure parts)", () => {
  it("asks Codex for the servers as JSON, with the run's own overrides", () => {
    expect(codexMcpListCommand(["--config", "features.plugins=false"])).toEqual({
      command: "codex",
      args: ["mcp", "list", "--json", "--config", "features.plugins=false"],
      env: {},
    });
  });

  it("reads only each server's name and enabled flag, never its env, headers or command", () => {
    const stdout = JSON.stringify([
      {
        name: "fetchy",
        enabled: true,
        transport: { type: "stdio", command: "/bin/x", env: { TOKEN: "dummy-secret" } },
      },
      {
        name: "we.ird name",
        enabled: false,
        transport: { type: "streamable_http", http_headers: { X: "dummy-header" } },
      },
    ]);
    const servers = parseCodexMcpList(stdout);
    expect(servers).toEqual([
      { name: "fetchy", enabled: true },
      { name: "we.ird name", enabled: false },
    ]);
    expect(JSON.stringify(servers)).not.toMatch(/dummy/u);
    expect(parseCodexMcpList("[]\n")).toEqual([]);
  });

  it("reads nothing it cannot be sure of (fail closed)", () => {
    for (const stdout of [
      "",
      "No MCP servers configured",
      "{}",
      '[{"enabled":true}]',
      '[{"name":"x"}]',
      '[{"name":"x","enabled":"yes"}]',
      '[{"name":"","enabled":true}]',
      '["x"]',
    ]) {
      expect(parseCodexMcpList(stdout), stdout).toBeNull();
    }
  });

  it("turns servers off with one inline table, which takes any name (a dotted -c key splits a quoted name)", () => {
    expect(codexMcpServersOffOverride(["fetchy", "we.ird name", 'q"uote'])).toBe(
      'mcp_servers={"fetchy"={enabled=false}, "we.ird name"={enabled=false}, "q\\"uote"={enabled=false}}',
    );
    // the fake reads it back the way codex-cli 0.162.1 does
    expect(
      fakeMcpList(
        [
          { name: "fetchy", enabled: true },
          { name: "we.ird name", enabled: true },
          { name: 'q"uote', enabled: true },
        ],
        [codexMcpServersOffOverride(["fetchy", "we.ird name", 'q"uote'])],
      ).every((server) => !server.enabled),
    ).toBe(true);
  });

  it("refuses a server name TOML cannot carry, or an empty list", () => {
    expect(() => codexMcpServersOffOverride(["bad\u0000name"])).toThrow(/name/u);
    expect(() => codexMcpServersOffOverride(["lone\ud800"])).toThrow(/name/u);
    expect(() => codexMcpServersOffOverride([])).toThrow(/no server/u);
  });

  it("picks the --config and -c values out of an argv, in order", () => {
    expect(
      codexConfigArgs([
        "exec",
        "--sandbox",
        "read-only",
        "--config",
        "a=1",
        "-c",
        "b=2",
        "--",
        "-",
      ]),
    ).toEqual(["--config", "a=1", "-c", "b=2"]);
  });
});

describe("codexHeadlessCommand with the user's servers turned off", () => {
  const options = { scratchDir: "/users-dev/.vtc/run/codex" };

  it("puts the inline table before the profile's overrides, so the engine bridge keys still apply after it", () => {
    const args = codexHeadlessCommand(request(), {
      ...options,
      mcpServersOff: ["fetchy", "vtc", "planted"],
    }).args;
    const values = configValues(args);
    const off = values.indexOf('mcp_servers={"fetchy"={enabled=false}, "planted"={enabled=false}}');
    expect(off).toBeGreaterThanOrEqual(0);
    // the bridge is never turned off, and its keys come after the table (a later whole-table
    // override would drop them: codex-cli 0.162.1 applies overrides in order)
    expect(values.filter((v) => v.startsWith("mcp_servers="))).toHaveLength(1);
    expect(values.findIndex((v) => v.startsWith("mcp_servers.vtc."))).toBeGreaterThan(off);
  });

  it("adds no table when there is nothing to turn off", () => {
    for (const mcpServersOff of [undefined, [], ["vtc"]]) {
      const args = codexHeadlessCommand(request(), {
        ...options,
        ...(mcpServersOff === undefined ? {} : { mcpServersOff }),
      }).args;
      expect(configValues(args).some((v) => v.startsWith("mcp_servers="))).toBe(false);
    }
  });

  it("refuses a profile that sets the whole mcp_servers table: it would undo the table above", () => {
    const base = request();
    const sandbox = {
      ...base.sandbox,
      cliArgs: [...base.sandbox.cliArgs, "--config", "mcp_servers={}"],
    };
    expect(() => codexHeadlessCommand({ ...base, sandbox }, options)).toThrow(/mcp_servers/u);
  });

  it("turns Codex plugins off for every role run: a plugin's MCP servers cannot be turned off by name", () => {
    for (const tools of [RESEARCH, { profile: "read_only", write_paths: [], engine_tools: [] }]) {
      expect(
        configValues(codexHeadlessCommand(request(tools as RoleTools), options).args),
      ).toContain("features.plugins=false");
    }
  });
});

describe("Codex spawnRole keeps the user's MCP servers out (D-cf, AD-25 rule 1)", () => {
  const SERVERS = [
    { name: "fetchy", enabled: true },
    { name: "already-off", enabled: false },
    { name: "planted", enabled: true },
  ];

  it("lists the servers in the role's cwd with the run's overrides, turns all but the bridge off, and checks again", async () => {
    const fake = codexFakeSpawner({ servers: SERVERS });
    const adapter = createCodexAdapter({ spawner: fake.spawner, scratchDir: scratch() });
    const spawned = await adapter.spawnRole(request());
    if (spawned.dispatch !== "headless") throw new Error("expected a headless run");
    const run = fake.processes[0]!;
    // the run is exactly the adapter's headless command, which now names the servers
    expect(run.command).toEqual(adapter.headlessCommand(request()));
    expect(configValues(run.command.args)).toContain(
      'mcp_servers={"already-off"={enabled=false}, "fetchy"={enabled=false}, "planted"={enabled=false}}',
    );
    // first the discovery (the run's overrides without the table), then the check (with it)
    expect(fake.mcpLists).toHaveLength(2);
    const [discover, confirm] = fake.mcpLists;
    expect(discover!.options).toEqual({ cwd: CWD, stdin: "closed" });
    expect(discover!.command.args.slice(0, 3)).toEqual(["mcp", "list", "--json"]);
    expect(discover!.command.args.slice(3)).toEqual(
      codexConfigArgs(codexHeadlessCommand(request(), { scratchDir: "x" }).args),
    );
    expect(confirm!.command.args.slice(3)).toEqual(codexConfigArgs(run.command.args));
    run.exit(0);
    await spawned.run.wait();
    await adapter.dispose();
  });

  it("does the same before a resume", async () => {
    const fake = codexFakeSpawner({ servers: SERVERS });
    const adapter = createCodexAdapter({ spawner: fake.spawner, scratchDir: scratch() });
    const session = { host: "codex" as const, id: "thr-1" };
    const resumed = await adapter.resume(session, request());
    if (resumed.dispatch !== "headless") throw new Error("expected a headless run");
    expect(fake.mcpLists).toHaveLength(2);
    expect(fake.processes[0]!.command).toEqual(adapter.headlessCommand(request(), session));
    expect(fake.processes[0]!.command.args).toContain("resume");
    expect(
      configValues(fake.processes[0]!.command.args).some((v) => v.startsWith("mcp_servers=")),
    ).toBe(true);
    fake.processes[0]!.exit(0);
    await adapter.dispose();
  });

  it("with no server of the user's, the run carries no table", async () => {
    const fake = codexFakeSpawner();
    const adapter = createCodexAdapter({ spawner: fake.spawner, scratchDir: scratch() });
    await adapter.spawnRole(request());
    expect(
      configValues(fake.processes[0]!.command.args).some((v) => v.startsWith("mcp_servers=")),
    ).toBe(false);
    fake.processes[0]!.exit(0);
    await adapter.dispose();
  });

  const refuses = async (
    onMcpList: Parameters<typeof codexFakeSpawner>[0],
    pattern: RegExp,
    extra: { readonly mcpListTimeoutMs?: number } = {},
  ) => {
    const fake = codexFakeSpawner(onMcpList);
    const adapter = createCodexAdapter({ spawner: fake.spawner, scratchDir: scratch(), ...extra });
    await expect(adapter.spawnRole(request())).rejects.toThrow(pattern);
    // nothing started: no role run ever begins with servers it could not account for
    expect(fake.processes).toEqual([]);
    await adapter.dispose();
    return fake;
  };

  it("refuses the run when Codex cannot list its servers (exit code, no start, garbled or cut output)", async () => {
    await refuses(
      {
        onMcpList: (p) => {
          p.writeStderr("Error: failed to load configuration\n");
          p.exit(1);
        },
      },
      /could not list the MCP servers.*exited 1/u,
    );
    await refuses(
      {
        onMcpList: (p) => {
          p.failToStart(new Error("ENOENT"));
        },
      },
      /could not list the MCP servers/u,
    );
    await refuses(
      {
        onMcpList: (p) => {
          p.emit('[{"name": "x", "enabled": tr');
          p.exit(0);
        },
      },
      /could not read/u,
    );
  });

  it("never echoes what the list printed (it can hold a server's env or headers)", async () => {
    const fake = codexFakeSpawner({
      onMcpList: (p) => {
        p.emit('{"name":"x","env":{"TOKEN":"dummy-secret"}}');
        p.writeStderr("dummy-secret-on-stderr\n");
        p.exit(0);
      },
    });
    const adapter = createCodexAdapter({ spawner: fake.spawner, scratchDir: scratch() });
    const error = await adapter.spawnRole(request()).catch((e: unknown) => e);
    expect(String(error)).toMatch(/could not read/u);
    expect(String(error)).not.toMatch(/dummy/u);
    await adapter.dispose();
  });

  it("refuses the run when a listed server is still on after the table (a source no override reaches)", async () => {
    let calls = 0;
    await refuses(
      {
        onMcpList: (p) => {
          calls += 1;
          // a server only the second (checking) listing shows, still on
          p.emit(
            JSON.stringify(
              calls === 1
                ? [{ name: "fetchy", enabled: true }]
                : [
                    { name: "fetchy", enabled: false },
                    { name: "sneaky", enabled: true },
                    { name: "vtc", enabled: true },
                  ],
            ),
          );
          p.exit(0);
        },
      },
      /would still start MCP servers sneaky/u,
    );
  });

  it("kills a listing that hangs, and refuses the run", async () => {
    const fake = await refuses({ onMcpList: () => undefined }, /could not list/u, {
      mcpListTimeoutMs: 20,
    });
    expect(fake.mcpLists[0]!.signals).toEqual(["SIGKILL"]);
  });

  it("dispose() stops a listing still running", async () => {
    const fake = codexFakeSpawner({ onMcpList: () => undefined });
    const adapter = createCodexAdapter({ spawner: fake.spawner, scratchDir: scratch() });
    const pending = adapter.spawnRole(request()).catch((e: unknown) => e);
    await new Promise((resolve) => setImmediate(resolve));
    await adapter.dispose();
    expect(String(await pending)).toMatch(/could not list/u);
    expect(fake.mcpLists[0]!.signals).toEqual(["SIGKILL"]);
  });

  it("a subagent dispatch lists nothing", async () => {
    const fake = codexFakeSpawner();
    const adapter = createCodexAdapter({ spawner: fake.spawner, scratchDir: scratch() });
    await adapter.spawnRole({ ...request(), dispatch: "subagent" });
    expect(fake.mcpLists).toEqual([]);
    await adapter.dispose();
  });
});

describe("the D-cl offline MCP check (codex-cli 0.162.1, mcp-isolation.json)", () => {
  interface Listing {
    readonly ok: boolean;
    readonly servers?: readonly { name: string; enabled: boolean }[];
  }
  const recorded = fixtureJson("codex/mcp-isolation.json") as {
    readonly withoutOverrides: Listing;
    readonly discovered: readonly string[];
    readonly afterOverrides: Listing;
    readonly confirmOff: string;
    readonly dottedKeyForDottedName: Listing;
    readonly dottedThenTable: Listing;
    readonly pluginServerByName: Listing;
  };
  const on = (listing: Listing) =>
    (listing.servers ?? []).filter((s) => s.enabled).map((s) => s.name);

  it("a role worktree in a trusted repo sees the user's servers, one planted in its own .codex/config.toml and a plugin's", () => {
    expect(on(recorded.withoutOverrides)).toEqual([
      "fetchy",
      "planted",
      "plugfetch",
      "we.ird name",
    ]);
  });

  it("with the run's overrides the plugin's server is gone, the rest are turned off by name, and only the bridge stays on", () => {
    expect(recorded.discovered).toEqual(["fetchy", "off", "planted", "we.ird name"]);
    expect(on(recorded.afterOverrides)).toEqual(["vtc"]);
    expect(recorded.confirmOff).toBe("ok");
  });

  it("why one inline table first: a dotted key cannot name a dotted server, a later table drops earlier dotted keys, and a plugin's server has no entry to turn off", () => {
    expect(recorded.dottedKeyForDottedName.ok).toBe(false);
    expect(recorded.dottedThenTable.ok).toBe(true);
    expect((recorded.dottedThenTable.servers ?? []).map((s) => s.name)).not.toContain("vtc");
    expect(recorded.pluginServerByName.ok).toBe(false);
  });
});

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findForbiddenHostArgs,
  HostOutcomeSchema,
  jsonSchemaFor,
  ROLE_DENIED_VTC,
  type RoleTools,
  type SpawnRoleRequest,
} from "@vtc/shared";
import { codexSandboxProfile } from "../../src/codex/command.js";
import { ADAPTER_FACTORIES, createCodexAdapter } from "../../src/index.js";
import { fakeSpawner } from "../support/fake-spawner.js";
import { fixtureLines } from "../support/fixtures.js";

const CWD = "/work/app/.vtc/state/worktrees/T-1";
const READ_ONLY: RoleTools = { profile: "read_only", write_paths: [], engine_tools: [] };
const ENGINEER: RoleTools = { profile: "code_sandboxed", write_paths: [], engine_tools: [] };
const WRITE_SCOPED: RoleTools = {
  profile: "write_scoped",
  write_paths: [".vtc/spec/**"],
  engine_tools: [],
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "vtc-codex-scratch-"));
  dirs.push(dir);
  return dir;
};

// not under /home: on macOS that is an automount, and the overlap check resolves real paths
const VTC_HOME = "/users-dev/.vtc";
const profile = (tools: RoleTools, network: "none" | "registries" = "none") =>
  createCodexAdapter({ vtcHome: VTC_HOME }).sandboxProfile({
    tools,
    cwd: CWD,
    writablePaths: ["src/**"],
    protectedPaths: ["test/acceptance/**"],
    network,
  });

const argAfter = (args: readonly string[], flag: string): string | undefined =>
  args[args.indexOf(flag) + 1];

const request = (overrides: Partial<SpawnRoleRequest> = {}): SpawnRoleRequest => ({
  role: "spec_verifier",
  model: { tier: "top", effort: "high", model: "engine-model-id" },
  dispatch: "headless",
  cwd: CWD,
  prompt: "Read the task pack and follow it.",
  outputSchema: jsonSchemaFor("RoleResult", { target: "structured-output" }),
  sandbox: profile(READ_ONLY),
  timeoutMs: 60_000,
  ...overrides,
});

describe("Codex sandboxProfile (§12.1, AD-9)", () => {
  it("reviewers run read-only", () => {
    const p = profile(READ_ONLY);
    expect(p.cliArgs).toEqual(["--config", 'sandbox_mode="read-only"']);
    expect(p.settings).toEqual({ sandbox_mode: "read-only" });
    expect(p.enforced).toEqual({
      readOnly: true,
      perPathWriteDeny: false,
      network: true,
      secretsUnreadable: false,
    });
  });

  it("write-scoped roles and engineers run workspace-write with the network forced off; the engine checks the paths", () => {
    for (const tools of [WRITE_SCOPED, ENGINEER]) {
      const p = profile(tools);
      // set explicitly, so a user config.toml that opens the network or adds roots cannot widen it
      expect(p.cliArgs).toEqual([
        "--config",
        'sandbox_mode="workspace-write"',
        "--config",
        "sandbox_workspace_write.network_access=false",
        "--config",
        "sandbox_workspace_write.writable_roots=[]",
      ]);
      expect(p.settings).toEqual({
        sandbox_mode: "workspace-write",
        sandbox_workspace_write: { network_access: false, writable_roots: [] },
      });
      // Codex has no per-path read deny: the token and host credentials stay readable (D-ad)
      expect(p.enforced).toEqual({
        readOnly: false,
        perPathWriteDeny: false,
        network: true,
        secretsUnreadable: false,
      });
    }
  });

  it("refuses the registry network for every role: Codex could only open all of it, engine API included (D-ac)", () => {
    for (const tools of [READ_ONLY, WRITE_SCOPED, ENGINEER]) {
      expect(() => profile(tools, "registries")).toThrow(/registries network on Codex/);
    }
  });

  it("keeps the VTC home's denied directories unwritable: the sandbox writes only the worktree, so a worktree overlapping one is refused (D-w)", () => {
    const at =
      (vtcHome: string, tools: RoleTools, cwd = CWD) =>
      () =>
        createCodexAdapter({ vtcHome }).sandboxProfile({
          tools,
          cwd,
          writablePaths: [],
          protectedPaths: [],
          network: "none",
        });
    for (const tools of [WRITE_SCOPED, ENGINEER]) {
      expect(at(`${CWD}/.home/.vtc`, tools)).toThrow(/VTC home/);
      expect(at("/v", tools, "/v/hidden/T-1")).toThrow(/VTC home/);
      expect(at("/v", tools, "/v")).toThrow(/VTC home/);
      // D-ap: everything under the VTC home that is later run or trusted with full privileges
      for (const inside of [
        "/v/scanners/osv",
        "/v/claude-marketplace/plugins",
        "/v/plugins/0.1.0",
        "/v/engines",
        "/v/run",
        "/v/config.yaml",
        "/v/token",
      ]) {
        expect(at("/v", tools, inside), inside).toThrow(/VTC home/);
      }
      // a repo whose own .vtc is the VTC home (a dotfiles repo at ~) keeps its worktrees writable
      expect(at(VTC_HOME, tools, `${VTC_HOME}/state/worktrees/T-1`)).not.toThrow();
    }
    // a reviewer writes nothing, wherever the VTC home is
    expect(() =>
      createCodexAdapter({ vtcHome: `${CWD}/.vtc-home` }).sandboxProfile({
        tools: READ_ONLY,
        cwd: CWD,
        writablePaths: [],
        protectedPaths: [],
        network: "none",
      }),
    ).not.toThrow();
  });

  it("drops the OS temp roots from the writable set when the VTC home lies under one (D-w)", () => {
    const request = (tools: RoleTools) => ({
      tools,
      cwd: CWD,
      writablePaths: [],
      protectedPaths: [],
      network: "none" as const,
    });
    const excluded = [
      "--config",
      "sandbox_workspace_write.exclude_tmpdir_env_var=true",
      "--config",
      "sandbox_workspace_write.exclude_slash_tmp=true",
    ];
    for (const tools of [WRITE_SCOPED, ENGINEER]) {
      const p = codexSandboxProfile(request(tools), {
        vtcHome: "/scratch-tmp/vtc",
        tempRoots: ["/scratch-tmp"],
      });
      expect(p.cliArgs.slice(-4)).toEqual(excluded);
      expect(p.settings).toEqual({
        sandbox_mode: "workspace-write",
        sandbox_workspace_write: {
          network_access: false,
          writable_roots: [],
          exclude_tmpdir_env_var: true,
          exclude_slash_tmp: true,
        },
      });
      // a VTC home outside every temp root keeps the temp directory writable (D-ag)
      expect(
        codexSandboxProfile(request(tools), { vtcHome: VTC_HOME, tempRoots: ["/scratch-tmp"] })
          .cliArgs,
      ).not.toContain("sandbox_workspace_write.exclude_slash_tmp=true");
      // the real temp directory, as the adapter finds it
      expect(
        createCodexAdapter({ vtcHome: join(scratch(), "vtc") }).sandboxProfile(request(tools))
          .cliArgs,
      ).toEqual(expect.arrayContaining(excluded));
    }
    // a reviewer writes nothing, so it needs no exclusion
    expect(
      codexSandboxProfile(request(READ_ONLY), {
        vtcHome: "/scratch-tmp/vtc",
        tempRoots: ["/scratch-tmp"],
      }).cliArgs,
    ).toEqual(["--config", 'sandbox_mode="read-only"']);
  });

  it.skipIf(process.platform === "win32")(
    "compares real paths, so a symlinked worktree or VTC home cannot hide an overlap (D-w)",
    () => {
      const root = scratch();
      const vtcHome = join(root, "vtc");
      mkdirSync(join(vtcHome, "hidden", "T-1"), { recursive: true });
      symlinkSync(join(vtcHome, "hidden", "T-1"), join(root, "worktree-link"));
      const at = (home: string, cwd: string) => () =>
        createCodexAdapter({ vtcHome: home }).sandboxProfile({
          tools: ENGINEER,
          cwd,
          writablePaths: [],
          protectedPaths: [],
          network: "none",
        });
      expect(at(vtcHome, join(root, "worktree-link"))).toThrow(/VTC home/);
      const worktree = join(root, "repo", "wt");
      mkdirSync(join(worktree, "nested"), { recursive: true });
      symlinkSync(join(worktree, "nested"), join(root, "vtc-link"));
      expect(at(join(root, "vtc-link"), worktree)).toThrow(/VTC home/);
    },
  );

  it("records what Codex cannot express of the role deny list (D-w): no command deny for `vtc calibrate`, no per-path write deny", () => {
    // Gap: Codex has no per-command deny for a headless run, so `vtc calibrate` cannot be denied
    // here. Writes to <vtcHome>/{allowlists,osv-db,hidden} are blocked only because
    // workspace-write writes nothing outside the worktree (and the OS temp directory, D-ag).
    // `vtc calibrate` confirms in an interactive terminal only, and the engine never runs a role
    // with a terminal.
    expect(ROLE_DENIED_VTC.subcommands).toEqual(["calibrate"]);
    for (const tools of [READ_ONLY, WRITE_SCOPED, ENGINEER]) {
      const p = profile(tools);
      const text = JSON.stringify([p.cliArgs, p.settings]);
      expect(text).not.toContain("calibrate");
      for (const glob of ROLE_DENIED_VTC.homeWriteDeny) expect(text).not.toContain(glob);
      expect(p.enforced.perPathWriteDeny).toBe(false);
    }
  });
});

describe("Codex headlessCommand", () => {
  it("runs codex exec --json with the sandbox, the schema file, the engine's model and the prompt on stdin", () => {
    const dir = scratch();
    const command = createCodexAdapter({ scratchDir: dir }).headlessCommand(request());
    expect(command.command).toBe("codex");
    expect(command.env).toEqual({});
    const args = command.args;
    expect(args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(args).toContain('sandbox_mode="read-only"');
    expect(args).not.toContain("--sandbox");
    expect(argAfter(args, "--output-schema")).toMatch(
      new RegExp(`^${dir}/role-result-[0-9a-f]{16}\\.json$`),
    );
    expect(args).toContain('model_reasoning_effort="high"');
    // the engine resolves the model (AD-6 rule 2); the adapter never picks one
    expect(argAfter(args, "--model")).toBe("engine-model-id");
    expect(args.slice(-2)).toEqual(["--", "-"]);
    expect(args.join(" ")).not.toContain("Read the task pack");
    expect(findForbiddenHostArgs(args)).toEqual([]);
  });

  it("resumes the thread with codex exec resume (spike: works after 4h)", () => {
    const args = createCodexAdapter().headlessCommand(request(), {
      host: "codex",
      id: "thr-1",
    }).args;
    expect(args.slice(0, 3)).toEqual(["exec", "resume", "--json"]);
    // `codex exec resume` has no --sandbox flag; the config override keeps the sandbox
    expect(args).toContain('sandbox_mode="read-only"');
    expect(args).not.toContain("--sandbox");
    expect(args.slice(-3)).toEqual(["--", "thr-1", "-"]);
  });

  it("runs on the session's default model with only the effort set when the engine resolved no id (D-ae)", () => {
    const adapter = ADAPTER_FACTORIES.codex!({ vtcHome: VTC_HOME });
    for (const session of [undefined, { host: "codex" as const, id: "thr-1" }]) {
      const args = adapter.headlessCommand(
        request({ model: { tier: "mid", effort: "medium" } }),
        session,
      ).args;
      expect(args).not.toContain("--model");
      expect(args).not.toContain("-m");
      expect(args.some((a) => a.startsWith("model="))).toBe(false);
      expect(args).toContain('model_reasoning_effort="medium"');
    }
  });

  it("turns off `notify` for every role run, fresh or resumed, so no planted or user notify command runs outside the sandbox (D-ao)", () => {
    const adapter = createCodexAdapter({ vtcHome: VTC_HOME });
    for (const session of [undefined, { host: "codex" as const, id: "thr-1" }]) {
      for (const tools of [READ_ONLY, WRITE_SCOPED, ENGINEER]) {
        const args = adapter.headlessCommand(request({ sandbox: profile(tools) }), session).args;
        const at = args.indexOf("notify=[]");
        expect(at).toBeGreaterThan(0);
        expect(args[at - 1]).toBe("--config");
        // an option, never after the `--` that ends them
        expect(at).toBeLessThan(args.indexOf("--"));
      }
    }
  });

  it("records what `codex exec --help` (0.162.1) offers no override for: project MCP servers (D-ao, spine §7)", () => {
    // Gap: `-c` sets one dotted key and its help does not say whether a table value replaces or
    // merges into the project layer, and no flag skips the project `.codex/config.toml`
    // (`--ignore-user-config` covers only `$CODEX_HOME/config.toml`). A blanket
    // `-c mcp_servers={}` would also drop the engine bridge `[mcp_servers.vtc]` that roles use
    // for engine tools, if it replaced the table. So no MCP override is passed; the engine's
    // pre-dispatch restore of `.codex/**` (spine §5 reading 72) keeps a planted server from
    // reaching the next start, and the §7 spike row settles the override.
    for (const session of [undefined, { host: "codex" as const, id: "thr-1" }]) {
      const args = createCodexAdapter({ vtcHome: VTC_HOME }).headlessCommand(
        request(),
        session,
      ).args;
      expect(args.some((a) => a.startsWith("mcp_servers"))).toBe(false);
      expect(args).not.toContain("--dangerously-bypass-hook-trust");
    }
  });

  it("refuses another host's session", () => {
    expect(() =>
      createCodexAdapter().headlessCommand(request(), { host: "claude-code", id: "s" }),
    ).toThrow(/claude-code/);
  });
});

describe("Codex spawnRole", () => {
  it("a subagent dispatch is a foreground spawn_role with the base agent name", async () => {
    const result = await createCodexAdapter().spawnRole(
      request({ dispatch: "subagent", role: "qa", mode: "author" }),
    );
    expect(result).toEqual({
      dispatch: "subagent",
      instruction: {
        agent: "vtc-qa-author",
        prompt: "Read the task pack and follow it.",
        background: false,
      },
    });
    expect("subagentName" in createCodexAdapter()).toBe(false);
  });

  it("a headless run writes the schema file, sends the prompt on stdin and ends with the recorded outcome", async () => {
    const dir = scratch();
    const { spawner, processes } = fakeSpawner();
    const adapter = createCodexAdapter({ spawner, scratchDir: dir });
    const spawned = await adapter.spawnRole(request());
    if (spawned.dispatch !== "headless") throw new Error("expected a headless run");
    const proc = processes[0]!;
    expect(proc.command).toEqual(adapter.headlessCommand(request()));
    expect(proc.options).toEqual({ cwd: CWD, stdin: "pipe" });
    expect(await proc.stdinText()).toBe("Read the task pack and follow it.");
    const schemaPath = argAfter(proc.command.args, "--output-schema")!;
    expect(JSON.parse(readFileSync(schemaPath, "utf8"))).toEqual(request().outputSchema);
    expect(statSync(schemaPath).mode & 0o077).toBe(0);
    proc.emit(...fixtureLines("codex/exec-output-schema-events.jsonl").filter((l) => l !== ""));
    proc.exit(0);
    const outcome = HostOutcomeSchema.parse(await spawned.run.wait());
    expect(outcome).toMatchObject({
      kind: "done",
      session_ref: { host: "codex", id: "<thread-id>" },
    });
    await adapter.dispose();
  });
});

describe.skipIf(process.platform === "win32")("Codex scratch directory", () => {
  const spawnWith = async (scratchDir: string) => {
    const { spawner } = fakeSpawner((p) => {
      p.exit(0);
    });
    const adapter = createCodexAdapter({ spawner, scratchDir });
    try {
      await adapter.spawnRole(request());
    } finally {
      await adapter.dispose();
    }
  };

  it("creates a missing scratch directory private (0700)", async () => {
    const dir = join(scratch(), "nested");
    await spawnWith(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("refuses a scratch directory others can reach, or a link planted in its place", async () => {
    const open = join(scratch(), "open");
    mkdirSync(open);
    chmodSync(open, 0o777);
    await expect(spawnWith(open)).rejects.toThrow(/not a private directory/);
    const link = join(scratch(), "link");
    symlinkSync(scratch(), link);
    await expect(spawnWith(link)).rejects.toThrow(/not a private directory/);
  });
});

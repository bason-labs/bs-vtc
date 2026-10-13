import { describe, expect, it } from "vitest";
import {
  findForbiddenHostArgs,
  HostOutcomeSchema,
  jsonSchemaFor,
  type RoleTools,
  type SpawnRoleRequest,
} from "@vtc/shared";
import { createClaudeCodeAdapter } from "../../src/index.js";
import { fakeSpawner } from "../support/fake-spawner.js";
import { fixtureText } from "../support/fixtures.js";

const CWD = "/work/app/.vtc/state/worktrees/T-1";
const READ_ONLY: RoleTools = { profile: "read_only", write_paths: [], engine_tools: [] };
const WRITE_SCOPED: RoleTools = {
  profile: "write_scoped",
  write_paths: [".vtc/spec/**"],
  engine_tools: ["research_fetch"],
};
const ENGINEER: RoleTools = { profile: "code_sandboxed", write_paths: [], engine_tools: [] };

const HOME = "/home/dev";
const profile = (
  tools: RoleTools,
  network: "none" | "registries" = "none",
  writablePaths: readonly string[] = ["src/**"],
) =>
  createClaudeCodeAdapter({ home: HOME }).sandboxProfile({
    tools,
    cwd: CWD,
    writablePaths,
    protectedPaths: ["test/acceptance/**"],
    network,
  });

/** Denied to every role: the web tools (engine tools only) and the VTC install token. */
const ALWAYS_DENIED = ["WebFetch", "WebSearch", "Read(~/.vtc/token)"];
const HOST_CONFIG_DENIED = [".claude/**", ".mcp.json", ".codex/**"].flatMap((path) =>
  ["Edit", "Write", "NotebookEdit"].map((tool) => `${tool}(${path})`),
);

const argAfter = (args: readonly string[], flag: string): string | undefined =>
  args[args.indexOf(flag) + 1];

const request = (overrides: Partial<SpawnRoleRequest> = {}): SpawnRoleRequest => ({
  role: "qa",
  mode: "judge",
  model: { tier: "mid", effort: "medium", model: "sonnet" },
  dispatch: "headless",
  cwd: CWD,
  prompt: "Read the task pack and follow it.",
  outputSchema: jsonSchemaFor("RoleResult", { target: "structured-output" }),
  sandbox: profile(READ_ONLY),
  timeoutMs: 60_000,
  ...overrides,
});

describe("Claude sandboxProfile (§12.1, AD-9)", () => {
  it("reviewers get read tools only: no edits, no shell", () => {
    const p = profile(READ_ONLY);
    expect(p.enforced).toEqual({ readOnly: true, perPathWriteDeny: true, network: true });
    expect(argAfter(p.cliArgs, "--allowedTools")).toBe("Read,Grep,Glob");
    expect(argAfter(p.cliArgs, "--disallowedTools")?.split(",")).toEqual([
      "Edit",
      "Write",
      "NotebookEdit",
      "Bash",
      ...ALWAYS_DENIED,
    ]);
  });

  it("pins the permission mode in the settings too, so the allowlist decides", () => {
    expect(profile(WRITE_SCOPED).settings).toMatchObject({
      permissions: { defaultMode: "dontAsk" },
    });
  });

  it("no role may read the VTC install token, from a tool or from the sandboxed shell (AD-5)", () => {
    for (const tools of [READ_ONLY, WRITE_SCOPED, ENGINEER]) {
      const p = profile(tools);
      expect(argAfter(p.cliArgs, "--disallowedTools")?.split(",")).toEqual(
        expect.arrayContaining(ALWAYS_DENIED),
      );
      expect(p.settings).toMatchObject({
        sandbox: { filesystem: { denyRead: [`${HOME}/.vtc/token`] } },
      });
    }
  });

  it("refuses a write path that would inject permission rules", () => {
    for (const hostile of [
      "x),mcp__plugin_vtc_vtc__approve,Edit(y",
      "a b",
      "src/(x)",
      'src/"x"',
      "src/\u0007x",
    ]) {
      expect(() => profile(WRITE_SCOPED, "none", [hostile])).toThrow(/permission rule/);
    }
    expect(() => profile(WRITE_SCOPED, "none", ["src/**/*.ts", ".vtc/spec/**"])).not.toThrow();
  });

  it("write-scoped roles may edit only their paths, plus their engine tools", () => {
    const allowed = argAfter(profile(WRITE_SCOPED).cliArgs, "--allowedTools")?.split(",");
    expect(allowed).toEqual([
      "Read",
      "Grep",
      "Glob",
      "Edit(src/**)",
      "Write(src/**)",
      "NotebookEdit(src/**)",
      "mcp__plugin_vtc_vtc__research_fetch",
    ]);
    expect(argAfter(profile(WRITE_SCOPED).cliArgs, "--disallowedTools")?.split(",")).toEqual([
      "Edit(test/acceptance/**)",
      "Write(test/acceptance/**)",
      "NotebookEdit(test/acceptance/**)",
      ...HOST_CONFIG_DENIED,
      "Bash",
      ...ALWAYS_DENIED,
    ]);
  });

  it("engineers get Bash inside the OS sandbox, with no unsandboxed escape", () => {
    const p = profile(ENGINEER);
    expect(argAfter(p.cliArgs, "--allowedTools")?.split(",")).toContain("Bash");
    expect(p.settings).toMatchObject({
      sandbox: {
        enabled: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        filesystem: {
          denyWrite: [
            `${CWD}/test/acceptance/**`,
            `${CWD}/.claude/**`,
            `${CWD}/.mcp.json`,
            `${CWD}/.codex/**`,
          ],
        },
        network: { allowedDomains: [] },
      },
    });
    expect(JSON.parse(argAfter(p.cliArgs, "--settings") ?? "")).toEqual(p.settings);
  });

  it("protected paths and host config are denied to the edit tools as well", () => {
    expect(argAfter(profile(ENGINEER).cliArgs, "--disallowedTools")?.split(",")).toEqual([
      "Edit(test/acceptance/**)",
      "Write(test/acceptance/**)",
      "NotebookEdit(test/acceptance/**)",
      ...HOST_CONFIG_DENIED,
      ...ALWAYS_DENIED,
    ]);
  });

  it("only the install phase reaches package registries", () => {
    const domains = (network: "none" | "registries") =>
      (
        profile(ENGINEER, network).settings as {
          sandbox: { network: { allowedDomains: string[] } };
        }
      ).sandbox.network.allowedDomains;
    expect(domains("none")).toEqual([]);
    expect(domains("registries")).toContain("registry.npmjs.org");
  });
});

describe("Claude headlessCommand", () => {
  const adapter = createClaudeCodeAdapter();

  it("runs claude -p as the role's plugin agent with stream-json, the host schema form and the prompt on stdin", () => {
    const command = adapter.headlessCommand(request({ maxTurns: 30, maxBudgetUsd: 2.5 }));
    expect(command.command).toBe("claude");
    expect(command.env).toEqual({});
    const args = command.args;
    expect(args[0]).toBe("-p");
    expect(argAfter(args, "--output-format")).toBe("stream-json");
    expect(args).toContain("--verbose");
    expect(argAfter(args, "--agent")).toBe("vtc:vtc-qa-judge");
    expect(argAfter(args, "--model")).toBe("sonnet");
    expect(argAfter(args, "--effort")).toBe("medium");
    expect(argAfter(args, "--permission-prompts")).toBe("none");
    // pinned, so the user's defaultMode (acceptEdits, auto) never applies to a role run
    expect(argAfter(args, "--permission-mode")).toBe("dontAsk");
    expect(argAfter(args, "--max-turns")).toBe("30");
    expect(argAfter(args, "--max-budget-usd")).toBe("2.5");
    const schema = JSON.parse(argAfter(args, "--json-schema") ?? "") as Record<string, unknown>;
    expect(schema).not.toHaveProperty("$schema");
    expect(schema).not.toHaveProperty("$id");
    expect(args.join(" ")).not.toContain("Read the task pack");
    expect(args).not.toContain("--resume");
    expect(args).not.toContain("--plugin-dir");
    expect(findForbiddenHostArgs(args)).toEqual([]);
  });

  it("with the compiled plugin on disk, loads it directly and ignores the user's settings", () => {
    const isolated = createClaudeCodeAdapter({ home: HOME, pluginDir: "/opt/vtc/plugin" });
    const args = isolated.headlessCommand(request()).args;
    expect(argAfter(args, "--plugin-dir")).toBe("/opt/vtc/plugin");
    expect(argAfter(args, "--setting-sources")).toBe("project");
    expect(findForbiddenHostArgs(args)).toEqual([]);
  });

  it("resumes the same session with --resume (spike: works after 4h)", () => {
    const args = adapter.headlessCommand(request(), { host: "claude-code", id: "sess-9" }).args;
    expect(argAfter(args, "--resume")).toBe("sess-9");
  });

  it("refuses another host's session or sandbox profile", () => {
    expect(() => adapter.headlessCommand(request(), { host: "codex", id: "t" })).toThrow(/codex/);
    const codexSandbox = { ...profile(READ_ONLY), host: "codex" as const };
    expect(() => adapter.headlessCommand(request({ sandbox: codexSandbox }))).toThrow(/codex/);
  });

  it("names plugin agents with the plugin namespace (AD-14 rule 1)", () => {
    expect(adapter.subagentName?.("vtc-qa-judge")).toBe("vtc:vtc-qa-judge");
  });
});

describe("Claude spawnRole and resume", () => {
  it("a subagent dispatch is a background spawn_role instruction for the Lead", async () => {
    const result = await createClaudeCodeAdapter().spawnRole(request({ dispatch: "subagent" }));
    expect(result).toEqual({
      dispatch: "subagent",
      instruction: {
        agent: "vtc:vtc-qa-judge",
        prompt: "Read the task pack and follow it.",
        background: true,
      },
    });
  });

  it("a headless run starts exactly headlessCommand, streams lines and ends with the outcome", async () => {
    const { spawner, processes } = fakeSpawner();
    const adapter = createClaudeCodeAdapter({ spawner });
    const spawned = await adapter.spawnRole(request());
    if (spawned.dispatch !== "headless") throw new Error("expected a headless run");
    const proc = processes[0]!;
    expect(proc.command).toEqual(adapter.headlessCommand(request()));
    expect(proc.options).toEqual({ cwd: CWD, stdin: "pipe" });
    expect(await proc.stdinText()).toBe("Read the task pack and follow it.");
    expect(spawned.run.command).toBe(proc.command);
    const result = JSON.stringify(JSON.parse(fixtureText("claude-code/p-json-schema-result.json")));
    proc.emit('{"type":"system","subtype":"init","session_id":"<session-id>"}', result);
    proc.exit(0);
    const outcome = HostOutcomeSchema.parse(await spawned.run.wait());
    expect(outcome.kind).toBe("done");
    const lines: string[] = [];
    for await (const line of spawned.run.lines()) lines.push(line);
    expect(lines).toHaveLength(2);
    expect(adapter.parseEvents(lines).outcome).toEqual(outcome);
  });

  it("resume starts the --resume command and refuses a Codex session", async () => {
    const { spawner, processes } = fakeSpawner((p) => {
      p.exit(1);
    });
    const adapter = createClaudeCodeAdapter({ spawner });
    const session = { host: "claude-code" as const, id: "sess-1" };
    const resumed = await adapter.resume(session, request());
    if (resumed.dispatch !== "headless") throw new Error("expected a headless run");
    await resumed.run.wait();
    expect(processes[0]?.command).toEqual(adapter.headlessCommand(request(), session));
    await expect(adapter.resume({ host: "codex", id: "t" }, request())).rejects.toThrow(/codex/);
  });

  it("dispose kills live runs and refuses new ones", async () => {
    const { spawner, processes } = fakeSpawner();
    const adapter = createClaudeCodeAdapter({ spawner });
    const spawned = await adapter.spawnRole(request());
    if (spawned.dispatch !== "headless") throw new Error("expected a headless run");
    await adapter.dispose();
    expect(processes[0]?.signals).toEqual(["SIGTERM"]);
    expect((await spawned.run.wait()).kind).toBe("error");
    await expect(adapter.spawnRole(request())).rejects.toThrow(/disposed/);
    await adapter.dispose();
  });
});

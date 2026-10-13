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
  type RoleTools,
  type SpawnRoleRequest,
} from "@vtc/shared";
import { createCodexAdapter } from "../../src/index.js";
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

const profile = (tools: RoleTools, network: "none" | "registries" = "none") =>
  createCodexAdapter().sandboxProfile({
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
  model: { tier: "top", effort: "high", model: "gpt-5-codex" },
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
    expect(p.enforced).toEqual({ readOnly: true, perPathWriteDeny: false, network: true });
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
      expect(p.enforced).toEqual({ readOnly: false, perPathWriteDeny: false, network: true });
    }
  });

  it("opens the network only for the install phase, and then says the host does not scope it", () => {
    const p = profile(ENGINEER, "registries");
    expect(p.cliArgs).toEqual([
      "--config",
      'sandbox_mode="workspace-write"',
      "--config",
      "sandbox_workspace_write.network_access=true",
      "--config",
      "sandbox_workspace_write.writable_roots=[]",
    ]);
    expect(p.enforced.network).toBe(false);
    expect(profile(READ_ONLY, "registries").cliArgs).toEqual([
      "--config",
      'sandbox_mode="read-only"',
    ]);
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
    expect(argAfter(args, "--model")).toBe("gpt-5-codex");
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

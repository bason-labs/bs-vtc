import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
import { CODEX_DEFAULT_TIER_MODELS, codexModelFor, createCodexAdapter } from "../../src/index.js";
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
  model: { tier: "top", effort: "high", model: "engine-guess" },
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

  it("write-scoped roles and engineers run workspace-write; the engine checks the paths", () => {
    for (const tools of [WRITE_SCOPED, ENGINEER]) {
      const p = profile(tools);
      expect(p.cliArgs).toEqual(["--config", 'sandbox_mode="workspace-write"']);
      expect(p.enforced.perPathWriteDeny).toBe(false);
      expect(p.enforced.readOnly).toBe(false);
    }
  });

  it("opens the network only for the install phase, and then says the host does not scope it", () => {
    const p = profile(ENGINEER, "registries");
    expect(p.cliArgs).toEqual([
      "--config",
      'sandbox_mode="workspace-write"',
      "--config",
      "sandbox_workspace_write.network_access=true",
    ]);
    expect(p.enforced.network).toBe(false);
    expect(profile(READ_ONLY, "registries").cliArgs).toEqual([
      "--config",
      'sandbox_mode="read-only"',
    ]);
  });
});

describe("Codex models (spine §5 reading 26)", () => {
  it("the built-in tier map is empty until the spike names Codex model ids", () => {
    expect(CODEX_DEFAULT_TIER_MODELS).toEqual({});
    expect(codexModelFor("top")).toBeNull();
  });

  it("project.yaml hosts.models.codex overrides per tier", () => {
    expect(codexModelFor("top", { top: "model-x" })).toBe("model-x");
    expect(codexModelFor("low", { top: "model-x" })).toBeNull();
  });
});

describe("Codex headlessCommand", () => {
  it("runs codex exec --json with the sandbox, the schema file and only the reasoning effort", () => {
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
    // the engine's model id is not a Codex model the adapter knows: run on the session's model
    expect(args).not.toContain("--model");
    expect(args.slice(-2)).toEqual(["--", "Read the task pack and follow it."]);
    expect(findForbiddenHostArgs(args)).toEqual([]);
  });

  it("passes the project's model for the tier", () => {
    const args = createCodexAdapter({ models: { top: "model-x" } }).headlessCommand(request()).args;
    expect(argAfter(args, "--model")).toBe("model-x");
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
    expect(args.slice(-3)).toEqual(["--", "thr-1", "Read the task pack and follow it."]);
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

  it("a headless run writes the schema file, closes stdin and ends with the recorded outcome", async () => {
    const dir = scratch();
    const { spawner, processes } = fakeSpawner();
    const adapter = createCodexAdapter({ spawner, scratchDir: dir });
    const spawned = await adapter.spawnRole(request());
    if (spawned.dispatch !== "headless") throw new Error("expected a headless run");
    const proc = processes[0]!;
    expect(proc.command).toEqual(adapter.headlessCommand(request()));
    expect(proc.options).toEqual({ cwd: CWD, stdin: "closed" });
    const schemaPath = argAfter(proc.command.args, "--output-schema")!;
    expect(JSON.parse(readFileSync(schemaPath, "utf8"))).toEqual(request().outputSchema);
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

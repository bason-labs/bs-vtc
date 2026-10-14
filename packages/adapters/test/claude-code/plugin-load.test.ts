/**
 * The load proof of a replay arm's run (D-cg, spine §5 reading 201): the recorded D-cl run
 * (`stream-arm-success.jsonl`, `arm-debug-plugin-lines.log`, Claude Code 2.1.299, the real
 * compiled plugin copied unchanged into an arm) and the documented managed-settings lock line.
 */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonSchemaFor, type RoleTools, type SpawnRoleRequest } from "@vtc/shared";
import { claudeArmDebugFile } from "../../src/claude-code/command.js";
import { claudePluginLoadProof, PLUGIN_LOCKED_MARK } from "../../src/claude-code/plugin-load.js";
import { createClaudeCodeAdapter } from "../../src/index.js";
import { fakeSpawner } from "../support/fake-spawner.js";
import { fixtureLines, fixtureText } from "../support/fixtures.js";

const ARM = "<arm-dir>";
const AGENT = "vtc:vtc-qa-judge";
const STREAM = fixtureLines("claude-code/stream-arm-success.jsonl").filter((l) => l !== "");
const DEBUG = fixtureText("claude-code/arm-debug-plugin-lines.log");

const proof = (overrides: Partial<Parameters<typeof claudePluginLoadProof>[0]> = {}) =>
  claudePluginLoadProof({
    armDir: ARM,
    agent: AGENT,
    lines: STREAM,
    debugLog: DEBUG,
    ...overrides,
  });

/** The recorded stream with its init record's plugins and agents replaced. */
const withInit = (change: (init: Record<string, unknown>) => Record<string, unknown>) =>
  STREAM.map((line) => {
    const event = JSON.parse(line) as Record<string, unknown>;
    return event.subtype === "init" ? JSON.stringify(change(event)) : line;
  });

describe("claudePluginLoadProof (D-cg)", () => {
  it("the recorded arm run proves the arm's copy loaded: its init names the arm as the vtc plugin's source, and the debug log has no lock", () => {
    expect(DEBUG).toContain("--plugin-dir <arm-dir> is one plugin");
    expect(DEBUG).not.toContain(PLUGIN_LOCKED_MARK);
    expect(proof()).toEqual({ loaded: true, dir: ARM });
  });

  it("a managed-settings lock in the debug log is plugin_locked, whatever the stream says", () => {
    const locked = fixtureText("claude-code/arm-debug-locked.synthetic.log");
    expect(locked).toContain('copy of "vtc" ignored: plugin is locked by managed settings');
    const result = proof({ debugLog: locked });
    expect(result.loaded).toBe(false);
    expect(result.loaded ? "" : result.reason).toMatch(/^plugin_locked/u);
  });

  it("fails closed without a debug log, an init record, the agent, or the arm as the vtc plugin's only source", () => {
    const cases: readonly Partial<Parameters<typeof claudePluginLoadProof>[0]>[] = [
      { debugLog: null },
      { lines: STREAM.filter((line) => !line.includes('"subtype":"init"')) },
      { lines: [] },
      { agent: "vtc:vtc-architect-not-there" },
      // the installed copy, not the arm
      {
        lines: withInit((init) => ({
          ...init,
          plugins: [
            { name: "vtc", path: "/home/dev/.vtc/claude-marketplace/vtc", source: "vtc@vtc" },
          ],
        })),
      },
      // the arm and another vtc copy
      {
        lines: withInit((init) => ({
          ...init,
          plugins: [
            { name: "vtc", path: ARM, source: "vtc@inline" },
            { name: "vtc", path: "/elsewhere/vtc", source: "vtc@vtc" },
          ],
        })),
      },
      { lines: withInit((init) => ({ ...init, plugins: "<redacted>" })) },
      { lines: withInit((init) => ({ ...init, plugins: [{ name: "vtc" }] })) },
      { lines: withInit((init) => ({ ...init, agents: undefined })) },
    ];
    for (const change of cases) {
      expect(proof(change).loaded, JSON.stringify(change).slice(0, 120)).toBe(false);
    }
  });

  it("compares directories by their real location", () => {
    const real = (path: string) => (path === "/tmp/link/a" ? "/private/tmp/link/a" : path);
    const lines = withInit((init) => ({
      ...init,
      plugins: [{ name: "vtc", path: "/private/tmp/link/a", source: "vtc@inline" }],
    }));
    expect(proof({ armDir: "/tmp/link/a", lines, realPath: real })).toEqual({
      loaded: true,
      dir: "/tmp/link/a",
    });
    expect(proof({ armDir: "/tmp/link/a", lines }).loaded).toBe(false);
  });
});

describe("HeadlessRun.pluginLoad on a replay arm's run (D-cg)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const READ_ONLY: RoleTools = { profile: "read_only", write_paths: [], engine_tools: [] };
  const setup = (keepArmDebugLogs?: boolean) => {
    const guard = mkdtempSync(join(tmpdir(), "vtc-arm-"));
    dirs.push(guard);
    const armDir = join(guard, "arms", "trial-1", "b");
    mkdirSync(armDir, { recursive: true });
    const { spawner, processes } = fakeSpawner();
    const adapter = createClaudeCodeAdapter({
      spawner,
      vtcHome: "/home/dev/.vtc",
      codexHome: "/home/dev/.codex",
      claudeConfigDir: "/home/dev/.claude",
      homeDir: "/home/dev",
      pluginDir: "/opt/vtc/plugin",
      ...(keepArmDebugLogs === undefined ? {} : { keepArmDebugLogs }),
    });
    const request = (pluginDir?: string): SpawnRoleRequest => ({
      role: "qa",
      mode: "judge",
      model: { tier: "low", effort: "low" },
      dispatch: "headless",
      cwd: join(guard, "checkout"),
      prompt: "Read the task pack and follow it.",
      outputSchema: jsonSchemaFor("RoleResult", { target: "structured-output" }),
      sandbox: adapter.sandboxProfile({
        tools: READ_ONLY,
        cwd: join(guard, "checkout"),
        writablePaths: [],
        protectedPaths: [],
        network: "none",
        readDeny: ["/work/app", "/work/app/.git"],
      }),
      timeoutMs: 60_000,
      ...(pluginDir === undefined ? {} : { pluginDir }),
    });
    /** The recorded stream with the arm at its real path, as the live run printed it. */
    const stream = STREAM.map((line) => line.split(ARM).join(armDir));
    return { adapter, processes, armDir, request, stream };
  };

  it("proves the arm's copy from the run's stream and the debug log it wrote beside the arm", async () => {
    const { adapter, processes, armDir, request, stream } = setup();
    const spawned = await adapter.spawnRole(request(armDir));
    if (spawned.dispatch !== "headless") throw new Error("expected a headless run");
    expect(processes[0]?.command.args).toContain("--debug-file");
    writeFileSync(claudeArmDebugFile(armDir), DEBUG.split(ARM).join(armDir));
    processes[0]?.emit(...stream);
    processes[0]?.exit(0);
    expect((await spawned.run.wait()).kind).toBe("done");
    expect(await spawned.run.pluginLoad?.()).toEqual({ loaded: true, dir: armDir });
    await adapter.dispose();
  });

  it("removes the debug log once the run has ended and the proof has read it; the proof is worked out once", async () => {
    const { adapter, processes, armDir, request, stream } = setup();
    const spawned = await adapter.spawnRole(request(armDir));
    if (spawned.dispatch !== "headless") throw new Error("expected a headless run");
    writeFileSync(claudeArmDebugFile(armDir), DEBUG.split(ARM).join(armDir));
    processes[0]?.emit(...stream);
    processes[0]?.exit(0);
    const first = await spawned.run.pluginLoad?.();
    expect(first).toEqual({ loaded: true, dir: armDir });
    expect(existsSync(claudeArmDebugFile(armDir))).toBe(false);
    expect(await spawned.run.pluginLoad?.()).toEqual(first);
    await adapter.dispose();
  });

  it("removes the debug log after the run even when nobody asks for the proof, unless told to keep it", async () => {
    for (const keep of [false, true]) {
      const { adapter, processes, armDir, request, stream } = setup(keep);
      const spawned = await adapter.spawnRole(request(armDir));
      if (spawned.dispatch !== "headless") throw new Error("expected a headless run");
      writeFileSync(claudeArmDebugFile(armDir), DEBUG.split(ARM).join(armDir));
      processes[0]?.emit(...stream);
      processes[0]?.exit(0);
      await spawned.run.wait();
      await adapter.dispose();
      if (keep) {
        await spawned.run.pluginLoad?.();
        expect(existsSync(claudeArmDebugFile(armDir))).toBe(true);
      } else {
        // the proof settles on its own after the run, without a pluginLoad() call
        await vi.waitFor(() => {
          expect(existsSync(claudeArmDebugFile(armDir))).toBe(false);
        });
      }
    }
  });

  it("never reads a debug log an earlier run left: it is removed before the run starts", async () => {
    const { adapter, processes, armDir, request, stream } = setup();
    writeFileSync(claudeArmDebugFile(armDir), DEBUG.split(ARM).join(armDir));
    const spawned = await adapter.spawnRole(request(armDir));
    if (spawned.dispatch !== "headless") throw new Error("expected a headless run");
    processes[0]?.emit(...stream);
    processes[0]?.exit(0);
    const result = await spawned.run.pluginLoad?.();
    expect(result?.loaded).toBe(false);
    await adapter.dispose();
  });

  it("a locked plugin's run is not proven, even with a clean stream", async () => {
    const { adapter, processes, armDir, request, stream } = setup();
    const spawned = await adapter.spawnRole(request(armDir));
    if (spawned.dispatch !== "headless") throw new Error("expected a headless run");
    writeFileSync(
      claudeArmDebugFile(armDir),
      fixtureText("claude-code/arm-debug-locked.synthetic.log"),
    );
    processes[0]?.emit(...stream);
    processes[0]?.exit(0);
    const result = await spawned.run.pluginLoad?.();
    expect(result?.loaded).toBe(false);
    await adapter.dispose();
  });

  it("a run without an arm has no pluginLoad and loads the adapter's plugin", async () => {
    const { adapter, processes, request } = setup();
    const spawned = await adapter.spawnRole(request());
    if (spawned.dispatch !== "headless") throw new Error("expected a headless run");
    expect("pluginLoad" in spawned.run).toBe(false);
    expect(processes[0]?.command.args).not.toContain("--debug-file");
    processes[0]?.exit(0);
    await spawned.run.wait();
    await adapter.dispose();
  });
});

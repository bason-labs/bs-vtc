import { describe, expect, it } from "vitest";
import { findForbiddenHostArgs, HostAuthStatusSchema, type HostAdapter } from "@vtc/shared";
import { createClaudeCodeAdapter, createCodexAdapter } from "../src/index.js";
import { fakeSpawner, type FakeProcess } from "./support/fake-spawner.js";

const NOW = new Date("2026-10-14T09:00:00Z");

const adapterFor = (
  host: "claude-code" | "codex",
  onSpawn: (p: FakeProcess) => void,
  authTimeoutMs?: number,
) => {
  const fake = fakeSpawner(onSpawn);
  const options = {
    spawner: fake.spawner,
    now: () => NOW,
    ...(authTimeoutMs === undefined ? {} : { authTimeoutMs }),
  };
  const adapter: HostAdapter =
    host === "claude-code" ? createClaudeCodeAdapter(options) : createCodexAdapter(options);
  return { adapter, processes: fake.processes };
};

const replying =
  (code: number | null, stdout: string, stderr = "") =>
  (p: FakeProcess): void => {
    setImmediate(() => {
      p.stdout.write(stdout);
      p.writeStderr(stderr);
      p.exit(code);
    });
  };

const status = async (adapter: HostAdapter) => {
  if (adapter.authStatus === undefined) throw new Error("expected authStatus");
  return HostAuthStatusSchema.parse(await adapter.authStatus());
};

describe("authStatus through the host's own status command (AD-25 rule 3, AD-9)", () => {
  it("Claude: runs `claude auth status --json` with stdin closed and reads loggedIn and authMethod only", async () => {
    const { adapter, processes } = adapterFor(
      "claude-code",
      replying(
        0,
        JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          email: "dev@example.com",
          orgName: "Example",
        }),
      ),
    );
    const result = await status(adapter);
    expect(result).toEqual({
      host: "claude-code",
      logged_in: true,
      method: "claude.ai",
      checked_at: "2026-10-14T09:00:00.000Z",
    });
    // only the method label leaves the command, never the account details
    expect(JSON.stringify(result)).not.toContain("example");
    const proc = processes[0]!;
    expect(proc.command).toEqual({
      command: "claude",
      args: ["auth", "status", "--json"],
      env: {},
    });
    expect(proc.options.stdin).toBe("closed");
    expect(findForbiddenHostArgs([proc.command.command, ...proc.command.args])).toEqual([]);
  });

  it("Claude: a non-zero exit, or a status that says loggedIn false, is logged out", async () => {
    for (const [code, stdout] of [
      [1, JSON.stringify({ loggedIn: false })],
      [0, JSON.stringify({ loggedIn: false })],
      [1, "Not logged in"],
    ] as const) {
      const { adapter } = adapterFor("claude-code", replying(code, stdout));
      expect(await status(adapter)).toMatchObject({ logged_in: false, method: null });
    }
  });

  it("Claude: exit 0 with output it cannot read is logged in with an unknown method", async () => {
    const { adapter } = adapterFor("claude-code", replying(0, "Logged in."));
    expect(await status(adapter)).toMatchObject({ logged_in: true, method: null });
  });

  it("Claude: a method that is not a plain label is dropped, never passed on", async () => {
    for (const authMethod of ["sk-ant-oat01-abc\ndef", "x".repeat(101), "", 42]) {
      const { adapter } = adapterFor(
        "claude-code",
        replying(0, JSON.stringify({ loggedIn: true, authMethod })),
      );
      expect(await status(adapter)).toMatchObject({ logged_in: true, method: null });
    }
  });

  it("Codex: runs `codex login status` and names only the kind of login", async () => {
    const { adapter, processes } = adapterFor("codex", replying(0, "Logged in using ChatGPT\n"));
    expect(await status(adapter)).toEqual({
      host: "codex",
      logged_in: true,
      method: "ChatGPT",
      checked_at: "2026-10-14T09:00:00.000Z",
    });
    expect(processes[0]?.command).toEqual({ command: "codex", args: ["login", "status"], env: {} });
    expect(processes[0]?.options.stdin).toBe("closed");
  });

  it("Codex: an API-key login is named as such, and the masked key never leaves the command", async () => {
    const { adapter } = adapterFor(
      "codex",
      replying(0, "", "Logged in using an API key - sk-proj-***ABCD\n"),
    );
    const result = await status(adapter);
    expect(result).toMatchObject({ logged_in: true, method: "API key" });
    expect(JSON.stringify(result)).not.toContain("sk-");
  });

  it("Codex: a non-zero exit is logged out", async () => {
    const { adapter } = adapterFor("codex", replying(1, "Not logged in\n"));
    expect(await status(adapter)).toMatchObject({ logged_in: false, method: null });
  });

  it("a status command that cannot start, or is killed, leaves the login unknown (null), never false", async () => {
    for (const host of ["claude-code", "codex"] as const) {
      const { adapter } = adapterFor(host, (p) => {
        p.failToStart(new Error(`spawn ${host} ENOENT`));
      });
      expect(await status(adapter)).toMatchObject({ host, logged_in: null, method: null });
      const killed = adapterFor(host, replying(null, ""));
      expect(await status(killed.adapter)).toMatchObject({ logged_in: null });
    }
  });

  it("a status command that hangs is killed after its timeout, leaving the login unknown", async () => {
    const { adapter, processes } = adapterFor("claude-code", () => undefined, 20);
    expect(await status(adapter)).toMatchObject({ logged_in: null, method: null });
    expect(processes[0]?.signals).toEqual(["SIGKILL"]);
  });

  it("dispose stops a status command still running", async () => {
    const { adapter, processes } = adapterFor("codex", () => undefined, 60_000);
    const pending = status(adapter);
    await new Promise((resolve) => setImmediate(resolve));
    await adapter.dispose();
    expect(processes[0]?.signals).toEqual(["SIGKILL"]);
    expect(await pending).toMatchObject({ logged_in: null });
  });
});

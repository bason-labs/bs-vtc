import { homedir, tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  findForbiddenHostArgs,
  HostAuthStatusSchema,
  type HostAdapter,
  type HostBilling,
} from "@vtc/shared";
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
  it("runs the status command from the user's home, never the shared temp directory (§15)", async () => {
    for (const host of ["claude-code", "codex"] as const) {
      const { adapter, processes } = adapterFor(host, replying(0, "{}"));
      await status(adapter);
      const cwd = processes[0]?.options.cwd;
      expect(cwd).toBe(homedir());
      expect(cwd).not.toBe(tmpdir());
    }
  });

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
      billing: "subscription",
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
      expect(await status(adapter)).toMatchObject({
        logged_in: false,
        method: null,
        billing: null,
      });
    }
  });

  it("Claude: exit 0 with output it cannot read is logged in with an unknown method", async () => {
    const { adapter } = adapterFor("claude-code", replying(0, "Logged in."));
    // nothing the adapter can read says who pays: unknown, never a guess (D-bq)
    expect(await status(adapter)).toMatchObject({ logged_in: true, method: null, billing: null });
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
      billing: "subscription",
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
    expect(result).toMatchObject({ logged_in: true, method: "API key", billing: "api_key" });
    expect(JSON.stringify(result)).not.toContain("sk-");
  });

  it("Codex: a login of a kind it does not name has unknown billing (D-bq)", async () => {
    const { adapter } = adapterFor("codex", replying(0, "Logged in using an access token\n"));
    expect(await status(adapter)).toMatchObject({ logged_in: true, method: null, billing: null });
  });

  it("Claude: billing is provider for a cloud provider or gateway, api_key for an API key, subscription only for a first-party claude.ai login, else unknown (D-bq, D-ci, spine §5 readings 171 and 203)", async () => {
    const cases: readonly (readonly [Record<string, unknown>, HostBilling | null])[] = [
      // only a first-party claude.ai login is the subscription
      [{ loggedIn: true, authMethod: "claude.ai" }, "subscription"],
      [{ loggedIn: true, authMethod: "claude.ai", apiKeySource: "none" }, "subscription"],
      [{ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }, "subscription"],
      // an OAuth token may be a setup-token login, ANTHROPIC_AUTH_TOKEN for a proxy or a profile
      // token: the status cannot tell them apart, so unknown, never a guess (D-ci)
      [{ loggedIn: true, authMethod: "oauth_token" }, null],
      [{ loggedIn: true, authMethod: "oauth_token", apiProvider: "firstParty" }, null],
      [{ loggedIn: true, authMethod: "api_key" }, "api_key"],
      [{ loggedIn: true, authMethod: "apiKeyHelper" }, "api_key"],
      [{ loggedIn: true, authMethod: "api_key_helper" }, "api_key"],
      [{ loggedIn: true, authMethod: "claude.ai", apiKeySource: "ANTHROPIC_API_KEY" }, "api_key"],
      [{ loggedIn: true, authMethod: "api_key", apiKeySource: "apiKeyHelper" }, "api_key"],
      // the status names no login method at all: unknown, never a guess
      [{ loggedIn: true }, null],
      // Bedrock, Vertex, Foundry, a gateway or any other third-party provider bills that provider
      [{ loggedIn: true, authMethod: "third_party", apiProvider: "bedrock" }, "provider"],
      [{ loggedIn: true, authMethod: "third_party", apiProvider: "vertex" }, "provider"],
      [{ loggedIn: true, authMethod: "third_party", apiProvider: "foundry" }, "provider"],
      [{ loggedIn: true, authMethod: "third_party", apiProvider: "anthropicAws" }, "provider"],
      [{ loggedIn: true, authMethod: "claude.ai", apiProvider: "vertex" }, "provider"],
      [{ loggedIn: true, authMethod: "third_party" }, "provider"],
      [{ loggedIn: true, authMethod: "oauth_token", apiProvider: "gateway" }, "provider"],
      [{ loggedIn: true, apiProvider: "gateway" }, "provider"],
      // the provider bills, whatever key the environment also names
      [{ loggedIn: true, authMethod: "api_key", apiProvider: "foundry" }, "provider"],
      [
        {
          loggedIn: true,
          authMethod: "third_party",
          apiProvider: "bedrock",
          apiKeySource: "ANTHROPIC_API_KEY",
        },
        "provider",
      ],
      // a method it does not know: unknown
      [{ loggedIn: true, authMethod: "none" }, null],
      [{ loggedIn: true, authMethod: "something_new" }, null],
      [{ loggedIn: true, authMethod: "claude.ai", apiProvider: 7 }, null],
    ];
    for (const [json, billing] of cases) {
      const { adapter } = adapterFor("claude-code", replying(0, JSON.stringify(json)));
      expect(await status(adapter), JSON.stringify(json)).toMatchObject({
        logged_in: true,
        billing,
      });
    }
  });

  it("Codex: a non-zero exit is logged out", async () => {
    const { adapter } = adapterFor("codex", replying(1, "Not logged in\n"));
    expect(await status(adapter)).toMatchObject({ logged_in: false, method: null, billing: null });
  });

  it("a status command that cannot start, or is killed, leaves the login unknown (null), never false", async () => {
    for (const host of ["claude-code", "codex"] as const) {
      const { adapter } = adapterFor(host, (p) => {
        p.failToStart(new Error(`spawn ${host} ENOENT`));
      });
      expect(await status(adapter)).toMatchObject({
        host,
        logged_in: null,
        method: null,
        billing: null,
      });
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

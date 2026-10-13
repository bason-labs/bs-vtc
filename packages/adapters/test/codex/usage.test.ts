import { describe, expect, it } from "vitest";
import { UsageSnapshotSchema, type UsageSnapshot } from "@vtc/shared";
import { codexUsageFromRateLimits, createCodexAdapter } from "../../src/index.js";
import { fakeSpawner, onStdinMessage, type FakeProcess } from "../support/fake-spawner.js";
import { fixtureJson } from "../support/fixtures.js";

const AT = "2026-10-13T12:00:00.000Z";
const now = () => new Date(AT);
const READ = fixtureJson("codex/app-server-rateLimits-read.json") as { result: unknown };
const UPDATED = fixtureJson("codex/app-server-rateLimits-updated.synthetic.json") as {
  params: unknown;
};
const ACCOUNT_UPDATED = fixtureJson("codex/app-server-account-updated.json");

describe("codexUsageFromRateLimits (recorded read, spike 1)", () => {
  it("labels windows from windowDurationMins, never from primary/secondary", () => {
    const snapshot = UsageSnapshotSchema.parse(codexUsageFromRateLimits(READ.result, AT));
    expect(snapshot).toEqual({
      host: "codex",
      source: "app_server",
      windows: [
        {
          kind: "five_hour",
          label: "five_hour",
          window_minutes: 300,
          used_pct: 1,
          resets_at: "2026-10-13T16:50:33.000Z",
        },
        {
          kind: "weekly",
          label: "weekly",
          window_minutes: 10080,
          used_pct: 12,
          resets_at: "2026-10-20T05:16:41.000Z",
        },
      ],
      model_limits: [],
      updated_at: AT,
    });
    const swapped = codexUsageFromRateLimits(
      { primary: { usedPercent: 3, windowDurationMins: 10080 }, secondary: null },
      AT,
    );
    expect(swapped.windows.map((w) => w.kind)).toEqual(["weekly"]);
  });

  it("keeps unknown values unknown, never 0", () => {
    const snapshot = codexUsageFromRateLimits(
      {
        primary: { usedPercent: "12", windowDurationMins: 60 },
        secondary: { windowDurationMins: null },
      },
      AT,
    );
    expect(snapshot.windows).toEqual([
      { kind: "other", label: "60m", window_minutes: 60, used_pct: null, resets_at: null },
      { kind: "other", label: "window", window_minutes: null, used_pct: null, resets_at: null },
    ]);
    expect(codexUsageFromRateLimits(null, AT).windows).toEqual([]);
  });
});

/** A fake `codex app-server`: answers initialize and reads, sends unprompted notifications. */
const appServer = (options: { readonly failRead?: boolean } = {}) => {
  const received: Record<string, unknown>[] = [];
  const { spawner, processes } = fakeSpawner((proc: FakeProcess) => {
    onStdinMessage(proc, (message) => {
      received.push(message);
      if (message.method === "initialize") {
        proc.emit(JSON.stringify({ id: message.id, result: { userAgent: "codex/0.162.1" } }));
        proc.emit(JSON.stringify(ACCOUNT_UPDATED));
        proc.emit(JSON.stringify({ method: "remoteControl/status/changed", params: {} }));
      } else if (message.method === "account/rateLimits/read") {
        proc.emit(
          JSON.stringify(
            options.failRead === true
              ? { id: message.id, error: { code: -32000, message: "not signed in" } }
              : { ...READ, id: message.id },
          ),
        );
      }
    });
  });
  return { spawner, processes, received };
};

describe("Codex readUsage / watchUsage (managed app-server child, AD-6 rule 4)", () => {
  it("starts codex app-server, initializes, and reads the rate limits", async () => {
    const server = appServer();
    const adapter = createCodexAdapter({ spawner: server.spawner, now, clientVersion: "1.2.3" });
    const snapshot = await adapter.readUsage?.();
    expect(snapshot?.windows.map((w) => [w.kind, w.used_pct])).toEqual([
      ["five_hour", 1],
      ["weekly", 12],
    ]);
    const proc = server.processes[0]!;
    expect(proc.command).toEqual({ command: "codex", args: ["app-server"], env: {} });
    expect(proc.options.stdin).toBe("pipe");
    expect(server.received.map((m) => m.method)).toEqual([
      "initialize",
      "initialized",
      "account/rateLimits/read",
    ]);
    expect(server.received[0]).toMatchObject({
      params: { clientInfo: { name: "vtc", version: "1.2.3" } },
    });
    // one child for many reads
    await adapter.readUsage?.();
    expect(server.processes).toHaveLength(1);
    await adapter.dispose();
    expect(proc.signals).toEqual(["SIGTERM"]);
  });

  it("pushes the first read and every rateLimits/updated notification to watchers", async () => {
    const server = appServer();
    const adapter = createCodexAdapter({ spawner: server.spawner, now });
    const seen: UsageSnapshot[] = [];
    const stop = adapter.watchUsage?.((s) => seen.push(s));
    await expect.poll(() => seen.length).toBe(1);
    server.processes[0]!.emit(JSON.stringify(UPDATED));
    await expect.poll(() => seen.length).toBe(2);
    expect(seen[1]?.windows[0]).toMatchObject({ kind: "five_hour", used_pct: 55 });
    stop?.();
    server.processes[0]!.emit(JSON.stringify(UPDATED));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(seen).toHaveLength(2);
    await adapter.dispose();
  });

  it("declines requests from the server instead of leaving them hanging", async () => {
    const server = appServer();
    const adapter = createCodexAdapter({ spawner: server.spawner, now });
    await adapter.readUsage?.();
    server.processes[0]!.emit(
      JSON.stringify({ id: 77, method: "item/commandExecution/requestApproval" }),
    );
    await expect
      .poll(() => server.received.find((m) => m.id === 77))
      .toMatchObject({
        error: { code: -32601 },
      });
    await adapter.dispose();
  });

  it("rejects when the host reports an error, and restarts a child that died", async () => {
    const failing = appServer({ failRead: true });
    const adapter = createCodexAdapter({ spawner: failing.spawner, now });
    await expect(adapter.readUsage?.()).rejects.toThrow(/not signed in/);
    failing.processes[0]!.exit(1);
    await expect(adapter.readUsage?.()).rejects.toThrow(/not signed in/);
    expect(failing.processes).toHaveLength(2);
    await adapter.dispose();
  });

  it("rejects when codex is not installed, without throwing synchronously", async () => {
    const { spawner } = fakeSpawner((proc) => {
      proc.failToStart(new Error("spawn codex ENOENT"));
    });
    const adapter = createCodexAdapter({ spawner, now });
    await expect(adapter.readUsage?.()).rejects.toThrow(/not available.*ENOENT/);
    await adapter.dispose();
  });

  it("dispose stops the child and every subscription; nothing starts afterwards", async () => {
    const server = appServer();
    const adapter = createCodexAdapter({ spawner: server.spawner, now });
    const seen: UsageSnapshot[] = [];
    adapter.watchUsage?.((s) => seen.push(s));
    await expect.poll(() => seen.length).toBe(1);
    await adapter.dispose();
    expect(server.processes[0]?.finished).toBe(true);
    await expect(adapter.readUsage?.()).rejects.toThrow(/disposed/);
    await adapter.dispose();
  });
});

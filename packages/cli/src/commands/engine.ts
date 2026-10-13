/**
 * Owner: cli+binary team (AD-12, AD-19).
 * - `vtc engine --daemon [--wake]` builds `EngineDeps` (`wiring.ts`) and calls `runDaemon` from
 *   @vtc/engine (engine-core team); it runs until the daemon exits (idle, or SIGINT/SIGTERM).
 * - `vtc engine --mcp --host <host>` is the stdio bridge, the MCP entry of every host plugin
 *   (AD-16): it finds the repo's daemon (starting one detached when none is live), sends its
 *   hello and then relays bytes. Nothing but MCP is ever written to its stdout.
 * - `vtc engine --wake-due` is what the auto-resume timer (launchd or systemd) runs every minute: it starts
 *   `vtc engine --daemon --wake` for each repo whose persisted wake-up is due (§6.9 step 4).
 */
import { existsSync } from "node:fs";
import { core, mcp } from "@vtc/engine";
import { HostIdSchema } from "@vtc/shared";
import { ensureDaemon, liveDaemon } from "../daemon.js";
import { requireRepoRoot, UsageError } from "../repo.js";
import { runtime } from "../runtime.js";
import { createWakeScheduler, dueWakeups, wakeRecords } from "../scheduler.js";
import { ensureInstallToken } from "../token.js";
import { buildEngineParts, disposeAdapters, startDaemon } from "../wiring.js";
import type { CommandContext, CommandSpec } from "./types.js";
import { EXIT, guarded, parseFlags } from "./util.js";

const onTerminate = (handler: () => void): (() => void) => {
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const s of signals) process.once(s, handler);
  return () => {
    for (const s of signals) process.off(s, handler);
  };
};

const runDaemonCommand = async (ctx: CommandContext, wake: boolean): Promise<number> => {
  const repoRoot = await requireRepoRoot(ctx.cwd);
  const rt = runtime();
  const parts = await buildEngineParts({
    repoRoot,
    vtcHome: ctx.vtcHome,
    installToken: ensureInstallToken(ctx.vtcHome),
    assets: rt.assets,
  });
  let daemon;
  try {
    daemon = await startDaemon(parts, { wake });
  } catch (error) {
    await disposeAdapters(parts);
    if (error instanceof core.EngineLockedError) {
      ctx.io.err(`vtc engine: another engine already runs for ${repoRoot}`);
      return EXIT.failed;
    }
    if (error instanceof core.RoleContractsError && rt.kind === "dev")
      throw new Error(`${error.message} (build the plugins first: pnpm build)`, { cause: error });
    throw error;
  }
  ctx.io.err(
    `vtc engine: serving ${repoRoot} on http://127.0.0.1:${String(daemon.port)} (pid ${String(process.pid)})`,
  );
  const off = onTerminate(() => {
    void daemon.close();
  });
  await daemon.closed;
  off();
  await disposeAdapters(parts);
  return EXIT.ok;
};

const runBridge = async (ctx: CommandContext, hostName: string | undefined): Promise<number> => {
  const host = HostIdSchema.safeParse(hostName);
  if (!host.success) throw new UsageError("--mcp needs --host claude-code or --host codex");
  const repoRoot = await requireRepoRoot(ctx.cwd);
  const discovery = await ensureDaemon({
    vtcHome: ctx.vtcHome,
    repoRoot,
    selfCommand: runtime().selfCommand,
  });
  await mcp.runStdioBridge({
    path: discovery.mcp_socket,
    host: host.data,
    stdin: process.stdin,
    stdout: process.stdout,
  });
  return EXIT.ok;
};

/**
 * How long past its time a wake-up stays with the woken engine before `--wake-due` drops it. The
 * engine cancels or moves its own wake-up when it acts on the wake; a record still unchanged this
 * long after its time means the engine did neither (it failed, or found nothing to resume), so the
 * next start drops it rather than waking the repo every minute forever.
 */
export const WAKE_GRACE_MS = 10 * 60_000;

/** Starts the daemon of every repo whose wake-up is due; resolves how many were started. */
export const wakeDue = async (
  ctx: CommandContext,
  now: Date = new Date(),
  start: typeof ensureDaemon = ensureDaemon,
): Promise<number> => {
  let started = 0;
  const scheduler = createWakeScheduler(ctx.vtcHome);
  for (const record of dueWakeups(ctx.vtcHome, now)) {
    if (!existsSync(record.repo_root)) {
      await scheduler.cancel(record.repo_root); // the repo is gone: nothing to resume
      continue;
    }
    if ((await liveDaemon(ctx.vtcHome, record.repo_root)) !== null) continue; // it owns its timer
    try {
      await start({
        vtcHome: ctx.vtcHome,
        repoRoot: record.repo_root,
        selfCommand: runtime().selfCommand,
        flags: ["--wake"],
      });
      started += 1;
      ctx.io.out(`vtc engine: woke the engine for ${record.repo_root} (due ${record.at})`);
      // The woken engine owns its wake-up: drop it only once the grace has passed unchanged.
      const after = wakeRecords(ctx.vtcHome).find((r) => r.repo_root === record.repo_root);
      if (after?.at === record.at && now.getTime() - Date.parse(record.at) >= WAKE_GRACE_MS)
        await scheduler.cancel(record.repo_root);
    } catch (error) {
      ctx.io.err(
        `vtc engine: could not wake ${record.repo_root}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return started;
};

export const command: CommandSpec = {
  name: "engine",
  summary: "Run the engine daemon (--daemon) or the stdio MCP bridge (--mcp --host <host>)",
  run: (args, ctx) =>
    guarded("engine", ctx, async () => {
      const { values } = parseFlags(args, {
        daemon: { type: "boolean" },
        wake: { type: "boolean" },
        mcp: { type: "boolean" },
        host: { type: "string" },
        "wake-due": { type: "boolean" },
      });
      const modes = [values.daemon, values.mcp, values["wake-due"]].filter((v) => v === true);
      if (modes.length !== 1)
        throw new UsageError(
          "usage: vtc engine --daemon [--wake] | --mcp --host <claude-code|codex> | --wake-due",
        );
      if (values.daemon === true) return runDaemonCommand(ctx, values.wake === true);
      if (values.mcp === true) return runBridge(ctx, values.host);
      await wakeDue(ctx);
      return EXIT.ok;
    }),
};

/**
 * Owner: cli+binary team (AD-16 rule 3, spine §5 reading 31). `vtc hook <session-start|
 * pre-tool-use|subagent-stop> --host <host>`, the only command plugin hooks run; the behaviour is
 * the frozen contract in `@vtc/shared` hook.ts (`hook.ts` here). It fails open on everything,
 * bad arguments included, and always finishes within `VTC_HOOK.timeoutMs`.
 */
import { core } from "@vtc/engine";
import { HostIdSchema, VTC_HOOK, VtcHookEventSchema } from "@vtc/shared";
import { liveDaemon } from "../daemon.js";
import { ALLOW, runHook, type HookDeps, type HookOutcome } from "../hook.js";
import { findRepoRoot } from "../repo.js";
import type { CommandContext, CommandSpec } from "./types.js";
import { readStdin } from "./util.js";

/** Margin kept for writing the answer and exiting before the host's own timeout. */
const MARGIN_MS = 750;

export interface HookCommandDeps {
  readonly stdin: (maxBytes: number, timeoutMs: number) => Promise<string | null>;
  readonly write: (outcome: HookOutcome) => void;
  readonly deps: (ctx: CommandContext) => HookDeps;
  readonly timeoutMs: number;
}

export const defaultHookCommandDeps = (): HookCommandDeps => ({
  stdin: readStdin,
  write: (outcome) => {
    if (outcome.stdout !== undefined) process.stdout.write(outcome.stdout);
    if (outcome.stderr !== undefined) process.stderr.write(`${outcome.stderr}\n`);
  },
  deps: (ctx) => ({
    vtcHome: ctx.vtcHome,
    cwd: ctx.cwd,
    findRepoRoot: (cwd) => findRepoRoot(cwd),
    liveDaemon: (vtcHome, repoRoot) => liveDaemon(vtcHome, repoRoot),
    loadRuns: (repoRoot) => core.loadRuns(repoRoot).map((r) => r.state),
  }),
  timeoutMs: VTC_HOOK.timeoutMs - MARGIN_MS,
});

const decide = async (
  args: readonly string[],
  ctx: CommandContext,
  d: HookCommandDeps,
  deadline: number,
): Promise<HookOutcome> => {
  const [eventName, flag, hostName, ...rest] = args;
  const event = VtcHookEventSchema.safeParse(eventName);
  const host = HostIdSchema.safeParse(hostName);
  if (!event.success || flag !== "--host" || !host.success || rest.length > 0) return ALLOW;
  const stdin = await d.stdin(VTC_HOOK.maxStdinBytes, Math.max(0, deadline - Date.now()));
  if (stdin === null || stdin.trim() === "") return ALLOW;
  return runHook(event.data, host.data, stdin, { ...d.deps(ctx), deadline });
};

export const createHookCommand = (
  make: () => HookCommandDeps = defaultHookCommandDeps,
): CommandSpec => ({
  name: "hook",
  summary: "Plugin hook entry (session-start | pre-tool-use | subagent-stop --host <host>)",
  run: async (args, ctx) => {
    const d = make();
    const deadline = Date.now() + d.timeoutMs;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<HookOutcome>((resolve) => {
      timer = setTimeout(() => {
        resolve(ALLOW);
      }, d.timeoutMs);
    });
    const outcome = await Promise.race([
      decide(args, ctx, d, deadline).catch(() => ALLOW),
      timeout,
    ]);
    clearTimeout(timer);
    try {
      d.write(outcome);
    } catch {
      return VTC_HOOK.exit.allow;
    }
    return outcome.code;
  },
});

export const command = createHookCommand();

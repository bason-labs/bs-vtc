/**
 * What both adapters share around a role spawn: the Lead's subagent instruction (AD-4 rule 4)
 * and the set of live headless runs that `dispose()` kills (§15: no orphans).
 */
import {
  agentNameFor,
  SubagentInstructionSchema,
  type HeadlessRun,
  type HostCommand,
  type HostId,
  type HostOutcome,
  type SpawnResult,
  type SpawnRoleRequest,
} from "@vtc/shared";
import { headlessArgvProblems } from "./argv.js";
import { startHeadlessRun, type RunExit } from "./headless-run.js";
import type { Spawner } from "./process.js";

/** The `spawn_role` instruction the Lead performs in its own session. */
export const subagentSpawn = (
  request: SpawnRoleRequest,
  options: { readonly background: boolean; readonly name?: (agent: string) => string },
): SpawnResult => {
  const agent = agentNameFor(request.role, request.mode);
  return {
    dispatch: "subagent",
    instruction: SubagentInstructionSchema.parse({
      agent: options.name?.(agent) ?? agent,
      prompt: request.prompt,
      background: options.background,
    }),
  };
};

export interface RunLauncherOptions {
  /** The host whose isolation flags every started argv must carry (AD-25 rule 1). */
  readonly host: HostId;
  readonly spawner: Spawner;
  /** SIGINT → SIGTERM grace. Default `HEADLESS_DEFAULTS.interruptGraceMs` (AD-25 rule 4). */
  readonly interruptGraceMs?: number;
  /** SIGTERM → SIGKILL grace. Default `HEADLESS_DEFAULTS.termGraceMs`. */
  readonly termGraceMs?: number;
  readonly outcome: (lines: readonly string[], exit: RunExit) => HostOutcome;
}

/** Starts headless runs and remembers the live ones until they settle or `dispose` kills them. */
export const createRunLauncher = (options: RunLauncherOptions) => {
  const live = new Set<HeadlessRun>();
  let disposed = false;
  return {
    /**
     * Starts `command` with the request's prompt on stdin (both hosts read it from there), under
     * the request's wall and idle timeouts (AD-25 rule 4). Refuses an argv with an AD-9 marker,
     * a disallowed flag or a missing isolation flag, whoever built it (AD-25 rules 1–2).
     */
    start(command: HostCommand, request: SpawnRoleRequest): SpawnResult {
      if (disposed) throw new Error("this host adapter was disposed");
      const problems = headlessArgvProblems(options.host, command);
      if (problems.length > 0) {
        throw new Error(`refusing to start ${command.command}: ${problems.join("; ")}`);
      }
      const run: HeadlessRun = startHeadlessRun({
        command,
        cwd: request.cwd,
        input: request.prompt,
        timeoutMs: request.timeoutMs,
        ...(request.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: request.idleTimeoutMs }),
        ...(options.interruptGraceMs === undefined
          ? {}
          : { interruptGraceMs: options.interruptGraceMs }),
        ...(options.termGraceMs === undefined ? {} : { termGraceMs: options.termGraceMs }),
        spawner: options.spawner,
        outcome: options.outcome,
        onSettled: () => live.delete(run),
      });
      live.add(run);
      return { dispatch: "headless", run };
    },
    get live(): number {
      return live.size;
    },
    async dispose(): Promise<void> {
      disposed = true;
      await Promise.all([...live].map((run) => run.kill()));
    },
  };
};

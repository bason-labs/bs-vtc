/**
 * What both adapters share around a role spawn: the Lead's subagent instruction (AD-4 rule 4)
 * and the set of live headless runs that `dispose()` kills (§15: no orphans).
 */
import {
  agentNameFor,
  SubagentInstructionSchema,
  type HeadlessRun,
  type HostCommand,
  type HostOutcome,
  type SpawnResult,
  type SpawnRoleRequest,
} from "@vtc/shared";
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
  readonly spawner: Spawner;
  readonly killGraceMs?: number;
  readonly outcome: (lines: readonly string[], exit: RunExit) => HostOutcome;
}

/** Starts headless runs and remembers the live ones until they settle or `dispose` kills them. */
export const createRunLauncher = (options: RunLauncherOptions) => {
  const live = new Set<HeadlessRun>();
  let disposed = false;
  return {
    /** Starts `command` with the request's prompt on stdin (both hosts read it from there). */
    start(command: HostCommand, request: SpawnRoleRequest): SpawnResult {
      if (disposed) throw new Error("this host adapter was disposed");
      const run: HeadlessRun = startHeadlessRun({
        command,
        cwd: request.cwd,
        input: request.prompt,
        timeoutMs: request.timeoutMs,
        spawner: options.spawner,
        outcome: options.outcome,
        ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
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

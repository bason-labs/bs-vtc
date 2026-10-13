/**
 * `vtc hook <session-start|pre-tool-use|subagent-stop> --host <host>`: the command every plugin
 * hook runs (AD-16 rule 3; the frozen contract is `@vtc/shared` hook.ts). It fails open: no VTC
 * run, no live daemon, unreadable input or any error is exit 0 with no output. It blocks (exit 2,
 * the reason on stderr) only a VTC role agent's git write, or a write outside the write scope of
 * that agent's in-flight dispatch. The engine stays the enforcement point.
 */
import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { core, git } from "@vtc/engine";
import {
  VTC_HOOK,
  VtcHookInputSchema,
  type EngineDiscovery,
  type HostId,
  type VtcHookEvent,
  type VtcHookInput,
} from "@vtc/shared";
import {
  agentBaseName,
  gitWriteIn,
  isVtcRoleAgent,
  matchesAnyGlob,
  packWriteScope,
  shellCommandOf,
  writeTargets,
} from "./hook-rules.js";

export interface HookOutcome {
  readonly code: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

/** The run state the hook reads: the engine's own replay of the committed event logs. */
type RunState = core.RunState;

export interface HookDeps {
  readonly vtcHome: string;
  /** Where the hook process runs; the input's `cwd` wins when present. */
  readonly cwd: string;
  readonly findRepoRoot: (cwd: string) => Promise<string | null>;
  readonly liveDaemon: (vtcHome: string, repoRoot: string) => EngineDiscovery | null;
  readonly loadRuns: (repoRoot: string) => readonly RunState[];
}

export const ALLOW: HookOutcome = { code: VTC_HOOK.exit.allow };

const block = (reason: string): HookOutcome => ({
  code: VTC_HOOK.exit.block,
  stderr: reason.slice(0, VTC_HOOK.maxReasonChars),
});

/** The repo's unfinished run, when its daemon is alive. */
const activeRunOf = async (
  input: VtcHookInput,
  deps: HookDeps,
): Promise<{ repoRoot: string; run: RunState } | null> => {
  const repoRoot = await deps.findRepoRoot(input.cwd ?? deps.cwd);
  if (repoRoot === null || deps.liveDaemon(deps.vtcHome, repoRoot) === null) return null;
  const run = core.activeRun([...deps.loadRuns(repoRoot)]);
  return run === undefined || run.run.finished_at !== undefined ? null : { repoRoot, run };
};

/** The path with symlinks resolved as far as it exists (a new file's parent, and so on). */
const realish = (abs: string): string => {
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    return parent === abs ? abs : join(realish(parent), basename(abs));
  }
};

const readText = (abs: string): string | null => {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
};

/** Why writing `target` is outside the dispatch's scope, or `null` when it is allowed. */
const writeViolation = (
  target: string,
  repoRoot: string,
  run: RunState,
  dispatches: readonly core.RoleRunRecord[],
): string | null => {
  const worktrees = realish(join(repoRoot, git.WORKTREES_DIR));
  const rel = relative(worktrees, realish(target));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel))
    return `${target} is outside your worktree under ${git.WORKTREES_DIR}/`;
  const [id = "", ...rest] = rel.split(sep);
  const path = rest.join("/");
  const mine = dispatches.filter(
    (d) => d.task === id || core.roleWorktreeId(run.id, d.action_id) === id,
  );
  if (mine.length === 0) return `${target} is in a worktree that is not yours (${id})`;
  const scope: string[] = [];
  for (const d of mine) {
    const pack = readText(join(repoRoot, d.pack));
    const own = pack === null ? null : packWriteScope(pack);
    if (own === null) return null; // the pack is unreadable: allow (the engine still checks)
    scope.push(...own);
  }
  if (path !== "" && matchesAnyGlob(scope, path)) return null;
  return `${path || target} is outside your write scope (${scope.length === 0 ? "read-only" : scope.join(", ")})`;
};

const preToolUse = async (input: VtcHookInput, deps: HookDeps): Promise<HookOutcome> => {
  if (!isVtcRoleAgent(input.agent_type)) return ALLOW;
  const agent = agentBaseName(input.agent_type);
  const toolInput = input.tool_input ?? {};
  const shell = shellCommandOf(toolInput);
  const gitWrite = shell === null ? null : gitWriteIn(shell);
  const targets = writeTargets(input.tool_name, toolInput, input.cwd ?? deps.cwd);
  if (gitWrite === null && targets.length === 0) return ALLOW;
  const active = await activeRunOf(input, deps);
  if (active === null) return ALLOW;
  if (gitWrite !== null)
    return block(
      `VTC: role agents never run git ${gitWrite}. Leave your changes in the worktree; the engine commits, merges and pushes them after the Lead submits your result.`,
    );
  const dispatches = [...active.run.roleRuns.values()].filter(
    (r) => r.status === "in_flight" && agentBaseName(r.agent) === agent,
  );
  if (dispatches.length === 0) return ALLOW;
  for (const target of targets) {
    const violation = writeViolation(target, active.repoRoot, active.run, dispatches);
    if (violation !== null)
      return block(`VTC: ${violation}. Write only inside your task pack's write scope.`);
  }
  return ALLOW;
};

const sessionStart = async (input: VtcHookInput, deps: HookDeps): Promise<HookOutcome> => {
  const active = await activeRunOf(input, deps);
  if (active === null) return ALLOW;
  const { run } = active.run;
  const state = run.paused ? "paused" : "in progress";
  return {
    code: VTC_HOOK.exit.allow,
    stdout: `VTC: run ${run.id} (${run.track}, phase ${run.phase}) is ${state} in this repo. Offer the user to resume it: call the vtc \`status\` tool to summarise it${run.paused ? ", `resume` if the user agrees," : ""} then \`next\` and perform exactly the actions it returns.\n`,
  };
};

const subagentStop = async (input: VtcHookInput, deps: HookDeps): Promise<HookOutcome> => {
  if (!isVtcRoleAgent(input.agent_type)) return ALLOW;
  if ((await activeRunOf(input, deps)) === null) return ALLOW;
  return {
    code: VTC_HOOK.exit.allow,
    stdout: `VTC: role agent ${agentBaseName(input.agent_type)} has stopped. Submit its outcome with the vtc \`submit\` tool and the action_id of its spawn_role action: kind "result" with its RoleResult, or kind "failure" with the reason it did not finish.\n`,
  };
};

/** Decides one hook call from the host's stdin text. Never throws. */
export const runHook = async (
  event: VtcHookEvent,
  _host: HostId,
  stdin: string,
  deps: HookDeps,
): Promise<HookOutcome> => {
  try {
    if (new TextEncoder().encode(stdin).length > VTC_HOOK.maxStdinBytes) return ALLOW;
    const parsed = VtcHookInputSchema.safeParse(JSON.parse(stdin));
    if (!parsed.success) return ALLOW;
    switch (event) {
      case "pre-tool-use":
        return await preToolUse(parsed.data, deps);
      case "session-start":
        return await sessionStart(parsed.data, deps);
      case "subagent-stop":
        return await subagentStop(parsed.data, deps);
    }
  } catch {
    return ALLOW;
  }
};

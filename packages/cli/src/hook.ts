/**
 * `vtc hook <session-start|pre-tool-use|subagent-stop> --host <host>`: the command every plugin
 * hook runs (AD-16 rule 3; the frozen contract is `@vtc/shared` hook.ts). It fails open: no VTC
 * run, no live daemon, unreadable input or any error is exit 0 with no output. It blocks (exit 2,
 * the reason on stderr) only a VTC role agent's git write, or a write outside the write scope of
 * that agent's in-flight dispatch: its worktree's scope entries, plus the entries it writes in the
 * main checkout (QA author mode's hidden-test staging). The engine stays the enforcement point.
 *
 * Known limit: the host's hook input names the calling agent but not which of its dispatches it
 * serves. With concurrency 2-3, two in-flight dispatches can share an agent (two `vtc-engineer`
 * tasks). When the input's `cwd` lies in one of their worktrees, only that dispatch counts;
 * otherwise a write into either worktree, inside that worktree's own scope, is allowed. The
 * engine still attributes and checks each worktree's diff against its own task (L5).
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
  inAllScopes,
  isVtcRoleAgent,
  packWriteScopes,
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
  readonly liveDaemon: (vtcHome: string, repoRoot: string) => Promise<EngineDiscovery | null>;
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
  if (repoRoot === null || (await deps.liveDaemon(deps.vtcHome, repoRoot)) === null) return null;
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

/** POSIX form of a relative path. */
const posix = (rel: string): string => rel.split(sep).join("/");

/** `rel` (from `relative`) when it stays below its base, else `null`. */
const below = (rel: string): string | null =>
  rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : rel;

/**
 * A scope entry the role writes in the main checkout rather than in its worktree: anything under
 * the git-ignored `.vtc/state/` but outside the worktrees, which never exists in a worktree. Today
 * that is QA author mode's `HIDDEN_TESTS.stagingDir/<task>/**`, which the engine reads from the
 * main checkout (`join(repoRoot, artifact.path)`, §7.3).
 */
const isCheckoutEntry = (entry: string): boolean =>
  entry.startsWith(".vtc/state/") && !entry.startsWith(`${git.WORKTREES_DIR}/`);

/**
 * Each dispatch's write-scope lists from its task pack (`packWriteScopes`: a path must be in all
 * of them), or `null` when a pack is unreadable.
 */
const scopesOf = (
  repoRoot: string,
  dispatches: readonly core.RoleRunRecord[],
): Map<core.RoleRunRecord, string[][]> | null => {
  const scopes = new Map<core.RoleRunRecord, string[][]>();
  for (const d of dispatches) {
    const pack = readText(join(repoRoot, d.pack));
    const own = pack === null ? null : packWriteScopes(pack);
    if (own === null) return null;
    scopes.set(d, own);
  }
  return scopes;
};

/** The worktree id (first segment under `WORKTREES_DIR`) that `abs` lies in, or `null`. */
const worktreeIdOf = (repoRoot: string, abs: string): string | null => {
  const rel = below(relative(realish(join(repoRoot, git.WORKTREES_DIR)), realish(abs)));
  return rel === null ? null : (rel.split(sep)[0] ?? null);
};

/** True when the dispatch's worktree is `id`. */
const ownsWorktree = (run: RunState, d: core.RoleRunRecord, id: string): boolean =>
  d.task === id || core.roleWorktreeId(run.id, d.action_id) === id;

/** Why writing `target` is outside the dispatch's scope, or `null` when it is allowed. */
const writeViolation = (
  target: string,
  repoRoot: string,
  run: RunState,
  dispatches: readonly core.RoleRunRecord[],
): string | null => {
  const scopes = scopesOf(repoRoot, dispatches);
  if (scopes === null) return null; // a pack is unreadable: allow (the engine still checks)
  const real = realish(target);
  const inWorktrees = below(relative(realish(join(repoRoot, git.WORKTREES_DIR)), real));
  if (inWorktrees === null) {
    const inRepo = below(relative(realish(repoRoot), real));
    const allowed =
      inRepo !== null &&
      dispatches.some((d) =>
        inAllScopes(
          (scopes.get(d) ?? []).map((scope) => scope.filter(isCheckoutEntry)),
          posix(inRepo),
        ),
      );
    return allowed ? null : `${target} is outside your worktree under ${git.WORKTREES_DIR}/`;
  }
  const [id = "", ...rest] = inWorktrees.split(sep);
  const path = rest.join("/");
  const mine = dispatches.filter((d) => ownsWorktree(run, d, id));
  if (mine.length === 0) return `${target} is in a worktree that is not yours (${id})`;
  if (path !== "" && mine.some((d) => inAllScopes(scopes.get(d) ?? [], path))) return null;
  const scope = [...new Set(mine.flatMap((d) => scopes.get(d)?.[0] ?? []))];
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
  const sameAgent = [...active.run.roleRuns.values()].filter(
    (r) => r.status === "in_flight" && agentBaseName(r.agent) === agent,
  );
  if (sameAgent.length === 0) return ALLOW;
  // several dispatches of this agent: the one whose worktree the caller runs in, when known
  const cwdWorktree =
    sameAgent.length > 1 && input.cwd !== undefined
      ? worktreeIdOf(active.repoRoot, input.cwd)
      : null;
  const own =
    cwdWorktree === null ? [] : sameAgent.filter((d) => ownsWorktree(active.run, d, cwdWorktree));
  const dispatches = own.length > 0 ? own : sameAgent;
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

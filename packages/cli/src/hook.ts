/**
 * `vtc hook <session-start|pre-tool-use|subagent-stop> --host <host>`: the command every plugin
 * hook runs (AD-16 rule 3; the frozen contract is `@vtc/shared` hook.ts). It fails open: no VTC
 * run, unreadable input or any error is exit 0 with no output, and so is no live daemon for
 * `pre-tool-use` and `subagent-stop`. `session-start` reads the committed event logs itself and
 * prints the resume hint for each unfinished run whether or not a daemon answers yet (D-af, spine
 * §5 reading 52; `run-log.ts`).
 *
 * It blocks (exit 2, the reason on stderr) only a VTC role agent's git write (commits, pushes,
 * merges, rebases, resets, config changes, ref writes and `git -c` / `--config-env` overrides of
 * keys that are not output-only; reading 64), or a write outside its effective write scope (D-ag,
 * reading 53): its own worktree within its in-flight dispatch's write scope, its main-checkout
 * staging entries (QA author mode's hidden tests, reading 65) and the OS temp directory
 * ({@link osTempDirs}). The engine stays the enforcement point.
 *
 * Known limit: the host's hook input names the calling agent but not which of its dispatches it
 * serves. With concurrency 2-3, two in-flight dispatches can share an agent (two `vtc-engineer`
 * tasks). When the input's `cwd` lies in one of their worktrees, only that dispatch counts;
 * otherwise a write into either worktree, inside that worktree's own scope, is allowed. The
 * engine still attributes and checks each worktree's diff against its own task (L5).
 *
 * TODO(engine-core, spine §5 reading 67): the write scope is still read from the rendered
 * Markdown pack (`packWriteScopes`) and matched with the cli's copy of the glob dialect
 * (`hook-rules.ts`), because build/foundation's `core` exports neither `matchesAny` /
 * `globToRegExp` nor a structured per-dispatch write scope yet. Switch to those exports and delete
 * both copies as soon as engine-core lands them.
 */
import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
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
import { unfinishedRuns, type UnfinishedRun } from "./run-log.js";

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
  /** The OS temp directories a role agent may write in (D-ag); {@link osTempDirs} by default. */
  readonly tempDirs?: readonly string[];
  /** The repo's unfinished runs from its event logs (`run-log.ts`), by default. */
  readonly unfinishedRuns?: (repoRoot: string, deadline: number) => Promise<UnfinishedRun[]>;
  /** When the hook must have answered (epoch ms); `VTC_HOOK.timeoutMs` from now by default. */
  readonly deadline?: number;
}

/**
 * The OS temp directory (D-ag, spine §5 reading 53): an absolute `$TMPDIR`, the runtime's
 * `tmpdir()`, `/tmp` and `/private/tmp`, and `/var/folders` on macOS (where `$TMPDIR` lives).
 */
export const osTempDirs = (
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
  osTmp: string = tmpdir(),
): string[] => {
  const dirs = [env.TMPDIR, osTmp, "/tmp", "/private/tmp"];
  if (platform === "darwin") dirs.push("/var/folders");
  return [
    ...new Set(dirs.filter((d): d is string => d !== undefined && d !== "" && isAbsolute(d))),
  ];
};

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
  tempDirs: readonly string[],
): string | null => {
  const scopes = scopesOf(repoRoot, dispatches);
  if (scopes === null) return null; // a pack is unreadable: allow (the engine still checks)
  const real = realish(target);
  const inWorktrees = below(relative(realish(join(repoRoot, git.WORKTREES_DIR)), real));
  if (inWorktrees === null) {
    const inRepo = below(relative(realish(repoRoot), real));
    // outside the repo (where it lands, symlinks resolved), the OS temp directory is allowed
    if (inRepo === null && tempDirs.some((dir) => below(relative(realish(dir), real)) !== null))
      return null;
    const allowed =
      inRepo !== null &&
      dispatches.some((d) =>
        inAllScopes(
          (scopes.get(d) ?? []).map((scope) => scope.filter(isCheckoutEntry)),
          posix(inRepo),
        ),
      );
    return allowed
      ? null
      : `${target} is outside your worktree under ${git.WORKTREES_DIR}/ (and outside the OS temp directory)`;
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
    const violation = writeViolation(
      target,
      active.repoRoot,
      active.run,
      dispatches,
      deps.tempDirs ?? osTempDirs(),
    );
    if (violation !== null)
      return block(`VTC: ${violation}. Write only inside your task pack's write scope.`);
  }
  return ALLOW;
};

/** The one-paragraph hint for an unfinished run (hook rule 3, §6.8). */
const resumeHint = (run: UnfinishedRun): string => {
  const what = [run.track, run.phase === null ? null : `phase ${run.phase}`]
    .filter((p) => p !== null)
    .join(", ");
  const state = run.paused ? "paused" : "in progress";
  return `VTC: run ${run.id}${what === "" ? "" : ` (${what})`} is ${state} in this repo. Resume run? Offer the user to resume it: call the vtc \`status\` tool to summarise it${run.paused ? ", `resume` if the user agrees," : ""} then \`next\` and perform exactly the actions it returns.\n`;
};

/**
 * Hook rule 3 with D-af: the hint for every run the committed event log shows unfinished, read
 * from the logs themselves, so it needs no daemon.
 */
const sessionStart = async (input: VtcHookInput, deps: HookDeps): Promise<HookOutcome> => {
  const repoRoot = await deps.findRepoRoot(input.cwd ?? deps.cwd);
  if (repoRoot === null) return ALLOW;
  const read = deps.unfinishedRuns ?? unfinishedRuns;
  const runs = await read(repoRoot, deps.deadline ?? Date.now() + VTC_HOOK.timeoutMs);
  if (runs.length === 0) return ALLOW;
  return { code: VTC_HOOK.exit.allow, stdout: runs.map(resumeHint).join("") };
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

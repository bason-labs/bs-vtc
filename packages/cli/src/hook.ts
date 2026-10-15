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
 * Since round 5 (D-cs, spine §5 reading 221): a VTC role agent's shell call (`Bash`) that is not
 * blocked also appends its command shapes to the engine's private spool while the repo's daemon
 * is alive (`command-spool.ts`): the shape only, never the command; it never blocks.
 *
 * Known limit: the host's hook input names the calling agent but not which of its dispatches it
 * serves. With concurrency 2-3, two in-flight dispatches can share an agent (two `vtc-engineer`
 * tasks). When the input's `cwd` lies in one of their worktrees, only that dispatch counts;
 * otherwise a write into either worktree, inside that worktree's own scope, is allowed. The
 * engine still attributes and checks each worktree's diff against its own task (L5).
 *
 * The effective write scope is engine core's structured per-dispatch scope
 * (`core.dispatchWriteScope`, spine §5 reading 67), matched with engine core's own glob dialect
 * (`core.matchesAny`), so the hook and the engine agree on which entries are main-checkout entries
 * (only QA author mode's own staging, `core.isCheckoutScopeEntry`). A VTC role agent with no
 * in-flight dispatch of its own in the active run has an empty scope: only the OS temp directory
 * (rule 4). When a dispatch's persisted pack is unreadable, its scope is unknown: a write inside
 * its own worktree is left to the engine (L5 checks the diff), and a write outside it stays
 * blocked.
 */
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { core, git } from "@vtc/engine";
import {
  HEADLESS_ROLE_ENV,
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
  shellCommandOf,
  writeTargets,
} from "./hook-rules.js";
import { appendSpoolRows, SHELL_TOOLS, spoolRowsOf } from "./command-spool.js";
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
  /** The clock of the command-shape spool rows (D-cs); the system clock by default. */
  readonly now?: () => Date;
  /**
   * The hook process's environment, where an engine-launched headless role run carries
   * `HEADLESS_ROLE_ENV` (hook contract rule 7, contracts 5.5.0); `process.env` by default.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** The role agent an engine-launched headless run marks itself as (rule 7), if any. */
const headlessRoleOf = (deps: HookDeps): string | undefined => {
  const marked = (deps.env ?? process.env)[HEADLESS_ROLE_ENV];
  return isVtcRoleAgent(marked) ? marked : undefined;
};

/** The VTC role agent making the call: the host's `agent_type`, else the headless marker. */
const roleAgentOf = (input: VtcHookInput, deps: HookDeps): string | undefined =>
  isVtcRoleAgent(input.agent_type) ? input.agent_type : headlessRoleOf(deps);

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

/** The repo the hook's `cwd` is in, when its daemon is alive; `null` otherwise. */
type LiveRepo = () => Promise<string | null>;

/** {@link LiveRepo} asked at most once per hook call (the write guard and the spool share it). */
const liveRepoOf = (input: VtcHookInput, deps: HookDeps): LiveRepo => {
  let found: Promise<string | null> | undefined;
  return () =>
    (found ??= (async () => {
      const repoRoot = await deps.findRepoRoot(input.cwd ?? deps.cwd);
      if (repoRoot === null || (await deps.liveDaemon(deps.vtcHome, repoRoot)) === null)
        return null;
      return repoRoot;
    })());
};

/** The repo's unfinished run, when its daemon is alive. */
const activeRunOf = async (
  liveRepo: LiveRepo,
  deps: HookDeps,
): Promise<{ repoRoot: string; run: RunState } | null> => {
  const repoRoot = await liveRepo();
  if (repoRoot === null) return null;
  const run = core.activeRun([...deps.loadRuns(repoRoot)]);
  return run === undefined || run.run.finished_at !== undefined ? null : { repoRoot, run };
};

/** Links followed before a path is judged as it is written (the kernel's own limit is 40). */
const MAX_LINKS = 40;

/**
 * The path with symlinks resolved as far as it exists (a new file's parent, and so on). A
 * dangling symlink is judged by where it points, since writing through it creates its target.
 */
const realish = (abs: string, links = 0): string => {
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    if (parent === abs) return abs;
    const realParent = realish(parent, links);
    if (links < MAX_LINKS) {
      let target: string | null = null;
      try {
        if (lstatSync(abs).isSymbolicLink()) target = readlinkSync(abs);
      } catch {
        // not there yet: a new file
      }
      if (target !== null) return realish(resolve(realParent, target), links + 1);
    }
    return join(realParent, basename(abs));
  }
};

/** POSIX form of a relative path. */
const posix = (rel: string): string => rel.split(sep).join("/");

/** `rel` (from `relative`) when it stays below its base, else `null`. */
const below = (rel: string): string | null =>
  rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? null : rel;

/** A dispatch with its effective write scope (`null` when its persisted pack is unreadable). */
interface Dispatch {
  readonly scope: core.DispatchWriteScope | null;
  /** Its worktree's id under `WORKTREES_DIR`, or `null` when it has none. */
  readonly worktreeId: string | null;
}

/** The id under `WORKTREES_DIR` of a repo-relative worktree path, or `null`. */
const worktreeIdFromPath = (worktree: string | null): string | null =>
  worktree?.startsWith(`${git.WORKTREES_DIR}/`) === true
    ? (worktree.slice(git.WORKTREES_DIR.length + 1).split("/")[0] ?? null) || null
    : null;

/** Each dispatch with engine core's structured write scope (spine §5 reading 67). */
const dispatchesOf = (
  repoRoot: string,
  run: RunState,
  records: readonly core.RoleRunRecord[],
): Dispatch[] =>
  records.map((record) => {
    const scope = core.dispatchWriteScope(repoRoot, run, record);
    return {
      scope,
      worktreeId: worktreeIdFromPath(scope?.worktree ?? core.dispatchWorktree(run, record)),
    };
  });

/** The worktree id (first segment under `WORKTREES_DIR`) that `abs` lies in, or `null`. */
const worktreeIdOf = (repoRoot: string, abs: string): string | null => {
  const rel = below(relative(realish(join(repoRoot, git.WORKTREES_DIR)), realish(abs)));
  return rel === null ? null : (rel.split(sep)[0] ?? null);
};

/** Why writing `target` is outside the dispatches' scope, or `null` when it is allowed. */
const writeViolation = (
  target: string,
  repoRoot: string,
  dispatches: readonly Dispatch[],
  tempDirs: readonly string[],
): string | null => {
  const real = realish(target);
  const none = dispatches.length === 0 ? " (you have no in-flight dispatch in this run)" : "";
  const inWorktrees = below(relative(realish(join(repoRoot, git.WORKTREES_DIR)), real));
  if (inWorktrees === null) {
    const inRepo = below(relative(realish(repoRoot), real));
    // outside the repo (where it lands, symlinks resolved), the OS temp directory is allowed
    if (inRepo === null && tempDirs.some((dir) => below(relative(realish(dir), real)) !== null))
      return null;
    // in the main checkout, only engine core's main-checkout entries (QA author's own staging)
    const allowed =
      inRepo !== null &&
      dispatches.some(
        (d) => d.scope !== null && core.matchesAny(d.scope.checkout_globs, posix(inRepo)),
      );
    return allowed
      ? null
      : `${target} is outside your worktree under ${git.WORKTREES_DIR}/ (and outside the OS temp directory)${none}`;
  }
  const [id = "", ...rest] = inWorktrees.split(sep);
  const path = rest.join("/");
  const mine = dispatches.filter((d) => d.worktreeId === id);
  if (mine.length === 0) return `${target} is in a worktree that is not yours (${id})${none}`;
  // an unreadable pack: its scope is unknown, so a write in its own worktree is left to L5
  if (
    path !== "" &&
    mine.some((d) => d.scope === null || core.matchesAny(d.scope.worktree_globs, path))
  )
    return null;
  const scope = [...new Set(mine.flatMap((d) => d.scope?.worktree_globs ?? []))];
  return `${path || target} is outside your write scope (${scope.length === 0 ? "read-only" : scope.join(", ")})`;
};

/** The write guard of a role agent's call (contract rule 4): allow, or block with the reason. */
const guardWrites = async (
  input: VtcHookInput,
  agentType: string,
  shell: string | null,
  liveRepo: LiveRepo,
  deps: HookDeps,
): Promise<HookOutcome> => {
  const agent = agentBaseName(agentType);
  const gitWrite = shell === null ? null : gitWriteIn(shell);
  const targets = writeTargets(input.tool_name, input.tool_input ?? {}, input.cwd ?? deps.cwd);
  if (gitWrite === null && targets.length === 0) return ALLOW;
  const active = await activeRunOf(liveRepo, deps);
  if (active === null) return ALLOW;
  if (gitWrite !== null)
    return block(
      `VTC: role agents never run git ${gitWrite}. Leave your changes in the worktree; the engine commits, merges and pushes them after the Lead submits your result.`,
    );
  // No in-flight dispatch of this agent: its effective write scope is empty (rule 4), so only
  // the OS temp directory is allowed.
  const sameAgent = dispatchesOf(
    active.repoRoot,
    active.run,
    [...active.run.roleRuns.values()].filter(
      (r) => r.status === "in_flight" && agentBaseName(r.agent) === agent,
    ),
  );
  // several dispatches of this agent: the one whose worktree the caller runs in, when known
  const cwdWorktree =
    sameAgent.length > 1 && input.cwd !== undefined
      ? worktreeIdOf(active.repoRoot, input.cwd)
      : null;
  const own = cwdWorktree === null ? [] : sameAgent.filter((d) => d.worktreeId === cwdWorktree);
  const dispatches = own.length > 0 ? own : sameAgent;
  for (const target of targets) {
    const violation = writeViolation(
      target,
      active.repoRoot,
      dispatches,
      deps.tempDirs ?? osTempDirs(),
    );
    if (violation !== null)
      return block(`VTC: ${violation}. Write only inside your task pack's write scope.`);
  }
  return ALLOW;
};

/**
 * D-cs (reading 221): the shapes of a role agent's shell call go to the engine's spool
 * (`command-spool.ts`), only while the repo's daemon is alive to drain it and the deadline has
 * not passed. Never the raw command; any failure is swallowed, so it never blocks.
 */
const spoolShapes = async (
  input: VtcHookInput,
  agentType: string,
  shell: string,
  liveRepo: LiveRepo,
  deps: HookDeps,
): Promise<void> => {
  try {
    if (shell.trim() === "") return;
    const repoRoot = await liveRepo();
    if (repoRoot === null || Date.now() >= (deps.deadline ?? Infinity)) return;
    const rows = spoolRowsOf({
      command: shell,
      agent: agentType,
      session: input.session_id,
      cwd: input.cwd ?? deps.cwd,
      at: (deps.now ?? (() => new Date()))(),
    });
    appendSpoolRows(deps.vtcHome, repoRoot, rows);
  } catch {
    // fail open: a lost row loses one tool-signal count, never the call
  }
};

const preToolUse = async (input: VtcHookInput, deps: HookDeps): Promise<HookOutcome> => {
  const agentType = roleAgentOf(input, deps);
  if (agentType === undefined) return ALLOW;
  const shell = shellCommandOf(input.tool_input ?? {});
  const liveRepo = liveRepoOf(input, deps);
  const outcome = await guardWrites(input, agentType, shell, liveRepo, deps);
  if (
    outcome.code === VTC_HOOK.exit.allow &&
    shell !== null &&
    SHELL_TOOLS.has(input.tool_name ?? "") &&
    // a headless run's shapes come from its adapter's stream (rule 7)
    headlessRoleOf(deps) === undefined
  )
    await spoolShapes(input, agentType, shell, liveRepo, deps);
  return outcome;
};

/** At most this many runs get a hint, the newest; older ones are counted in one line. */
export const MAX_HINTED_RUNS = 3;
/** An upper bound on what `session-start` prints into the Lead's context. */
export const MAX_RESUME_HINT_CHARS = 2000;

/** The one-paragraph hint for an unfinished run (hook rule 3, §6.8). */
const resumeHint = (run: UnfinishedRun): string => {
  const what = [run.track, run.phase === null ? null : `phase ${run.phase}`]
    .filter((p) => p !== null)
    .join(", ");
  const state = run.paused ? "paused" : "in progress";
  return `VTC: run ${run.id}${what === "" ? "" : ` (${what})`} is ${state} in this repo. Resume run? Offer the user to resume it: call the vtc \`status\` tool to summarise it${run.paused ? ", `resume` if the user agrees," : ""} then \`next\` and perform exactly the actions it returns.\n`;
};

/**
 * Hook rule 3 with D-af: the hint for the newest runs the committed event log shows unfinished,
 * read from the logs themselves, so it needs no daemon. Only for the Lead: a VTC role session
 * (headless roles load the plugin too, D-aa) gets nothing. `run-log.ts` lets only schema-valid
 * ids, tracks and phases through, and the output is bounded.
 */
const sessionStart = async (input: VtcHookInput, deps: HookDeps): Promise<HookOutcome> => {
  if (isVtcRoleAgent(input.agent_type) || headlessRoleOf(deps) !== undefined) return ALLOW;
  const repoRoot = await deps.findRepoRoot(input.cwd ?? deps.cwd);
  if (repoRoot === null) return ALLOW;
  const read = deps.unfinishedRuns ?? unfinishedRuns;
  const runs = await read(repoRoot, deps.deadline ?? Date.now() + VTC_HOOK.timeoutMs);
  if (runs.length === 0) return ALLOW;
  const older = runs.length - MAX_HINTED_RUNS;
  const hints = runs.slice(-MAX_HINTED_RUNS).map(resumeHint);
  if (older > 0)
    hints.push(
      `VTC: ${String(older)} older unfinished ${older === 1 ? "run is" : "runs are"} in this repo too; the vtc \`status\` tool lists them.\n`,
    );
  return { code: VTC_HOOK.exit.allow, stdout: hints.join("").slice(0, MAX_RESUME_HINT_CHARS) };
};

const subagentStop = async (input: VtcHookInput, deps: HookDeps): Promise<HookOutcome> => {
  if (!isVtcRoleAgent(input.agent_type)) return ALLOW;
  if ((await activeRunOf(liveRepoOf(input, deps), deps)) === null) return ALLOW;
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

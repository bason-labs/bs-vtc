/**
 * The dispatch guard (AD-7 rules 2 and 7, AD-8 rule 3; spine §5 readings 21–23). No role works in
 * the user's checkout: task roles have their task worktree, front-half roles and advisors their
 * own (`role-worktree.ts`), so the user's own edits never count as a role's write. Every role can
 * still reach the repo through the host, so the engine records, for EVERY dispatch, before the
 * Lead can start it:
 *
 * - the held git configuration (`gitConfigFingerprint`: hooks, attributes, every config key that
 *   can run code). While any role is in flight, every engine git call in the repo first checks
 *   it (`setGitPreflight`), and a change refuses git until the human resumes: a planted hook,
 *   signing program or filter driver never runs. Allow-listed keys may change;
 * - the engine's own files ({@link ENGINE_FILE_DIRS}: event logs, plan files, evidence, packs,
 *   results). A changed path passes only when it holds exactly what the engine last wrote there
 *   (`EngineWrites`); a new one never does.
 *
 * Records live in memory and in the engine's private directory (`guard.ts`), outside anything a
 * role can write. Every way a run ends is checked: a result, a failure, a limit, a run
 * superseded by `resume`, a restart; a run that ended without a check is checked before the next
 * dispatch. A record is dropped only after its check. A finding is logged in full as an incident
 * (`checkout_write`, paths as evidence) and pauses the run with a short reason; nothing is
 * restored automatically, and only the human's `resume` takes the files as they then are. On
 * open, a run still in flight with no record cannot be verified: its run pauses.
 */
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { eventLogPath, SlugSchema, toEventLine } from "@vtc/shared";
import {
  fingerprintChanges,
  GitConfigChangedError,
  gitConfigFingerprint,
  writeRepoFile,
} from "../git/index.js";
import { NEVER_WROTE } from "./engine-writes.js";
import type { DispatchRecord } from "./dispatch-record.js";
import { ensurePrivateDir, readPrivateFile, removePrivateFile, writePrivateFile } from "./guard.js";
import type { Kernel, RunHandle } from "./kernel.js";
import { inFlight } from "./queries.js";
import type { RoleRunRecord } from "./state.js";

export type { DispatchRecord };

/** Where the engine's own files are: a role's write there never passes (AD-7 rule 2). */
export const ENGINE_FILE_DIRS = [
  ".vtc/runs",
  ".vtc/tasks",
  ".vtc/evidence",
  ".vtc/design/reviews",
  ".vtc/state/results",
  ".vtc/state/runs",
  ".vtc/state/packs",
] as const;

/** Globs of the same paths (role worktree diffs are checked against them). */
export const ENGINE_ONLY_GLOBS: readonly string[] = [
  ...ENGINE_FILE_DIRS.map((d) => `${d}/**`),
  ".vtc/state/**",
];

/** Where the displaced content of a changed log is kept for the human (ignored, never replayed). */
export const FORENSICS_DIR = ".vtc/state/forensics";

export const recordKey = (run: string, actionId: string): string => `${run}/${actionId}`;

const hashOf = (abs: string): string => {
  try {
    const stat = lstatSync(abs);
    if (stat.isSymbolicLink()) return `symlink:${readlinkSync(abs)}`;
    if (stat.isDirectory()) return "dir";
    return createHash("sha256").update(readFileSync(abs)).digest("hex");
  } catch {
    return "deleted";
  }
};

/** Content hashes of every file under {@link ENGINE_FILE_DIRS}. */
export const engineFiles = (repoRoot: string): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (rel: string, depth: number): void => {
    let names: string[];
    try {
      names = readdirSync(join(repoRoot, rel));
    } catch {
      return;
    }
    for (const name of names) {
      const child = `${rel}/${name}`;
      let directory: boolean;
      try {
        const stat = lstatSync(join(repoRoot, child));
        directory = stat.isDirectory() && !stat.isSymbolicLink();
      } catch {
        continue;
      }
      if (directory) {
        if (depth > 0) walk(child, depth - 1);
      } else {
        out[child] = hashOf(join(repoRoot, child));
      }
    }
  };
  for (const dir of ENGINE_FILE_DIRS) walk(dir, 4);
  return out;
};

// ------------------------------------------------------------- persistence

const recordsDir = (k: Kernel): string => join(k.guardDir, "dispatches");

const recordFile = (k: Kernel, run: string, actionId: string): string =>
  join(recordsDir(k), `${SlugSchema.parse(run)}--${SlugSchema.parse(actionId)}.json`);

const gitHoldFile = (k: Kernel): string => join(k.guardDir, "git-hold.json");

/** Records a dispatch now (before the Lead can start it) and keeps it for a restart. */
export const recordDispatch = (
  k: Kernel,
  run: string,
  actionId: string,
  worktree?: DispatchRecord["worktree"],
): DispatchRecord => {
  const record: DispatchRecord = {
    v: 3,
    run,
    action_id: actionId,
    git: gitConfigFingerprint(k.deps.repoRoot),
    state: engineFiles(k.deps.repoRoot),
    ...(worktree === undefined ? {} : { worktree }),
  };
  k.dispatches.set(recordKey(run, actionId), record);
  ensurePrivateDir(recordsDir(k));
  writePrivateFile(recordFile(k, run, actionId), `${JSON.stringify(record)}\n`);
  return record;
};

/** Drops a checked record (memory and file). */
export const dropDispatch = (k: Kernel, run: string, actionId: string): void => {
  k.dispatches.delete(recordKey(run, actionId));
  removePrivateFile(recordFile(k, run, actionId));
};

const isHashes = (value: unknown): value is Record<string, string> =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.values(value as Record<string, unknown>).every((h) => typeof h === "string");

const isRecord = (value: unknown): value is DispatchRecord => {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  const w: unknown = r.worktree;
  return (
    r.v === 3 &&
    typeof r.run === "string" &&
    typeof r.action_id === "string" &&
    isHashes(r.git) &&
    isHashes(r.state) &&
    (w === undefined ||
      (typeof w === "object" &&
        w !== null &&
        typeof (w as Record<string, unknown>).path === "string" &&
        typeof (w as Record<string, unknown>).base === "string"))
  );
};

/** Records kept for a restart, back in memory. Unreadable ones are dropped (no record). */
export const restoreDispatches = (k: Kernel): void => {
  let names: string[];
  try {
    names = readdirSync(recordsDir(k));
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const text = readPrivateFile(join(recordsDir(k), name));
    try {
      const parsed: unknown = text === null ? null : JSON.parse(text);
      if (isRecord(parsed)) k.dispatches.set(recordKey(parsed.run, parsed.action_id), parsed);
    } catch {
      // unreadable: no record
    }
  }
};

/** The git fingerprint kept after a reported change, until the human resumes (or `null`). */
export const loadGitHold = (k: Kernel): Record<string, string> | null => {
  const text = readPrivateFile(gitHoldFile(k));
  try {
    const parsed: unknown = text === null ? null : JSON.parse(text);
    return isHashes(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const saveGitHold = (k: Kernel, hold: Readonly<Record<string, string>> | null): void => {
  if (hold === null) removePrivateFile(gitHoldFile(k));
  else {
    ensurePrivateDir(k.guardDir);
    writePrivateFile(gitHoldFile(k), `${JSON.stringify(hold)}\n`);
  }
};

// ------------------------------------------------------------------ checks

/** What a check found. */
export interface WriteFindings {
  /** One line per offending path. */
  readonly issues: string[];
  /** The paths (or git keys) behind the issues, for the incident's evidence. */
  readonly paths: string[];
  /** Held git state that changed (engine git is refused until the human resumes). */
  readonly git: string[];
}

export const NO_FINDINGS: WriteFindings = { issues: [], paths: [], git: [] };

/** Checks the git configuration and the engine's files against a dispatch record. */
export const checkDispatch = (k: Kernel, record: DispatchRecord): WriteFindings => {
  const git = fingerprintChanges(record.git, gitConfigFingerprint(k.deps.repoRoot));
  if (git.length > 0) {
    // Git is not run on a changed config: report what changed and stop here.
    return {
      issues: git.map((key) => `${key} was changed (git configuration that can run code)`),
      paths: git,
      git,
    };
  }
  const issues: string[] = [];
  const paths: string[] = [];
  for (const path of fingerprintChanges(record.state, engineFiles(k.deps.repoRoot))) {
    // Gate Runner output of a job still running is adopted when the job ends (`adoptGateOutput`).
    const owner = /^\.vtc\/evidence\/([^/]+)\//.exec(path)?.[1];
    if (owner !== undefined && k.jobRunningFor(owner)) continue;
    const check = k.writes.check(path);
    if (check.ok) continue;
    paths.push(path);
    issues.push(
      check.detail === NEVER_WROTE
        ? `${path} was written where only the engine writes`
        : `${path} changed outside the engine: ${check.detail}`,
    );
  }
  return { issues, paths, git: [] };
};

/** The checks of a role run, by its record; a missing record cannot be verified. */
export const checkRun = (k: Kernel, h: RunHandle, run: RoleRunRecord): WriteFindings => {
  const record = k.dispatches.get(recordKey(h.state.id, run.action_id));
  if (record === undefined)
    return {
      issues: [
        `the engine has no record of ${run.role} (${run.action_id}) at dispatch, so what it did cannot be verified`,
      ],
      paths: [],
      git: [],
    };
  return checkDispatch(k, record);
};

/**
 * The run's event log is not what the engine wrote (AD-7 rule 2): it is rewritten at once from
 * the events the engine holds, so nothing it did not write is ever replayed, and the displaced
 * content is kept under {@link FORENSICS_DIR}. An incident and a pause say so.
 */
export const restoreLog = (k: Kernel, h: RunHandle, detail: string): void => {
  const rel = eventLogPath(h.state.id);
  const keep = `${FORENSICS_DIR}/${h.state.id}-${k.now().toISOString().replace(/[:.]/g, "-")}.jsonl`;
  let kept = "";
  try {
    writeRepoFile(k.deps.repoRoot, keep, readFileSync(join(k.deps.repoRoot, rel)), 0o600);
    kept = keep;
  } catch {
    // nothing to keep
  }
  writeRepoFile(k.deps.repoRoot, rel, h.state.events.map((e) => toEventLine(e)).join(""));
  k.emit(h, {
    type: "incident.recorded",
    actor: "engine",
    data: {
      kind: "log_corruption",
      detail:
        `${rel} was changed outside the engine (${detail}); it was rewritten from the engine's own events${kept === "" ? "" : `, the changed file is kept at ${kept}`}`.slice(
          0,
          2000,
        ),
      evidence: kept === "" ? [] : [{ type: "file", ref: kept }],
    },
  });
  k.emit(h, {
    type: "run.paused",
    actor: "engine",
    data: {
      reason:
        "the run's event log was changed outside the engine; it was rewritten from the engine's own events (see the incident). Check the repo, then vtc resume",
    },
  });
};

/**
 * Logs what a check found in full (`incident.recorded` kind `checkout_write`, the paths as
 * evidence) and pauses the run with a short reason (said again when it is already paused, so the
 * human sees it before resuming); a git change also holds engine git until the human resumes.
 */
export const reportFindings = (
  k: Kernel,
  h: RunHandle,
  who: { readonly role: string; readonly action_id: string },
  findings: WriteFindings,
): void => {
  if (findings.issues.length === 0) return;
  const log = k.writes.check(eventLogPath(h.state.id));
  if (!log.ok) restoreLog(k, h, log.detail);
  if (findings.git.length > 0 && k.gitHold === null) {
    const baseline = k.dispatches.get(recordKey(h.state.id, who.action_id))?.git ?? null;
    if (baseline !== null) {
      k.gitHold = baseline;
      saveGitHold(k, baseline);
    }
  }
  k.emit(h, {
    type: "incident.recorded",
    actor: "engine",
    data: {
      kind: "checkout_write",
      detail:
        `while ${who.role} (${who.action_id}) was in flight: ${findings.issues.join("; ")}`.slice(
          0,
          2000,
        ),
      evidence: findings.paths.slice(0, 20).map((ref) => ({ type: "file" as const, ref })),
    },
  });
  k.emit(h, {
    type: "run.paused",
    actor: "engine",
    data: {
      reason:
        `${String(findings.issues.length)} write(s) no role or engine write explains while ${who.role} (${who.action_id}) was in flight (see the incident); vtc resume accepts the repo as it then is`.slice(
          0,
          300,
        ),
    },
  });
};

/** Removes a front-half role's or advisor's worktree and branch (best effort). */
export const removeRoleWorktree = async (k: Kernel, record: DispatchRecord): Promise<void> => {
  if (record.worktree === undefined) return;
  try {
    await k.deps.workspace.removeWorktree(record.worktree.path);
    await k.deps.workspace.deleteBranch(`vtc/${record.worktree.path.split("/").at(-1) ?? ""}`);
  } catch {
    // a held git change refuses git: the worktree stays until the human resumes
  }
};

/**
 * Checks every record of this run whose role run is no longer in flight (a failure, a limit
 * interruption, a run superseded by resume, a restart), reports what it found, then drops it.
 */
export const sweepDispatches = async (k: Kernel, h: RunHandle): Promise<WriteFindings> => {
  const issues: string[] = [];
  const paths: string[] = [];
  const git: string[] = [];
  for (const record of [...k.dispatches.values()]) {
    if (record.run !== h.state.id) continue;
    const run = h.state.roleRuns.get(record.action_id);
    if (run?.status === "in_flight") continue;
    const found = checkDispatch(k, record);
    reportFindings(k, h, { role: run?.role ?? "a role", action_id: record.action_id }, found);
    if (found.git.length === 0) await removeRoleWorktree(k, record);
    dropDispatch(k, record.run, record.action_id);
    issues.push(...found.issues);
    paths.push(...found.paths);
    git.push(...found.git);
  }
  return { issues, paths, git };
};

/**
 * On open: every role run still in flight must have its record; one without cannot be verified,
 * so its run pauses (said once per action).
 */
export const reportUnverifiable = (k: Kernel, h: RunHandle): void => {
  const missing = inFlight(h.state).filter(
    (r) => !k.dispatches.has(recordKey(h.state.id, r.action_id)),
  );
  if (missing.length === 0) return;
  const ids = missing.map((r) => `${r.role} (${r.action_id})`).join(", ");
  k.emit(h, {
    type: "incident.recorded",
    actor: "engine",
    data: {
      kind: "checkout_write",
      detail:
        `the engine has no dispatch record of ${ids}, still in flight when it opened, so what they did cannot be verified`.slice(
          0,
          2000,
        ),
    },
  });
  k.emit(h, {
    type: "run.paused",
    actor: "engine",
    data: {
      reason:
        `role runs in flight without a dispatch record (${ids}) cannot be verified; check the repo, then vtc resume`.slice(
          0,
          300,
        ),
    },
  });
};

/**
 * The git files against every in-flight role's baseline: a change pauses the run and holds
 * engine git (it would otherwise only surface as refused git calls). True when found.
 */
export const checkGitNow = (k: Kernel, h: RunHandle): boolean => {
  const now = gitConfigFingerprint(k.deps.repoRoot);
  for (const record of k.dispatches.values()) {
    if (record.run !== h.state.id) continue;
    const changed = fingerprintChanges(record.git, now);
    if (changed.length === 0) continue;
    const run = h.state.roleRuns.get(record.action_id);
    reportFindings(
      k,
      h,
      { role: run?.role ?? "a role", action_id: record.action_id },
      {
        issues: changed.map((key) => `${key} was changed (git configuration that can run code)`),
        paths: changed,
        git: changed,
      },
    );
    return true;
  }
  return false;
};

/** The git baselines engine git must match now (open records and a held change). */
export const gitBaselines = (k: Kernel): Readonly<Record<string, string>>[] => [
  ...[...k.dispatches.values()].map((r) => r.git),
  ...(k.gitHold === null ? [] : [k.gitHold]),
];

/**
 * `setGitPreflight`'s check, before every engine git call in the repo: throws when the held git
 * state differs from any baseline (an in-flight role's, or a held change's).
 */
export const gitPreflight = (k: Kernel): void => {
  const baselines = gitBaselines(k);
  if (baselines.length === 0) return;
  const now = gitConfigFingerprint(k.deps.repoRoot);
  const changed = new Set(baselines.flatMap((b) => fingerprintChanges(b, now)));
  if (changed.size > 0) throw new GitConfigChangedError([...changed].sort());
};

/**
 * The human resumed: the repo is taken as it is (every file the engine wrote that has changed
 * becomes the engine's again; the run's own log never differs, `restoreLog`). A git change is
 * no longer held.
 */
export const acceptCheckout = (k: Kernel): void => {
  for (const rel of k.writes.changed()) k.writes.accept(rel);
  if (k.gitHold !== null) {
    k.gitHold = null;
    saveGitHold(k, null);
  }
};

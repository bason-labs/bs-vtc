/**
 * The engine side of the checkout write check (`phase-scope.ts`, AD-7 rule 7): which writes a
 * checkout role may make, checking a run when it ends (or before the next dispatch, for one that
 * ended without a submit), pausing the run on anything found, refusing engine git while the
 * repo's git files differ from the baseline, and what the human's `resume` accepts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eventLogPath, resolveRoleMode, toEventLine } from "@vtc/shared";
import { writeRepoFile } from "../git/index.js";
import type { Kernel, RunHandle } from "./kernel.js";
import { fingerprintChanges, gitConfigFingerprint } from "../git/index.js";
import {
  assertGitUnchanged,
  checkoutWrites,
  dropCheckoutRecord,
  loadCheckoutRecords,
  runsInCheckout,
  saveGitHold,
  type WriteFindings,
} from "./phase-scope.js";
import type { RoleRunRecord } from "./state.js";

/** A role run's effective write paths (its mode's, else the role's). */
export const writePathsOf = (
  k: Kernel,
  run: Pick<RoleRunRecord, "role" | "mode">,
): readonly string[] => {
  const contract = k.deps.roles.get(run.role);
  if (contract === undefined) return [];
  const effective = resolveRoleMode(contract, run.mode);
  return effective.ok ? effective.contract.tools.write_paths : [];
};

/** The run's write paths and those of every checkout role whose run overlapped it. */
const allowedFor = (h: RunHandle, k: Kernel, run: RoleRunRecord): string[] => {
  const end = run.closedSeq ?? Number.MAX_SAFE_INTEGER;
  const concurrent = [...h.state.roleRuns.values()].filter(
    (r) =>
      runsInCheckout(r.role) &&
      r.action_id !== run.action_id &&
      r.seq < end &&
      (r.status === "in_flight" || (r.closedSeq ?? 0) > run.seq),
  );
  return [...writePathsOf(k, run), ...concurrent.flatMap((r) => writePathsOf(k, r))];
};

/** Checks one checkout role's writes against its dispatch record. */
export const checkRunWrites = async (
  k: Kernel,
  h: RunHandle,
  run: RoleRunRecord,
): Promise<WriteFindings> => {
  const before = k.checkouts.get(run.action_id);
  if (before === undefined) {
    return {
      issues: [
        "the engine has no record of the checkout at dispatch, so the writes cannot be verified",
      ],
      git: [],
    };
  }
  return checkoutWrites(k.deps.repoRoot, k.writes, before, allowedFor(h, k, run));
};

/** Where a log's displaced content is kept for the human (ignored, never replayed). */
export const FORENSICS_DIR = ".vtc/state/forensics";

/**
 * The run's event log is not what the engine wrote (AD-7 rule 2): the file is rewritten at once
 * from the events the engine holds, so nothing it did not write is ever replayed, and the
 * displaced content is kept under {@link FORENSICS_DIR}. An incident and a pause say so.
 */
export const restoreLog = (k: Kernel, h: RunHandle, detail: string): void => {
  const rel = eventLogPath(h.state.id);
  const keep = `${FORENSICS_DIR}/${h.state.id}-${k.now().toISOString().replace(/[:.]/g, "-")}.jsonl`;
  let kept: string;
  try {
    writeRepoFile(k.deps.repoRoot, keep, readFileSync(join(k.deps.repoRoot, rel)), 0o600);
    kept = keep;
  } catch {
    kept = "";
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
    },
  });
  k.emit(h, {
    type: "run.paused",
    actor: "engine",
    data: {
      reason:
        "the run's event log was changed outside the engine; it was rewritten from the engine's own events (see the incident). Check the checkout, then vtc resume",
    },
  });
};

/**
 * Pauses the run with what a check found (said again when it is already paused, so the human
 * sees it before resuming); a git change also holds engine git until the human resumes.
 */
export const reportWrites = (
  k: Kernel,
  h: RunHandle,
  run: Pick<RoleRunRecord, "role" | "action_id">,
  findings: WriteFindings,
): void => {
  if (findings.issues.length === 0) return;
  const log = k.writes.check(eventLogPath(h.state.id));
  if (!log.ok) restoreLog(k, h, log.detail);
  if (findings.git.length > 0) {
    const baseline = k.checkouts.get(run.action_id)?.git ?? null;
    if (baseline !== null && k.gitHold === null) {
      k.gitHold = baseline;
      saveGitHold(k.deps.repoRoot, baseline);
    }
  }
  const what = findings.issues.slice(0, 5).join("; ");
  k.emit(h, {
    type: "run.paused",
    actor: "engine",
    data: {
      reason:
        `${run.role} (${run.action_id}) changed the checkout where it may not; vtc resume accepts the checkout as it then is and rewrites the run's log from the engine's record: ${what}`.slice(
          0,
          300,
        ),
    },
  });
};

/**
 * Checks every record whose run ended without a check (a failure, a limit interruption, a run
 * superseded by resume, a restart), then drops it. Returns what was found.
 */
export const sweepCheckouts = async (k: Kernel, h: RunHandle): Promise<WriteFindings> => {
  const issues: string[] = [];
  const git: string[] = [];
  for (const [actionId] of [...k.checkouts]) {
    const run = h.state.roleRuns.get(actionId);
    if (run?.status === "in_flight") continue;
    if (run === undefined) {
      // another run's record: that run sweeps it
      if ([...k.allStates()].some((s) => s.roleRuns.has(actionId))) continue;
      dropCheckoutRecord(k.deps.repoRoot, k.checkouts, actionId);
      continue;
    }
    const found = await checkRunWrites(k, h, run);
    reportWrites(k, h, run, found);
    dropCheckoutRecord(k.deps.repoRoot, k.checkouts, actionId);
    issues.push(...found.issues);
    git.push(...found.git);
  }
  return { issues, git };
};

/**
 * The git files against every in-flight checkout role's baseline: a change pauses the run and
 * holds engine git (it would otherwise only surface as refused git calls). True when found.
 */
export const checkGitNow = (k: Kernel, h: RunHandle): boolean => {
  const now = gitConfigFingerprint(k.deps.repoRoot);
  for (const [actionId, record] of k.checkouts) {
    const changed = fingerprintChanges(record.git, now);
    if (changed.length === 0) continue;
    const run = h.state.roleRuns.get(actionId);
    reportWrites(
      k,
      h,
      { role: run?.role ?? "a checkout role", action_id: actionId },
      {
        issues: changed.map((p) => `${p} was changed (git configuration, hooks or attributes)`),
        git: changed,
      },
    );
    return true;
  }
  return false;
};

/** The git baselines engine git must match now (open records and a held change). */
export const gitBaselines = (k: Kernel): Readonly<Record<string, string>>[] => [
  ...[...k.checkouts.values()].map((r) => r.git),
  ...(k.gitHold === null ? [] : [k.gitHold]),
];

/** `setGitPreflight`'s check: no engine git while the git files differ from a baseline. */
export const gitPreflight = (k: Kernel): void => {
  assertGitUnchanged(k.deps.repoRoot, gitBaselines(k));
};

/** Records kept on disk for a restart, back in memory. */
export const restoreCheckoutRecords = (k: Kernel): void => {
  for (const [id, record] of loadCheckoutRecords(k.deps.repoRoot)) k.checkouts.set(id, record);
};

/**
 * The human resumed: the checkout is taken as it is (every file the engine wrote that has
 * changed becomes the engine's again; the run's own log never differs, `restoreLog`). A git
 * change is no longer held.
 */
export const acceptCheckout = (k: Kernel): void => {
  for (const rel of k.writes.changed()) k.writes.accept(rel);
  if (k.gitHold !== null) {
    k.gitHold = null;
    saveGitHold(k.deps.repoRoot, null);
  }
};

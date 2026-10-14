/**
 * Pins and canaries (AD-21 rules 3 and 7; spine §5 reading 103).
 *
 * - Pins are read only from `~/.vtc/lookback/pins.yaml` (`LookbackPins`, read with
 *   `parsePersisted`). Nothing here takes a repo path, so a `pins.yaml` inside a repo can never
 *   select a prompt.
 * - Only a human promotes or pins (`vtc lookback approve|pin|rollback`, the cli). The engine's one
 *   write is {@link autoRollback}: it removes a canary and appends an `auto_rollback` history
 *   entry, and {@link checkEngineWrite} proves that is all it changed before the file is written.
 * - A pins file that does not parse selects nothing (every role runs its compiled default) and is
 *   never overwritten by the engine.
 */
import {
  canaryArmFor,
  LOOKBACK_HOME,
  LOOKBACK_PINS_LOCK_STALE_MS,
  LookbackPinsSchema,
  parsePersisted,
  type HostId,
  type LookbackPins,
  type PromptVersionRef,
} from "@vtc/shared";
import { join } from "node:path";
import { parseYaml, toYaml } from "../core/index.js";
import { lookbackEvent, type LookbackEventDraft } from "./events.js";
import { readTextIfExists, withFileLock, writeAtomicIfUnchanged } from "./files.js";
import { sameTarget } from "./traces.js";
import { loadPromptVersion, promptVersionRef } from "./versions.js";

export interface PinTarget {
  readonly role: string;
  readonly mode?: string | undefined;
  readonly host: HostId;
}

export const EMPTY_PINS: LookbackPins = { v: 1, projects: {}, history: [] };

/** Absolute path of the pins file under the VTC home. */
export const pinsPath = (vtcHome: string): string => join(vtcHome, LOOKBACK_HOME.pinsFile);

export interface PinsRead {
  readonly pins: LookbackPins;
  /** Why the file was ignored (it exists but does not parse), or `undefined`. */
  readonly problem?: string;
  readonly exists: boolean;
}

const parsePins = (text: string | undefined): PinsRead => {
  if (text === undefined) return { pins: EMPTY_PINS, exists: false };
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    return {
      pins: EMPTY_PINS,
      exists: true,
      problem: `pins.yaml does not parse: ${String(error)}`,
    };
  }
  const parsed = parsePersisted(LookbackPinsSchema, raw ?? {});
  if (!parsed.success) {
    return {
      pins: EMPTY_PINS,
      exists: true,
      problem: `pins.yaml is invalid: ${parsed.error.message}`,
    };
  }
  return { pins: parsed.data, exists: true };
};

/** Reads `~/.vtc/lookback/pins.yaml`. A missing file means no pins. */
export const readPins = async (vtcHome: string): Promise<PinsRead> =>
  parsePins(await readTextIfExists(pinsPath(vtcHome)));

export interface PromptSelection {
  /** The version the dispatch runs; `role.dispatched` records its `editable_sha256`. */
  readonly ref: PromptVersionRef;
  /** The editable section the task pack renders first (reading 102). */
  readonly editable: string;
  readonly source: "default" | "pin" | "canary";
  /** Under a canary: the task's sticky arm (`lookback.canary_assigned`, `role.dispatched.canary_arm`). */
  readonly canary?: {
    readonly arm: "candidate" | "baseline";
    readonly candidate: string;
    readonly baseline: string;
  };
  /** A pin or canary that could not be honoured (its version file is missing or does not verify). */
  readonly problem?: string;
}

/**
 * The prompt version a dispatch runs: the task's canary arm when a canary covers the target, else
 * the human's pin, else the compiled default. Pins come from the VTC home only.
 */
export const selectPromptVersion = async (input: {
  readonly vtcHome: string;
  readonly repoKey: string;
  readonly target: PinTarget;
  readonly task?: string | undefined;
  /** The role's locked core and compiled default editable section (`splitRolePrompt`). */
  readonly locked: string;
  readonly defaultEditable: string;
}): Promise<PromptSelection> => {
  const fallback = promptVersionRef({
    ...input.target,
    locked: input.locked,
    editable: input.defaultEditable,
  });
  const byDefault = (problem?: string): PromptSelection => ({
    ref: fallback,
    editable: input.defaultEditable.trim(),
    source: "default",
    ...(problem === undefined ? {} : { problem }),
  });
  const { pins, problem } = await readPins(input.vtcHome);
  if (problem !== undefined) return byDefault(problem);
  const project = pins.projects[input.repoKey];
  if (project === undefined) return byDefault();

  const canary =
    input.task === undefined
      ? undefined
      : project.canaries.find((c) => sameTarget(c, input.target));
  const pin = project.pins.find((p) => sameTarget(p, input.target));
  let wanted: string;
  let source: PromptSelection["source"];
  let arm: "candidate" | "baseline" | undefined;
  if (canary !== undefined && input.task !== undefined) {
    arm = canaryArmFor(input.repoKey, input.task);
    wanted = arm === "candidate" ? canary.candidate : canary.baseline;
    source = "canary";
  } else if (pin !== undefined) {
    wanted = pin.effective_sha256;
    source = "pin";
  } else {
    return byDefault();
  }
  const canaryInfo =
    canary !== undefined && arm !== undefined
      ? { canary: { arm, candidate: canary.candidate, baseline: canary.baseline } }
      : {};
  if (wanted === fallback.effective_sha256) {
    return { ref: fallback, editable: input.defaultEditable.trim(), source, ...canaryInfo };
  }
  const version = await loadPromptVersion(input.vtcHome, input.target, wanted, input.locked);
  if (version === undefined) {
    return byDefault(
      `the ${source} names version ${wanted.slice(0, 8)}, whose file is missing or does not verify against the current locked core`,
    );
  }
  return {
    ref: promptVersionRef({ ...input.target, locked: input.locked, editable: version.editable }),
    editable: version.editable,
    source,
    ...canaryInfo,
  };
};

/**
 * Proves an engine write of the pins file changed nothing but one canary rollback: the pins are
 * unchanged, exactly one canary is gone, and exactly one `auto_rollback` entry by the engine was
 * appended for that canary. Throws otherwise.
 */
export const checkEngineWrite = (before: LookbackPins, after: LookbackPins): void => {
  const fail = (why: string): never => {
    throw new Error(`the engine may only roll a canary back: ${why}`);
  };
  if (after.history.length !== before.history.length + 1) fail("history must grow by one entry");
  if (JSON.stringify(after.history.slice(0, -1)) !== JSON.stringify(before.history))
    fail("history was edited");
  const added = after.history.at(-1);
  if (added?.gesture !== "auto_rollback" || added.by !== "engine")
    fail("the new entry is not an engine auto_rollback");
  const keys = new Set([...Object.keys(before.projects), ...Object.keys(after.projects)]);
  let removed = 0;
  for (const key of keys) {
    const b = before.projects[key];
    const a = after.projects[key];
    if (b === undefined || a === undefined) fail("a project was added or removed");
    if (JSON.stringify(a?.pins) !== JSON.stringify(b?.pins)) fail("pins changed");
    const left = (b?.canaries ?? []).filter(
      (c) => !(a?.canaries ?? []).some((x) => JSON.stringify(x) === JSON.stringify(c)),
    );
    if ((a?.canaries.length ?? 0) + left.length !== (b?.canaries.length ?? 0))
      fail("a canary was added or changed");
    for (const gone of left) {
      removed += 1;
      if (
        added?.repo_key !== key ||
        !sameTarget(gone, added) ||
        added.from !== gone.candidate ||
        added.to !== gone.baseline
      ) {
        fail("the history entry does not describe the removed canary");
      }
    }
  }
  if (removed !== 1) fail("exactly one canary must be removed");
};

/**
 * Rolls a canary back (§13 step 6): removes it from the project and records an `auto_rollback`
 * by the engine, holding the pins lock. Returns the `lookback.rolled_back` draft, or `undefined`
 * when there is no such canary, the pins file cannot be read safely or the lock stays held (the
 * file is then left untouched).
 */
export const autoRollback = async (input: {
  readonly vtcHome: string;
  readonly repoKey: string;
  readonly target: PinTarget;
  readonly reason: string;
  readonly now: Date;
}): Promise<LookbackEventDraft | undefined> => {
  // Every writer of pins.yaml takes `LOOKBACK_HOME.pinsLock` (spine §5 reading 128), the cli's
  // gestures included. The file is still replaced only if it holds the bytes this rollback read,
  // so a writer that skipped the lock is never overwritten either.
  const held = await withFileLock(
    join(input.vtcHome, LOOKBACK_HOME.pinsLock),
    { staleMs: LOOKBACK_PINS_LOCK_STALE_MS, waitMs: PINS_LOCK_WAIT_MS },
    async () => {
      for (let attempt = 0; attempt < PINS_WRITE_ATTEMPTS; attempt += 1) {
        const text = await readTextIfExists(pinsPath(input.vtcHome));
        const step = rollbackStep(parsePins(text), input);
        if (step === undefined) return undefined;
        if (await writeAtomicIfUnchanged(pinsPath(input.vtcHome), toYaml(step.after), text))
          return step.event;
      }
      return undefined;
    },
  );
  return held?.value;
};

/** How long {@link autoRollback} waits for the pins lock before it leaves the file alone. */
const PINS_LOCK_WAIT_MS = 5_000;

/** Attempts of {@link autoRollback} when pins.yaml keeps changing under it. */
const PINS_WRITE_ATTEMPTS = 3;

const rollbackStep = (
  read: PinsRead,
  input: {
    readonly repoKey: string;
    readonly target: PinTarget;
    readonly reason: string;
    readonly now: Date;
  },
): { readonly after: LookbackPins; readonly event: LookbackEventDraft } | undefined => {
  const { pins: before, problem, exists } = read;
  if (problem !== undefined || !exists) return undefined;
  const project = before.projects[input.repoKey];
  const canary = project?.canaries.find((c) => sameTarget(c, input.target));
  if (project === undefined || canary === undefined) return undefined;
  const reason = input.reason.slice(0, 300);
  const after: LookbackPins = LookbackPinsSchema.parse({
    ...before,
    projects: {
      ...before.projects,
      [input.repoKey]: { ...project, canaries: project.canaries.filter((c) => c !== canary) },
    },
    history: [
      ...before.history,
      {
        role: canary.role,
        ...(canary.mode === undefined ? {} : { mode: canary.mode }),
        host: canary.host,
        at: input.now.toISOString(),
        repo_key: input.repoKey,
        gesture: "auto_rollback",
        from: canary.candidate,
        to: canary.baseline,
        by: "engine",
        reason,
      },
    ],
  });
  checkEngineWrite(before, after);
  return {
    after,
    event: lookbackEvent("lookback.rolled_back", {
      target_role: canary.role,
      ...(canary.mode === undefined ? {} : { target_mode: canary.mode }),
      target_host: canary.host,
      from: canary.candidate,
      to: canary.baseline,
      reason,
    }),
  };
};

/**
 * `lookback.canary_assigned` for a dispatch under a canary (its envelope names the task and the
 * role), or `undefined` when no canary covers it.
 */
export const canaryAssignedEvent = (
  selection: PromptSelection,
  task: string,
  role: string,
): LookbackEventDraft | undefined =>
  selection.canary === undefined
    ? undefined
    : lookbackEvent(
        "lookback.canary_assigned",
        {
          arm: selection.canary.arm,
          candidate: selection.canary.candidate,
          baseline: selection.canary.baseline,
        },
        { task, role },
      );

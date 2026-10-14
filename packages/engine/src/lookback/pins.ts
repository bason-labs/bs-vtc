/**
 * Pins and canaries (AD-21 rules 3 and 7; spine §5 reading 103).
 *
 * - Pins are read only from `~/.vtc/lookback/pins.yaml` (`LookbackPins`, read with
 *   `parsePersisted`). Nothing here takes a repo path, so a `pins.yaml` inside a repo can never
 *   select a prompt.
 * - Only a human promotes or pins (`vtc lookback approve|pin|rollback`, the cli). Since D-cb
 *   (spine §5 reading 196) these gestures are a local canary on one machine: the promotion for
 *   everyone is the human's merge of the bs-vtc PR a replay verdict `improve` opens, delivered in
 *   the next VTC release. The engine's one write is {@link autoRollback} (unchanged): it removes a
 *   canary and appends an `auto_rollback` history entry, and {@link checkEngineWrite} proves that
 *   is all it changed before the file is written.
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
import { statSync } from "node:fs";
import { join } from "node:path";
import {
  parseYaml,
  toYaml,
  type PinnedPrompt,
  type PromptPins,
  type PromptTarget,
} from "../core/index.js";
import { lookbackEvent, type LookbackEventDraft } from "./events.js";
import {
  readTextIfExists,
  readTextIfExistsSync,
  withFileLock,
  writeAtomicIfUnchanged,
} from "./files.js";
import { sameTarget } from "./traces.js";
import { loadPromptVersion, loadPromptVersionSync, promptVersionRef } from "./versions.js";

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

interface SelectInput {
  readonly vtcHome: string;
  readonly repoKey: string;
  readonly target: PinTarget;
  readonly task?: string | undefined;
  /** The role's locked core and compiled default editable section (`splitRolePrompt`). */
  readonly locked: string;
  readonly defaultEditable: string;
}

/** What the pins say before any version file is read: a final selection, or a version to load. */
type Decision =
  | { readonly kind: "done"; readonly selection: PromptSelection }
  | {
      readonly kind: "load";
      readonly wanted: string;
      readonly source: "pin" | "canary";
      readonly canary?: PromptSelection["canary"];
    };

const fallbackRef = (input: SelectInput): PromptVersionRef =>
  promptVersionRef({ ...input.target, locked: input.locked, editable: input.defaultEditable });

const byDefault = (input: SelectInput, problem?: string): PromptSelection => ({
  ref: fallbackRef(input),
  editable: input.defaultEditable.trim(),
  source: "default",
  ...(problem === undefined ? {} : { problem }),
});

const decide = (read: PinsRead, input: SelectInput): Decision => {
  const done = (selection: PromptSelection): Decision => ({ kind: "done", selection });
  if (read.problem !== undefined) return done(byDefault(input, read.problem));
  const project = read.pins.projects[input.repoKey];
  if (project === undefined) return done(byDefault(input));
  const canary =
    input.task === undefined
      ? undefined
      : project.canaries.find((c) => sameTarget(c, input.target));
  const pin = project.pins.find((p) => sameTarget(p, input.target));
  let wanted: string;
  let source: "pin" | "canary";
  let arm: "candidate" | "baseline" | undefined;
  if (canary !== undefined && input.task !== undefined) {
    arm = canaryArmFor(input.repoKey, input.task);
    wanted = arm === "candidate" ? canary.candidate : canary.baseline;
    source = "canary";
  } else if (pin !== undefined) {
    wanted = pin.effective_sha256;
    source = "pin";
  } else {
    return done(byDefault(input));
  }
  const canaryInfo =
    canary !== undefined && arm !== undefined
      ? { canary: { arm, candidate: canary.candidate, baseline: canary.baseline } }
      : {};
  const fallback = fallbackRef(input);
  if (wanted === fallback.effective_sha256) {
    return done({ ref: fallback, editable: input.defaultEditable.trim(), source, ...canaryInfo });
  }
  return { kind: "load", wanted, source, ...canaryInfo };
};

const finish = (
  input: SelectInput,
  decision: Extract<Decision, { kind: "load" }>,
  version: { readonly editable: string } | undefined,
): PromptSelection => {
  if (version === undefined) {
    return byDefault(
      input,
      `the ${decision.source} names version ${decision.wanted.slice(0, 8)}, whose file is missing or does not verify against the current locked core`,
    );
  }
  return {
    ref: promptVersionRef({ ...input.target, locked: input.locked, editable: version.editable }),
    editable: version.editable,
    source: decision.source,
    ...(decision.canary === undefined ? {} : { canary: decision.canary }),
  };
};

/**
 * The prompt version a dispatch runs: the task's canary arm when a canary covers the target, else
 * the human's pin, else the compiled default. Pins come from the VTC home only.
 */
export const selectPromptVersion = async (input: SelectInput): Promise<PromptSelection> => {
  const decision = decide(await readPins(input.vtcHome), input);
  if (decision.kind === "done") return decision.selection;
  return finish(
    input,
    decision,
    await loadPromptVersion(input.vtcHome, input.target, decision.wanted, input.locked),
  );
};

/** Reads `~/.vtc/lookback/pins.yaml` synchronously. */
export const readPinsSync = (vtcHome: string): PinsRead =>
  parsePins(readTextIfExistsSync(pinsPath(vtcHome)));

/**
 * {@link selectPromptVersion}, synchronously, over pins already read (`read`, by default read now):
 * engine core's prompt selector (`PromptPins`) is synchronous.
 */
export const selectPromptVersionSync = (
  input: SelectInput,
  read: PinsRead = readPinsSync(input.vtcHome),
): PromptSelection => {
  const decision = decide(read, input);
  if (decision.kind === "done") return decision.selection;
  return finish(
    input,
    decision,
    loadPromptVersionSync(input.vtcHome, input.target, decision.wanted, input.locked),
  );
};

/** The compiled agent's locked core and default editable section (the plugin carries both). */
export type CompiledPrompt = (
  agent: string,
  host: HostId,
) => { readonly locked: string; readonly editable: string } | undefined;

/**
 * Engine core's prompt selector (`Engine.setPromptPins`, AD-21 rules 1–3 and 7; spine §5 reading
 * 135(d)) over {@link selectPromptVersionSync}. Pins are read from the VTC home only, once per
 * change of `pins.yaml` (its size and modification time), so a gesture of the cli takes effect at
 * the next dispatch. It returns `null` for the compiled default (core then renders the default
 * itself), the selection for a pin or a canary arm, and throws when a pin or canary cannot be
 * honoured (a broken pins file, a missing or unverifiable version file): core then runs the
 * compiled default and records a `prompt_selection` incident.
 */
export const createPromptPins = (input: {
  readonly vtcHome: string;
  readonly repoKey: string;
  readonly compiled: CompiledPrompt;
}): PromptPins => {
  let cached: { readonly stamp: string; readonly read: PinsRead } | null = null;
  const pins = (): PinsRead => {
    const stamp = ((): string => {
      try {
        const st = statSync(pinsPath(input.vtcHome));
        return `${String(st.ino)}:${String(st.size)}:${String(st.mtimeMs)}`;
      } catch {
        return "missing";
      }
    })();
    if (cached?.stamp !== stamp) cached = { stamp, read: readPinsSync(input.vtcHome) };
    return cached.read;
  };
  return (target: PromptTarget): PinnedPrompt | null => {
    const compiled = input.compiled(target.agent, target.host);
    if (compiled === undefined) return null;
    const selection = selectPromptVersionSync(
      {
        vtcHome: input.vtcHome,
        repoKey: input.repoKey,
        target: {
          role: target.role,
          ...(target.mode === undefined ? {} : { mode: target.mode }),
          host: target.host,
        },
        task: target.task,
        locked: compiled.locked,
        defaultEditable: compiled.editable,
      },
      pins(),
    );
    if (selection.problem !== undefined) throw new Error(selection.problem);
    if (selection.source === "default") return null;
    return {
      version: selection.ref,
      text: selection.editable,
      ...(selection.canary === undefined ? {} : { canary: selection.canary }),
    };
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
 * by the engine, holding `LOOKBACK_HOME.pinsLock` (reading-128 protocol, spine §5 reading 176)
 * around its read and its {@link writeAtomicIfUnchanged}. Returns the `lookback.rolled_back` draft, or `undefined`
 * when there is no such canary, the pins file cannot be read safely or the lock stays held (the
 * file is then left untouched).
 */
export const autoRollback = async (input: {
  readonly vtcHome: string;
  readonly repoKey: string;
  readonly target: PinTarget;
  readonly reason: string;
  readonly now: Date;
  /** How long to wait for a held pins lock (default {@link PINS_LOCK_WAIT_MS}). */
  readonly lockWaitMs?: number;
}): Promise<LookbackEventDraft | undefined> => {
  // Every writer of pins.yaml takes `LOOKBACK_HOME.pinsLock` (spine §5 reading 128), the cli's
  // gestures included. The file is still replaced only if it holds the bytes this rollback read,
  // so a writer that skipped the lock is never overwritten either.
  const held = await withFileLock(
    join(input.vtcHome, LOOKBACK_HOME.pinsLock),
    { staleMs: LOOKBACK_PINS_LOCK_STALE_MS, waitMs: input.lockWaitMs ?? PINS_LOCK_WAIT_MS },
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

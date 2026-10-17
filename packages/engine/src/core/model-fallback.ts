/**
 * The model id fallback (D-cx; spine §5 reading 244). When a host refuses the model id a run asked
 * for ("model not available" on the user's plan, or similar), its adapter ends the run with
 * `HostOutcome` `error` cause `model_refused`, before any work. The refused attempt is neither a
 * role failure nor a fix round (`state.ts` closes it as stopped on `headless.ended`); the engine
 * appends a {@link ModelRefusalRow} to `<vtcHome>/engines/model-refusals.jsonl` (created 0600,
 * appended, never through a symlink), which `vtc doctor` reads, and dispatches the step once more
 * with no model flag, logging `role.dispatched.model_fallback`. A refusal of that retry is an
 * ordinary error. An id refused within the last day is not asked for again: the dispatch goes
 * straight to the host default, with the same fallback record.
 */
import { dirname, join } from "node:path";
import {
  MODEL_REFUSALS_FILE,
  ModelRefusalRowSchema,
  redactSecrets,
  type HostId,
  type ModelFallback,
  type ModelRefusalRow,
} from "@vtc/shared";
import { appendPrivateFile, ensurePrivateDir, readPrivateFile, writePrivateFile } from "./guard.js";
import type { Kernel, RunHandle } from "./kernel.js";
import type { RoleRunRecord } from "./state.js";

/** How long a refusal stands for the "skip the flag" rule (reading 244: the last day). */
export const MODEL_REFUSAL_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The file is compacted once it holds more rows than this (every dispatch with a model id reads
 * it): the rows of the last day and the latest row per host and model are kept.
 */
export const MODEL_REFUSALS_COMPACT_AT = 200;

/** `<vtcHome>/engines/model-refusals.jsonl`. */
export const modelRefusalsPath = (vtcHome: string): string => join(vtcHome, MODEL_REFUSALS_FILE);

/**
 * The host's message as one trimmed line (`ModelFallback.detail`, at most 300 characters),
 * redacted first (AD-18: host error text can echo environment or config fragments): it goes to the
 * long-lived refusals file and the run log.
 */
export const refusalDetail = (
  message: string,
  secrets: readonly string[] = [],
): string | undefined => {
  const line = redactSecrets(message, secrets).replace(/\s+/g, " ").trim().slice(0, 300).trim();
  return line === "" ? undefined : line;
};

/** Appends one refusal row. Never throws: the row is for `vtc doctor`, the retry does not need it. */
export const recordModelRefusal = (
  k: Pick<Kernel, "deps" | "now">,
  host: HostId,
  model: string,
  detail: string | undefined,
): void => {
  const path = modelRefusalsPath(k.deps.vtcHome);
  try {
    const row = ModelRefusalRowSchema.parse({
      v: 1,
      at: k.now().toISOString(),
      host,
      model,
      ...(detail === undefined ? {} : { detail }),
    });
    ensurePrivateDir(dirname(path));
    appendPrivateFile(path, `${JSON.stringify(row)}\n`);
    const rows = readModelRefusals(k.deps.vtcHome);
    if (rows.length > MODEL_REFUSALS_COMPACT_AT) {
      const kept = compactRefusals(rows, k.now().getTime());
      writePrivateFile(path, kept.map((r) => `${JSON.stringify(r)}\n`).join(""));
    }
  } catch {
    // an unwritable home or a model id the row cannot hold: the fallback still runs
  }
};

/** The rows of the last day, and the latest row of each host and model, oldest first. */
export const compactRefusals = (
  rows: readonly ModelRefusalRow[],
  nowMs: number,
): ModelRefusalRow[] => {
  const latest = new Map<string, ModelRefusalRow>();
  for (const row of rows) latest.set(`${row.host}\0${row.model}`, row);
  const keep = new Set(latest.values());
  return rows.filter((row) => {
    const at = Date.parse(row.at);
    return keep.has(row) || (Number.isFinite(at) && nowMs - at < MODEL_REFUSAL_TTL_MS);
  });
};

/** The refusal rows on file, oldest first; a line that is not a row is skipped. */
export const readModelRefusals = (vtcHome: string): ModelRefusalRow[] => {
  const text = readPrivateFile(modelRefusalsPath(vtcHome));
  if (text === null) return [];
  return text.split("\n").flatMap((line) => {
    if (line.trim() === "") return [];
    try {
      const row = ModelRefusalRowSchema.safeParse(JSON.parse(line));
      return row.success ? [row.data] : [];
    } catch {
      return [];
    }
  });
};

/** The step a dispatch is for, as a role run records it. */
export interface FallbackStep {
  readonly role: string;
  readonly mode?: string | undefined;
  readonly task?: string | undefined;
  readonly feature?: string | undefined;
  readonly subject?: string | undefined;
  /** A replay trial never falls back: it measures its tier. */
  readonly replay?: unknown;
}

const sameStep = (run: RoleRunRecord, step: FallbackStep, host: HostId): boolean =>
  run.role === step.role &&
  run.mode === step.mode &&
  run.task === step.task &&
  run.subject === step.subject &&
  (step.task !== undefined || run.feature === step.feature) &&
  run.host === host;

/**
 * The fallback a dispatch of `step` on `host` takes instead of `model`, or `undefined`: the step's
 * previous run ended refused on this model (the one retry), or the model was refused on this host
 * within the last day ({@link MODEL_REFUSAL_TTL_MS}).
 */
export const modelFallbackFor = (
  k: Pick<Kernel, "deps" | "now">,
  h: RunHandle,
  step: FallbackStep,
  host: HostId,
  model: string | undefined,
): ModelFallback | undefined => {
  if (model === undefined || step.replay !== undefined) return undefined;
  const rows = readModelRefusals(k.deps.vtcHome).filter(
    (r) => r.host === host && r.model === model,
  );
  const fallback = (): ModelFallback => {
    const detail = rows.at(-1)?.detail;
    return {
      requested: model,
      reason: "model_refused",
      ...(detail === undefined ? {} : { detail }),
    };
  };
  const previous = [...h.state.roleRuns.values()].filter((r) => sameStep(r, step, host)).at(-1);
  if (previous?.modelRefused === true && previous.model === model) return fallback();
  const now = k.now().getTime();
  const recent = rows.some((r) => {
    const at = Date.parse(r.at);
    return Number.isFinite(at) && now - at >= 0 && now - at < MODEL_REFUSAL_TTL_MS;
  });
  return recent ? fallback() : undefined;
};

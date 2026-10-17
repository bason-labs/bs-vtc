/**
 * The model ids a host refused on this machine's sign-in (D-cx; spine §5 reading 244; owner:
 * cli+binary team). When Codex refuses a model id, the engine retries the run once on the host
 * default and appends a `ModelRefusalRow` to `<vtcHome>/engines/model-refusals.jsonl`
 * (`MODEL_REFUSALS_FILE`). `vtc doctor` reads that file, read only and never through a link, and
 * reports each (host, model) refused with its last time and the host's detail. A refusal never
 * fails a role, so these lines are `info`. Lines that do not parse are skipped and counted.
 */
import { lstatSync } from "node:fs";
import { join } from "node:path";
import {
  MODEL_REFUSALS_FILE,
  ModelRefusalRowSchema,
  parsePersisted,
  type HostId,
} from "@vtc/shared";
import type { DoctorCheck } from "./doctor-checks.js";
import { printable } from "./human-gesture.js";
import { readRegularFile } from "./lookback-pins.js";

/** One (host, model) the host refused: how often, the last time, and that time's detail. */
export interface RefusedModel {
  readonly host: HostId;
  readonly model: string;
  readonly last: string;
  readonly times: number;
  readonly detail?: string;
}

export type ModelRefusalsRead =
  | { readonly kind: "none" }
  | { readonly kind: "unreadable"; readonly path: string }
  | {
      readonly kind: "read";
      readonly path: string;
      readonly refused: readonly RefusedModel[];
      readonly skipped: number;
    };

const exists = (path: string): boolean => {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
};

const parseLine = (line: string): unknown => {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
};

/** The refusals the engine recorded under `vtcHome`, one entry per (host, model), sorted. */
export const readModelRefusals = (vtcHome: string): ModelRefusalsRead => {
  const path = join(vtcHome, MODEL_REFUSALS_FILE);
  if (!exists(path)) return { kind: "none" };
  const bytes = readRegularFile(path);
  if (bytes === undefined) return { kind: "unreadable", path };
  const latest = new Map<string, RefusedModel>();
  let skipped = 0;
  for (const line of bytes.toString("utf8").split("\n")) {
    if (line.trim() === "") continue;
    const parsed = parsePersisted(ModelRefusalRowSchema, parseLine(line));
    if (!parsed.success) {
      skipped += 1;
      continue;
    }
    const row = parsed.data;
    const key = `${row.host}\u0000${row.model}`;
    const seen = latest.get(key);
    const newer = seen === undefined || Date.parse(row.at) >= Date.parse(seen.last);
    latest.set(
      key,
      newer
        ? {
            host: row.host,
            model: row.model,
            last: row.at,
            times: (seen?.times ?? 0) + 1,
            ...(row.detail === undefined ? {} : { detail: row.detail }),
          }
        : { ...seen, times: seen.times + 1 },
    );
  }
  const refused = [...latest.values()].sort((a, b) =>
    a.host !== b.host
      ? a.host < b.host
        ? -1
        : 1
      : a.model < b.model
        ? -1
        : a.model > b.model
          ? 1
          : 0,
  );
  return { kind: "read", path, refused, skipped };
};

/** `vtc doctor`'s lines for the refused model ids; nothing when none was refused. */
export const checkModelRefusals = (read: ModelRefusalsRead): DoctorCheck[] => {
  if (read.kind === "none") return [];
  if (read.kind === "unreadable")
    return [
      {
        name: "model ids",
        status: "warn",
        detail: `${read.path} is not a regular file, so the refused model ids are not shown`,
      },
    ];
  const checks: DoctorCheck[] = read.refused.map((r) => ({
    name: "model ids",
    status: "info",
    detail: `${r.host} refused ${r.model} (${String(r.times)} time${r.times === 1 ? "" : "s"}, last ${r.last}${
      r.detail === undefined ? "" : `: ${printable(r.detail)}`
    }); its runs fall back to the host default. To choose another id, set hosts.models.${r.host} in .vtc/project.yaml`,
  }));
  if (read.skipped > 0)
    checks.push({
      name: "model ids",
      status: "info",
      detail: `${String(read.skipped)} line(s) of ${read.path} do not parse and were skipped`,
    });
  return checks;
};

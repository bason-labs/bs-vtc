/**
 * Reading persisted, git-shared data across vtc versions (AD-3 rule 2). Writers validate
 * strictly: an unknown key is an error, so no producer can invent a field. Teammates' clones run
 * other vtc versions (D8), and a newer MINOR version may add optional fields, so readers of
 * persisted data (event logs, `project.yaml`, `gates.yml`, evidence bundles, traceability
 * reports, test inventories, discovery and allowlist files) use {@link parsePersisted}: it drops
 * keys the reader does not know, reports where, and otherwise applies every rule of the schema.
 */
import type { z } from "zod";

export type PersistedParse<T> =
  | {
      readonly success: true;
      readonly data: T;
      /** Dotted paths of the unknown keys that were dropped, e.g. `data.task.note`. */
      readonly stripped: readonly string[];
    }
  | { readonly success: false; readonly error: z.ZodError };

type Path = readonly PropertyKey[];

const unknownKeysOf = (issue: z.core.$ZodIssue): { path: Path; keys: string[] } | null =>
  issue.code === "unrecognized_keys" ? { path: issue.path, keys: issue.keys } : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A copy of `value` without `keys` at `path`; other branches are shared, never mutated. */
const without = (value: unknown, path: Path, keys: readonly string[]): unknown => {
  if (path.length === 0) {
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k)));
  }
  const [head, ...rest] = path;
  if (Array.isArray(value) && typeof head === "number") {
    return (value as unknown[]).map((item, i) => (i === head ? without(item, rest, keys) : item));
  }
  if (isRecord(value) && typeof head === "string" && Object.hasOwn(value, head)) {
    return { ...value, [head]: without(value[head], rest, keys) };
  }
  return value;
};

/** Upper bound on strip passes; each pass removes every unknown key Zod reported. */
const MAX_PASSES = 8;

/**
 * Parses persisted data written by this or a newer MINOR version: unknown keys are dropped (and
 * listed in `stripped`), every other rule still applies. Any issue other than an unknown key
 * fails, exactly as `schema.safeParse` would.
 */
export const parsePersisted = <S extends z.ZodType>(
  schema: S,
  raw: unknown,
): PersistedParse<z.infer<S>> => {
  let value = raw;
  const stripped: string[] = [];
  for (let pass = 0; ; pass += 1) {
    const result = schema.safeParse(value);
    if (result.success) return { success: true, data: result.data, stripped };
    const unknown = result.error.issues.map(unknownKeysOf);
    if (pass === MAX_PASSES || unknown.some((u) => u === null)) {
      return { success: false, error: result.error };
    }
    for (const u of unknown) {
      if (u === null) continue;
      value = without(value, u.path, u.keys);
      for (const key of u.keys) stripped.push([...u.path, key].map(String).join("."));
    }
  }
};

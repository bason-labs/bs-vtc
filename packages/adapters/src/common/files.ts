/** File helpers for `install`: atomic writes, careful edits of the user's own config files. */
import { randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "./json.js";

const tempSibling = (path: string): string =>
  join(dirname(path), `.${randomBytes(6).toString("hex")}.vtc-tmp`);

/** Writes `text` to `path` through a temp file and a rename, so a reader never sees half a file. */
export const writeFileAtomic = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  const temp = tempSibling(path);
  try {
    writeFileSync(temp, text, "utf8");
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
};

export const readTextOrNull = (path: string): string | null =>
  existsSync(path) ? readFileSync(path, "utf8") : null;

/**
 * A JSON settings file as an object: `{}` when it does not exist. Throws when it exists but is
 * not a JSON object, so `install` never overwrites a file it cannot read back.
 */
export const readJsonSettings = (path: string): Record<string, unknown> => {
  const raw = readTextOrNull(path);
  if (raw === null || raw.trim() === "") return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`${path} is not valid JSON; fix or remove it, then install again`);
  }
  if (!isRecord(value)) throw new Error(`${path} is not a JSON object; refusing to edit it`);
  return value;
};

export const writeJson = (path: string, value: unknown): void => {
  writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
};

/**
 * Replaces the directory `target` with a copy of `source`: copied next to it first, then swapped
 * in, so a failed copy leaves the previous install in place.
 */
export const replaceDirectory = (source: string, target: string): void => {
  mkdirSync(dirname(target), { recursive: true });
  const staging = tempSibling(target);
  const previous = tempSibling(target);
  try {
    cpSync(source, staging, { recursive: true, dereference: true });
    const hadTarget = existsSync(target);
    if (hadTarget) renameSync(target, previous);
    try {
      renameSync(staging, target);
    } catch (error) {
      if (hadTarget) renameSync(previous, target);
      throw error;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(previous, { recursive: true, force: true });
  }
};

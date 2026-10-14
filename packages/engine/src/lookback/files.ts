/**
 * File helpers for Lookback: atomic writes through a temp file and a rename, whole-line JSONL
 * appends, and reads that treat a missing file as absent.
 */
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";

/** The file's UTF-8 text, or `undefined` when it does not exist. */
export const readTextIfExists = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
};

/** Writes the file through a sibling temp file and a rename. */
export const writeAtomic = async (path: string, data: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, data);
  await rename(temp, path);
};

/** Appends whole JSON lines. */
export const appendJsonLines = async (path: string, values: readonly unknown[]): Promise<void> => {
  if (values.length === 0) return;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, values.map((v) => `${JSON.stringify(v)}\n`).join(""));
};

/** The JSON values of a JSONL file (lines that do not parse are skipped). */
export const readJsonLines = async (path: string): Promise<unknown[]> => {
  const text = await readTextIfExists(path);
  if (text === undefined) return [];
  const values: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      values.push(JSON.parse(line) as unknown);
    } catch {
      // A torn or hand-edited line: skipped, the rest still counts.
    }
  }
  return values;
};

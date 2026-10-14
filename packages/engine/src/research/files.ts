/**
 * Small file helpers for the research module (a leaf, AD-22 rule 1: it shares no code with other
 * engine modules). Writes go through a temp file and a rename, so a crash never leaves a torn
 * blob; JSONL files are appended one whole line at a time.
 */
import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** Lower-case hex SHA-256 of raw bytes. */
export const sha256Bytes = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

const isMissing = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";

/** The file's bytes, or `undefined` when it does not exist. */
export const readBytesIfExists = async (path: string): Promise<Uint8Array | undefined> => {
  try {
    return new Uint8Array(await readFile(path));
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
};

/** The file's UTF-8 text, or `undefined` when it does not exist. */
export const readTextIfExists = async (path: string): Promise<string | undefined> => {
  const bytes = await readBytesIfExists(path);
  return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
};

/** Writes the file through a sibling temp file and a rename. */
export const writeAtomic = async (path: string, data: Uint8Array | string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, data);
  await rename(temp, path);
};

/** Appends whole lines (each must end without a newline; one is added). */
export const appendLines = async (path: string, lines: readonly string[]): Promise<void> => {
  if (lines.length === 0) return;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, lines.map((line) => `${line}\n`).join(""));
};

/** Parsed JSON values of a JSONL text, with the 1-based numbers of lines that did not parse. */
export const parseJsonLines = (
  text: string,
): {
  readonly values: { readonly line: number; readonly value: unknown }[];
  readonly invalid: number[];
} => {
  const values: { line: number; value: unknown }[] = [];
  const invalid: number[] = [];
  text.split("\n").forEach((raw, index) => {
    if (raw.trim() === "") return;
    try {
      values.push({ line: index + 1, value: JSON.parse(raw) as unknown });
    } catch {
      invalid.push(index + 1);
    }
  });
  return { values, invalid };
};

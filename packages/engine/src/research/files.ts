/**
 * Small file helpers for the research module (a leaf, AD-22 rule 1: it shares no code with other
 * engine modules). Writes go through a temp file and a rename, so a crash never leaves a torn
 * blob; JSONL files are appended one whole line at a time.
 */
import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
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

/**
 * An append-only JSONL file read incrementally: each {@link JsonlTail.read} parses only the whole
 * lines appended since the last one (a torn last line waits for its newline), and starts over when
 * the file shrank or was replaced. Other processes may append to the same file meanwhile. Reads
 * of one instance run one at a time: overlapping reads would each start at the same offset and
 * each advance it, skipping the lines appended after.
 */
export class JsonlTail {
  private offset = 0;
  private identity: string | undefined;
  /** The read in flight (settled when none is); the next read starts after it. */
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  /** The JSON values of the lines appended since the last read; `reset` when it starts over. */
  read(): Promise<{ readonly reset: boolean; readonly values: readonly unknown[] }> {
    const next = this.pending.then(
      () => this.readNow(),
      () => this.readNow(),
    );
    this.pending = next.catch(() => undefined);
    return next;
  }

  private async readNow(): Promise<{
    readonly reset: boolean;
    readonly values: readonly unknown[];
  }> {
    let handle;
    try {
      handle = await open(this.path, "r");
    } catch (error) {
      if (!isMissing(error)) throw error;
      const reset = this.offset !== 0;
      this.offset = 0;
      this.identity = undefined;
      return { reset, values: [] };
    }
    try {
      const info = await handle.stat();
      const identity = `${String(info.dev)}:${String(info.ino)}`;
      let reset = false;
      if (identity !== this.identity || info.size < this.offset) {
        reset = this.identity !== undefined || this.offset !== 0;
        this.offset = 0;
        this.identity = identity;
      }
      if (info.size === this.offset) return { reset, values: [] };
      const buffer = new Uint8Array(info.size - this.offset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, this.offset);
      const chunk = buffer.subarray(0, bytesRead);
      const end = chunk.lastIndexOf(0x0a);
      if (end === -1) return { reset, values: [] };
      this.offset += end + 1;
      const text = new TextDecoder().decode(chunk.subarray(0, end + 1));
      return { reset, values: parseJsonLines(text).values.map((v) => v.value) };
    } finally {
      await handle.close();
    }
  }
}

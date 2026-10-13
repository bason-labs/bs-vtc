/** Helpers the cli+binary team's commands share: argument parsing, errors, stdin. */
import { parseArgs } from "node:util";
import { UsageError } from "../repo.js";
import type { CommandContext } from "./types.js";

/** Exit codes: 0 done, 1 failed, 64 bad usage (sysexits `EX_USAGE`). */
export const EXIT = { ok: 0, failed: 1, usage: 64 } as const;

type Options = NonNullable<Parameters<typeof parseArgs>[0]>["options"];

/** Strict `parseArgs`: an unknown flag or a missing value throws a {@link UsageError}. */
export const parseFlags = <O extends NonNullable<Options>>(
  args: readonly string[],
  options: O,
  allowPositionals = false,
) => {
  try {
    return parseArgs({ args: [...args], options, strict: true, allowPositionals });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
};

/** Runs a command body, turning a thrown error into a one-line message and an exit code. */
export const guarded = async (
  name: string,
  ctx: CommandContext,
  body: () => Promise<number>,
): Promise<number> => {
  try {
    return await body();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.io.err(`vtc ${name}: ${message}`);
    return error instanceof UsageError ? EXIT.usage : EXIT.failed;
  }
};

/**
 * Reads stdin up to `maxBytes`. Resolves `null` when there is more (the caller fails open or
 * refuses), and whatever arrived when `timeoutMs` passes first.
 */
export const readStdin = (maxBytes: number, timeoutMs: number): Promise<string | null> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.stdin.pause();
      process.stdin.removeAllListeners("data");
      resolve(value);
    };
    const timer = setTimeout(() => {
      finish(Buffer.concat(chunks).toString("utf8"));
    }, timeoutMs);
    if (process.stdin.isTTY) {
      finish("");
      return;
    }
    process.stdin.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) finish(null);
      else chunks.push(chunk);
    });
    process.stdin.once("end", () => {
      finish(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.once("error", () => {
      finish(null);
    });
  });

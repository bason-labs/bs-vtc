/**
 * How the visual step runs its runner script (AD-24 rule 1): as one gate command in the gate
 * sandbox (`GateCommandJail`), verify phase, with the project's Node, allowed by name like a
 * pinned scanner (it is VTC's own script, never repo content). The script and its input go into
 * the command's private temp directory; its result and images come back from there and are
 * read as untrusted data (regular files only, bounded, schema-checked). Tests inject a fake
 * {@link VisualRunner} and never start a browser.
 */
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GateCommandJail } from "../sandbox.js";
import {
  RUNNER_INPUT_FILE,
  RUNNER_OUT_DIR,
  RUNNER_RESULT_FILE,
  RUNNER_SCRIPT_FILE,
  RunnerResultSchema,
  type RunnerInput,
  type RunnerResult,
} from "./protocol.js";
import { VISUAL_RUNNER_SCRIPT } from "./runner-script.js";

export interface VisualRunnerCall {
  /** The input without `out_dir`, which the runner sets to its own output directory. */
  readonly input: Omit<RunnerInput, "out_dir">;
  /** Absolute directories the script must read (Playwright's browser store or cache). */
  readonly allowRead: readonly string[];
  /** The app server listens on the loopback. */
  readonly loopback: boolean;
  /** The scrubbed gate environment, plus `PLAYWRIGHT_BROWSERS_PATH`. */
  readonly env: Readonly<Record<string, string>>;
  /** Absolute verification checkout (the command's working directory). */
  readonly checkout: string;
  readonly timeoutMs: number;
  /** Raw logs under `.vtc/state/` (absolute). */
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

export type VisualRunnerOutcome =
  | {
      readonly ok: true;
      readonly result: RunnerResult;
      /** One output file by the name the result gives it; `null` when absent or not a plain file. */
      readonly file: (name: string) => Uint8Array | null;
    }
  | { readonly ok: false; readonly reason: string };

export interface VisualRunner {
  run(call: VisualRunnerCall): Promise<VisualRunnerOutcome>;
}

/** Largest output file read back (a full-page screenshot fits). */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const PLAIN_NAME = /^[A-Za-z0-9._-]{1,200}$/;

const readPlain = (path: string, max: number): Uint8Array | null => {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > max) return null;
    return readFileSync(path);
  } catch {
    return null;
  }
};

/** The runner in the gate sandbox; `jail` is `null` when there is no sandbox (nothing runs). */
export const sandboxedVisualRunner = (
  jail: GateCommandJail | null,
  options: { readonly node: string; readonly noSandbox: string },
): VisualRunner => ({
  run: async (call) => {
    if (jail === null) return { ok: false, reason: options.noSandbox };
    let exec;
    try {
      exec = await jail.run({
        phase: "verify",
        ...(call.loopback ? { loopback: true } : {}),
        checkout: call.checkout,
        argv: [
          options.node,
          `{tmp}/${RUNNER_SCRIPT_FILE}`,
          `{tmp}/${RUNNER_INPUT_FILE}`,
          `{tmp}/${RUNNER_RESULT_FILE}`,
        ],
        cwd: call.checkout,
        env: call.env,
        timeoutMs: call.timeoutMs,
        stdoutPath: call.stdoutPath,
        stderrPath: call.stderrPath,
        allowRead: call.allowRead,
        setup: (tmp) => {
          writeFileSync(join(tmp, RUNNER_SCRIPT_FILE), VISUAL_RUNNER_SCRIPT, { mode: 0o600 });
          mkdirSync(join(tmp, RUNNER_OUT_DIR), { mode: 0o700 });
          const input: RunnerInput = { ...call.input, out_dir: join(tmp, RUNNER_OUT_DIR) };
          writeFileSync(join(tmp, RUNNER_INPUT_FILE), JSON.stringify(input), { mode: 0o600 });
        },
      });
    } catch (error) {
      return {
        ok: false,
        reason: `the visual runner could not start in the gate sandbox: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (exec.leftover !== undefined) return { ok: false, reason: exec.leftover };
    if (exec.spawnError !== undefined) {
      return { ok: false, reason: `the visual runner could not start: ${exec.spawnError}` };
    }
    if (exec.timedOut) {
      return {
        ok: false,
        reason: `the visual runner timed out after ${String(Math.round(call.timeoutMs / 1000))} s`,
      };
    }
    const raw = readPlain(join(exec.tempDir, RUNNER_RESULT_FILE), 16 * 1024 * 1024);
    if (raw === null) {
      return {
        ok: false,
        reason: `the visual runner wrote no result (exit ${String(exec.code)}): ${exec.tail.slice(-400)}`,
      };
    }
    let parsed;
    try {
      parsed = RunnerResultSchema.safeParse(JSON.parse(new TextDecoder().decode(raw)));
    } catch {
      return { ok: false, reason: "the visual runner's result is not JSON" };
    }
    if (!parsed.success) {
      return {
        ok: false,
        reason: `the visual runner's result is not valid: ${parsed.error.issues
          .slice(0, 3)
          .map((i) => `${i.path.map(String).join(".")}: ${i.message}`)
          .join("; ")}`,
      };
    }
    const outDir = join(exec.tempDir, RUNNER_OUT_DIR);
    return {
      ok: true,
      result: parsed.data,
      file: (name) =>
        PLAIN_NAME.test(name) ? readPlain(join(outDir, name), MAX_OUTPUT_BYTES) : null,
    };
  },
});

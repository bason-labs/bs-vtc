/**
 * How the visual step runs its runner script (AD-24 rule 1): as one gate command in the gate
 * sandbox (`GateCommandJail`), verify phase, with the project's Node, allowed by name like a
 * pinned scanner (it is VTC's own script, never repo content). The script, its input and a fresh
 * random key go into the command's private temp directory; its result and images come back from
 * there and are read as untrusted data (regular files only, bounded, schema-checked). The app
 * server can write that directory too, so the result is used only when its envelope's HMAC
 * verifies under the key (which the runner deleted before starting the app), and an image only
 * when it matches the SHA-256 the signed result records for it; anything else fails the step as
 * gate infrastructure. Tests inject a fake {@link VisualRunner} and never start a browser.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GateCommandJail } from "../sandbox.js";
import {
  MAX_RUNNER_BODY,
  RunnerEnvelopeSchema,
  RUNNER_INPUT_FILE,
  RUNNER_KEY_FILE,
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

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Why a result without a valid MAC under the run's key is not used. */
const forged =
  "the visual runner's result does not carry a valid MAC under this run's key: something other than the runner wrote it (the app server, or a process it left behind, can write the runner's temp directory), so it is not used";

/** The runner's signed result body, or why there is none. */
const openEnvelope = (raw: Uint8Array, key: Buffer): { body: string } | { reason: string } => {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return { reason: "the visual runner's result is not JSON" };
  }
  const envelope = RunnerEnvelopeSchema.safeParse(value);
  if (!envelope.success) {
    const body = (value as { body?: unknown } | null)?.body;
    return typeof body === "string" && body.length > MAX_RUNNER_BODY
      ? {
          reason: `the visual runner's result is larger than ${String(MAX_RUNNER_BODY / (1024 * 1024))} MiB`,
        }
      : { reason: forged };
  }
  const expected = createHmac("sha256", key).update(envelope.data.body).digest();
  const actual = Buffer.from(envelope.data.mac, "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { reason: forged };
  }
  return { body: envelope.data.body };
};

/** The runner in the gate sandbox; `jail` is `null` when there is no sandbox (nothing runs). */
export const sandboxedVisualRunner = (
  jail: GateCommandJail | null,
  options: { readonly node: string; readonly noSandbox: string },
): VisualRunner => ({
  run: async (call) => {
    if (jail === null) return { ok: false, reason: options.noSandbox };
    const key = randomBytes(32);
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
          `{tmp}/${RUNNER_KEY_FILE}`,
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
          writeFileSync(join(tmp, RUNNER_KEY_FILE), key, { mode: 0o600 });
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
    // Envelope overhead: the body is a JSON string inside JSON (escaped quotes double at most).
    const raw = readPlain(join(exec.tempDir, RUNNER_RESULT_FILE), 2 * MAX_RUNNER_BODY + 4096);
    if (raw === null) {
      return {
        ok: false,
        reason: `the visual runner wrote no result (exit ${String(exec.code)}): ${exec.tail.slice(-400)}`,
      };
    }
    const opened = openEnvelope(raw, key);
    if ("reason" in opened) return { ok: false, reason: opened.reason };
    let parsed;
    try {
      parsed = RunnerResultSchema.safeParse(JSON.parse(opened.body));
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
    const hashes = parsed.data.files;
    // Every image the runner recorded must still be the one it wrote. Too large for evidence is
    // left out (`file` answers null); missing, replaced or changed is tampering.
    for (const [name, digest] of Object.entries(hashes)) {
      let size: number | null = null;
      try {
        const stat = lstatSync(join(outDir, name));
        if (stat.isFile()) size = stat.size;
      } catch {
        // missing
      }
      if (size !== null && size > MAX_OUTPUT_BYTES) continue;
      const bytes = size === null ? null : readPlain(join(outDir, name), MAX_OUTPUT_BYTES);
      if (bytes === null || sha256(bytes) !== digest) {
        return {
          ok: false,
          reason: `the visual runner's output ${name} is not the file the runner wrote (missing or changed after it was written), so the run is not used`,
        };
      }
    }
    return {
      ok: true,
      result: parsed.data,
      file: (name) => {
        const digest = Object.hasOwn(hashes, name) ? hashes[name] : undefined;
        if (!PLAIN_NAME.test(name) || digest === undefined) return null;
        const bytes = readPlain(join(outDir, name), MAX_OUTPUT_BYTES);
        return bytes !== null && sha256(bytes) === digest ? bytes : null;
      },
    };
  },
});

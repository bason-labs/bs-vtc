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
 *
 * The runner itself must stay out of the app server's reach (reading 124), since code running in
 * it could sign anything: Node runs with `--disable-sigusr1`, so a signal from the app cannot
 * open the inspector; the app runs in a session and process group of its own; the interpreter is
 * an absolute `node` outside the repository ({@link resolveNodeExecutable}), never one the
 * checkout supplies; and on Linux, where a same-user process may read another's memory through
 * ptrace unless Yama restricts it to descendants, a render with an app server runs only with
 * `kernel.yama.ptrace_scope` 1 or higher; otherwise nothing runs and the step is `skipped`
 * with {@link LINUX_PTRACE_REFUSAL} (reading 164, D-bj).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, isAbsolute, join, relative, sep } from "node:path";
import type { z } from "zod";
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
  /**
   * The loopback port the app server listens on (the only one the sandbox opens), or `null`: no
   * socket at all (the probe).
   */
  readonly loopbackPort: number | null;
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
  | {
      readonly ok: false;
      readonly reason: string;
      /**
       * Nothing ran, on purpose, for a reason a human fixes on the host: the step is `skipped`
       * with `reason`, not `error` (Linux `ptrace_scope` 0, reading 164). Absent: `error`.
       */
      readonly skipped?: true;
    };

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
const forgedBy = (label: string): string =>
  `the ${label}'s result does not carry a valid MAC under this run's key: something other than the runner wrote it (the app server, or a process it left behind, can write the runner's temp directory), so it is not used`;

/** The runner's signed result body, or why there is none. */
const openEnvelope = (
  raw: Uint8Array,
  key: Buffer,
  label: string,
): { body: string } | { reason: string } => {
  const forged = forgedBy(label);
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return { reason: `the ${label}'s result is not JSON` };
  }
  const envelope = RunnerEnvelopeSchema.safeParse(value);
  if (!envelope.success) {
    const body = (value as { body?: unknown } | null)?.body;
    return typeof body === "string" && body.length > MAX_RUNNER_BODY
      ? {
          reason: `the ${label}'s result is larger than ${String(MAX_RUNNER_BODY / (1024 * 1024))} MiB`,
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

/** The Node flag that keeps a signal from opening the runner's inspector (Node 22.14 or later). */
export const DISABLE_SIGUSR1 = "--disable-sigusr1";

/**
 * Why no render runs on a Linux host whose ptrace policy lets the app server reach the runner:
 * the step's `skipped_reason` (reading 164, D-bj). A visible note at Levels 1–2; never a Level-3
 * pass, since that item counts only `pass` (reading 105).
 */
export const LINUX_PTRACE_REFUSAL =
  "the visual step does not render on this Linux host: kernel.yama.ptrace_scope is 0 or absent, so the app server (project code in the runner's sandbox, as the same user) could attach to the runner and sign any result; set kernel.yama.ptrace_scope to 1 or higher (sysctl) to run it";

/** Why no runner runs without an interpreter VTC can trust. */
export const NO_RUNNER_NODE =
  "no node executable for the visual runner: none was found on an absolute PATH entry outside the repository (a relative PATH entry, or one inside the checkout, would let the change under review supply it)";

const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
};

const realOrNull = (path: string): string | null => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

/**
 * The interpreter running the engine, when it is Node with `--disable-sigusr1` (22.14 or later,
 * 23.7 or later): an absolute binary the engine already trusts, picked before anything on `PATH`.
 * `null` under Bun (the release binary) or an older Node.
 */
export const engineNodeExecutable = (
  versions: NodeJS.ProcessVersions = process.versions,
  execPath: string = process.execPath,
): string | null => {
  if (versions.bun !== undefined || !isAbsolute(execPath)) return null;
  const [major = 0, minor = 0] = versions.node.split(".").map(Number);
  const supported = major >= 24 || (major === 23 && minor >= 7) || (major === 22 && minor >= 14);
  return supported ? execPath : null;
};

/**
 * The absolute `node` the visual runner runs with: `preferred` (the engine's own Node,
 * {@link engineNodeExecutable}) when it lies outside every one of `exclude` (the repository and
 * the verification checkout), else the first executable `node` on an absolute `PATH` entry that,
 * followed through symbolic links, lies outside them. `null` when there is none.
 *
 * Known limit: a version-manager shim on `PATH` (Volta, asdf, mise) is accepted like any `node`
 * outside the repository, and such a shim picks its interpreter, and with mise an environment,
 * from config files in its working directory, the checkout under review. An interpreter without
 * `--disable-sigusr1` fails closed (`error`), but a trusted mise config could still set
 * `NODE_OPTIONS` for the runner. Preferring the engine's own Node avoids the shim in development.
 */
export const resolveNodeExecutable = (
  path: string | undefined,
  exclude: readonly string[],
  preferred: string | null = null,
): string | null => {
  const roots = exclude.flatMap((root) => [root, realOrNull(root) ?? root]);
  const outside = (p: string): boolean => !roots.some((root) => inside(root, p));
  const usable = (candidate: string): boolean => {
    const real = realOrNull(candidate);
    if (real === null || !outside(real)) return false;
    try {
      if (!statSync(real).isFile()) return false;
      accessSync(real, constants.X_OK);
    } catch {
      return false;
    }
    return true;
  };
  if (preferred !== null && isAbsolute(preferred) && outside(preferred) && usable(preferred)) {
    return preferred;
  }
  for (const dir of (path ?? "").split(delimiter)) {
    if (dir === "" || !isAbsolute(dir) || !outside(dir)) continue;
    const candidate = join(dir, "node");
    if (usable(candidate)) return candidate;
  }
  return null;
};

/** `kernel.yama.ptrace_scope` of this host, or `null` when the kernel has no Yama. */
export const readPtraceScope = (): string | null => {
  try {
    return readFileSync("/proc/sys/kernel/yama/ptrace_scope", "utf8").trim();
  } catch {
    return null;
  }
};

export interface SandboxedVisualRunnerOptions {
  /** Absolute interpreter ({@link resolveNodeExecutable}); `null`: none found, nothing runs. */
  readonly node: string | null;
  readonly noSandbox: string;
  /** Test seams: the host platform and its ptrace policy. */
  readonly platform?: NodeJS.Platform;
  readonly ptraceScope?: () => string | null;
}

/** One run of a VTC-written runner script in the gate sandbox ({@link runSignedScript}). */
export interface SignedScriptCall {
  /** The script's source, written to the command's private temp directory. */
  readonly script: string;
  /** What the script names itself in reasons: "visual runner", "evidence runner". */
  readonly label: string;
  /** The JSON input without `out_dir`, which is set to the script's own output directory. */
  readonly input: object;
  readonly allowRead: readonly string[];
  readonly loopbackPort: number | null;
  readonly env: Readonly<Record<string, string>>;
  readonly checkout: string;
  readonly timeoutMs: number;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  /** Called with the private temp directory after the script, input and key are written. */
  readonly setup?: (tempDir: string) => void;
}

export type SignedScriptOutcome<R> =
  | {
      readonly ok: true;
      readonly result: R;
      readonly file: (name: string) => Uint8Array | null;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Runs a VTC-written runner script (`node --disable-sigusr1 <script> <input> <result> <key>`) as
 * one verify-phase command in `jail` and reads back its signed result (AD-24 rule 1): the
 * envelope's HMAC must verify under the run's fresh key and every output file must match the
 * SHA-256 the signed result records for it (`files`); anything else is a reason, never a result.
 * Shared by the visual step and the evidence recorder (AD-27 rule 6).
 */
export const runSignedScript = async <R extends { readonly files: Record<string, string> }>(
  jail: GateCommandJail,
  node: string,
  call: SignedScriptCall,
  schema: z.ZodType<R>,
): Promise<SignedScriptOutcome<R>> => {
  const { label } = call;
  const key = randomBytes(32);
  let exec;
  try {
    exec = await jail.run({
      phase: "verify",
      ...(call.loopbackPort === null ? {} : { loopbackPorts: [call.loopbackPort] }),
      checkout: call.checkout,
      argv: [
        node,
        DISABLE_SIGUSR1,
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
        writeFileSync(join(tmp, RUNNER_SCRIPT_FILE), call.script, { mode: 0o600 });
        mkdirSync(join(tmp, RUNNER_OUT_DIR), { mode: 0o700 });
        const input = { ...call.input, out_dir: join(tmp, RUNNER_OUT_DIR) };
        writeFileSync(join(tmp, RUNNER_INPUT_FILE), JSON.stringify(input), { mode: 0o600 });
        writeFileSync(join(tmp, RUNNER_KEY_FILE), key, { mode: 0o600 });
        call.setup?.(tmp);
      },
    });
  } catch (error) {
    return {
      ok: false,
      reason: `the ${label} could not start in the gate sandbox: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (exec.leftover !== undefined) return { ok: false, reason: exec.leftover };
  if (exec.spawnError !== undefined) {
    return { ok: false, reason: `the ${label} could not start: ${exec.spawnError}` };
  }
  if (exec.timedOut) {
    return {
      ok: false,
      reason: `the ${label} timed out after ${String(Math.round(call.timeoutMs / 1000))} s`,
    };
  }
  // Envelope overhead: the body is a JSON string inside JSON (escaped quotes double at most).
  const raw = readPlain(join(exec.tempDir, RUNNER_RESULT_FILE), 2 * MAX_RUNNER_BODY + 4096);
  if (raw === null && exec.tail.includes(`bad option: ${DISABLE_SIGUSR1}`)) {
    return {
      ok: false,
      reason: `the ${label} needs Node 22.14 or later (for ${DISABLE_SIGUSR1}, which keeps the app server from opening its inspector): ${exec.tail.slice(-300)}`,
    };
  }
  if (raw === null) {
    return {
      ok: false,
      reason: `the ${label} wrote no result (exit ${String(exec.code)}): ${exec.tail.slice(-400)}`,
    };
  }
  const opened = openEnvelope(raw, key, label);
  if ("reason" in opened) return { ok: false, reason: opened.reason };
  let parsed;
  try {
    parsed = schema.safeParse(JSON.parse(opened.body));
  } catch {
    return { ok: false, reason: `the ${label}'s result is not JSON` };
  }
  if (!parsed.success) {
    return {
      ok: false,
      reason: `the ${label}'s result is not valid: ${parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.map(String).join(".")}: ${i.message}`)
        .join("; ")}`,
    };
  }
  const outDir = join(exec.tempDir, RUNNER_OUT_DIR);
  const hashes = parsed.data.files;
  // Every file the runner recorded must still be the one it wrote. Too large for evidence is
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
        reason: `the ${label}'s output ${name} is not the file the runner wrote (missing or changed after it was written), so the run is not used`,
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
};

/** The runner in the gate sandbox; `jail` is `null` when there is no sandbox (nothing runs). */
export const sandboxedVisualRunner = (
  jail: GateCommandJail | null,
  options: SandboxedVisualRunnerOptions,
): VisualRunner => ({
  run: async (call) => {
    if (jail === null) return { ok: false, reason: options.noSandbox };
    const node = options.node;
    if (node === null || !isAbsolute(node)) return { ok: false, reason: NO_RUNNER_NODE };
    if (call.input.app !== null && (options.platform ?? process.platform) === "linux") {
      const scope = Number((options.ptraceScope ?? readPtraceScope)() ?? "0");
      if (!(scope >= 1)) return { ok: false, skipped: true, reason: LINUX_PTRACE_REFUSAL };
    }
    return runSignedScript(
      jail,
      node,
      { ...call, script: VISUAL_RUNNER_SCRIPT, label: "visual runner" },
      RunnerResultSchema,
    );
  },
});

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The temp root's name prefix: short, so a test's Unix socket path under it still fits (AD-12). */
export const TEST_TMP_PREFIX = "vt.";

/**
 * The longest Unix socket path VTC binds (`UNIX_SOCKET_MAX_BYTES` in `@vtc/shared`, which this
 * global setup cannot import before the packages are built; the arch test checks they agree).
 */
export const TEST_SOCKET_MAX_BYTES = 100;

/**
 * The deepest socket path a test binds under the temp root (engine and cli tests: a VTC home
 * `vh-XXXXXX` with `run/<16 hex>.sock`, AD-12), with the root's own name.
 */
export const deepestTestSocket = (base: string): string =>
  join(base, `${TEST_TMP_PREFIX}XXXXXX`, "vh-XXXXXX", "run", `${"0".repeat(16)}.sock`);

const KEYS = ["TMPDIR", "TMP", "TEMP"] as const;

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

/**
 * Where the test run's temp root goes: the OS temp directory, unless a test socket under it would
 * not fit the Unix socket limit (macOS's default TMPDIR, `/var/folders/…/T/`, resolves to
 * `/private/var/folders/…`, too long for the daemon tests' sockets): then `/tmp`. Tests resolve
 * their temp directories (`realpath`), so the check does too. Never changes product socket paths.
 */
export const testTmpBase = (
  base: string = tmpdir(),
  platform: string = process.platform,
): string =>
  platform === "win32" || Buffer.byteLength(deepestTestSocket(real(base))) <= TEST_SOCKET_MAX_BYTES
    ? base
    : "/tmp";

/**
 * Vitest global setup shared by every package (D-cz; spine §5 readings 246, 249 and 266): the test
 * run gets its own temp root, short enough for its sockets ({@link testTmpBase}), the workers it
 * starts and the processes they spawn see it as their temp directory, and the run removes it with
 * everything in it when it ends. A test that leaves a temp directory behind can then never pile up
 * in the user's TMPDIR, where tens of thousands of leftovers made every `mkdtemp` slower and
 * engine tests timed out under load; and a run never shares a temp directory with another
 * package's run. Returns the teardown.
 */
export default function setupTestTmpdir(): () => void {
  const previous = KEYS.map((key) => [key, process.env[key]] as const);
  const root = mkdtempSync(join(testTmpBase(), TEST_TMP_PREFIX));
  for (const key of KEYS) process.env[key] = root;
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  };
}

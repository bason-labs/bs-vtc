import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The temp root's name prefix: short, so a test's Unix socket path under it still fits (AD-12). */
export const TEST_TMP_PREFIX = "vt.";

const KEYS = ["TMPDIR", "TMP", "TEMP"] as const;

/**
 * Vitest global setup shared by every package (D-cz; spine §5 readings 246 and 249): the test run
 * gets its own temp root under the OS temp directory, the workers it starts and the processes they
 * spawn see it as their temp directory, and the run removes it with everything in it when it ends.
 * A test that leaves a temp directory behind can then never pile up in the user's TMPDIR, where
 * tens of thousands of leftovers made every `mkdtemp` slower and engine tests timed out under
 * load; and a run never shares a temp directory with another package's run. Returns the teardown.
 */
export default function setupTestTmpdir(): () => void {
  const previous = KEYS.map((key) => [key, process.env[key]] as const);
  const root = mkdtempSync(join(tmpdir(), TEST_TMP_PREFIX));
  for (const key of KEYS) process.env[key] = root;
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  };
}

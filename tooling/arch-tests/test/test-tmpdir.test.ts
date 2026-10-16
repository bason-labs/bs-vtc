/**
 * D-cz (spine §5 readings 246 and 249): every package's test run gets its own short temp root,
 * which the run removes when it ends, so a test that leaves a temp directory behind never piles
 * up in the user's TMPDIR (tens of thousands of leftovers there made every mkdtemp slower, and
 * engine tests timed out under load).
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UNIX_SOCKET_MAX_BYTES } from "@vtc/shared";
import { availableParallelism } from "node:os";
import { sharedConfig, testWorkers } from "../../../vitest.shared.ts";
import engineConfig from "../../../packages/engine/vitest.config.ts";
import setupTestTmpdir, {
  deepestTestSocket,
  TEST_SOCKET_MAX_BYTES,
  TEST_TMP_PREFIX,
  testTmpBase,
} from "../../../vitest.tmpdir.ts";

describe("the test run's own temp root (D-cz)", () => {
  it("is every package's global setup", () => {
    const setups: string[] = [sharedConfig.test?.globalSetup ?? []].flat();
    expect(setups.some((s) => s.endsWith("vitest.tmpdir.ts"))).toBe(true);
  });

  it("points TMPDIR at a fresh root, removes it with what tests left there, and restores TMPDIR", () => {
    const outer = mkdtempSync(join(tmpdir(), "vtc-tmpdir-test-"));
    const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
    try {
      process.env.TMPDIR = outer;
      const teardown = setupTestTmpdir();
      const root = tmpdir();
      expect(root.startsWith(join(outer, TEST_TMP_PREFIX))).toBe(true);
      expect(process.env.TMP).toBe(root);
      expect(process.env.TEMP).toBe(root);
      // a test that never cleans up
      const leaked = mkdtempSync(join(tmpdir(), "vtc-leak-"));
      mkdirSync(join(leaked, "deep"), { recursive: true });
      writeFileSync(join(leaked, "deep", "file"), "x");
      teardown();
      expect(existsSync(root)).toBe(false);
      expect(process.env.TMPDIR).toBe(outer);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
      rmSync(outer, { recursive: true, force: true });
    }
  });

  it("keeps a test's socket path under it within the Unix socket limit", () => {
    // engine and cli tests bind `<tmp>/vh-XXXXXX/run/<16 hex>.sock` (AD-12), on the resolved path
    const socket = join(realpathSync(tmpdir()), "vh-XXXXXX", "run", `${"0".repeat(16)}.sock`);
    expect(Buffer.byteLength(socket)).toBeLessThanOrEqual(UNIX_SOCKET_MAX_BYTES);
    expect(TEST_SOCKET_MAX_BYTES).toBe(UNIX_SOCKET_MAX_BYTES);
  });

  it("goes under /tmp when the OS temp directory is too long for a socket (macOS's default, reading 266)", () => {
    const macos = "/var/folders/kt/dz52y9w50rddwtjqj04r501r0000gn/T/";
    expect(Buffer.byteLength(deepestTestSocket(`/private${macos}`))).toBeGreaterThan(
      UNIX_SOCKET_MAX_BYTES,
    );
    // the resolved form, so the check does not depend on this path existing (it does not on Linux)
    expect(testTmpBase(`/private${macos}`, "darwin")).toBe("/tmp");
    expect(testTmpBase(`/private${macos}`, "linux")).toBe("/tmp");
    expect(testTmpBase("/tmp", "darwin")).toBe("/tmp");
    expect(testTmpBase("/scratch/t", "linux")).toBe("/scratch/t");
    expect(testTmpBase("C:\\Users\\me\\AppData\\Local\\Temp", "win32")).toBe(
      "C:\\Users\\me\\AppData\\Local\\Temp",
    );
    expect(Buffer.byteLength(deepestTestSocket(realpathSync("/tmp")))).toBeLessThanOrEqual(
      UNIX_SOCKET_MAX_BYTES,
    );
  });

  it("still makes a fresh root of its own under /tmp, and removes it", () => {
    const saved = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
    try {
      process.env.TMPDIR = `/tmp/${"x".repeat(80)}`;
      const teardown = setupTestTmpdir();
      const root = tmpdir();
      expect(root.startsWith(`/tmp/${TEST_TMP_PREFIX}`)).toBe(true);
      expect(existsSync(root)).toBe(true);
      teardown();
      expect(existsSync(root)).toBe(false);
      expect(process.env.TMPDIR).toBe(`/tmp/${"x".repeat(80)}`);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) Reflect.deleteProperty(process.env, key);
        else process.env[key] = value;
      }
    }
  });
});

describe("the test pools fit the machine together (D-cz, reading 249)", () => {
  // turbo runs every package's tests at once: each vitest sizing its pool to the whole machine
  // (cpus - 1) put about 70 workers on 11 cores, and a pure-CPU adapters test timed out at 5 s
  it("gives each package a quarter of the machine, and the engine (the long pole) all of it", () => {
    const cpus = availableParallelism();
    expect(testWorkers(1)).toBe(Math.max(1, cpus - 1));
    expect(sharedConfig.test?.maxWorkers).toBe(testWorkers(0.25));
    expect(testWorkers(0.25)).toBeLessThanOrEqual(Math.max(1, Math.floor(cpus / 4)));
    const engine = engineConfig as { readonly test?: { readonly maxWorkers?: unknown } };
    expect(engine.test?.maxWorkers).toBe(testWorkers(1));
  });
});

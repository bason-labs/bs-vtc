/**
 * Opt-in (`VTC_LIVE_SANDBOX=1`, macOS with a working sandbox-exec): VTC's own dependency scan in
 * the real verify-phase sandbox. The owner's 2026-10-17 run showed every scan failing: the report
 * was written to the install phase's HOME, which the verify phase (its own empty HOME, spine §5
 * reading 252) may not write. A fake scanner that only writes its `--output` stands in for
 * osv-scanner, so nothing is downloaded.
 */
import { chmodSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  OSV_DB_STAMP,
  detectGateSandbox,
  osvDatabaseDir,
  scanLockfileAdvisories,
} from "../../src/gates/index.js";
import { cleanupDirs, tempDir } from "../helpers/repo.js";

afterEach(cleanupDirs);

const live = process.env.VTC_LIVE_SANDBOX === "1" && detectGateSandbox().kind === "sandbox-exec";

const REPORT = JSON.stringify({
  results: [
    {
      packages: [
        { package: { name: "left-pad", version: "1.0.0" }, vulnerabilities: [{ id: "GHSA-x" }] },
      ],
    },
  ],
});

describe.runIf(live)("VTC's own dependency scan in the live sandbox (opt-in)", () => {
  it("writes and reads its report in the verify phase", async () => {
    const vtcHome = realpathSync(tempDir("vtc-osv-live-"));
    const db = osvDatabaseDir(vtcHome);
    mkdirSync(db);
    writeFileSync(join(db, OSV_DB_STAMP), "{}");
    writeFileSync(join(db, "npm.zip"), "db");
    const bin = join(vtcHome, "scanners", "osv-scanner");
    mkdirSync(bin, { recursive: true });
    const scanner = join(bin, "osv-scanner");
    writeFileSync(
      scanner,
      `#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = --output ] && out=$2; shift; done\nprintf '%s' '${REPORT}' > "$out" || exit 2\nexit 1\n`,
    );
    chmodSync(scanner, 0o755);
    const logDir = join(vtcHome, "logs");
    mkdirSync(logDir);
    const result = await scanLockfileAdvisories({
      vtcHome,
      scanners: { names: ["osv-scanner"], ensure: () => Promise.resolve(scanner) },
      lockfile: new TextEncoder().encode("lockfileVersion: '9.0'\n"),
      logDir,
      env: { PATH: process.env.PATH ?? "" },
    });
    expect(result).toEqual({ ok: true, advisories: [{ id: "GHSA-x", package: "left-pad" }] });
  });
});

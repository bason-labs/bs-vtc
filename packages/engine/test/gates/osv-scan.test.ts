/**
 * The offline osv-scanner pass over VTC's own lockfile (D-bv (4); spine §5 reading 216): the
 * pinned scanner against the database `vtc calibrate` downloaded, never the network, in the gate
 * sandbox. The advisories it finds become `security` facts in VTC's repo. The scanner here is a
 * fake script (D-cc: no real scanner, no network).
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  advisoriesFromOsvReport,
  OSV_DB_STAMP,
  osvDatabaseDir,
  scanLockfileAdvisories,
  UNSANDBOXED,
  type ScannerStore,
} from "../../src/gates/index.js";
import { cleanupDirs, tempDir } from "../helpers/repo.js";

afterEach(cleanupDirs);

const REPORT = {
  results: [
    {
      source: { path: "/tmp/x/pnpm-lock.yaml", type: "lockfile" },
      packages: [
        {
          package: { name: "vite", version: "7.0.1", ecosystem: "npm" },
          vulnerabilities: [{ id: "GHSA-aaaa-bbbb-cccc", summary: "x" }],
          groups: [{ ids: ["GHSA-aaaa-bbbb-cccc"], max_severity: "7.5" }],
        },
        {
          package: { name: "@babel/core", version: "7.1.0", ecosystem: "npm" },
          vulnerabilities: [
            { id: "GHSA-dddd-eeee-ffff" },
            { id: "GHSA-dddd-eeee-ffff" },
            { id: "not an id; rm -rf" },
          ],
        },
      ],
    },
  ],
};

describe("advisoriesFromOsvReport", () => {
  it("reads each advisory id and package name once, and nothing it cannot trust", () => {
    expect(advisoriesFromOsvReport(REPORT)).toEqual([
      { id: "GHSA-aaaa-bbbb-cccc", package: "vite" },
      { id: "GHSA-dddd-eeee-ffff", package: "@babel/core" },
    ]);
    expect(advisoriesFromOsvReport({ results: [] })).toEqual([]);
    expect(advisoriesFromOsvReport("nonsense")).toEqual([]);
  });
});

describe("scanLockfileAdvisories", () => {
  const setup = (options: { database?: boolean; exit?: number } = {}) => {
    const vtcHome = tempDir("vtc-home-");
    if (options.database !== false) {
      mkdirSync(osvDatabaseDir(vtcHome), { recursive: true });
      writeFileSync(join(osvDatabaseDir(vtcHome), OSV_DB_STAMP), "{}\n");
      writeFileSync(join(osvDatabaseDir(vtcHome), "npm.zip"), "db");
    }
    const bin = tempDir("vtc-bin-");
    const argsFile = join(bin, "args.txt");
    const script = join(bin, "osv-scanner");
    writeFileSync(
      script,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$@" > ${JSON.stringify(argsFile)}`,
        `printf '%s\\n' "$OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY" >> ${JSON.stringify(argsFile)}`,
        'out=""; prev=""',
        'for a in "$@"; do if [ "$prev" = "--output" ]; then out="$a"; fi; prev="$a"; done',
        `printf '%s' '${JSON.stringify(REPORT)}' > "$out"`,
        `exit ${String(options.exit ?? 1)}`,
        "",
      ].join("\n"),
    );
    chmodSync(script, 0o755);
    const ensured: string[] = [];
    const scanners: ScannerStore = {
      names: ["osv-scanner"],
      ensure: (name) => {
        ensured.push(name);
        return Promise.resolve(script);
      },
    };
    const scan = () =>
      scanLockfileAdvisories({
        vtcHome,
        scanners,
        lockfile: new TextEncoder().encode("lockfileVersion: '9.0'\n"),
        logDir: tempDir("vtc-logs-"),
        env: process.env,
        sandbox: UNSANDBOXED,
      });
    return { vtcHome, scan, ensured, args: () => readFileSync(argsFile, "utf8").split("\n") };
  };

  it("scans the lockfile offline against the downloaded database and reads the advisories", async () => {
    const s = setup();
    expect(await s.scan()).toEqual({
      ok: true,
      advisories: [
        { id: "GHSA-aaaa-bbbb-cccc", package: "vite" },
        { id: "GHSA-dddd-eeee-ffff", package: "@babel/core" },
      ],
    });
    const args = s.args();
    expect(args.slice(0, 3)).toEqual(["scan", "source", "--offline"]);
    expect(args).toContain("--lockfile");
    expect(args.find((a) => a.endsWith("pnpm-lock.yaml"))).toBeDefined();
    expect(args.at(-2)).toBe(osvDatabaseDir(s.vtcHome));
  });

  it("reads no advisory when the scanner found none", async () => {
    const s = setup({ exit: 0 });
    expect(await s.scan()).toMatchObject({ ok: true });
  });

  it("never scans (or downloads) without the offline database", async () => {
    const s = setup({ database: false });
    expect(await s.scan()).toMatchObject({ ok: false, reason: "no_database" });
    expect(s.ensured).toEqual([]);
  });

  it("fails on a scanner error rather than reporting no advisory", async () => {
    const s = setup({ exit: 2 });
    expect(await s.scan()).toMatchObject({ ok: false, reason: "failed" });
  });
});

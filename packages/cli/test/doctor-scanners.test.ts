/**
 * `vtc doctor` and the pinned scanners (§4.4: downloaded on demand by `vtc doctor`, into
 * `~/.vtc/`, pinned by SHA-256; spine §5 reading 66). The store itself (download, checksum,
 * unpack, re-verify) is the Gate Runner's typed `gates.createScannerStore` (AD-13 rule 2); doctor
 * reports it and, with `--download`, fills it and refreshes the osv-scanner offline database.
 * Nothing is downloaded here: the real store runs with a download that refuses, and a fake store
 * stands in for the downloading paths.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { gates } from "@vtc/engine";
import { createDoctorCommand, defaultDoctorEnv } from "../src/commands/doctor.js";
import type { ExecResult } from "../src/process.js";
import { checkOsvDatabase, checkScanners, type OsvEnv } from "../src/scanner-checks.js";
import { capture, cleanupDirs, tempHome } from "./helpers.js";

afterEach(cleanupDirs);

interface FakeState {
  readonly installed: Set<string>;
  /** Scanners with no published build for this platform. */
  readonly unsupported: readonly string[];
  /** Scanners whose download does not match the pin. */
  readonly tampered: readonly string[];
  readonly downloads: string[];
  readonly opened: gates.ScannerStoreOptions[];
}

const NAMES = ["gitleaks", "osv-scanner", "opengrep", "checkov"];

/** Behaves like the Gate Runner's store: verified install, else `download`, else a mismatch. */
const fakeStore =
  (state: FakeState) =>
  (options: gates.ScannerStoreOptions): gates.ScannerStore => {
    state.opened.push(options);
    const download =
      options.download ??
      ((url: string) => {
        state.downloads.push(url);
        return Promise.resolve(new Uint8Array([1]));
      });
    return {
      names: NAMES,
      ensure: async (name) => {
        if (state.unsupported.includes(name))
          throw new gates.ScannerError(
            name,
            "no pinned build for darwin-arm64; install it yourself and confirm it in vtc calibrate",
          );
        const path = `${options.vtcHome}/scanners/${name}/bin/${name}`;
        if (state.installed.has(name)) return path;
        await download(`https://example.invalid/${name}`);
        if (state.tampered.includes(name))
          throw new gates.ScannerError(name, "checksum mismatch; nothing was installed");
        state.installed.add(name);
        return path;
      },
    };
  };

const freshState = (over: Partial<FakeState> = {}): FakeState => ({
  installed: new Set(["gitleaks"]),
  unsupported: ["checkov"],
  tampered: [],
  downloads: [],
  opened: [],
  ...over,
});

const notOnPath = (): Promise<string | null> => Promise.resolve(null);

const ok: ExecResult = { code: 0, stdout: "x 1.0\n", stderr: "" };

describe("vtc doctor: the pinned scanners", () => {
  it("finds the Gate Runner's real store and reports every pin without downloading", async () => {
    // the typed export, not a duck-typed lookup (reading 66)
    const { ctx } = capture("/w", "/vh");
    expect(defaultDoctorEnv(ctx).scanners?.open).toBe(gates.createScannerStore);
    const home = tempHome();
    const checks = await checkScanners({ vtcHome: home, onPath: notOnPath }, "check", () => {
      throw new Error("nothing is downloaded on a plain doctor");
    });
    expect(checks.map((c) => c.name)).toEqual(gates.SCANNER_PINS.scanners.map((s) => s.name));
    for (const c of checks) expect(c.status).toBe("warn");
  });

  it("reports each pinned scanner without downloading anything", async () => {
    const state = freshState();
    const progress: string[] = [];
    const checks = await checkScanners(
      { open: fakeStore(state), vtcHome: "/vh", onPath: notOnPath },
      "check",
      (l) => progress.push(l),
    );
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ["gitleaks", "ok"],
      ["osv-scanner", "warn"],
      ["opengrep", "warn"],
      ["checkov", "warn"],
    ]);
    expect(checks[0]?.detail).toMatch(/verified \(\/vh\/scanners\/gitleaks\/bin\/gitleaks\)/);
    expect(checks[1]?.detail).toMatch(
      /not downloaded yet, or its install no longer verifies: run vtc doctor --download/,
    );
    expect(state.downloads).toEqual([]);
    expect(progress).toEqual([]);
    expect(state.opened.every((o) => o.vtcHome === "/vh")).toBe(true);
  });

  it("warns, and nothing more, for Checkov where it has no native build (D-u)", async () => {
    const state = freshState();
    const [, , , absent] = await checkScanners(
      { open: fakeStore(state), vtcHome: "/vh", onPath: notOnPath },
      "download",
      () => undefined,
    );
    expect(absent).toMatchObject({ name: "checkov", status: "warn" });
    expect(absent?.detail).toMatch(/no pinned build for darwin-arm64/);
    expect(absent?.detail).toMatch(/L4 IaC gate is skipped/);
    const [, , , installed] = await checkScanners(
      {
        open: fakeStore(freshState()),
        vtcHome: "/vh",
        onPath: (name) => Promise.resolve(name === "checkov" ? "checkov 3.3.20" : null),
      },
      "check",
      () => undefined,
    );
    expect(installed).toMatchObject({ name: "checkov", status: "ok" });
    expect(installed?.detail).toMatch(/user-installed \(checkov 3\.3\.20\)/);
  });

  it("recognises the real store's no-pinned-build error (D-u), not only the fake's", async () => {
    // the Gate Runner's own store and wording: a reworded error fails here, not silently in doctor
    const onPath = (name: string) => Promise.resolve(name === "checkov" ? "checkov 3.3.20" : null);
    for (const platform of ["darwin-arm64", null] as const) {
      const checks = await checkScanners(
        {
          open: (options) => gates.createScannerStore({ ...options, platform }),
          vtcHome: tempHome(),
          onPath,
        },
        "check",
        () => undefined,
      );
      const checkov = checks.find((c) => c.name === "checkov");
      expect(checkov?.status).toBe("ok");
      expect(checkov?.detail).toMatch(/^user-installed \(checkov 3\.3\.20\)/);
      const others = checks.filter((c) => c.name !== "checkov");
      if (platform === null)
        for (const c of others) expect(c.detail).toMatch(/not on PATH either, so its L4 gate/);
      else for (const c of others) expect(c.detail).toMatch(/not downloaded yet/);
    }
  });

  it("--download fetches only the missing ones through the store, which verifies the pin", async () => {
    const state = freshState({ tampered: ["opengrep"] });
    const progress: string[] = [];
    const checks = await checkScanners(
      { open: fakeStore(state), vtcHome: "/vh", onPath: notOnPath },
      "download",
      (l) => progress.push(l),
    );
    expect(state.downloads).toEqual([
      "https://example.invalid/osv-scanner",
      "https://example.invalid/opengrep",
    ]);
    expect(progress).toEqual([
      "Downloading osv-scanner (pinned by SHA-256) into /vh...",
      "Downloading opengrep (pinned by SHA-256) into /vh...",
    ]);
    expect(checks.map((c) => [c.name, c.status])).toEqual([
      ["gitleaks", "ok"],
      ["osv-scanner", "ok"],
      ["opengrep", "fail"],
      ["checkov", "warn"],
    ]);
    expect(checks[1]?.detail).toMatch(/downloaded and verified/);
    expect(checks[2]?.detail).toMatch(/checksum mismatch; nothing was installed/);
  });
});

describe("vtc doctor: the osv-scanner offline database", () => {
  const osvEnv = (over: Partial<OsvEnv> = {}): OsvEnv & { readonly calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      fetchedAt: () => null,
      checkout: () => Promise.resolve("/repo"),
      download: (request) => {
        calls.push(`${request.vtcHome} ${request.checkoutAbs} ${request.scanners.names.join(",")}`);
        return Promise.resolve({ ok: true, detail: `downloaded into ${request.vtcHome}/osv-db` });
      },
      ...over,
    };
  };

  it("reads the real database stamp under ~/.vtc/osv-db", () => {
    const home = tempHome();
    const env = defaultDoctorEnv(capture("/w", home).ctx).osv;
    expect(env?.fetchedAt(home)).toBeNull();
    const dir = gates.osvDatabaseDir(home);
    expect(dir).toBe(join(home, "osv-db"));
    mkdirSync(join(dir, "npm"), { recursive: true });
    writeFileSync(join(dir, gates.OSV_DB_STAMP), '{ "fetched_at": "2026-10-14T08:00:00.000Z" }\n');
    expect(env?.fetchedAt(home)).toBe("2026-10-14T08:00:00.000Z");
  });

  it("reports its age, and only --download refreshes it, with the pinned osv-scanner", async () => {
    const store = fakeStore(freshState())({ vtcHome: "/vh" });
    const missing = osvEnv();
    const absent = await checkOsvDatabase(missing, "/vh", store, "check");
    expect(absent).toMatchObject({ name: "osv-db", status: "warn" });
    expect(absent.detail).toMatch(/not downloaded: run vtc doctor --download in a repo/);
    expect(missing.calls).toEqual([]);
    const fresh = osvEnv({ fetchedAt: () => "2026-10-14T08:00:00.000Z" });
    const ready = await checkOsvDatabase(fresh, "/vh", store, "check");
    expect(ready.status).toBe("ok");
    expect(ready.detail).toMatch(/downloaded 2026-10-14T08:00:00\.000Z/);
    // --download refreshes even a ready database
    expect(await checkOsvDatabase(fresh, "/vh", store, "download")).toMatchObject({
      status: "ok",
      detail: "downloaded into /vh/osv-db",
    });
    expect(fresh.calls).toEqual(["/vh /repo gitleaks,osv-scanner,opengrep,checkov"]);
    const failing = osvEnv({
      download: () => Promise.resolve({ ok: false, detail: "the download failed (exit code 2)" }),
    });
    expect(await checkOsvDatabase(failing, "/vh", store, "download")).toMatchObject({
      status: "fail",
      detail: "the download failed (exit code 2)",
    });
    // the ecosystems come from a repo's lockfiles: outside one there is nothing to fetch
    const outside = osvEnv({ checkout: () => Promise.resolve(null) });
    const elsewhere = await checkOsvDatabase(outside, "/vh", store, "download");
    expect(elsewhere.status).toBe("warn");
    expect(elsewhere.detail).toMatch(/inside a repo/);
    expect(outside.calls).toEqual([]);
  });
});

describe("vtc doctor --download", () => {
  it("exits 1 when a download fails, 0 otherwise", async () => {
    const exec = () => Promise.resolve(ok);
    const run = async (state: FakeState, args: string[]) => {
      const { ctx, out } = capture("/w", "/vh");
      const cmd = createDoctorCommand((c) => ({
        exec,
        versions: { node: "22.17.1" },
        scanners: { open: fakeStore(state), vtcHome: c.vtcHome, onPath: notOnPath },
      }));
      return { code: await cmd.run(args, ctx), text: out.join("\n") };
    };
    const plain = await run(freshState(), []);
    expect(plain.code).toBe(0);
    expect(plain.text).toMatch(/warn +osv-scanner +not downloaded yet/);
    const fetched = await run(freshState(), ["--download"]);
    expect(fetched.code).toBe(0);
    expect(fetched.text).toMatch(/Downloading osv-scanner/);
    expect(fetched.text).toMatch(/ok {4}osv-scanner +downloaded and verified/);
    const broken = await run(freshState({ tampered: ["opengrep"] }), ["--download"]);
    expect(broken.code).toBe(1);
    expect(broken.text).toMatch(/FAIL +opengrep +scanner opengrep: checksum mismatch/);
  });
});

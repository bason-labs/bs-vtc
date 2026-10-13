/**
 * `vtc doctor` and the pinned scanners (§4.4: downloaded on demand by `vtc doctor`, into
 * `~/.vtc/`, pinned by SHA-256). The store itself (download, checksum, unpack, re-verify) is the
 * Gate Runner's (AD-13 rule 2); doctor reports it and, with `--download`, fills it. Nothing is
 * downloaded here: a fake store stands in, and the probe proves doctor never downloads unasked.
 */
import { describe, expect, it } from "vitest";
import { createDoctorCommand } from "../src/commands/doctor.js";
import type { ExecResult } from "../src/process.js";
import {
  checkScanners,
  engineScannerStore,
  type OpenScannerStore,
  type ScannerStoreOptions,
} from "../src/scanner-checks.js";
import { capture } from "./helpers.js";

interface FakeState {
  readonly installed: Set<string>;
  /** Scanners with no published build for this platform. */
  readonly unsupported: readonly string[];
  /** Scanners whose download does not match the pin. */
  readonly tampered: readonly string[];
  readonly downloads: string[];
  readonly opened: ScannerStoreOptions[];
}

const NAMES = ["gitleaks", "osv-scanner", "opengrep", "checkov"];

/** Behaves like the Gate Runner's store: verified install, else `download`, else a mismatch. */
const fakeStore =
  (state: FakeState): OpenScannerStore =>
  (options) => {
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
          throw new Error(
            `scanner ${name}: no pinned build for darwin-arm64; install it yourself and confirm it in vtc calibrate`,
          );
        const path = `${options.vtcHome}/scanners/${name}/bin/${name}`;
        if (state.installed.has(name)) return path;
        await download(`https://example.invalid/${name}`);
        if (state.tampered.includes(name))
          throw new Error(`scanner ${name}: checksum mismatch; nothing was installed`);
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

const ok: ExecResult = { code: 0, stdout: "x 1.0\n", stderr: "" };

describe("vtc doctor: the pinned scanners", () => {
  it("reports each pinned scanner without downloading anything", async () => {
    const state = freshState();
    const progress: string[] = [];
    const checks = await checkScanners({ open: fakeStore(state), vtcHome: "/vh" }, "check", (l) =>
      progress.push(l),
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
    expect(checks[3]?.detail).toMatch(/no pinned build for darwin-arm64/);
    expect(state.downloads).toEqual([]);
    expect(progress).toEqual([]);
    expect(state.opened.every((o) => o.vtcHome === "/vh")).toBe(true);
  });

  it("--download fetches only the missing ones through the store, which verifies the pin", async () => {
    const state = freshState({ tampered: ["opengrep"] });
    const progress: string[] = [];
    const checks = await checkScanners(
      { open: fakeStore(state), vtcHome: "/vh" },
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

  it("says so when this build has no scanner store", async () => {
    const [check] = await checkScanners({ open: null, vtcHome: "/vh" }, "check", () => {});
    expect(check).toMatchObject({ name: "scanners", status: "warn" });
    expect(check?.detail).toMatch(/no pinned scanner store/);
    const [asked] = await checkScanners({ open: null, vtcHome: "/vh" }, "download", () => {});
    expect(asked?.status).toBe("fail");
  });

  it("uses the Gate Runner's store when the engine exports one", () => {
    expect(engineScannerStore({})).toBeNull();
    const seen: ScannerStoreOptions[] = [];
    const open = engineScannerStore({
      createScannerStore: (o: ScannerStoreOptions) => {
        seen.push(o);
        return { names: ["gitleaks"], ensure: () => Promise.resolve("/x") };
      },
    });
    expect(open?.({ vtcHome: "/vh" }).names).toEqual(["gitleaks"]);
    expect(seen).toEqual([{ vtcHome: "/vh" }]);
  });

  it("vtc doctor --download exits 1 when a download fails, 0 otherwise", async () => {
    const exec = () => Promise.resolve(ok);
    const run = async (state: FakeState, args: string[]) => {
      const { ctx, out } = capture("/w", "/vh");
      const cmd = createDoctorCommand((c) => ({
        exec,
        versions: { node: "22.17.1" },
        scanners: { open: fakeStore(state), vtcHome: c.vtcHome },
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

/**
 * `vtc update` and doctor's daily update check (`update.ts`). gh, tar, ps and the binaries are a
 * fake `exec`; the binary being replaced is a file in a temp folder, never the real `vtc`.
 */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDoctorCommand } from "../src/commands/doctor.js";
import { createUpdateCommand, type UpdateDeps } from "../src/commands/update.js";
import type { Exec, ExecResult } from "../src/process.js";
import {
  PROJECTS_FILE,
  UPDATE_CHECK_TTL_MS,
  availableUpdate,
  expectedSum,
  listReleases,
  readProjects,
  releaseTarget,
  roleRunHost,
  roleRunsUnder,
} from "../src/update.js";
import { capture, cleanupDirs, tempDir, tempHome } from "./helpers.js";

afterEach(cleanupDirs);

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const RELEASES = JSON.stringify([
  { tagName: "v0.2.4" },
  { tagName: "v0.2.10" },
  { tagName: "v0.2.5" },
  { tagName: "nightly" },
]);
const ARCHIVE = "vtc-0.2.10-darwin-arm64.tar.gz";
const ARCHIVE_BYTES = "fake archive";
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

interface Fake {
  readonly exec: Exec;
  readonly calls: { command: string; args: readonly string[]; cwd?: string }[];
}

/** gh, tar, ps and the binaries as `vtc update` drives them. */
const fakeExec = (options: {
  sums?: string;
  ps?: () => string;
  newVersion?: string;
  ghFails?: boolean;
}): Fake => {
  const calls: Fake["calls"] = [];
  const exec: Exec = (command, args, opts) => {
    calls.push({ command, args, ...(opts?.cwd === undefined ? {} : { cwd: opts.cwd }) });
    if (command === "gh") {
      if (options.ghFails === true)
        return Promise.resolve({
          code: 1,
          stdout: "",
          stderr: "error connecting to api.github.com",
        });
      if (args[1] === "list") return Promise.resolve(ok(RELEASES));
      if (args[1] === "view") return Promise.resolve(ok(`- notes of ${String(args[2])}`));
      if (args[1] === "download") {
        const dir = args[args.indexOf("--dir") + 1] ?? "";
        writeFileSync(join(dir, ARCHIVE), ARCHIVE_BYTES);
        writeFileSync(
          join(dir, "SHA256SUMS"),
          options.sums ??
            `${sha(ARCHIVE_BYTES)}  ${ARCHIVE}\n${sha("x")}  vtc-0.2.10-linux-x64.tar.gz\n`,
        );
        return Promise.resolve(ok());
      }
    }
    if (command === "tar") {
      const dir = args[args.indexOf("-C") + 1] ?? "";
      writeFileSync(join(dir, "vtc"), "new binary");
      return Promise.resolve(ok());
    }
    if (command === "ps") return Promise.resolve(ok(options.ps?.() ?? ""));
    if (args[0] === "version")
      return Promise.resolve(
        ok(`vtc ${options.newVersion ?? "0.2.10"} (vtc-engine, contracts 5.14.0)\n`),
      );
    if (args[0] === "install") return Promise.resolve(ok("Installed the VTC plugin."));
    return Promise.resolve({ code: 1, stdout: "", stderr: `unexpected ${command}` });
  };
  return { exec, calls };
};

const setup = (fake: Fake, overrides: Partial<UpdateDeps> = {}) => {
  const bin = tempDir("vtc-bin-");
  const execPath = join(bin, "vtc");
  writeFileSync(execPath, "old binary");
  chmodSync(execPath, 0o755);
  const stopped: string[] = [];
  const slept: number[] = [];
  const neutral = tempDir("vtc-neutral-");
  const deps: UpdateDeps = {
    exec: fake.exec,
    platform: "darwin",
    arch: "arm64",
    execPath,
    runtimeKind: "binary",
    version: "0.2.4",
    tempDir: () => tempDir("vtc-dl-"),
    confirm: () => Promise.resolve(true),
    stopEngine: (_home, repo) => {
      stopped.push(repo);
      return Promise.resolve(4242);
    },
    sleep: (ms) => {
      slept.push(ms);
      return Promise.resolve();
    },
    neutralDir: () => neutral,
    ...overrides,
  };
  return { cmd: createUpdateCommand(() => deps), execPath, bin, stopped, slept, neutral };
};

/** An engine discovery record for `repo` under `home`, with daemon pid 100. */
const engineFor = (home: string, repo: string): void => {
  mkdirSync(join(home, "engines"), { recursive: true });
  writeFileSync(
    join(home, "engines", "k.json"),
    JSON.stringify({
      v: 1,
      pid: 100,
      port: 6000,
      prototype_port: null,
      mcp_socket: join(home, "run", "k.sock"),
      repo_root: repo,
      started_at: "2026-10-17T00:00:00.000Z",
      engine_version: "vtc-engine@0.2.4",
      contracts_version: "5.13.0",
    }),
  );
};

/** A repo with VTC's project-scope Codex skills. */
const codexRepo = (): string => {
  const repo = tempDir("vtc-repo-");
  mkdirSync(join(repo, ".agents", "skills", "vtc-lead"), { recursive: true });
  writeFileSync(join(repo, ".agents", "skills", "vtc-lead", ".vtc-generated"), "");
  return repo;
};

const PS_IDLE =
  "  100     1 /usr/local/bin/vtc engine --daemon\n  101   100 node /x/bin/codex app-server\n  102   101 /x/vendor/bin/codex app-server\n";
const PS_BUSY = `${PS_IDLE}  103   100 node /x/bin/codex exec --sandbox read-only --json\n  104   103 /x/vendor/aarch64/bin/codex exec --sandbox read-only\n`;

describe("releases", () => {
  it("takes the newest release by version, prereleases included, and skips odd tags", async () => {
    const releases = await listReleases(fakeExec({}).exec);
    expect(releases.map((r) => r.tag)).toEqual(["v0.2.10", "v0.2.5", "v0.2.4"]);
  });

  it("reads a sum in either SHA256SUMS form", () => {
    expect(
      expectedSum(`${"a".repeat(64)}  vtc-a.tar.gz\n${"B".repeat(64)} *vtc-b.zip\n`, "vtc-b.zip"),
    ).toBe("b".repeat(64));
    expect(expectedSum("", "vtc-a.tar.gz")).toBeNull();
  });

  it("names the platform archives release.yml builds", () => {
    expect(releaseTarget("darwin", "arm64")).toBe("darwin-arm64");
    expect(releaseTarget("linux", "x64")).toBe("linux-x64");
    expect(releaseTarget("win32", "x64")).toBe("windows-x64");
    expect(releaseTarget("win32", "arm64")).toBeNull();
    expect(releaseTarget("freebsd", "x64")).toBeNull();
  });

  it("counts codex exec and claude -p as role runs, never Codex's app-server", async () => {
    expect(roleRunHost("node /x/bin/codex exec --json")).toBe("codex");
    expect(roleRunHost("/x/vendor/bin/codex exec --sandbox read-only")).toBe("codex");
    expect(roleRunHost("/usr/local/bin/claude --model m -p hi")).toBe("claude-code");
    expect(roleRunHost("node /x/bin/codex app-server")).toBeNull();
    expect(roleRunHost("claude")).toBeNull();
    expect(await roleRunsUnder(fakeExec({ ps: () => PS_IDLE }).exec, 100)).toEqual([]);
    expect(
      (await roleRunsUnder(fakeExec({ ps: () => PS_BUSY }).exec, 100))?.map((c) => c.pid),
    ).toEqual([103, 104]);
  });
});

describe("vtc update", () => {
  it("says so when this vtc is the newest release", async () => {
    const fake = fakeExec({});
    const { cmd } = setup(fake, { version: "0.2.10" });
    const { ctx, out } = capture(tempDir(), tempHome());
    expect(await cmd.run([], ctx)).toBe(0);
    expect(out).toEqual(["vtc 0.2.10 is already up to date."]);
    expect(fake.calls.map((c) => c.args[1])).toEqual(["list"]);
  });

  it("--check only reports", async () => {
    const fake = fakeExec({});
    const { cmd, execPath } = setup(fake);
    const { ctx, out } = capture(tempDir(), tempHome());
    expect(await cmd.run(["--check"], ctx)).toBe(0);
    expect(out).toEqual(["Update available: vtc 0.2.4 -> 0.2.10. Run vtc update to install it."]);
    expect(readFileSync(execPath, "utf8")).toBe("old binary");
  });

  it("replaces the binary, keeps a backup, stops engines and installs the plugins again", async () => {
    const home = tempHome();
    mkdirSync(join(home, "claude-marketplace"));
    const repo = codexRepo();
    const other = codexRepo();
    engineFor(home, repo);
    const fake = fakeExec({ ps: () => PS_IDLE });
    const { cmd, execPath, bin, stopped, neutral } = setup(fake);
    const { ctx, out, err } = capture(tempDir(), home);
    expect(await cmd.run(["--repo", other], ctx)).toBe(0);
    expect(err).toEqual([]);
    expect(readFileSync(execPath, "utf8")).toBe("new binary");
    expect(readFileSync(join(bin, ".vtc-0.2.4.bak"), "utf8")).toBe("old binary");
    expect(stopped).toEqual([repo]);
    const installs = fake.calls.filter((c) => c.command === execPath && c.args[0] === "install");
    expect(installs).toEqual([
      { command: execPath, args: ["install", "claude-code"], cwd: neutral },
      ...[repo, other]
        .sort()
        .map((cwd) => ({ command: execPath, args: ["install", "codex"], cwd })),
    ]);
    expect(readProjects(home)).toEqual([repo, other].sort());
    expect(out.join("\n")).toContain("What changed in v0.2.5:\n- notes of v0.2.5");
    expect(out.join("\n")).toContain("What changed in v0.2.10:\n- notes of v0.2.10");
    expect(out.at(-1)).toContain("Open a new Codex or Claude Code chat");
    expect(existsSync(join(bin, `.vtc-update-${String(process.pid)}`))).toBe(false);
  });

  it("refuses an archive that does not match SHA256SUMS and changes nothing", async () => {
    const fake = fakeExec({ sums: `${"0".repeat(64)}  ${ARCHIVE}\n` });
    const { cmd, execPath, stopped } = setup(fake);
    const { ctx, err } = capture(tempDir(), tempHome());
    expect(await cmd.run(["--yes"], ctx)).toBe(1);
    expect(err.join("\n")).toContain("does not match SHA256SUMS");
    expect(readFileSync(execPath, "utf8")).toBe("old binary");
    expect(stopped).toEqual([]);
  });

  it("refuses a binary that does not answer as the release", async () => {
    const { cmd, execPath } = setup(fakeExec({ newVersion: "0.2.9" }));
    const { ctx, err } = capture(tempDir(), tempHome());
    expect(await cmd.run([], ctx)).toBe(1);
    expect(err.join("\n")).toContain("does not run as vtc 0.2.10");
    expect(readFileSync(execPath, "utf8")).toBe("old binary");
  });

  it("stops while a role run is in flight, and --wait waits for it", async () => {
    const home = tempHome();
    const repo = codexRepo();
    engineFor(home, repo);
    const busy = setup(fakeExec({ ps: () => PS_BUSY }));
    const first = capture(tempDir(), home);
    expect(await busy.cmd.run([], first.ctx)).toBe(1);
    expect(first.err[0]).toBe(`vtc update: the engine of ${repo} is running 1 Codex role run`);
    expect(readFileSync(busy.execPath, "utf8")).toBe("old binary");
    expect(busy.stopped).toEqual([]);

    let polls = 0;
    const waiting = setup(fakeExec({ ps: () => (++polls < 3 ? PS_BUSY : PS_IDLE) }));
    const second = capture(tempDir(), home);
    expect(await waiting.cmd.run(["--wait"], second.ctx)).toBe(0);
    expect(waiting.slept.length).toBe(2);
    expect(waiting.stopped).toEqual([repo]);
    expect(readFileSync(waiting.execPath, "utf8")).toBe("new binary");
  });

  it("asks first, and a no changes nothing", async () => {
    const fake = fakeExec({});
    const { cmd, execPath } = setup(fake, { confirm: () => Promise.resolve(false) });
    const { ctx, out } = capture(tempDir(), tempHome());
    expect(await cmd.run([], ctx)).toBe(1);
    expect(out.at(-1)).toContain("vtc was not updated");
    expect(fake.calls.some((c) => c.args[1] === "download")).toBe(false);
    expect(readFileSync(execPath, "utf8")).toBe("old binary");
  });

  it("refuses from source, on Windows and where the binary is not writable", async () => {
    const dev = setup(fakeExec({}), { runtimeKind: "dev" });
    const a = capture(tempDir(), tempHome());
    expect(await dev.cmd.run(["--yes"], a.ctx)).toBe(1);
    expect(a.err[0]).toContain("runs from source");

    const win = setup(fakeExec({}), { platform: "win32", arch: "x64" });
    const b = capture(tempDir(), tempHome());
    expect(await win.cmd.run(["--yes"], b.ctx)).toBe(1);
    expect(b.err[0]).toContain("replace");

    const locked = setup(fakeExec({}));
    chmodSync(locked.bin, 0o555);
    const c = capture(tempDir(), tempHome());
    try {
      expect(await locked.cmd.run(["--yes"], c.ctx)).toBe(1);
      expect(c.err[0]).toContain("is not writable by you");
    } finally {
      chmodSync(locked.bin, 0o755);
    }
  });

  it("installs the release --version names, and rejects a bad one", async () => {
    const { cmd, execPath } = setup(fakeExec({}));
    const { ctx, err } = capture(tempDir(), tempHome());
    expect(await cmd.run(["--version", "v9.9.9"], ctx)).toBe(1);
    expect(err[0]).toContain("there is no release v9.9.9");
    expect(await cmd.run(["--version", "latest"], ctx)).toBe(64);
    expect(readFileSync(execPath, "utf8")).toBe("old binary");
  });
});

describe("doctor's update check", () => {
  it("asks GitHub at most once a day and names a newer release", async () => {
    const home = tempHome();
    const fake = fakeExec({});
    let now = new Date("2026-10-17T00:00:00Z");
    const check = () =>
      availableUpdate({ exec: fake.exec, vtcHome: home, current: "0.2.4", now: () => now });
    expect(await check()).toBe("0.2.10");
    expect(await check()).toBe("0.2.10");
    expect(fake.calls.length).toBe(1);
    now = new Date(now.getTime() + UPDATE_CHECK_TTL_MS + 1);
    expect(await check()).toBe("0.2.10");
    expect(fake.calls.length).toBe(2);
    expect(
      await availableUpdate({ exec: fake.exec, vtcHome: home, current: "0.2.10", now: () => now }),
    ).toBeNull();
  });

  it("shows one info line in vtc doctor, and none when up to date or the check throws", async () => {
    const quiet: Exec = () => Promise.resolve(ok());
    const run = async (update: () => Promise<string | null>) => {
      const { ctx, out } = capture("/w", "/h");
      const code = await createDoctorCommand(() => ({
        exec: quiet,
        versions: { node: "22.17.1" },
        update,
      })).run([], ctx);
      return { code, lines: out.filter((l) => l.includes("update")) };
    };
    const newer = await run(() => Promise.resolve("0.2.10"));
    expect(newer.lines).toHaveLength(1);
    expect(newer.lines[0]).toMatch(/update\s+update available: v0\.2\.10 \(run vtc update\)$/);
    expect((await run(() => Promise.resolve(null))).lines).toEqual([]);
    const broken = await run(() => Promise.reject(new Error("offline")));
    expect(broken.lines).toEqual([]);
    expect(broken.code).toBe(newer.code);
  });

  it("answers null offline and leaves no cache", async () => {
    const home = tempHome();
    expect(
      await availableUpdate({
        exec: fakeExec({ ghFails: true }).exec,
        vtcHome: home,
        current: "0.2.4",
        now: () => new Date(),
      }),
    ).toBeNull();
    expect(existsSync(join(home, "update-check.json"))).toBe(false);
    expect(existsSync(join(home, PROJECTS_FILE))).toBe(false);
  });
});

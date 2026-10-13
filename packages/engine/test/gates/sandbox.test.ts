/**
 * The gate sandbox (D-al, spine §5 reading 69, AD-13 rule 11): the macOS `sandbox-exec` profile,
 * the Linux `bwrap` argv, detection for `vtc doctor`, the read-deny list and the per-run home and
 * temp directories. Nothing here starts a real sandbox except the opt-in live test at the end
 * (`VTC_LIVE_SANDBOX=1`), which runs `sandbox-exec` on macOS without any network access.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  GATE_SANDBOX,
  hostCredentialDenyReadPaths,
  type GateSandbox,
  type GateSandboxSpec,
} from "@vtc/shared";
import { afterEach, describe, expect, it } from "vitest";
import {
  bwrapArgs,
  createBwrapSandbox,
  createSandboxExecSandbox,
  detectGateSandbox,
  GATE_READABLE_VTC_HOME,
  GateCommandJail,
  gateDenyReadPaths,
  OSV_DB_DIR,
  RULES_DIR,
  SANDBOX_EXEC,
  sandboxEnv,
  sandboxExecProfile,
  SCANNERS_DIR,
  UNSANDBOXED,
} from "../../src/gates/index.js";
import { cleanupDirs, tempDir } from "../helpers/repo.js";

afterEach(cleanupDirs);

const spec = (over: Partial<GateSandboxSpec> = {}): GateSandboxSpec => ({
  phase: "verify",
  checkout: "/work/repo/.vtc/state/checkouts/abc",
  tempDir: "/tmp/vtc-gate-1/tmp-0",
  home: "/tmp/vtc-gate-1/home",
  denyRead: ["/home/u/.vtc/token", "/home/u/.claude"],
  ...over,
});

/** A path resolver that changes nothing (the unit tests use paths that do not exist). */
const same = (p: string): string => p;

const paramsOf = (args: readonly string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== "-D") continue;
    const kv = args[i + 1] ?? "";
    out[kv.slice(0, kv.indexOf("="))] = kv.slice(kv.indexOf("=") + 1);
  }
  return out;
};

describe("the macOS sandbox-exec profile", () => {
  it("denies the network in the verify phase, writes outside the checkout and temp, and reads of denied paths", () => {
    const wrapped = createSandboxExecSandbox({ realpath: same }).wrap(
      ["node", "test.mjs", "--x"],
      spec(),
    );
    expect(wrapped.command).toBe(SANDBOX_EXEC);
    expect(wrapped.network).toBe("none");
    const args = wrapped.args;
    expect(args[0]).toBe("-p");
    const profile = args[1] ?? "";
    expect(profile).toContain("(deny network*)");
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toMatch(/\(deny file-read\*/);
    // Paths travel as -D parameters, never spliced into the profile text.
    expect(profile).not.toContain("/work/repo");
    expect(profile).not.toContain("/home/u");
    const params = paramsOf(args);
    expect(params.CHECKOUT).toBe("/work/repo/.vtc/state/checkouts/abc");
    expect(params.TEMP).toBe("/tmp/vtc-gate-1/tmp-0");
    expect(params.HOME).toBe("/tmp/vtc-gate-1/home");
    expect(
      Object.entries(params)
        .filter(([k]) => k.startsWith("DENY_"))
        .map(([, v]) => v),
    ).toEqual(["/home/u/.vtc/token", "/home/u/.claude"]);
    // The gate's own argv follows `--` unchanged.
    expect(args.slice(args.indexOf("--") + 1)).toEqual(["node", "test.mjs", "--x"]);
  });

  it("gives the install phase the full network (sandbox-exec cannot filter by registry) with the same file rules", () => {
    const wrapped = createSandboxExecSandbox({ realpath: same }).wrap(
      ["pnpm", "install"],
      spec({ phase: "install" }),
    );
    expect(wrapped.network).toBe("full");
    const profile = wrapped.args[1] ?? "";
    expect(profile).not.toContain("(deny network*)");
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toMatch(/\(deny file-read\*/);
  });

  it("denies both the given and the resolved path of a symlinked deny entry", () => {
    const { params } = sandboxExecProfile(spec({ denyRead: ["/var/x"] }), (p) =>
      p === "/var/x" ? "/private/var/x" : p,
    );
    expect(params.filter(([k]) => k.startsWith("DENY_")).map(([, v]) => v)).toEqual([
      "/var/x",
      "/private/var/x",
    ]);
  });

  it("refuses an empty argv and relative paths", () => {
    const sandbox = createSandboxExecSandbox({ realpath: same });
    expect(() => sandbox.wrap([], spec())).toThrow(/empty/);
    expect(() => sandbox.wrap(["x"], spec({ checkout: "rel/path" }))).toThrow(/absolute/);
  });
});

describe("the Linux bwrap argv", () => {
  const kinds: Record<string, "dir" | "file"> = {
    "/home/u/.vtc/token": "file",
    "/home/u/.claude": "dir",
  };
  const fs = { realpath: same, kind: (p: string) => kinds[p] ?? null };

  it("unshares the network in the verify phase, binds only the checkout and temp dirs writable and hides denied paths", () => {
    const args = bwrapArgs(["node", "t.mjs"], spec(), fs);
    expect(args).toContain("--unshare-net");
    expect(args).toContain("--die-with-parent");
    const pairs = (flag: string): string[][] =>
      args.flatMap((a, i) => (a === flag ? [[args[i + 1] ?? "", args[i + 2] ?? ""]] : []));
    expect(pairs("--ro-bind")).toContainEqual(["/", "/"]);
    expect(pairs("--bind")).toEqual([
      ["/work/repo/.vtc/state/checkouts/abc", "/work/repo/.vtc/state/checkouts/abc"],
      ["/tmp/vtc-gate-1/home", "/tmp/vtc-gate-1/home"],
      ["/tmp/vtc-gate-1/tmp-0", "/tmp/vtc-gate-1/tmp-0"],
    ]);
    // A denied file is replaced by /dev/null, a denied directory by an empty read-only tmpfs.
    expect(pairs("--ro-bind")).toContainEqual(["/dev/null", "/home/u/.vtc/token"]);
    expect(args.join(" ")).toContain("--tmpfs /home/u/.claude --remount-ro /home/u/.claude");
    // The denials come after the writable binds, so nothing re-exposes them.
    expect(args.indexOf("/home/u/.claude")).toBeGreaterThan(
      args.lastIndexOf("/tmp/vtc-gate-1/tmp-0"),
    );
    expect(args.slice(args.indexOf("--") + 1)).toEqual(["node", "t.mjs"]);
  });

  it("keeps the network in the install phase (bwrap cannot filter by registry)", () => {
    const sandbox = createBwrapSandbox({ binary: "/usr/bin/bwrap", ...fs });
    const wrapped = sandbox.wrap(["pnpm", "install"], spec({ phase: "install" }));
    expect(wrapped.command).toBe("/usr/bin/bwrap");
    expect(wrapped.network).toBe("full");
    expect(wrapped.args).not.toContain("--unshare-net");
    expect(wrapped.args).toContain("--unshare-pid");
  });

  it("skips denied paths that do not exist (there is nothing to read)", () => {
    const args = bwrapArgs(["x"], spec({ denyRead: ["/nope"] }), fs);
    expect(args).not.toContain("/nope");
  });
});

describe("detection (vtc doctor)", () => {
  it("uses sandbox-exec on macOS when a probe run succeeds", () => {
    const probes: string[][] = [];
    const found = detectGateSandbox({
      platform: "darwin",
      exists: (p) => p === SANDBOX_EXEC,
      probe: (argv) => {
        probes.push([...argv]);
        return true;
      },
    });
    expect(found.kind).toBe("sandbox-exec");
    expect(found.sandbox?.kind).toBe("sandbox-exec");
    expect(probes[0]?.[0]).toBe(SANDBOX_EXEC);
    expect(found.detail).toMatch(/sandbox-exec/);
  });

  it("uses bwrap on Linux from an absolute PATH entry when a probe run succeeds", () => {
    const found = detectGateSandbox({
      platform: "linux",
      env: { PATH: "relative/bin:/opt/bin:/usr/bin" },
      exists: (p) => p === "/usr/bin/bwrap" || p === "relative/bin/bwrap",
      probe: (argv) => argv[0] === "/usr/bin/bwrap" && argv.includes("--unshare-net"),
    });
    expect(found.kind).toBe("bwrap");
    expect(found.detail).toContain("/usr/bin/bwrap");
  });

  it("reports no sandbox, with the visible reason, when the tool is missing or cannot start", () => {
    const missing = detectGateSandbox({
      platform: "linux",
      env: { PATH: "/usr/bin" },
      exists: () => false,
    });
    expect(missing.kind).toBeNull();
    expect(missing.sandbox).toBeNull();
    expect(missing.detail).toContain(GATE_SANDBOX.noSandboxReason);
    expect(missing.detail).toMatch(/bwrap/);
    // e.g. user namespaces disabled, or VTC itself already inside a sandbox.
    const broken = detectGateSandbox({
      platform: "darwin",
      exists: () => true,
      probe: () => false,
    });
    expect(broken.kind).toBeNull();
    expect(broken.detail).toContain(GATE_SANDBOX.noSandboxReason);
    const windows = detectGateSandbox({ platform: "win32", exists: () => true, probe: () => true });
    expect(windows.kind).toBeNull();
  });

  it("detects this machine's sandbox with no options (never throws)", () => {
    const found = detectGateSandbox();
    expect(["sandbox-exec", "bwrap", null]).toContain(found.kind);
  });
});

describe("what a gate may not read", () => {
  it("denies the VTC home except the scanners, rules and OSV database the gates run with", () => {
    const vtcHome = tempDir("vtc-home-");
    for (const name of ["scanners", "rules", "osv-db", "allowlists", "hidden", "plugins"]) {
      mkdirSync(join(vtcHome, name));
    }
    writeFileSync(join(vtcHome, "config.yaml"), "version: 1\n");
    const deny = gateDenyReadPaths(vtcHome, { HOME: "/home/u" });
    for (const name of ["allowlists", "hidden", "plugins", "config.yaml", "token", "run"]) {
      expect(deny).toContain(join(vtcHome, name));
    }
    for (const name of GATE_READABLE_VTC_HOME) expect(deny).not.toContain(join(vtcHome, name));
    expect(GATE_READABLE_VTC_HOME).toEqual([SCANNERS_DIR, RULES_DIR, OSV_DB_DIR]);
  });

  it("denies the host config directories and credential files, wherever the environment moves them", () => {
    const deny = gateDenyReadPaths("/nowhere/.vtc", {
      HOME: "/home/u",
      CODEX_HOME: "/elsewhere/codex",
    });
    expect(deny).toContain("/home/u/.claude");
    expect(deny).toContain("/elsewhere/codex");
    for (const p of hostCredentialDenyReadPaths({
      "claude-code": "/home/u/.claude",
      codex: "/elsewhere/codex",
    })) {
      expect(deny).toContain(p);
    }
    expect(deny).toContain("/home/u/.ssh");
    expect(deny).toContain("/home/u/Library/Keychains");
    // Nothing under the VTC home is opened to build the list.
    expect(deny).toContain("/nowhere/.vtc/token");
  });
});

describe("the gate environment in the sandbox", () => {
  it("points HOME and the temp variables at the per-run directories and drops VTC_HOME and caches outside them", () => {
    const env = sandboxEnv(
      { PATH: "/usr/bin", HOME: "/home/u", VTC_HOME: "/home/u/.vtc", GOCACHE: "/home/u/go-cache" },
      { home: "/t/home", tempDir: "/t/tmp-0" },
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/t/home",
      USERPROFILE: "/t/home",
      TMPDIR: "/t/tmp-0",
      TMP: "/t/tmp-0",
      TEMP: "/t/tmp-0",
    });
  });
});

/** A wrapper that runs the argv as it is and records every spec (the runner tests use it too). */
const recording = (): { sandbox: GateSandbox; specs: GateSandboxSpec[] } => {
  const specs: GateSandboxSpec[] = [];
  return {
    specs,
    sandbox: {
      kind: "bwrap",
      wrap: (argv, s) => {
        specs.push(s);
        return { command: argv[0] ?? "", args: argv.slice(1), network: "none" };
      },
    },
  };
};

describe("a jail: per-run home, per-command temp dirs", () => {
  it("runs each command with an empty per-run HOME and its own temp dir, then removes them", async () => {
    const work = tempDir("vtc-jail-");
    const checkout = join(work, "checkout");
    mkdirSync(checkout);
    const { sandbox, specs } = recording();
    const jail = new GateCommandJail(sandbox, ["/denied"]);
    const dump = `require("fs").writeFileSync("env-" + process.argv[1] + ".json", JSON.stringify({ home: process.env.HOME, tmp: process.env.TMPDIR, vtc: process.env.VTC_HOME ?? null, listed: require("fs").readdirSync(process.env.HOME) }))`;
    for (const n of ["a", "b"]) {
      const result = await jail.run({
        phase: n === "a" ? "install" : "verify",
        checkout,
        argv: [process.execPath, "-e", dump, n],
        cwd: checkout,
        env: sandboxEnvInput(),
        timeoutMs: 20_000,
        stdoutPath: join(work, `${n}.out`),
        stderrPath: join(work, `${n}.err`),
      });
      expect(result.code).toBe(0);
    }
    expect(specs.map((s) => s.phase)).toEqual(["install", "verify"]);
    expect(specs[0]?.home).toBe(specs[1]?.home);
    expect(specs[0]?.tempDir).not.toBe(specs[1]?.tempDir);
    expect(specs[0]?.checkout).toBe(realpathSync(checkout));
    expect(specs[0]?.denyRead).toEqual(["/denied"]);
    const a = JSON.parse(readFileSync(join(checkout, "env-a.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(a).toEqual({ home: specs[0]?.home, tmp: specs[0]?.tempDir, vtc: null, listed: [] });
    expect(jail.ran).toBe(true);
    const home = specs[0]?.home ?? "";
    expect(existsSync(home)).toBe(true);
    jail.dispose();
    expect(existsSync(home)).toBe(false);
  });

  it("an unsandboxed jail runs the argv unchanged with the full network", () => {
    expect(UNSANDBOXED.kind).toBe("none");
    expect(UNSANDBOXED.wrap(["a", "b"], spec())).toEqual({
      command: "a",
      args: ["b"],
      network: "full",
    });
  });
});

const sandboxEnvInput = (): Record<string, string> => ({
  PATH: process.env.PATH ?? "",
  VTC_HOME: "/should/not/pass",
});

/**
 * Opt-in (`VTC_LIVE_SANDBOX=1`, macOS with a working sandbox-exec): one real wrapped command.
 * Fast, and it never reaches the network: the only socket it tries is a loopback connect, which
 * the verify profile refuses before any packet is sent.
 */
const live = process.env.VTC_LIVE_SANDBOX === "1" && detectGateSandbox().kind === "sandbox-exec";

describe.runIf(live)("live sandbox-exec (opt-in)", () => {
  it("confines writes, denied reads and sockets of a verify-phase command", async () => {
    const work = realpathSync(tempDir("vtc-live-"));
    const checkout = join(work, "checkout");
    const outside = join(work, "outside");
    const secret = join(work, "secret");
    for (const d of [checkout, outside, secret]) mkdirSync(d);
    writeFileSync(join(secret, "f"), "do not read\n");
    const script = `
const fs = require("fs"), net = require("net"), out = {};
const tryIt = (k, f) => { try { f(); out[k] = "ok"; } catch (e) { out[k] = e.code; } };
tryIt("checkout", () => fs.writeFileSync("w.txt", "x"));
tryIt("outside", () => fs.writeFileSync(${JSON.stringify(join(outside, "w.txt"))}, "x"));
tryIt("tmp", () => fs.writeFileSync(require("path").join(process.env.TMPDIR, "w"), "x"));
tryIt("home", () => fs.writeFileSync(require("path").join(process.env.HOME, "w"), "x"));
tryIt("secret", () => fs.readFileSync(${JSON.stringify(join(secret, "f"))}));
const done = () => fs.writeFileSync("out.json", JSON.stringify(out));
const sock = require("path").join(process.env.TMPDIR, "s.sock");
const server = net.createServer((c) => c.end("u")).listen(sock, () => {
  net.connect(sock).on("data", () => { out.unix = "ok"; server.close(); loopback(); })
    .on("error", (e) => { out.unix = e.code; server.close(); loopback(); });
}).on("error", (e) => { out.unix = e.code; loopback(); });
const loopback = () => {
  const s = net.connect(9, "127.0.0.1");
  s.on("error", (e) => { out.loopback = e.code; done(); });
  s.on("connect", () => { out.loopback = "connected"; s.destroy(); done(); });
};
`;
    const jail = new GateCommandJail(detectGateSandbox().sandbox ?? UNSANDBOXED, [
      join(work, "nothing-here"),
      secret,
    ]);
    try {
      const result = await jail.run({
        phase: "verify",
        checkout,
        argv: [process.execPath, "-e", script],
        cwd: checkout,
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 20_000,
        stdoutPath: join(work, "o.log"),
        stderrPath: join(work, "e.log"),
      });
      expect(result.code, readFileSync(join(work, "e.log"), "utf8")).toBe(0);
    } finally {
      jail.dispose();
    }
    expect(JSON.parse(readFileSync(join(checkout, "out.json"), "utf8"))).toEqual({
      checkout: "ok",
      outside: "EPERM",
      tmp: "ok",
      home: "ok",
      secret: "EPERM",
      unix: "ok",
      loopback: "EPERM",
    });
    expect(readdirSync(outside)).toEqual([]);
  });
});

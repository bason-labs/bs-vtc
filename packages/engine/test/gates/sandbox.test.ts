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
import { git, initRepo } from "../helpers/repo.js";
import {
  BROWSERS_DIR,
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
  GATE_MACH_SERVICES,
  GATE_READABLE_VTC_HOME,
  GateCommandJail,
  gateDenyReadPaths,
  gateReadPolicy,
  gateToolchainRoots,
  gitCommonDir,
  OSV_DB_DIR,
  REAPER_SCRIPT,
  RULES_DIR,
  SANDBOX_EXEC,
  sandboxEnv,
  sandboxExecProfile,
  SCANNERS_DIR,
  UNSANDBOXED,
  type GateJailSpec,
  type ReapedGateCommand,
} from "../../src/gates/index.js";
import { fakeReaperSandbox } from "./fixture.js";
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

/** The profile's rules, one per line, without the `(version 1)` header. */
const rulesOf = (profile: string): string[] => profile.split("\n").slice(1);

/** Every `global-name` a profile lets the command look up. */
const machNames = (profile: string): string[] =>
  [...profile.matchAll(/\(global-name "([^"]+)"\)/g)].map((m) => m[1] ?? "");

describe("the macOS sandbox-exec profile", () => {
  it("starts from deny default: nothing is allowed that the profile does not name", () => {
    for (const phase of ["verify", "install"] as const) {
      const { profile } = sandboxExecProfile(spec({ phase }), same);
      const rules = rulesOf(profile);
      expect(profile.startsWith("(version 1)\n(deny default)\n")).toBe(true);
      expect(profile).not.toContain("(allow default)");
      // No operation is allowed wholesale except reading files (narrowed by the deny rules).
      expect(rules.filter((r) => /^\(allow [a-z*-]+\)$/.test(r)).sort()).toEqual(
        [
          "(allow file-read*)",
          "(allow ipc-posix-sem)",
          "(allow process-exec)",
          "(allow process-fork)",
          "(allow sysctl-read)",
          ...(phase === "install" ? ["(allow system-socket)"] : []),
        ].sort(),
      );
      expect(profile).not.toMatch(/\(allow (network\*|mach\*|appleevent|iokit|pseudo-tty)/);
    }
  });

  it("reaches only the system services a toolchain needs, never LaunchServices, AppleEvents, background downloads, the pasteboard or the keychain", () => {
    const verify = machNames(sandboxExecProfile(spec(), same).profile);
    const install = machNames(sandboxExecProfile(spec({ phase: "install" }), same).profile);
    expect(verify).toEqual([...GATE_MACH_SERVICES.always]);
    expect(install).toEqual([...GATE_MACH_SERVICES.always, ...GATE_MACH_SERVICES.install]);
    for (const name of install) {
      expect(name).not.toMatch(
        /launchservices|lsd|appleevents|nsurlsession|pboard|pasteboard|SecurityServer|securityd|coreservicesd|xpc\.launchd|tccd|windowserver/i,
      );
    }
    // Only the per-user-lookup, logging and notification services are reachable in the verify phase.
    expect(GATE_MACH_SERVICES.always).toContain("com.apple.system.opendirectoryd.libinfo");
    // DNS and certificate checks only where the network is.
    expect(GATE_MACH_SERVICES.install).toContain("com.apple.dnssd.service");
    expect(verify).not.toContain("com.apple.dnssd.service");
  });

  it("lets processes signal and inspect only their own sandbox", () => {
    const rules = rulesOf(sandboxExecProfile(spec(), same).profile);
    expect(rules).toContain("(allow signal (target same-sandbox))");
    expect(rules).toContain("(allow process-info* (target same-sandbox))");
    expect(rules.filter((r) => r.startsWith("(allow signal"))).toHaveLength(1);
  });

  it("makes the run's dependency caches writable when the jail gives them (reading 252)", () => {
    const wrapped = createSandboxExecSandbox({ realpath: same }).wrap(["node", "t.mjs"], {
      ...spec(),
      deps: "/tmp/vtc-gate-1/deps",
    } as GateJailSpec);
    const params = paramsOf(wrapped.args);
    expect(params.DEPS).toBe("/tmp/vtc-gate-1/deps");
    const rules = rulesOf(wrapped.args[1] ?? "");
    expect(rules).toContainEqual(
      expect.stringMatching(
        /^\(allow file-read-data .*file-write\* .*\(subpath \(param "DEPS"\)\)\)$/,
      ),
    );
    // without them, no DEPS parameter and nothing more writable
    expect(
      paramsOf(createSandboxExecSandbox({ realpath: same }).wrap(["x"], spec()).args).DEPS,
    ).toBeUndefined();
  });

  it("denies the network in the verify phase except Unix sockets inside the writable directories", () => {
    const wrapped = createSandboxExecSandbox({ realpath: same }).wrap(
      ["node", "test.mjs", "--x"],
      spec(),
    );
    expect(wrapped.command).toBe(SANDBOX_EXEC);
    expect(wrapped.network).toBe("none");
    const args = wrapped.args;
    expect(args[0]).toBe("-p");
    const rules = rulesOf(args[1] ?? "");
    const network = rules.filter((r) => /^\(allow (network|system-socket)/.test(r));
    expect(network).toEqual([
      "(allow system-socket (socket-domain AF_UNIX))",
      ...["CHECKOUT", "TEMP", "HOME"].flatMap((k) => [
        `(allow network-bind network-inbound (local unix-socket (subpath (param "${k}"))))`,
        `(allow network-outbound (remote unix-socket (subpath (param "${k}"))))`,
      ]),
    ]);
    // Paths travel as -D parameters, never spliced into the profile text.
    expect(args[1]).not.toContain("/work/repo");
    expect(args[1]).not.toContain("/home/u");
    const params = paramsOf(args);
    expect(params.CHECKOUT).toBe("/work/repo/.vtc/state/checkouts/abc");
    expect(params.TEMP).toBe("/tmp/vtc-gate-1/tmp-0");
    expect(params.HOME).toBe("/tmp/vtc-gate-1/home");
    expect(
      Object.entries(params)
        .filter(([k]) => k.startsWith("DENY_"))
        .map(([, v]) => v),
    ).toEqual(["/home/u/.vtc/token", "/home/u/.claude"]);
    // Without the jail's sentinel there is no reaper: the gate's own argv follows `--` unchanged.
    expect(args.slice(args.indexOf("--") + 1)).toEqual(["node", "test.mjs", "--x"]);
  });

  it("gives the install phase IP networking but no Unix socket outside the writable directories except DNS", () => {
    const wrapped = createSandboxExecSandbox({ realpath: same }).wrap(
      ["pnpm", "install"],
      spec({ phase: "install" }),
    );
    expect(wrapped.network).toBe("full");
    const rules = rulesOf(wrapped.args[1] ?? "");
    const network = rules.filter((r) => /^\(allow (network|system-socket)/.test(r));
    expect(network).toEqual([
      "(allow system-socket)",
      "(allow network-outbound (remote ip))",
      "(allow network-bind network-inbound (local ip))",
      '(allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
      ...["CHECKOUT", "TEMP", "HOME"].flatMap((k) => [
        `(allow network-bind network-inbound (local unix-socket (subpath (param "${k}"))))`,
        `(allow network-outbound (remote unix-socket (subpath (param "${k}"))))`,
      ]),
    ]);
    // The engine socket (~/.vtc/run), agent sockets and Docker are Unix sockets: none is reachable.
    expect(rules).not.toContain("(allow network-outbound)");
    // Nor is the host's loopback (the engine's API, the prototype origin, local databases): the
    // deny follows the allow, so it wins (Linux: pasta maps no loopback).
    const allowIp = rules.indexOf("(allow network-outbound (remote ip))");
    const denyLoopback = rules.indexOf('(deny network-outbound (remote ip "localhost:*"))');
    expect(denyLoopback).toBeGreaterThan(allowIp);
  });

  it("gives the verify phase no IP socket at all by default (D-av)", () => {
    const rules = rulesOf(sandboxExecProfile(spec(), same).profile);
    expect(rules.filter((r) => r.includes("remote ip") || r.includes("local ip"))).toEqual([]);
    expect(rules).not.toContain("(allow system-socket)");
  });

  it("with gates.yml sandbox.verify_loopback, the verify phase reaches the loopback only (D-av)", () => {
    const wrapped = createSandboxExecSandbox({ realpath: same }).wrap(["node", "test.mjs"], {
      ...spec(),
      loopback: true,
    });
    expect(wrapped.network).toBe("none");
    const rules = rulesOf(wrapped.args[1] ?? "");
    const network = rules.filter((r) => /^\((allow|deny) (network|system-socket)/.test(r));
    expect(network).toEqual([
      "(allow system-socket)",
      '(allow network-outbound (remote ip "localhost:*"))',
      '(allow network-bind network-inbound (local ip "localhost:*"))',
      ...["CHECKOUT", "TEMP", "HOME"].flatMap((k) => [
        `(allow network-bind network-inbound (local unix-socket (subpath (param "${k}"))))`,
        `(allow network-outbound (remote unix-socket (subpath (param "${k}"))))`,
      ]),
    ]);
    expect(rules).not.toContain("(allow network-outbound (remote ip))");
    // the install phase ignores it: it never reaches the host loopback
    const install = rulesOf(
      sandboxExecProfile({ ...spec({ phase: "install" }), loopback: true }, same).profile,
    );
    expect(install).toContain('(deny network-outbound (remote ip "localhost:*"))');
  });

  it("opens only the given loopback ports to a verify-phase command (the visual app server)", () => {
    const wrapped = createSandboxExecSandbox({ realpath: same }).wrap(["node", "runner.mjs"], {
      ...spec(),
      loopbackPorts: [4173, 4173],
    } as GateJailSpec);
    const rules = rulesOf(wrapped.args[1] ?? "");
    const network = rules.filter((r) => /^\((allow|deny) (network|system-socket)/.test(r));
    expect(network).toEqual([
      "(allow system-socket)",
      '(allow network-outbound (remote ip "localhost:4173"))',
      '(allow network-bind network-inbound (local ip "localhost:4173"))',
      ...["CHECKOUT", "TEMP", "HOME"].flatMap((k) => [
        `(allow network-bind network-inbound (local unix-socket (subpath (param "${k}"))))`,
        `(allow network-outbound (remote unix-socket (subpath (param "${k}"))))`,
      ]),
    ]);
    expect(rules.some((r) => r.includes('"localhost:*"'))).toBe(false);
    // The install phase never reaches the host loopback, ports or not.
    const install = rulesOf(
      sandboxExecProfile({ ...spec({ phase: "install" }), loopbackPorts: [4173] }, same).profile,
    );
    expect(install).toContain('(deny network-outbound (remote ip "localhost:*"))');
    expect(install.some((r) => r.includes("localhost:4173"))).toBe(false);
    for (const bad of [0, 70_000, 1.5]) {
      expect(() =>
        createSandboxExecSandbox({ realpath: same }).wrap(["node"], {
          ...spec(),
          loopbackPorts: [bad],
        } as GateJailSpec),
      ).toThrow(/not a loopback port/);
    }
  });

  it("writes only the checkout, temp and home, /dev/null and /dev/zero and its own descriptors, never a terminal", () => {
    const rules = rulesOf(sandboxExecProfile(spec(), same).profile);
    const writes = rules.filter((r) => r.includes("file-write"));
    expect(writes).toEqual([
      '(allow file-read-data file-read-metadata file-read-xattr file-write* (subpath (param "CHECKOUT")) (subpath (param "TEMP")) (subpath (param "HOME")))',
      '(allow file-write-data (literal "/dev/null") (literal "/dev/zero") (subpath "/dev/fd"))',
    ]);
    expect(rules.filter((r) => r.startsWith("(allow") && r.includes("tty"))).toEqual([]);
    // The user's terminals cannot even be opened for reading.
    expect(rules).toContain(
      '(deny file-read* file-read-data file-read-metadata file-read-xattr (literal "/dev/tty") (regex #"^/dev/ttys[0-9]+$"))',
    );
  });

  it("hides the contents of the masked directories, re-allows the readable roots inside them, and denies the deny list last", () => {
    const jailSpec: GateJailSpec = {
      ...spec(),
      hideRead: ["/home/u", "/work/repo/.vtc/state"],
      allowRead: ["/home/u/.nvm", "/work/repo/.git"],
    };
    const { profile, params } = sandboxExecProfile(jailSpec, same);
    const p = Object.fromEntries(params);
    expect([p.HIDE_0, p.HIDE_1, p.READ_0, p.READ_1]).toEqual([
      "/home/u",
      "/work/repo/.vtc/state",
      "/home/u/.nvm",
      "/work/repo/.git",
    ]);
    const rules = rulesOf(profile);
    const at = (rule: string): number => {
      const i = rules.indexOf(rule);
      expect(i, rule).toBeGreaterThanOrEqual(0);
      return i;
    };
    // Names and metadata stay visible (tools resolve paths through these directories), contents not.
    const hide = at('(deny file-read-data file-read-xattr (subpath (param "HIDE_0")))');
    // The same operations as the hide rule: a rule for file-read* would lose to the specific one.
    const read = at(
      '(allow file-read-data file-read-metadata file-read-xattr (subpath (param "READ_0")))',
    );
    const writable = rules.findIndex((r) => r.includes('(subpath (param "CHECKOUT"))'));
    const deny = at(
      '(deny file-read* file-read-data file-read-metadata file-read-xattr (subpath (param "DENY_0")))',
    );
    expect(at("(allow file-read*)")).toBeLessThan(hide);
    expect(hide).toBeLessThan(read);
    expect(read).toBeLessThan(writable);
    expect(writable).toBeLessThan(deny);
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

  it("runs the command under the in-sandbox reaper when the jail gives a sentinel", () => {
    const jailSpec: GateJailSpec = { ...spec(), reapSentinel: "/tmp/vtc-gate-1/sandboxed" };
    const wrapped = createSandboxExecSandbox({ realpath: same }).wrap(["node", "t.mjs"], jailSpec);
    const after = wrapped.args.slice(wrapped.args.indexOf("--") + 1);
    expect(after).toEqual([
      "/bin/sh",
      "-c",
      REAPER_SCRIPT,
      "vtc-gate",
      "/tmp/vtc-gate-1/sandboxed",
      "node",
      "t.mjs",
    ]);
    expect(paramsOf(wrapped.args).SENTINEL).toBe("/tmp/vtc-gate-1/sandboxed");
    // The sentinel's contents are unreadable inside the sandbox only: the reaper kills nothing outside one.
    expect(wrapped.args[1]).toContain(
      '(deny file-read-data file-read-xattr (literal (param "SENTINEL")))',
    );
    expect(REAPER_SCRIPT).toContain("kill -KILL -1");
    expect(REAPER_SCRIPT).toMatch(/\[ -e "\$s" \] && ! \(: <"\$s"\)/);
  });

  it("refuses an empty argv and relative paths", () => {
    const sandbox = createSandboxExecSandbox({ realpath: same });
    expect(() => sandbox.wrap([], spec())).toThrow(/empty/);
    expect(() => sandbox.wrap(["x"], spec({ checkout: "rel/path" }))).toThrow(/absolute/);
    const relativeHide: GateJailSpec = { ...spec(), hideRead: ["rel"] };
    expect(() => sandbox.wrap(["x"], relativeHide)).toThrow(/absolute/);
  });
});

describe("the Linux bwrap argv", () => {
  const kinds: Record<string, "dir" | "file"> = {
    "/usr": "dir",
    "/bin": "dir",
    "/lib": "dir",
    "/lib64": "dir",
    "/etc": "dir",
    "/etc/resolv.conf": "file",
    "/opt": "dir",
    "/sys": "dir",
    "/home/u/.vtc/token": "file",
    "/home/u/.claude": "dir",
    "/home/u/.nvm": "dir",
    "/opt/repo/.git": "dir",
    "/opt/repo/.vtc/state": "dir",
    "/opt/repo/.vtc/state/checkouts/abc": "dir",
    "/tmp/vtc-gate-1/home": "dir",
    "/tmp/vtc-gate-1/tmp-0": "dir",
    "/work/repo/.vtc/state/checkouts/abc": "dir",
  };
  const links: Record<string, string> = {
    "/bin": "/usr/bin",
    "/lib": "/usr/lib",
    "/etc/resolv.conf": "/run/systemd/resolve/stub-resolv.conf",
  };
  const fs = { realpath: (p: string) => links[p] ?? p, kind: (p: string) => kinds[p] ?? null };
  const pairs = (args: readonly string[], flag: string): string[][] =>
    args.flatMap((a, i) => (a === flag ? [[args[i + 1] ?? "", args[i + 2] ?? ""]] : []));
  const mountsOf = (args: readonly string[]): string[] => {
    const out: string[] = [];
    for (let i = 0; i < args.length; i += 1) {
      const a = args[i] ?? "";
      if (a === "--") break;
      if (["--ro-bind", "--bind", "--symlink"].includes(a)) out.push(`${a} ${args[i + 2] ?? ""}`);
      if (a === "--tmpfs") out.push(`${a} ${args[i + 1] ?? ""}`);
    }
    return out;
  };

  it("binds the run's dependency caches writable, beside the checkout, home and temp dir (reading 252)", () => {
    const deps = "/tmp/vtc-gate-1/deps";
    for (const phase of ["install", "verify"] as const) {
      const args = bwrapArgs(["node", "t.mjs"], { ...spec({ phase }), deps }, fs);
      expect(pairs(args, "--bind")).toContainEqual([deps, deps]);
    }
    expect(pairs(bwrapArgs(["node", "t.mjs"], spec(), fs), "--bind").map(([a]) => a)).not.toContain(
      deps,
    );
  });

  it("builds a minimal root: system directories read-only, no host root, no host /tmp, /run or /var", () => {
    const args = bwrapArgs(["node", "t.mjs"], spec(), fs);
    expect(args).toContain("--unshare-net");
    expect(args).toContain("--die-with-parent");
    expect(args).toContain("--new-session");
    expect(pairs(args, "--ro-bind")).not.toContainEqual(["/", "/"]);
    expect(pairs(args, "--ro-bind")).toContainEqual(["/usr", "/usr"]);
    expect(pairs(args, "--ro-bind")).toContainEqual(["/etc", "/etc"]);
    // Merged-/usr links stay links.
    expect(pairs(args, "--symlink")).toContainEqual(["/usr/bin", "/bin"]);
    const mounts = mountsOf(args);
    // Host IPC endpoints (the D-Bus session bus under /run/user, X11 under /tmp/.X11-unix, Docker
    // under /var/run, agent sockets) are never mounted: /tmp is a fresh tmpfs, /run and /var absent.
    expect(mounts).toContain("--tmpfs /tmp");
    for (const m of mounts) {
      expect(m).not.toMatch(/ \/run(\/|$)| \/var\/run| \/tmp\/\.X11-unix| \/home(\/|$)/);
    }
    expect(args.slice(args.indexOf("--") + 1)).toEqual(["node", "t.mjs"]);
  });

  it("binds the checkout, home and temp dir writable after the /tmp tmpfs, and hides denied paths that are visible", () => {
    const args = bwrapArgs(
      ["node", "t.mjs"],
      { ...spec(), allowRead: ["/home/u/.nvm"], denyRead: ["/home/u/.nvm/token", "/etc/shadow"] },
      {
        ...fs,
        kind: (p) => (p === "/home/u/.nvm/token" || p === "/etc/shadow" ? "file" : fs.kind(p)),
      },
    );
    expect(pairs(args, "--bind")).toEqual([
      ["/tmp/vtc-gate-1/home", "/tmp/vtc-gate-1/home"],
      ["/tmp/vtc-gate-1/tmp-0", "/tmp/vtc-gate-1/tmp-0"],
      ["/work/repo/.vtc/state/checkouts/abc", "/work/repo/.vtc/state/checkouts/abc"],
    ]);
    const mounts = mountsOf(args);
    expect(mounts.indexOf("--tmpfs /tmp")).toBeLessThan(
      mounts.indexOf("--bind /tmp/vtc-gate-1/home"),
    );
    expect(pairs(args, "--ro-bind")).toContainEqual(["/home/u/.nvm", "/home/u/.nvm"]);
    // A denied file inside a bound root is replaced by /dev/null, after every bind.
    expect(mounts.slice(-2)).toEqual(["--ro-bind /home/u/.nvm/token", "--ro-bind /etc/shadow"]);
    expect(pairs(args, "--ro-bind")).toContainEqual(["/dev/null", "/etc/shadow"]);
    // A denied path that is not mounted at all needs nothing: /home/u/.claude is simply absent.
    expect(args.join(" ")).not.toContain("/home/u/.claude");
  });

  it("hides a masked directory that a bound root would show, and binds the readable roots and checkout inside it again", () => {
    const args = bwrapArgs(
      ["x"],
      {
        ...spec({ checkout: "/opt/repo/.vtc/state/checkouts/abc" }),
        hideRead: ["/opt/repo/.vtc/state", "/home/u"],
        allowRead: ["/opt/repo/.git"],
      },
      fs,
    );
    const mounts = mountsOf(args);
    const hide = mounts.indexOf("--tmpfs /opt/repo/.vtc/state");
    expect(hide).toBeGreaterThan(mounts.indexOf("--ro-bind /opt"));
    expect(hide).toBeLessThan(mounts.indexOf("--bind /opt/repo/.vtc/state/checkouts/abc"));
    expect(mounts).toContain("--ro-bind /opt/repo/.git");
    // /home/u is not under any bound root: nothing to hide.
    expect(mounts.join(" ")).not.toContain("/home/u");
  });

  const linux = {
    binary: "/usr/bin/bwrap",
    pasta: "/usr/bin/pasta",
    uid: 1000,
    gid: 1000,
    ...fs,
  };
  /** The argv before the first `--` (a pasta or bwrap option list). */
  const head = (args: readonly string[]): string[] =>
    args.includes("--") ? args.slice(0, args.indexOf("--")) : [...args];
  const resolvConf = "/tmp/vtc-gate-1/resolv.conf";

  it("runs the verify phase in bwrap's own network namespace, with no pasta", () => {
    const wrapped = createBwrapSandbox(linux).wrap(["node", "t.mjs"], spec());
    expect(wrapped.command).toBe("/usr/bin/bwrap");
    expect(wrapped.network).toBe("none");
    expect(head(wrapped.args)).toContain("--unshare-net");
    expect(wrapped.args).not.toContain("/usr/bin/pasta");
  });

  it("runs the install phase in a network namespace of its own (pasta), so abstract Unix sockets and host loopback stay out of reach", () => {
    const sandbox = createBwrapSandbox(linux);
    const wrapped = sandbox.wrap(["pnpm", "install"], {
      ...spec({ phase: "install" }),
      resolvConf,
    } as GateJailSpec);
    // pasta starts a new user and network namespace with user-mode IP networking; the host's
    // abstract AF_UNIX names (X11's @/tmp/.X11-unix/X0, a unix:abstract= D-Bus bus) belong to
    // the host's network namespace and do not exist in it.
    expect(wrapped.command).toBe("/usr/bin/pasta");
    expect(wrapped.network).toBe("full");
    const pasta = head(wrapped.args);
    expect(pasta).toContain("--config-net");
    expect(pasta).not.toContain("--netns-only");
    expect(pasta).not.toContain("--netns");
    // No port forwarding in either direction: a namespace port never reaches a host loopback
    // service (the engine, a database), and the host never reaches into the sandbox.
    for (const flag of ["-t", "-u", "-T", "-U"]) {
      expect(pairs(["", ...pasta], flag)).toContainEqual(["none", expect.any(String)]);
    }
    // The gateway address is not the host's loopback.
    expect(pasta).toContain("--no-map-gw");
    expect(pairs(["", ...pasta], "--dns-forward")).toContainEqual([
      "169.254.1.1",
      expect.any(String),
    ]);
    // After pasta: bwrap, in pasta's namespace (no --unshare-net, which would drop the network),
    // as the real uid rather than pasta's namespace root.
    const rest = wrapped.args.slice(wrapped.args.indexOf("--") + 1);
    expect(rest[0]).toBe("/usr/bin/bwrap");
    const bwrap = head(rest.slice(1));
    expect(bwrap).not.toContain("--unshare-net");
    expect(bwrap).toContain("--unshare-pid");
    expect(bwrap).toContain("--unshare-user");
    expect(pairs(["", ...bwrap], "--uid")).toContainEqual(["1000", expect.any(String)]);
    expect(pairs(["", ...bwrap], "--gid")).toContainEqual(["1000", expect.any(String)]);
    expect(rest.slice(rest.indexOf("--") + 1)).toEqual(["pnpm", "install"]);
    // DNS goes to pasta's forwarder: the jail's resolv.conf sits where /etc/resolv.conf points
    // (often into /run, which is otherwise absent).
    expect(pairs(bwrap, "--ro-bind")).toContainEqual([
      resolvConf,
      "/run/systemd/resolve/stub-resolv.conf",
    ]);
    expect(pairs(bwrapArgs(["x"], spec(), fs), "--ro-bind")).not.toContainEqual([
      resolvConf,
      "/run/systemd/resolve/stub-resolv.conf",
    ]);
  });

  it("never shares the host's network namespace, in either phase", () => {
    const sandbox = createBwrapSandbox(linux);
    for (const phase of ["install", "verify"] as const) {
      const wrapped = sandbox.wrap(["x"], { ...spec({ phase }), resolvConf } as GateJailSpec);
      const ownNet =
        (wrapped.command === "/usr/bin/bwrap" && head(wrapped.args).includes("--unshare-net")) ||
        (wrapped.command === "/usr/bin/pasta" && head(wrapped.args).includes("--config-net"));
      expect(ownNet, phase).toBe(true);
    }
  });

  it("refuses an install-phase command without the jail's resolv.conf", () => {
    const sandbox = createBwrapSandbox(linux);
    expect(() => sandbox.wrap(["pnpm", "install"], spec({ phase: "install" }))).toThrow(
      /resolv\.conf/,
    );
    expect(() =>
      sandbox.wrap(["pnpm", "install"], {
        ...spec({ phase: "install" }),
        resolvConf: "rel",
      } as GateJailSpec),
    ).toThrow(/absolute/);
  });

  it("skips paths that do not exist (there is nothing to read, and bwrap cannot mount over them)", () => {
    const args = bwrapArgs(["x"], { ...spec({ denyRead: ["/nope"] }), allowRead: ["/gone"] }, fs);
    expect(args).not.toContain("/nope");
    expect(args).not.toContain("/gone");
    expect(pairs(args, "--ro-bind")).not.toContainEqual(["/nix", "/nix"]);
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

  it("uses bwrap and pasta on Linux from absolute PATH entries when both probe runs succeed", () => {
    const probes: string[][] = [];
    const found = detectGateSandbox({
      platform: "linux",
      env: { PATH: "relative/bin:/opt/bin:/usr/bin" },
      exists: (p) => p === "/usr/bin/bwrap" || p === "relative/bin/bwrap" || p === "/opt/bin/pasta",
      probe: (argv) => {
        probes.push([...argv]);
        return (
          (argv[0] === "/usr/bin/bwrap" && argv.includes("--unshare-net")) ||
          (argv[0] === "/opt/bin/pasta" &&
            argv.includes("--config-net") &&
            argv.includes("/usr/bin/bwrap"))
        );
      },
    });
    expect(found.kind).toBe("bwrap");
    expect(found.detail).toContain("/usr/bin/bwrap");
    expect(found.detail).toContain("/opt/bin/pasta");
    expect(probes.map((p) => p[0])).toEqual(["/usr/bin/bwrap", "/opt/bin/pasta"]);
    const wrapped = found.sandbox?.wrap(["x"], {
      ...spec({ phase: "install" }),
      resolvConf: "/tmp/vtc-gate-1/resolv.conf",
    } as GateJailSpec);
    expect(wrapped?.command).toBe("/opt/bin/pasta");
  });

  it("on Linux without pasta, verify-phase gates still run in bwrap and only install-phase gates refuse (D-aw)", () => {
    const noPasta = detectGateSandbox({
      platform: "linux",
      env: { PATH: "/usr/bin" },
      exists: (p) => p === "/usr/bin/bwrap",
      probe: () => true,
    });
    expect(noPasta.kind).toBe("bwrap");
    expect(noPasta.warning).toMatch(/pasta/);
    expect(noPasta.warning).toMatch(/install-phase gates/);
    const sandbox = noPasta.sandbox;
    if (sandbox === null) throw new Error("expected a sandbox");
    expect(sandbox.wrap(["x"], spec()).command).toBe("/usr/bin/bwrap");
    expect(() =>
      sandbox.wrap(["pnpm", "install"], {
        ...spec({ phase: "install" }),
        resolvConf: "/tmp/vtc-gate-1/resolv.conf",
      } as GateJailSpec),
    ).toThrow(/pasta/);
    const pastaBroken = detectGateSandbox({
      platform: "linux",
      env: { PATH: "/usr/bin" },
      exists: (p) => p === "/usr/bin/bwrap" || p === "/usr/bin/pasta",
      probe: (argv) => argv[0] === "/usr/bin/bwrap",
    });
    expect(pastaBroken.kind).toBe("bwrap");
    expect(pastaBroken.warning).toMatch(/pasta/);
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
    expect(GATE_READABLE_VTC_HOME).toEqual([SCANNERS_DIR, RULES_DIR, OSV_DB_DIR, BROWSERS_DIR]);
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

  it("denies the credential stores of common package managers, registries and tools", () => {
    const deny = gateDenyReadPaths("/nowhere/.vtc", { HOME: "/home/u" });
    for (const p of [
      ".cargo/credentials.toml",
      ".yarnrc.yml",
      ".bunfig.toml",
      ".gradle/gradle.properties",
      ".m2/settings.xml",
      ".terraform.d/credentials.tfrc.json",
      ".vault-token",
      ".pgpass",
      ".config/op",
      ".config/hub",
      ".config/containers",
      ".local/share/keyrings",
      ".gem/credentials",
    ]) {
      expect(deny).toContain(join("/home/u", p));
    }
  });
});

describe("what a gate may read (the read policy)", () => {
  it("hides the whole real home and the repo's .vtc/state, and denies the repo's evidence", () => {
    const policy = gateReadPolicy({
      vtcHome: "/home/u/.vtc",
      env: { HOME: "/home/u", PATH: "/usr/bin" },
      repoRoot: "/work/repo",
      homedir: "/home/u",
    });
    expect(policy.hideRead).toEqual(["/home/u", "/work/repo/.vtc/state"]);
    expect(policy.denyRead).toContain("/work/repo/.vtc/evidence");
    expect(policy.denyRead).toEqual(
      expect.arrayContaining(gateDenyReadPaths("/home/u/.vtc", { HOME: "/home/u" })),
    );
    // The VTC home entries the gates run with stay readable inside the hidden home.
    for (const name of GATE_READABLE_VTC_HOME) {
      expect(policy.allowRead).toContain(join("/home/u/.vtc", name));
    }
  });

  it("hides the account's home as well when HOME was moved", () => {
    const policy = gateReadPolicy({
      vtcHome: "/v",
      env: { HOME: "/elsewhere/home" },
      homedir: "/home/u",
    });
    expect(policy.hideRead).toEqual(["/elsewhere/home", "/home/u"]);
  });

  it("keeps the toolchains on PATH and in the toolchain variables readable, never the home itself or a parent of it", () => {
    const roots = gateToolchainRoots(
      {
        HOME: "/home/u",
        PATH: [
          "/home/u/.nvm/versions/node/v22.17.1/bin",
          "/home/u/.local/bin",
          "/home/u/bin",
          "/home/u/.pyenv/shims",
          "/home/u/Library/pnpm",
          "/home/u",
          "/home",
          "/",
          "relative/bin",
          "/usr/bin",
        ].join(":"),
        NVM_DIR: "/home/u/.nvm",
        RUSTUP_HOME: "/home/u/.rustup",
        JAVA_HOME: "relative/jdk",
      },
      ["/home/u"],
    );
    expect(roots).toEqual([
      "/home/u/.nvm/versions/node/v22.17.1",
      "/home/u/.local/bin",
      "/home/u/bin",
      "/home/u/.pyenv",
      "/home/u/Library/pnpm",
      "/usr",
      "/home/u/.nvm",
      "/home/u/.rustup",
    ]);
  });

  it("keeps the repo's git directory readable (a verification checkout is a linked worktree)", () => {
    const repo = realpathSync(initRepo());
    expect(gitCommonDir(repo)).toBe(join(repo, ".git"));
    const linked = join(repo, ".vtc/state/checkouts/x");
    git(repo, "worktree", "add", "--detach", "--quiet", linked);
    // From a linked worktree, the common directory is the main repo's .git.
    expect(gitCommonDir(linked)).toBe(join(repo, ".git"));
    expect(gitCommonDir(join(repo, "nope"))).toBeNull();
    const policy = gateReadPolicy({ vtcHome: "/v", env: {}, repoRoot: repo, homedir: "/home/u" });
    expect(policy.allowRead).toContain(join(repo, ".git"));
  });
});

describe("the gate environment in the sandbox", () => {
  it("points HOME, the XDG dirs and the temp variables at the per-run directories and drops VTC_HOME and caches outside them", () => {
    const env = sandboxEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/u",
        VTC_HOME: "/home/u/.vtc",
        GOCACHE: "/home/u/go-cache",
        CARGO_HOME: "/home/u/.cargo",
      },
      { home: "/t/home", tempDir: "/t/tmp-0" },
    );
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/t/home",
      USERPROFILE: "/t/home",
      XDG_CONFIG_HOME: "/t/home/.config",
      XDG_CACHE_HOME: "/t/home/.cache",
      XDG_DATA_HOME: "/t/home/.local/share",
      XDG_STATE_HOME: "/t/home/.local/state",
      TMPDIR: "/t/tmp-0",
      TMP: "/t/tmp-0",
      TEMP: "/t/tmp-0",
    });
  });

  it("points Go's module cache and Cargo's home at the run's own dependency caches when given", () => {
    const env = sandboxEnv(
      { PATH: "/usr/bin", GOMODCACHE: "/home/u/go/pkg/mod", CARGO_HOME: "/home/u/.cargo" },
      {
        home: "/t/home-verify",
        tempDir: "/t/tmp-1",
        goModCache: "/t/deps/go-mod",
        cargoHome: "/t/deps/cargo-verify",
      },
    );
    expect(env).toMatchObject({
      GOMODCACHE: "/t/deps/go-mod",
      CARGO_HOME: "/t/deps/cargo-verify",
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
    // the install phase and the verify phase never share a home (spine §5 reading 252)
    expect(specs[0]?.home).not.toBe(specs[1]?.home);
    expect(specs[0]?.tempDir).not.toBe(specs[1]?.tempDir);
    expect(specs[0]?.checkout).toBe(realpathSync(checkout));
    expect(specs[0]?.denyRead).toEqual(["/denied"]);
    const a = JSON.parse(readFileSync(join(checkout, "env-a.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(a).toEqual({ home: specs[0]?.home, tmp: specs[0]?.tempDir, vtc: null, listed: [] });
    expect(jail.ran).toBe(true);
    const b = JSON.parse(readFileSync(join(checkout, "env-b.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(b).toEqual({ home: specs[1]?.home, tmp: specs[1]?.tempDir, vtc: null, listed: [] });
    const home = specs[0]?.home ?? "";
    expect(existsSync(home)).toBe(true);
    jail.dispose();
    expect(existsSync(home)).toBe(false);
    expect(existsSync(specs[1]?.home ?? "")).toBe(false);
  });

  it("gives the verify phase a fresh home and Cargo home, and keeps only the download caches (reading 252)", async () => {
    const work = tempDir("vtc-jail-");
    const checkout = join(work, "checkout");
    mkdirSync(checkout);
    const { sandbox, specs } = recording();
    const jail = new GateCommandJail(sandbox, []);
    // the install phase: user-level config in its home, a Cargo config in its own and in the
    // verify phase's Cargo home, and a downloaded module in each shared cache
    const plant = `const fs = require("fs"), p = require("path"), e = process.env;
fs.writeFileSync(p.join(e.HOME, ".npmrc"), "node-options=--require=/x.cjs\\n");
fs.mkdirSync(p.join(e.XDG_CONFIG_HOME, "pip"), { recursive: true });
fs.writeFileSync(p.join(e.CARGO_HOME, "config.toml"), "[build]\\nrustc-wrapper = '/x'\\n");
fs.mkdirSync(p.join(e.CARGO_HOME, "..", "cargo-verify"), { recursive: true });
fs.writeFileSync(p.join(e.CARGO_HOME, "..", "cargo-verify", "config.toml"), "planted");
fs.mkdirSync(p.join(e.GOMODCACHE, "example.com", "m@v1"), { recursive: true });
fs.writeFileSync(p.join(e.GOMODCACHE, "example.com", "m@v1", "m.go"), "package m");
fs.mkdirSync(p.join(e.CARGO_HOME, "registry", "src"), { recursive: true });
fs.writeFileSync(p.join(e.CARGO_HOME, "registry", "src", "crate.rs"), "fn main() {}");`;
    const look = `const fs = require("fs"), p = require("path"), e = process.env;
fs.writeFileSync("seen.json", JSON.stringify({
  home: fs.readdirSync(e.HOME),
  cargo: fs.readdirSync(e.CARGO_HOME).sort(),
  module: fs.existsSync(p.join(e.GOMODCACHE, "example.com", "m@v1", "m.go")),
  crate: fs.existsSync(p.join(e.CARGO_HOME, "registry", "src", "crate.rs")),
}));`;
    for (const [phase, script] of [
      ["install", plant],
      ["verify", look],
    ] as const) {
      const result = await jail.run({
        phase,
        checkout,
        argv: [process.execPath, "-e", script],
        cwd: checkout,
        env: sandboxEnvInput(),
        timeoutMs: 20_000,
        stdoutPath: join(work, `${phase}.out`),
        stderrPath: join(work, `${phase}.err`),
      });
      expect(result.code, readFileSync(join(work, `${phase}.err`), "utf8")).toBe(0);
    }
    expect(JSON.parse(readFileSync(join(checkout, "seen.json"), "utf8"))).toEqual({
      home: [],
      cargo: ["git", "registry"],
      module: true,
      crate: true,
    });
    // the shared caches are writable in both phases; each home only in its own
    const [install, verify] = specs as GateJailSpec[];
    expect(install?.deps).toBeDefined();
    expect(verify?.deps).toBe(install?.deps);
    expect(verify?.home).not.toBe(install?.home);
    expect((verify?.home ?? "").startsWith(`${install?.deps ?? ""}/`)).toBe(false);
    jail.dispose();
  });

  it("removes one command's temp directory on request, and nothing outside the run's own", async () => {
    const work = tempDir("vtc-jail-");
    const checkout = join(work, "checkout");
    mkdirSync(checkout);
    const { sandbox } = recording();
    const jail = new GateCommandJail(sandbox, []);
    const run = () =>
      jail.run({
        phase: "verify",
        checkout,
        argv: [process.execPath, "-e", ""],
        cwd: checkout,
        env: sandboxEnvInput(),
        timeoutMs: 20_000,
        stdoutPath: join(work, "o"),
        stderrPath: join(work, "e"),
        setup: (tmp) => {
          mkdirSync(join(tmp, "out"));
          writeFileSync(join(tmp, "out", "input.json"), "{}");
        },
      });
    const first = await run();
    const second = await run();
    jail.removeTempDir(first.tempDir);
    expect(existsSync(first.tempDir)).toBe(false);
    expect(existsSync(second.tempDir)).toBe(true);
    jail.removeTempDir(checkout);
    jail.removeTempDir(jail.homeDir());
    expect(existsSync(checkout)).toBe(true);
    expect(existsSync(jail.homeDir())).toBe(true);
    jail.dispose();
  });

  it("hands the sandbox the hidden and readable roots and, for a reaper, a sentinel it cannot read", async () => {
    const work = tempDir("vtc-jail-");
    const checkout = join(work, "checkout");
    mkdirSync(checkout);
    const { sandbox, specs } = recording();
    const jail = new GateCommandJail(sandbox, ["/denied"], {
      hideRead: ["/home/u"],
      allowRead: ["/home/u/.nvm"],
    });
    const result = await jail.run({
      phase: "verify",
      checkout,
      argv: [process.execPath, "-e", ""],
      cwd: checkout,
      env: sandboxEnvInput(),
      timeoutMs: 20_000,
      stdoutPath: join(work, "o"),
      stderrPath: join(work, "e"),
    });
    expect(result.code).toBe(0);
    const s = specs[0] as GateJailSpec;
    expect(s.hideRead).toEqual(["/home/u"]);
    expect(s.allowRead).toEqual(["/home/u/.nvm"]);
    // The sentinel sits in the run's private root, outside every writable directory.
    expect(s.reapSentinel).toBeDefined();
    expect(existsSync(s.reapSentinel ?? "")).toBe(true);
    for (const dir of [s.home, s.tempDir, s.checkout]) {
      expect((s.reapSentinel ?? "").startsWith(`${dir}/`)).toBe(false);
    }
    // The resolv.conf a Linux install phase uses (pasta's DNS forwarder), in the same private
    // root, outside every writable directory.
    expect(s.resolvConf).toBeDefined();
    expect(readFileSync(s.resolvConf ?? "", "utf8")).toBe("nameserver 169.254.1.1\n");
    for (const dir of [s.home, s.tempDir, s.checkout]) {
      expect((s.resolvConf ?? "").startsWith(`${dir}/`)).toBe(false);
    }
    jail.dispose();
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

/** Starts a detached child in its own session that writes `late` after 1.5 s, then exits. */
const ORPHAN = `
const { spawn } = require("child_process");
const c = spawn(process.execPath, ["-e", "setTimeout(() => require('fs').writeFileSync('late', 'still here'), 1500)"], { detached: true, stdio: "ignore" });
require("fs").writeFileSync("orphan.pid", String(c.pid));
c.unref();
`;

describe.skipIf(process.platform === "win32")(
  "the reaper protocol (macOS: no PID namespace)",
  () => {
    const runOrphan = async (
      sandbox: GateSandbox,
    ): Promise<{ jail: GateCommandJail; checkout: string; work: string; leftover?: string }> => {
      const work = tempDir("vtc-reap-");
      const checkout = join(work, "checkout");
      mkdirSync(checkout);
      const jail = new GateCommandJail(sandbox, []);
      const result = await jail.run({
        phase: "install",
        checkout,
        argv: [process.execPath, "-e", ORPHAN],
        cwd: checkout,
        env: sandboxEnvInput(),
        timeoutMs: 20_000,
        stdoutPath: join(work, "o"),
        stderrPath: join(work, "e"),
      });
      expect(result.code, readFileSync(join(work, "e"), "utf8")).toBe(0);
      return {
        jail,
        checkout,
        work,
        ...(result.leftover === undefined ? {} : { leftover: result.leftover }),
      };
    };

    it("stops what the command left behind before the run returns", async () => {
      const { jail, checkout, leftover } = await runOrphan(fakeReaperSandbox(true));
      expect(leftover).toBeUndefined();
      await new Promise((r) => setTimeout(r, 2_500));
      expect(existsSync(join(checkout, "late"))).toBe(false);
      jail.dispose();
    });

    it("waits for a slow reaper's confirmation (Bun closes the child before its extra pipes)", async () => {
      const work = tempDir("vtc-reap-");
      const checkout = join(work, "checkout");
      mkdirSync(checkout);
      const slow: GateSandbox = {
        kind: "sandbox-exec",
        wrap: (argv, s): ReapedGateCommand => ({
          command: "/bin/sh",
          args: [
            "-c",
            `exec 4<&0 0</dev/null
set -m
{ read -r _ <&4; sleep 1; printf R >&3; } >/dev/null 2>&1 &
set +m
exec 3>&- 4<&-
"$@"`,
            "vtc-gate",
            ...argv,
          ],
          network: s.phase === "verify" ? "none" : "full",
          reaper: true,
        }),
      };
      const jail = new GateCommandJail(slow, []);
      const started = Date.now();
      const result = await jail.run({
        phase: "verify",
        checkout,
        argv: [process.execPath, "-e", ""],
        cwd: checkout,
        env: sandboxEnvInput(),
        timeoutMs: 20_000,
        stdoutPath: join(work, "o"),
        stderrPath: join(work, "e"),
      });
      expect(result.leftover).toBeUndefined();
      expect(result.reaped).toBe(true);
      expect(Date.now() - started).toBeGreaterThanOrEqual(900);
      jail.dispose();
    });

    it("reports a reaper that never confirmed, and the jail then runs nothing more", async () => {
      const { jail, checkout, work, leftover } = await runOrphan(fakeReaperSandbox(false));
      expect(leftover).toMatch(/reaper/);
      await expect(
        jail.run({
          phase: "verify",
          checkout,
          argv: [process.execPath, "-e", ""],
          cwd: checkout,
          env: sandboxEnvInput(),
          timeoutMs: 20_000,
          stdoutPath: join(work, "o2"),
          stderrPath: join(work, "e2"),
        }),
      ).rejects.toThrow(/reaper/);
      jail.dispose();
    });
  },
);

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

  it("reaches only the app server's own loopback port when given one (the visual step)", async () => {
    const { createServer } = await import("node:net");
    const work = realpathSync(tempDir("vtc-live-"));
    const checkout = join(work, "checkout");
    mkdirSync(checkout);
    // A host service on another loopback port: the sandboxed command must not reach it.
    const host = createServer((c) => c.end("HOST\n"));
    await new Promise<void>((r) => host.listen(0, "127.0.0.1", r));
    const hostPort = (host.address() as { port: number }).port;
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const appPort = (probe.address() as { port: number }).port;
    await new Promise<void>((r) => {
      probe.close(() => {
        r();
      });
    });
    const script = `
const net = require("net"), fs = require("fs"), out = {};
const server = net.createServer((c) => c.end("APP")).listen(${String(appPort)}, "127.0.0.1", () => {
  net.connect(${String(appPort)}, "127.0.0.1").on("data", () => { out.app = "ok"; other(); }).on("error", (e) => { out.app = e.code; other(); });
}).on("error", (e) => { out.app = "bind " + e.code; other(); });
const other = () => net.connect(${String(hostPort)}, "127.0.0.1")
  .on("data", () => { out.host = "connected"; done(); })
  .on("error", (e) => { out.host = e.code; done(); });
const done = () => { fs.writeFileSync("out.json", JSON.stringify(out)); server.close(); };
`;
    const jail = new GateCommandJail(detectGateSandbox().sandbox ?? UNSANDBOXED, []);
    try {
      const result = await jail.run({
        phase: "verify",
        loopbackPorts: [appPort],
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
      host.close();
    }
    expect(JSON.parse(readFileSync(join(checkout, "out.json"), "utf8"))).toEqual({
      app: "ok",
      host: "EPERM",
    });
  });

  it("starts nothing outside the sandbox: no app through LaunchServices, no AppleEvent, no launchd job", async () => {
    const work = realpathSync(tempDir("vtc-live-"));
    const checkout = join(work, "checkout");
    const secret = join(work, "secret");
    for (const d of [checkout, secret]) mkdirSync(d);
    writeFileSync(join(secret, "f"), "SECRET-MARKER\n");
    const leak = (name: string): string => join(work, `leaked-${name}`);
    const script = `
const fs = require("fs"), cp = require("child_process"), path = require("path");
const app = path.join(process.cwd(), "q.app", "Contents");
fs.mkdirSync(path.join(app, "MacOS"), { recursive: true });
fs.writeFileSync(path.join(app, "Info.plist"), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>q</string><key>CFBundleIdentifier</key><string>dev.vtc.live-probe</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/></dict></plist>');
fs.writeFileSync(path.join(app, "MacOS", "q"), "#!/bin/sh\\n/bin/cat ${join(secret, "f")} > ${leak("open")}\\n", { mode: 0o755 });
const out = {};
out.open = cp.spawnSync("/usr/bin/open", ["-g", "-n", path.join(process.cwd(), "q.app")]).status;
out.osascript = cp.spawnSync("/usr/bin/osascript", ["-e", 'do shell script "/bin/cat ${join(secret, "f")} > ${leak("osa")}"']).status;
out.launchctl = cp.spawnSync("/bin/launchctl", ["submit", "-l", "dev.vtc.live-probe", "--", "/bin/sh", "-c", "/bin/cat ${join(secret, "f")} > ${leak("launchd")}"]).status;
try { fs.closeSync(fs.openSync("/dev/tty", "r")); out.tty = "ok"; } catch (e) { out.tty = e.code; }
fs.writeFileSync("out.json", JSON.stringify(out));
`;
    const jail = new GateCommandJail(detectGateSandbox().sandbox ?? UNSANDBOXED, [secret]);
    try {
      const result = await jail.run({
        phase: "verify",
        checkout,
        argv: [process.execPath, "-e", script],
        cwd: checkout,
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 30_000,
        stdoutPath: join(work, "o.log"),
        stderrPath: join(work, "e.log"),
      });
      expect(result.code, readFileSync(join(work, "e.log"), "utf8")).toBe(0);
    } finally {
      jail.dispose();
    }
    const out = JSON.parse(readFileSync(join(checkout, "out.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(out.open).not.toBe(0);
    expect(out.osascript).not.toBe(0);
    expect(out.launchctl).not.toBe(0);
    expect(out.tty).toBe("EPERM");
    // Give anything that did get started time to write.
    await new Promise((r) => setTimeout(r, 2_000));
    expect(readdirSync(work).filter((f) => f.startsWith("leaked-"))).toEqual([]);
  }, 40_000);

  it("refuses an install-phase connect to a Unix socket in a denied directory (the engine socket)", async () => {
    const { createServer } = await import("node:net");
    const work = realpathSync(tempDir("vtc-live-"));
    const checkout = join(work, "checkout");
    const run = join(work, "run");
    for (const d of [checkout, run]) mkdirSync(d);
    const sock = join(run, "e.sock");
    const server = createServer((c) => c.end("HELLO-FROM-ENGINE\n"));
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    const script = `
const s = require("net").connect(${JSON.stringify(sock)});
s.on("data", (d) => { require("fs").writeFileSync("out.txt", "got " + d); process.exit(0); });
s.on("error", (e) => { require("fs").writeFileSync("out.txt", e.code); process.exit(0); });
`;
    const jail = new GateCommandJail(detectGateSandbox().sandbox ?? UNSANDBOXED, [run]);
    try {
      await jail.run({
        phase: "install",
        checkout,
        argv: [process.execPath, "-e", script],
        cwd: checkout,
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 20_000,
        stdoutPath: join(work, "o.log"),
        stderrPath: join(work, "e.log"),
      });
    } finally {
      jail.dispose();
      server.close();
    }
    expect(readFileSync(join(checkout, "out.txt"), "utf8")).toBe("EPERM");
  });

  it("stops a setsid orphan that closed its stdio before the next gate runs", async () => {
    const work = realpathSync(tempDir("vtc-live-"));
    const checkout = join(work, "checkout");
    mkdirSync(checkout);
    const jail = new GateCommandJail(detectGateSandbox().sandbox ?? UNSANDBOXED, []);
    try {
      const result = await jail.run({
        phase: "install",
        checkout,
        argv: [process.execPath, "-e", ORPHAN],
        cwd: checkout,
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: 20_000,
        stdoutPath: join(work, "o.log"),
        stderrPath: join(work, "e.log"),
      });
      expect(result.code, readFileSync(join(work, "e.log"), "utf8")).toBe(0);
      expect(result.leftover).toBeUndefined();
    } finally {
      jail.dispose();
    }
    await new Promise((r) => setTimeout(r, 2_500));
    expect(existsSync(join(checkout, "late"))).toBe(false);
  });

  it("hides a masked directory's contents but keeps its readable roots, and toolchains still start", async () => {
    const work = realpathSync(tempDir("vtc-live-"));
    const checkout = join(work, "checkout");
    const masked = join(work, "home");
    const tool = join(masked, "tool");
    for (const d of [checkout, masked, tool]) mkdirSync(d);
    writeFileSync(join(masked, "private"), "x");
    writeFileSync(join(tool, "lib.js"), "module.exports = 42;\n");
    const script = `
const fs = require("fs"), out = {};
const tryIt = (k, f) => { try { out[k] = f(); } catch (e) { out[k] = e.code; } };
tryIt("list", () => fs.readdirSync(${JSON.stringify(masked)}).length);
tryIt("private", () => fs.readFileSync(${JSON.stringify(join(masked, "private"))}, "utf8"));
tryIt("tool", () => require(${JSON.stringify(join(tool, "lib.js"))}));
tryIt("shell", () => require("child_process").execFileSync("/usr/bin/env", ["sh", "-c", "echo ok"], { encoding: "utf8" }).trim());
fs.writeFileSync("out.json", JSON.stringify(out));
`;
    const jail = new GateCommandJail(detectGateSandbox().sandbox ?? UNSANDBOXED, [], {
      hideRead: [masked],
      allowRead: [tool],
    });
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
      list: "EPERM",
      private: "EPERM",
      tool: 42,
      shell: "ok",
    });
  });
});

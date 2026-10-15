/**
 * The cli+binary team's commands (§4.1, §4.4): init, install (adapter + the auto-resume timer), dashboard (session flow, live and snapshot), status/pause/resume over the typed client,
 * doctor (host logins only through the hosts' status commands).
 */
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { core, serveSnapshot } from "@vtc/engine";
import type { AdapterFactoryOptions } from "@vtc/adapters";
import {
  DEFAULT_INSTALL_SCOPE,
  ENGINE_HTTP,
  ProjectConfigSchema,
  type ControlResult,
  type EngineClient,
  type HostAdapter,
  type InstallRequest,
  type StatusResult,
} from "@vtc/shared";
import { createDiskAssetBundle } from "../src/assets.js";
import {
  createDashboardCommand,
  dashboardUrl,
  defaultDashboardDeps,
} from "../src/commands/dashboard.js";
import { pause, resume, status, formatStatus, toolErrorMessage } from "../src/commands/control.js";
import { createDoctorCommand, defaultDoctorEnv } from "../src/commands/doctor.js";
import { command as init, defaultProjectConfig } from "../src/commands/init.js";
import {
  createInstallCommand,
  defaultInstallDeps,
  type InstallDeps,
} from "../src/commands/install.js";
import { plistProgram, renderLaunchAgent } from "../src/launchd.js";
import type { Exec, ExecResult } from "../src/process.js";
import { renderSystemdService, systemdProgram } from "../src/systemd.js";
import { installTokenPath } from "../src/token.js";
import type { UserConfigRead } from "../src/user-config.js";
import { VERSION } from "../src/version.js";
import { capture, cleanupDirs, DASHBOARD_FIXTURE, initRepo, tempDir, tempHome } from "./helpers.js";

afterEach(cleanupDirs);

describe("vtc init", () => {
  it("writes project.yaml with every default (concurrency 2, plugin_only) and ignores .vtc/state", async () => {
    const repo = initRepo();
    const { ctx, out } = capture(repo, tempHome());
    expect(await init.run([], ctx)).toBe(0);
    const config = core.loadProjectConfig(repo);
    expect(config).toEqual(ProjectConfigSchema.parse({ version: 1 }));
    expect(config.concurrency).toBe(2);
    expect(config.hosts.dispatch).toBe("plugin_only");
    const text = readFileSync(join(repo, ".vtc/project.yaml"), "utf8");
    expect(text).toMatch(/^# VTC project settings/);
    expect(text).toContain("dispatch: plugin_only");
    // the header says when the engine launches roles itself (readings 98 and 99)
    expect(text).not.toMatch(/lets the engine start host CLIs/);
    expect(text).toMatch(/a Codex Lead's roles run as headless Codex runs/);
    expect(text).toMatch(/headless_allowed also\n# +lets the engine launch roles itself/);
    expect(readFileSync(join(repo, ".vtc/.gitignore"), "utf8")).toContain("/state/");
    expect(out[0]).toContain(".vtc/project.yaml");
  });

  it("refuses to overwrite without --force and bounds concurrency to 1–3", async () => {
    const repo = initRepo();
    const { ctx, err } = capture(repo, tempHome());
    expect(await init.run(["--concurrency", "3"], ctx)).toBe(0);
    expect(core.loadProjectConfig(repo).concurrency).toBe(3);
    writeFileSync(join(repo, ".vtc/project.yaml"), "version: 1\nconcurrency: 1\n");
    expect(await init.run([], ctx)).toBe(1);
    expect(err.at(-1)).toMatch(/exists; pass --force/);
    expect(await init.run(["--force"], ctx)).toBe(0);
    expect(core.loadProjectConfig(repo).concurrency).toBe(2);
    expect(await init.run(["--force", "--concurrency", "4"], ctx)).toBe(64);
    expect(err.at(-1)).toMatch(/from 1 to 3/);
    expect(() => defaultProjectConfig(0)).toThrow();
  });

  it("never writes through a planted symlink (a cloned repo can commit one)", async () => {
    const outside = tempDir();
    const victim = join(outside, "victim.txt");
    writeFileSync(victim, "keep me\n");
    // .vtc/project.yaml as a symlink: refused even with --force
    const repo = initRepo();
    mkdirSync(join(repo, ".vtc"));
    symlinkSync(victim, join(repo, ".vtc/project.yaml"));
    const { ctx, err } = capture(repo, tempHome());
    expect(await init.run(["--force"], ctx)).toBe(1);
    expect(err.at(-1)).toMatch(/project\.yaml is a symbolic link/);
    // a dangling .gitignore symlink: refused, its target never created
    const repo2 = initRepo();
    mkdirSync(join(repo2, ".vtc"));
    symlinkSync(join(outside, "created.txt"), join(repo2, ".vtc/.gitignore"));
    const second = capture(repo2, tempHome());
    expect(await init.run([], second.ctx)).toBe(1);
    expect(second.err.at(-1)).toMatch(/\.gitignore is a symbolic link/);
    expect(existsSync(join(outside, "created.txt"))).toBe(false);
    // .vtc itself as a symlink to a directory outside the repo
    const repo3 = initRepo();
    symlinkSync(outside, join(repo3, ".vtc"));
    const third = capture(repo3, tempHome());
    expect(await init.run([], third.ctx)).toBe(1);
    expect(third.err.at(-1)).toMatch(/\.vtc is a symbolic link/);
    expect(existsSync(join(outside, "project.yaml"))).toBe(false);
    expect(readFileSync(victim, "utf8")).toBe("keep me\n");
  });

  it("works from a subdirectory and refuses outside a git repo", async () => {
    const repo = initRepo();
    mkdirSync(join(repo, "src"));
    const { ctx } = capture(join(repo, "src"), tempHome());
    expect(await init.run([], ctx)).toBe(0);
    expect(existsSync(join(repo, ".vtc/project.yaml"))).toBe(true);
    const { ctx: outside, err } = capture(tempDir(), tempHome());
    expect(await init.run([], outside)).toBe(1);
    expect(err[0]).toMatch(/not inside a git repository/);
  });
});

const recorder = (results: Record<string, Partial<ExecResult>> = {}) => {
  const calls: string[] = [];
  const exec: Exec = (command, args) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    return Promise.resolve({ code: 0, stdout: "", stderr: "", ...results[line] });
  };
  return { calls, exec };
};

describe("vtc install", () => {
  const installDeps =
    (over: Partial<InstallDeps>, home: string): (() => InstallDeps) =>
    () => ({
      ...defaultInstallDeps(),
      home: () => home,
      pluginDir: (host) => `/plugins/${host}`,
      platform: "win32",
      timerHost: () => {
        throw new Error("the real launchd or systemd is never touched in tests");
      },
      ...over,
    });

  it("creates the token and installs through the host's adapter", async () => {
    const requests: InstallRequest[] = [];
    let disposed = 0;
    const adapter = {
      host: "codex",
      install: (r: InstallRequest) => {
        requests.push(r);
        return Promise.resolve({
          written: ["/h/.codex/agents/vtc-ba.toml"],
          notes: ["trust the hooks"],
        });
      },
      dispose: () => {
        disposed += 1;
        return Promise.resolve();
      },
    } as unknown as HostAdapter;
    const repo = initRepo();
    const vtcHome = tempHome();
    const { ctx, out } = capture(repo, vtcHome);
    const options: (AdapterFactoryOptions | undefined)[] = [];
    const factory = (o?: AdapterFactoryOptions): HostAdapter => (options.push(o), adapter);
    const cmd = createInstallCommand(
      installDeps({ factories: { codex: factory, "claude-code": factory } }, "/h"),
    );
    expect(await cmd.run(["--host", "codex", "--scope", "user"], ctx)).toBe(0);
    expect(requests).toEqual([
      // the VTC home goes with the request, so VTC-owned host files sit where the deny lists point
      { projectRoot: repo, home: "/h", pluginDir: "/plugins/codex", scope: "user", vtcHome },
    ]);
    expect(options).toEqual([{ pluginDir: "/plugins/codex", vtcHome, vtcVersion: VERSION }]);
    expect(disposed).toBe(1);
    expect(existsSync(installTokenPath(vtcHome))).toBe(true);
    expect(out.join("\n")).toContain("note: trust the hooks");
    expect(out.join("\n")).toMatch(/no auto-resume timer on this platform in v1/);
    // the spec's positional form (§4.4: `vtc install codex`); with no --scope each host's default
    // (D-ah): Codex in the project, Claude Code for the user
    expect(await cmd.run(["codex"], ctx)).toBe(0);
    expect(requests.at(-1)).toMatchObject({ pluginDir: "/plugins/codex", scope: "project" });
    // Codex plugin registration is the adapter's (AD-16 rule 4, reading 94): the cli itself
    // writes no marketplace, plugin copy or config.toml into the repo
    expect(existsSync(join(repo, ".agents"))).toBe(false);
    expect(existsSync(join(repo, ".codex"))).toBe(false);
    expect(await cmd.run(["claude-code"], ctx)).toBe(0);
    expect(requests.at(-1)).toMatchObject({ pluginDir: "/plugins/claude-code", scope: "user" });
    expect(DEFAULT_INSTALL_SCOPE).toEqual({ "claude-code": "user", codex: "project" });
    expect(await cmd.run(["codex", "claude-code"], ctx)).toBe(64);
    expect(await cmd.run(["codex", "--host", "codex"], ctx)).toBe(64);
  });

  it("refuses unknown hosts, scopes and hosts without an adapter yet", async () => {
    const { ctx, err } = capture(initRepo(), tempHome());
    const cmd = createInstallCommand(installDeps({ factories: {} }, "/h"));
    expect(await cmd.run(["--host", "vscode"], ctx)).toBe(64);
    expect(await cmd.run(["--host", "codex", "--scope", "global"], ctx)).toBe(64);
    expect(await cmd.run([], ctx)).toBe(64);
    expect(await cmd.run(["--host", "claude-code"], ctx)).toBe(1);
    expect(err.at(-1)).toMatch(/no claude-code adapter yet/);
  });

  it("installs the launchd timer only on --auto-resume (spine §5 reading 59), and removes it", async () => {
    const home = tempDir();
    const vtcHome = tempHome();
    const { calls, exec } = recorder();
    const { ctx } = capture(initRepo(), vtcHome);
    const cmd = createInstallCommand(
      installDeps(
        {
          platform: "darwin",
          timerHost: () => ({ home, uid: 501, exec, configHome: null }),
          agentSpec: (h) => ({ selfCommand: ["/opt/vtc"], vtcHome: h, path: "/usr/bin:/bin" }),
          factories: {},
        },
        home,
      ),
    );
    const plist = join(home, "Library/LaunchAgents/vtc.auto-resume.plist");
    expect(await cmd.run(["--auto-resume"], ctx)).toBe(0);
    const text = readFileSync(plist, "utf8");
    expect(text).toContain(
      "<string>/opt/vtc</string>\n    <string>engine</string>\n    <string>--wake-due</string>",
    );
    expect(text).toContain(`<string>${vtcHome}</string>`);
    expect(calls).toEqual([
      "launchctl bootout gui/501/vtc.auto-resume",
      `launchctl bootstrap gui/501 ${plist}`,
    ]);
    expect(await cmd.run(["--no-auto-resume"], ctx)).toBe(0);
    expect(existsSync(plist)).toBe(false);
    expect(await cmd.run(["--auto-resume", "--no-auto-resume"], ctx)).toBe(64);
    // `vtc install <host>` installs no timer, never silently: it says how; with --auto-resume it does
    const adapter = {
      install: () => Promise.resolve({ written: [], notes: [] }),
      dispose: () => Promise.resolve(),
    } as unknown as HostAdapter;
    const withHost = createInstallCommand(
      installDeps(
        {
          platform: "darwin",
          timerHost: () => ({ home, uid: 501, exec, configHome: null }),
          agentSpec: (h) => ({ selfCommand: ["/opt/vtc"], vtcHome: h, path: "/usr/bin:/bin" }),
          factories: { codex: () => adapter },
        },
        home,
      ),
    );
    const { ctx: hostCtx, out } = capture(initRepo(), vtcHome);
    expect(await withHost.run(["codex"], hostCtx)).toBe(0);
    expect(existsSync(plist)).toBe(false);
    expect(out.join("\n")).toMatch(/run vtc install --auto-resume to install the launchd timer/);
    expect(await withHost.run(["codex", "--auto-resume"], hostCtx)).toBe(0);
    expect(existsSync(plist)).toBe(true);
    expect(out.join("\n")).toMatch(/Installed the auto-resume timer/);
    // what the timer does in v1: it wakes the daemon; the Lead session continues the run
    expect(out.join("\n")).toMatch(/wakes the engine.*the Lead session/);
    expect(await withHost.run(["--host", "codex", "--no-auto-resume"], hostCtx)).toBe(0);
    expect(existsSync(plist)).toBe(false);
    // a launchctl failure leaves no plist behind
    const failing = recorder({
      [`launchctl bootstrap gui/501 ${plist}`]: { code: 5, stderr: "Bootstrap failed: 5\n" },
    });
    const broken = createInstallCommand(
      installDeps(
        {
          platform: "darwin",
          timerHost: () => ({ home, uid: 501, exec: failing.exec, configHome: null }),
          agentSpec: (h) => ({ selfCommand: ["/opt/vtc"], vtcHome: h, path: "/usr/bin:/bin" }),
          factories: {},
        },
        home,
      ),
    );
    expect(await broken.run(["--auto-resume"], ctx)).toBe(1);
    expect(existsSync(plist)).toBe(false);
  });
});

describe("vtc dashboard (AD-5 session flow)", () => {
  it("asks the live daemon for a nonce with the install token and opens the fragment URL", async () => {
    const repo = initRepo();
    const vtcHome = tempHome();
    const posts: string[] = [];
    const opened: string[] = [];
    const cmd = createDashboardCommand(() => ({
      ...defaultDashboardDeps(),
      liveDaemon: () => Promise.resolve({ port: 4711 } as never),
      post: (port, path, token) => {
        posts.push(`${String(port)} ${path} ${token.length}`);
        return Promise.resolve({
          status: 200,
          body: JSON.stringify({ nonce: "n".repeat(43), expires_at: "2026-10-13T00:00:00.000Z" }),
        });
      },
      open: (url) => opened.push(url),
    }));
    const { ctx, out } = capture(repo, vtcHome);
    expect(await cmd.run([], ctx)).toBe(0);
    expect(posts).toEqual([`4711 ${ENGINE_HTTP.routes.sessionNonce.path} 43`]);
    expect(opened).toEqual([dashboardUrl(4711, "n".repeat(43))]);
    expect(opened[0]).toBe(`http://127.0.0.1:4711/#nonce=${"n".repeat(43)}`);
    expect(out[0]).toContain("#nonce=");
    const refused = createDashboardCommand(() => ({
      ...defaultDashboardDeps(),
      liveDaemon: () => Promise.resolve({ port: 4711 } as never),
      post: () => Promise.resolve({ status: 403, body: "" }),
      open: () => undefined,
    }));
    expect(await refused.run(["--no-open"], ctx)).toBe(1);
  });

  it("serves the committed snapshot read-only when no engine runs, until interrupted", async () => {
    const repo = initRepo();
    let stop: () => void = () => undefined;
    const fetched: string[] = [];
    const cmd = createDashboardCommand(() => ({
      ...defaultDashboardDeps(),
      liveDaemon: () => Promise.resolve(null),
      serveSnapshot,
      assets: () => createDiskAssetBundle({ dashboard: DASHBOARD_FIXTURE }),
      open: (url) => {
        void fetch(url.replace(/#.*$/, ""))
          .then((r) => r.text())
          .then((t) => {
            fetched.push(t);
            stop();
          });
      },
      interrupted: () => new Promise<void>((r) => (stop = r)),
    }));
    const { ctx, out } = capture(repo, tempHome());
    expect(await cmd.run([], ctx)).toBe(0);
    expect(fetched[0]).toBe(readFileSync(join(DASHBOARD_FIXTURE, "index.html"), "utf8"));
    expect(out.join("\n")).toMatch(/read-only/);
  });
});

describe("vtc status / pause / resume (AD-19 rule 4)", () => {
  const statusResult = {
    run: {
      id: "r1",
      track: "feature",
      repo: "existing",
      has_ui: false,
      phase: "build",
      gates: { G1: { status: "approved", frozen: [] }, G2: { status: "approved", frozen: [] } },
      paused: true,
      merge_level_effective: 2,
      started_at: "2026-10-13T10:00:00.000Z",
      pipeline_config_hash: "a".repeat(64),
    },
    tasks_by_status: { merged: 2, building: 1 },
    parked: [{ task: "T-3", reason: "cap" }],
    features: [],
    open_escalations: 1,
    budget: { budget_usd: 10, spent_usd: 1.234 },
    usage: {
      hosts: [
        {
          host: "claude-code",
          source: "statusline",
          windows: [
            {
              kind: "five_hour",
              label: "five_hour",
              window_minutes: 300,
              used_pct: 42,
              resets_at: null,
            },
          ],
          model_limits: [],
          updated_at: null,
        },
      ],
      interrupted_tasks: [],
      auto_resume_at: null,
    },
  } as unknown as StatusResult;

  const fakeClient = (calls: string[]): EngineClient => ({
    call: (tool, input) => {
      calls.push(`${tool} ${JSON.stringify(input)}`);
      if (tool === "status") return Promise.resolve(statusResult as never);
      return Promise.resolve({ run: "r1", paused: tool === "pause", phase: "build" } as never);
    },
    close: () => {
      calls.push("close");
      return Promise.resolve();
    },
  });

  it("calls the tools over the client and prints a summary", async () => {
    const calls: string[] = [];
    const { ctx, out } = capture("/w", "/h", () => Promise.resolve(fakeClient(calls)));
    expect(await status.run([], ctx)).toBe(0);
    expect(await pause.run(["--run", "r1"], ctx)).toBe(0);
    expect(await resume.run(["--json"], ctx)).toBe(0);
    expect(calls).toEqual([
      "status {}",
      "close",
      'pause {"run":"r1"}',
      "close",
      "resume {}",
      "close",
    ]);
    expect(out[0]).toBe("Run r1: feature, phase build, PAUSED");
    expect(out).toContain("Tasks: 2 merged, 1 building");
    expect(out).toContain("  parked T-3: cap");
    expect(out).toContain("Budget: $1.23 of $10.00");
    expect(out).toContain("  claude-code: five_hour 42% used");
    expect(out).toContain("Run r1 paused: paused (phase build)");
    expect(JSON.parse(out.at(-1) ?? "")).toEqual({ run: "r1", paused: false, phase: "build" });
  });

  it("vtc resume --adopt goes over the human connection only, naming the run (reading 88)", async () => {
    const plain: string[] = [];
    const human: string[] = [];
    const asked: string[] = [];
    const { ctx, err } = capture("/w", "/h", () => Promise.resolve(fakeClient(plain)));
    // without a human connection (no terminal), nothing is sent
    expect(await resume.run(["--run", "r9", "--adopt"], ctx)).toBe(1);
    expect(plain).toEqual([]);
    const withHuman = {
      ...ctx,
      humanEngine: (what: string) => {
        asked.push(what);
        return Promise.resolve(fakeClient(human));
      },
    };
    expect(await resume.run(["--adopt"], withHuman)).toBe(64);
    expect(await resume.run(["--run", "r9", "--adopt"], withHuman)).toBe(0);
    expect(asked).toEqual(["adopt run r9 from another clone onto this machine"]);
    expect(human).toEqual(['resume {"run":"r9","adopt":true}', "close"]);
    expect(plain).toEqual([]);
    expect(err.join("\n")).toMatch(/--adopt needs --run/);
  });

  it("vtc pause / resume without a run exit 0 and say the kill switch state (reading 227 (2))", async () => {
    const answers: Record<string, ControlResult> = {
      pause: { run: null, automation_paused: true },
      resume: { run: null, automation_paused: false },
    };
    const calls: string[] = [];
    const client: EngineClient = {
      call: (tool, input) => {
        calls.push(`${tool} ${JSON.stringify(input)}`);
        return Promise.resolve(answers[tool] as never);
      },
      close: () => Promise.resolve(),
    };
    const { ctx, out, err } = capture("/w", "/h", () => Promise.resolve(client));
    expect(await pause.run([], ctx)).toBe(0);
    expect(await resume.run([], ctx)).toBe(0);
    expect(await pause.run(["--json"], ctx)).toBe(0);
    expect(calls).toEqual(["pause {}", "resume {}", "pause {}"]);
    expect(out.slice(0, 2)).toEqual([
      "No run to pause; automation is paused (automatic issues and PRs stay off until vtc resume)",
      "No run to resume; automation is on",
    ]);
    expect(JSON.parse(out.at(-1) ?? "")).toEqual({ run: null, automation_paused: true });
    expect(err).toEqual([]);
  });

  it("says the kill switch state for a run when the engine reports it", async () => {
    const client: EngineClient = {
      call: (tool) =>
        Promise.resolve({
          run: "r1",
          paused: tool === "pause",
          phase: "build",
          automation_paused: tool === "pause",
        } as never),
      close: () => Promise.resolve(),
    };
    const { ctx, out } = capture("/w", "/h", () => Promise.resolve(client));
    expect(await pause.run([], ctx)).toBe(0);
    expect(await resume.run([], ctx)).toBe(0);
    expect(out).toEqual([
      "Run r1 paused: paused (phase build); automation is paused",
      "Run r1 resumed: running (phase build); automation is on",
    ]);
  });

  it("shows unknown usage as unknown, never 0% (§6.9)", () => {
    const lines = formatStatus({
      ...statusResult,
      usage: { hosts: [], interrupted_tasks: [], auto_resume_at: null },
    });
    expect(lines.slice(-2)).toEqual(["Usage:", "  unknown"]);
  });

  it("reports engine errors as one readable line", async () => {
    const { ctx, err } = capture("/w", "/h", () =>
      Promise.resolve({
        call: () => Promise.reject(new Error('{"error":"no_run: no active run; start one first"}')),
        close: () => Promise.resolve(),
      }),
    );
    expect(await status.run([], ctx)).toBe(1);
    expect(err).toEqual(["vtc status: no_run: no active run; start one first"]);
    expect(toolErrorMessage(new Error("plain"))).toBe("plain");
  });
});

describe("vtc doctor", () => {
  it("checks the runtime, git, both hosts' logins through their status commands, and gh", async () => {
    const { calls, exec } = recorder({
      "git --version": { stdout: "git version 2.50.0\n" },
      "claude --version": { stdout: "2.1.296 (Claude Code)\n" },
      "claude auth status --json": {
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          email: "someone@example.com",
          orgName: "Org",
        }),
      },
      "codex --version": { code: null, error: "ENOENT" },
      "gh --version": { stdout: "gh version 2.80.0\n" },
    });
    const { ctx, out } = capture("/w", "/h");
    const cmd = createDoctorCommand(() => ({ exec, versions: { node: "22.17.1" } }));
    expect(await cmd.run([], ctx)).toBe(0);
    const text = out.join("\n");
    expect(text).toMatch(/ok {4}runtime {6}node 22\.17\.1/);
    expect(text).toMatch(/claude-code +2\.1\.296 \(Claude Code\), logged in \(claude\.ai\)/);
    expect(text).toMatch(/warn +codex +codex is not on PATH/);
    expect(text).not.toContain("someone@example.com");
    expect(text).not.toContain("Org");
    expect(calls).toContain("claude auth status --json");
    expect(calls.every((c) => !/credential|auth\.json|keychain|security /i.test(c))).toBe(true);
  });

  it("fails when no host is usable or the runtime is too old", async () => {
    const { exec } = recorder({
      "claude auth status --json": { stdout: JSON.stringify({ loggedIn: false }) },
      "codex login status": { code: 1, stdout: "Not logged in" },
    });
    const { ctx, out } = capture("/w", "/h");
    expect(
      await createDoctorCommand(() => ({ exec, versions: { node: "22.13.1" } })).run([], ctx),
    ).toBe(1);
    const text = out.join("\n");
    expect(text).toMatch(/FAIL +runtime +node 22\.13\.1: VTC needs node >= 22\.14/);
    expect(text).toMatch(/FAIL +claude-code .*not logged in/);
    expect(text).toMatch(/FAIL +codex .*not logged in/);
    expect(text).toMatch(/3 check\(s\) failed/);
    const bun = createDoctorCommand(() => ({
      exec: recorder().exec,
      versions: { node: "24.3.0", bun: "1.4.3" },
    }));
    expect(await bun.run([], capture("/w", "/h").ctx)).toBe(0);
  });

  it("checks the auto-resume timer (launchd, systemd): installed, and its program still there", async () => {
    const base = { exec: recorder().exec, versions: { node: "22.17.1" } };
    const timer = {
      kind: "launchd timer",
      read: () => null as string | null,
      program: plistProgram,
      exists: (p: string) => p === "/opt/vtc",
      wakeups: () => [] as { repo_root: string; at: string }[],
    };
    const run = async (t: typeof timer): Promise<string> => {
      const { ctx, out } = capture("/w", "/h");
      expect(await createDoctorCommand(() => ({ ...base, timer: t })).run([], ctx)).toBe(0);
      return out.join("\n");
    };
    expect(await run(timer)).toMatch(/warn +auto-resume +the launchd timer is not installed/);
    expect(
      await run({ ...timer, wakeups: () => [{ repo_root: "/r", at: "2026-10-13T10:00:00Z" }] }),
    ).toMatch(
      /a run in \/r waits to auto-resume at 2026-10-13T10:00:00Z, but the launchd timer is not installed: run vtc install --auto-resume/,
    );
    const plist = renderLaunchAgent({ selfCommand: ["/opt/vtc"], vtcHome: "/h", path: "/usr/bin" });
    expect(await run({ ...timer, read: () => plist })).toMatch(
      /ok +auto-resume +launchd timer installed \(\/opt\/vtc\)/,
    );
    const moved = renderLaunchAgent({
      selfCommand: ["/opt/homebrew/Cellar/vtc/0.1/bin/vtc"],
      vtcHome: "/h",
      path: "/usr/bin",
    });
    expect(await run({ ...timer, read: () => moved })).toMatch(
      /warn +auto-resume +the launchd timer runs \/opt\/homebrew\/Cellar\/vtc\/0\.1\/bin\/vtc, which no longer exists/,
    );
    // Linux: the systemd service names the program
    const systemd = { ...timer, kind: "systemd timer", program: systemdProgram };
    const service = renderSystemdService({
      selfCommand: ["/opt/vtc"],
      vtcHome: "/h",
      path: "/usr/bin",
    });
    expect(await run({ ...systemd, read: () => service })).toMatch(
      /ok +auto-resume +systemd timer installed \(\/opt\/vtc\)/,
    );
    expect(await run(systemd)).toMatch(/warn +auto-resume +the systemd timer is not installed/);
    // no timer on this platform: no check
    const { ctx, out } = capture("/w", "/h");
    expect(await createDoctorCommand(() => base).run([], ctx)).toBe(0);
    expect(out.join("\n")).not.toMatch(/auto-resume/);
    // Windows in v1 (D-aj): no timer, and doctor says what that means
    const win = capture("/w", "/h");
    expect(
      await createDoctorCommand(() => ({ ...base, timer: "unsupported" })).run([], win.ctx),
    ).toBe(0);
    expect(win.out.join("\n")).toMatch(
      /warn +auto-resume +no auto-resume timer on this platform in v1: a run parked on a usage limit resumes when its engine next runs/,
    );
  });

  it("warns about an apiKeyHelper Claude setup's API-key billing, read from claude auth status --json only (D-ab, D-bq)", async () => {
    for (const status of [
      { loggedIn: true, authMethod: "apiKeyHelper" },
      { loggedIn: true, authMethod: "api_key", apiKeySource: "apiKeyHelper" },
    ]) {
      const { calls, exec } = recorder({
        "claude auth status --json": { stdout: JSON.stringify(status) },
      });
      const { ctx, out } = capture("/w", "/h");
      expect(
        await createDoctorCommand(() => ({ exec, versions: { node: "22.17.1" } })).run([], ctx),
      ).toBe(0);
      expect(out.join("\n")).toMatch(
        /warn +claude-code +.*API-key billing: .*apiKeyHelper.*Role runs still run; to bill your subscription instead/,
      );
      expect(calls.filter((c) => c.startsWith("claude"))).toEqual([
        "claude --version",
        "claude auth status --json",
      ]);
    }
  });

  it("shows which credential variables pass to the detached daemon (D-ak)", async () => {
    const base = { exec: recorder().exec, versions: { node: "22.17.1" } };
    const run = async (read: UserConfigRead): Promise<{ code: number; text: string }> => {
      const { ctx, out } = capture("/w", "/h");
      const code = await createDoctorCommand(() => ({ ...base, userConfig: () => read })).run(
        [],
        ctx,
      );
      return { code, text: out.join("\n") };
    };
    const none = await run({
      ok: true,
      path: "/h/config.yaml",
      config: { version: 1, env_passthrough: [] },
    });
    expect(none.text).toMatch(
      /ok +env +the detached daemon drops credential variables; none pass \(env_passthrough in \/h\/config\.yaml\)/,
    );
    const some = await run({
      ok: true,
      path: "/h/config.yaml",
      config: { version: 1, env_passthrough: ["GITHUB_TOKEN", "ANTHROPIC_API_KEY"] },
    });
    expect(some.text).toMatch(
      /ok +env +passes GITHUB_TOKEN, ANTHROPIC_API_KEY to the detached daemon \(env_passthrough in \/h\/config\.yaml\)/,
    );
    const bad = await run({ ok: false, path: "/h/config.yaml", error: "env_passthrough.0: bad" });
    expect(bad.code).toBe(1);
    expect(bad.text).toMatch(
      /FAIL +env +\/h\/config\.yaml does not parse \(env_passthrough\.0: bad\)/,
    );
    // the default reads the real file under the VTC home
    const home = tempHome();
    writeFileSync(join(home, "config.yaml"), "version: 1\nenv_passthrough: [GH_TOKEN]\n");
    const { ctx } = capture("/w", home);
    expect(defaultDoctorEnv(ctx).userConfig?.()).toMatchObject({
      ok: true,
      config: { env_passthrough: ["GH_TOKEN"] },
    });
  });
});

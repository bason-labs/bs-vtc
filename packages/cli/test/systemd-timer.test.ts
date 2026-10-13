/**
 * The auto-resume timer on Linux (§6.9 step 4, AD-6 rule 4): a systemd user timer that runs
 * `vtc engine --wake-due` every minute, installed by `vtc install` like the macOS launchd agent.
 * `systemctl` is never run for real here: a recorder stands in for it.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostAdapter } from "@vtc/shared";
import {
  createInstallCommand,
  defaultInstallDeps,
  type InstallDeps,
} from "../src/commands/install.js";
import type { Exec, ExecResult } from "../src/process.js";
import {
  SYSTEMD_SERVICE,
  SYSTEMD_TIMER,
  renderSystemdService,
  renderSystemdTimer,
  systemdProgram,
  systemdUnitDir,
} from "../src/systemd.js";
import { autoResumeTimer, type TimerHost } from "../src/timer.js";
import { capture, cleanupDirs, initRepo, tempDir, tempHome } from "./helpers.js";

afterEach(cleanupDirs);

const recorder = (results: Record<string, Partial<ExecResult>> = {}) => {
  const calls: string[] = [];
  const exec: Exec = (command, args) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    return Promise.resolve({ code: 0, stdout: "", stderr: "", ...results[line] });
  };
  return { calls, exec };
};

describe("the systemd user timer", () => {
  const spec = {
    selfCommand: ["/opt/my tools/100%/vtc", 'say "hi"\\', "$HOME"],
    vtcHome: "/home/u/.vtc 2",
    path: "/usr/local/bin:/usr/bin",
  };

  it("renders a oneshot service that runs --wake-due with VTC_HOME and the user's PATH", () => {
    const service = renderSystemdService(spec);
    expect(service).toContain("Type=oneshot");
    // quoted words; % is a specifier and $ an expansion in ExecStart, both escaped
    expect(service).toContain(
      'ExecStart="/opt/my tools/100%%/vtc" "say \\"hi\\"\\\\" "$$HOME" "engine" "--wake-due"',
    );
    expect(service).toContain('Environment="VTC_HOME=/home/u/.vtc 2"');
    expect(service).toContain('Environment="PATH=/usr/local/bin:/usr/bin"');
    expect(service).not.toMatch(/token|credential/i);
    // doctor reads the program back
    expect(systemdProgram(service)).toBe("/opt/my tools/100%/vtc");
    expect(systemdProgram("[Service]\nType=oneshot\n")).toBeNull();
  });

  it("fires every minute and catches up after a sleep or a reboot", () => {
    const timer = renderSystemdTimer();
    expect(timer).toContain("OnCalendar=minutely");
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain(`Unit=${SYSTEMD_SERVICE}`);
    expect(timer).toContain("WantedBy=timers.target");
  });

  it("refuses arguments a unit file cannot carry", () => {
    expect(() =>
      renderSystemdService({ ...spec, selfCommand: ["/opt/vtc\nExecStartPre=/x"] }),
    ).toThrow(/control character/);
    expect(() => renderSystemdService({ ...spec, vtcHome: "/h\r" })).toThrow(/control character/);
  });

  it("lives in $XDG_CONFIG_HOME/systemd/user, or ~/.config/systemd/user", () => {
    expect(systemdUnitDir({ home: "/home/u", configHome: null })).toBe(
      "/home/u/.config/systemd/user",
    );
    expect(systemdUnitDir({ home: "/home/u", configHome: "/cfg" })).toBe("/cfg/systemd/user");
    expect(autoResumeTimer("linux")?.kind).toBe("systemd timer");
    expect(autoResumeTimer("darwin")?.kind).toBe("launchd timer");
    expect(autoResumeTimer("win32")).toBeNull();
  });
});

describe("vtc install on Linux", () => {
  const adapter = {
    install: () => Promise.resolve({ written: [], notes: [] }),
    dispose: () => Promise.resolve(),
  } as unknown as HostAdapter;

  const deps =
    (host: TimerHost, platform: NodeJS.Platform = "linux"): (() => InstallDeps) =>
    () => ({
      ...defaultInstallDeps(),
      home: () => host.home,
      pluginDir: (h) => `/plugins/${h}`,
      platform,
      timerHost: () => host,
      agentSpec: (vtcHome) => ({ selfCommand: ["/opt/vtc"], vtcHome, path: "/usr/bin:/bin" }),
      factories: { codex: () => adapter },
    });

  it("installs and enables the systemd timer with the host and on --auto-resume, and removes it", async () => {
    const home = tempDir();
    const { calls, exec } = recorder();
    const host: TimerHost = { home, uid: 1000, exec, configHome: null };
    const vtcHome = tempHome();
    const { ctx, out } = capture(initRepo(), vtcHome);
    const cmd = createInstallCommand(deps(host));
    const dir = join(home, ".config/systemd/user");

    expect(await cmd.run(["codex"], ctx)).toBe(0);
    const service = readFileSync(join(dir, SYSTEMD_SERVICE), "utf8");
    expect(service).toContain('ExecStart="/opt/vtc" "engine" "--wake-due"');
    expect(service).toContain(`Environment="VTC_HOME=${vtcHome}"`);
    expect(existsSync(join(dir, SYSTEMD_TIMER))).toBe(true);
    expect(calls).toEqual([
      "systemctl --user daemon-reload",
      `systemctl --user enable --now ${SYSTEMD_TIMER}`,
    ]);
    expect(out.join("\n")).toMatch(/Installed the auto-resume timer \(.*vtc-auto-resume\.timer\)/);

    calls.length = 0;
    expect(await cmd.run(["--no-auto-resume"], ctx)).toBe(0);
    expect(existsSync(join(dir, SYSTEMD_SERVICE))).toBe(false);
    expect(existsSync(join(dir, SYSTEMD_TIMER))).toBe(false);
    expect(calls).toEqual([
      `systemctl --user disable --now ${SYSTEMD_TIMER}`,
      "systemctl --user daemon-reload",
    ]);

    expect(await cmd.run(["--auto-resume"], ctx)).toBe(0);
    expect(existsSync(join(dir, SYSTEMD_TIMER))).toBe(true);
  });

  it("keeps the plugin install when systemd is unreachable, and says how to retry", async () => {
    const home = tempDir();
    const { exec } = recorder({
      "systemctl --user daemon-reload": {
        code: 1,
        stderr: "Failed to connect to bus: No medium found\n",
      },
    });
    const host: TimerHost = { home, uid: 1000, exec, configHome: join(home, "cfg") };
    const { ctx, out, err } = capture(initRepo(), tempHome());
    const cmd = createInstallCommand(deps(host));
    // implied by `vtc install <host>`: the plugin is installed, the timer is reported as missing
    expect(await cmd.run(["codex"], ctx)).toBe(0);
    expect(out.join("\n")).toMatch(/Installed the VTC plugin for codex/);
    expect(err.join("\n")).toMatch(
      /auto-resume timer was not installed: systemctl --user daemon-reload failed: Failed to connect to bus.*vtc install --auto-resume/,
    );
    // nothing half-installed is left behind
    expect(existsSync(join(home, "cfg/systemd/user", SYSTEMD_TIMER))).toBe(false);
    // asked for explicitly: a failure
    expect(await cmd.run(["--auto-resume"], ctx)).toBe(1);
    expect(err.at(-1)).toMatch(/Failed to connect to bus/);
  });

  it("has no timer on Windows yet: a note with the host, an error when asked for", async () => {
    const { exec, calls } = recorder();
    const host: TimerHost = { home: tempDir(), uid: 0, exec, configHome: null };
    const { ctx, out } = capture(initRepo(), tempHome());
    const cmd = createInstallCommand(deps(host, "win32"));
    expect(await cmd.run(["codex"], ctx)).toBe(0);
    expect(out.join("\n")).toMatch(/Auto-resume has no timer on this platform yet/);
    expect(await cmd.run(["--auto-resume"], ctx)).toBe(1);
    expect(await cmd.run(["--no-auto-resume"], ctx)).toBe(0);
    expect(calls).toEqual([]);
  });
});

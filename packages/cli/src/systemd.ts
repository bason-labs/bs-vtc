/**
 * The Linux systemd user timer behind auto-resume (§6.9 step 4, AD-6 rule 4): the counterpart of
 * the macOS launchd agent (`launchd.ts`), installed and removed by `vtc install` in the same way.
 * A oneshot service runs `vtc engine --wake-due`; a timer starts it every minute, and
 * `Persistent=true` runs a missed start after a sleep or a reboot. User timers run while the
 * user's systemd instance runs (normally while they are logged in); VTC never enables lingering.
 * The service pins the running binary's path; `vtc doctor` flags it when an upgrade moved it.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LaunchAgentSpec } from "./launchd.js";
import type { Exec } from "./process.js";

export const SYSTEMD_SERVICE = "vtc-auto-resume.service";
export const SYSTEMD_TIMER = "vtc-auto-resume.timer";

/** Where systemd looks for user units: `$XDG_CONFIG_HOME/systemd/user` (default `~/.config`). */
export const systemdUnitDir = (where: {
  readonly home: string;
  readonly configHome: string | null;
}): string => join(where.configHome ?? join(where.home, ".config"), "systemd", "user");

const refuseControl = (value: string): string => {
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value))
    throw new Error(`a systemd unit cannot carry a control character: ${JSON.stringify(value)}`);
  return value;
};

/**
 * One double-quoted word of a unit file: C-style `\\` and `\"`, `%%` for a literal `%` (a
 * specifier otherwise) and, in command lines, `$$` for a literal `$` (an expansion otherwise).
 */
const quoted = (value: string, command: boolean): string => {
  let text = refuseControl(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
  if (command) text = text.replace(/\$/g, "$$$$");
  return `"${text}"`;
};

const unquoted = (word: string): string =>
  word
    .replace(/\\(["\\])/g, "$1")
    .replace(/%%/g, "%")
    .replace(/\$\$/g, "$");

/** The service unit: VTC_HOME and the user's PATH, then `<vtc> engine --wake-due`. */
export const renderSystemdService = (spec: LaunchAgentSpec): string => {
  const args = [...spec.selfCommand, "engine", "--wake-due"];
  return [
    `[Unit]`,
    `Description=VTC auto-resume: restarts runs parked on a usage limit once it resets`,
    ``,
    `[Service]`,
    `Type=oneshot`,
    `Environment=${quoted(`VTC_HOME=${spec.vtcHome}`, false)}`,
    `Environment=${quoted(`PATH=${spec.path}`, false)}`,
    `ExecStart=${args.map((a) => quoted(a, true)).join(" ")}`,
    ``,
  ].join("\n");
};

/** The timer unit: every minute, catching up a missed start. */
export const renderSystemdTimer = (): string =>
  [
    `[Unit]`,
    `Description=VTC auto-resume: checks every minute for runs waiting on a usage reset`,
    ``,
    `[Timer]`,
    `OnCalendar=minutely`,
    `AccuracySec=10s`,
    `Persistent=true`,
    `Unit=${SYSTEMD_SERVICE}`,
    ``,
    `[Install]`,
    `WantedBy=timers.target`,
    ``,
  ].join("\n");

/** The program a service unit runs: the first word of its `ExecStart`. */
export const systemdProgram = (service: string): string | null => {
  const match = /^ExecStart="((?:[^"\\]|\\.)*)"/m.exec(service);
  return match?.[1] === undefined ? null : unquoted(match[1]);
};

export interface SystemdDeps {
  readonly home: string;
  /** `$XDG_CONFIG_HOME`, or `null` for `~/.config`. */
  readonly configHome: string | null;
  /** Runs `systemctl`; tests inject a recorder. */
  readonly exec: Exec;
}

const systemctl = async (deps: SystemdDeps, ...args: string[]): Promise<void> => {
  const result = await deps.exec("systemctl", ["--user", ...args], { timeoutMs: 20_000 });
  if (result.code !== 0)
    throw new Error(
      `systemctl --user ${args.join(" ")} failed: ${(result.stderr || result.error || "").trim().slice(0, 300)}`,
    );
};

/**
 * Writes both units, reloads the user manager and enables the timer. On failure nothing stays
 * installed. Returns the timer unit's path.
 */
export const installSystemdTimer = async (
  deps: SystemdDeps,
  spec: LaunchAgentSpec,
): Promise<string> => {
  const dir = systemdUnitDir(deps);
  const service = renderSystemdService(spec);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, SYSTEMD_SERVICE), service, { mode: 0o644 });
  writeFileSync(join(dir, SYSTEMD_TIMER), renderSystemdTimer(), { mode: 0o644 });
  try {
    await systemctl(deps, "daemon-reload");
    await systemctl(deps, "enable", "--now", SYSTEMD_TIMER);
  } catch (error) {
    rmSync(join(dir, SYSTEMD_SERVICE), { force: true });
    rmSync(join(dir, SYSTEMD_TIMER), { force: true });
    throw error;
  }
  return join(dir, SYSTEMD_TIMER);
};

/** Disables the timer and deletes both units. Idempotent. Returns the timer unit's path. */
export const uninstallSystemdTimer = async (deps: SystemdDeps): Promise<string> => {
  const dir = systemdUnitDir(deps);
  await deps.exec("systemctl", ["--user", "disable", "--now", SYSTEMD_TIMER], {
    timeoutMs: 20_000,
  });
  rmSync(join(dir, SYSTEMD_SERVICE), { force: true });
  rmSync(join(dir, SYSTEMD_TIMER), { force: true });
  await deps.exec("systemctl", ["--user", "daemon-reload"], { timeoutMs: 20_000 });
  return join(dir, SYSTEMD_TIMER);
};

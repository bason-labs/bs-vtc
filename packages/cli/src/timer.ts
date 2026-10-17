/**
 * The OS timer behind auto-resume (§6.9 step 4, AD-6 rule 4), per platform: a launchd agent on
 * macOS (`launchd.ts`), a systemd user timer on Linux (`systemd.ts`). Both run
 * `vtc engine --wake-due` every minute; only `vtc install --auto-resume` installs them (spine §5
 * reading 59), `--no-auto-resume` removes them, `vtc doctor` checks them. Windows has no timer in
 * v1 (D-aj, reading 56): there a parked run resumes when its engine next runs.
 */
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  installLaunchAgent,
  launchAgentPath,
  plistProgram,
  uninstallLaunchAgent,
  type LaunchAgentSpec,
} from "./launchd.js";
import { exec, type Exec } from "./process.js";
import {
  installSystemdTimer,
  SYSTEMD_SERVICE,
  systemdProgram,
  systemdUnitDir,
  uninstallSystemdTimer,
} from "./systemd.js";

/** What the timer runs: this `vtc`, the VTC home and the user's PATH. */
export type TimerSpec = LaunchAgentSpec;

/** The user session the timer is installed into; tests pass temp dirs and an exec recorder. */
export interface TimerHost {
  readonly home: string;
  readonly uid: number;
  /** Runs `launchctl` / `systemctl`. */
  readonly exec: Exec;
  /** `$XDG_CONFIG_HOME` (systemd only), or `null` for `~/.config`. */
  readonly configHome: string | null;
}

export interface AutoResumeTimer {
  /** How messages name it: "launchd timer", "systemd timer". */
  readonly kind: string;
  /** The installed file that names the program the timer runs. */
  readonly file: (host: Pick<TimerHost, "home" | "configHome">) => string;
  /** The program in that file, or `null` when it names none. */
  readonly program: (text: string) => string | null;
  /** Installs (or reinstalls) and enables the timer; returns the path to show. */
  readonly install: (host: TimerHost, spec: TimerSpec) => Promise<string>;
  /** Disables and removes the timer. Idempotent; returns the path to show. */
  readonly uninstall: (host: TimerHost) => Promise<string>;
}

const LAUNCHD: AutoResumeTimer = {
  kind: "launchd timer",
  file: (host) => launchAgentPath(host.home),
  program: plistProgram,
  install: installLaunchAgent,
  uninstall: uninstallLaunchAgent,
};

const SYSTEMD: AutoResumeTimer = {
  kind: "systemd timer",
  file: (host) => join(systemdUnitDir(host), SYSTEMD_SERVICE),
  program: systemdProgram,
  install: installSystemdTimer,
  uninstall: uninstallSystemdTimer,
};

/** The platform's timer, or `null` where VTC has none yet. */
export const autoResumeTimer = (platform: NodeJS.Platform): AutoResumeTimer | null =>
  platform === "darwin" ? LAUNCHD : platform === "linux" ? SYSTEMD : null;

/** This user's session. systemd ignores a relative `$XDG_CONFIG_HOME`, and so does VTC. */
export const defaultTimerHost = (): TimerHost => {
  const xdg = process.env.XDG_CONFIG_HOME;
  return {
    home: homedir(),
    uid: process.getuid?.() ?? 0,
    exec,
    configHome: xdg !== undefined && isAbsolute(xdg) ? xdg : null,
  };
};

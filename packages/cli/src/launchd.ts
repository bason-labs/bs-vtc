/**
 * The macOS launchd agent behind auto-resume (§6.9 step 4, AD-6 rule 4). Installed by
 * `vtc install <host>` (which says so) or `vtc install --auto-resume`, and removed by
 * `vtc install --no-auto-resume`; the engine's scheduler only writes wake records
 * (`scheduler.ts`). The plist pins the running binary's path; `vtc doctor` flags it when an
 * upgrade moved the binary. The agent runs
 * `vtc engine --wake-due` every minute while the user is logged in; that command does nothing
 * unless a wake record is due.
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Exec } from "./process.js";

export const LAUNCHD_LABEL = "vtc.auto-resume";
export const WAKE_INTERVAL_SECONDS = 60;

export const launchAgentPath = (home: string): string =>
  join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);

const xml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

export interface LaunchAgentSpec {
  /** `CliRuntime.selfCommand`: the program and its leading arguments. */
  readonly selfCommand: readonly string[];
  readonly vtcHome: string;
  /** The PATH the agent runs with, so `git`, `gh` and the host CLIs resolve as in the shell. */
  readonly path: string;
}

/** The agent's property list. */
export const renderLaunchAgent = (spec: LaunchAgentSpec): string => {
  const args = [...spec.selfCommand, "engine", "--wake-due"];
  const log = join(spec.vtcHome, "logs", "auto-resume.log");
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key>`,
    `  <string>${LAUNCHD_LABEL}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    ...args.map((a) => `    <string>${xml(a)}</string>`),
    `  </array>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict>`,
    `    <key>VTC_HOME</key>`,
    `    <string>${xml(spec.vtcHome)}</string>`,
    `    <key>PATH</key>`,
    `    <string>${xml(spec.path)}</string>`,
    `  </dict>`,
    `  <key>StartInterval</key>`,
    `  <integer>${String(WAKE_INTERVAL_SECONDS)}</integer>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>ProcessType</key>`,
    `  <string>Background</string>`,
    `  <key>StandardOutPath</key>`,
    `  <string>${xml(log)}</string>`,
    `  <key>StandardErrorPath</key>`,
    `  <string>${xml(log)}</string>`,
    `</dict>`,
    `</plist>`,
    ``,
  ].join("\n");
};

export interface LaunchdDeps {
  /** The user's home (`~/Library/LaunchAgents` lives under it); a temp dir in tests. */
  readonly home: string;
  readonly uid: number;
  /** Runs `launchctl`; tests inject a recorder. */
  readonly exec: Exec;
}

/** Writes the agent and (re)loads it into the user's GUI domain. Returns the plist path. */
export const installLaunchAgent = async (
  deps: LaunchdDeps,
  spec: LaunchAgentSpec,
): Promise<string> => {
  const plist = launchAgentPath(deps.home);
  mkdirSync(dirname(plist), { recursive: true });
  mkdirSync(join(spec.vtcHome, "logs"), { recursive: true, mode: 0o700 });
  writeFileSync(plist, renderLaunchAgent(spec), { mode: 0o644 });
  const domain = `gui/${String(deps.uid)}`;
  await deps.exec("launchctl", ["bootout", `${domain}/${LAUNCHD_LABEL}`], { timeoutMs: 10_000 });
  const loaded = await deps.exec("launchctl", ["bootstrap", domain, plist], { timeoutMs: 10_000 });
  if (loaded.code !== 0)
    throw new Error(
      `launchctl bootstrap failed: ${(loaded.stderr || loaded.error || "").trim().slice(0, 300)}`,
    );
  return plist;
};

/** Unloads and deletes the agent. Idempotent. */
export const uninstallLaunchAgent = async (deps: LaunchdDeps): Promise<string> => {
  const plist = launchAgentPath(deps.home);
  await deps.exec("launchctl", ["bootout", `gui/${String(deps.uid)}/${LAUNCHD_LABEL}`], {
    timeoutMs: 10_000,
  });
  rmSync(plist, { force: true });
  return plist;
};

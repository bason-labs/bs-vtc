/**
 * Owner: cli+binary team (wiring, auto-resume timer); the host part is `HostAdapter.install`
 * (adapters team), which places the compiled plugin (AD-6, AD-16).
 *
 * `vtc install --host <claude-code|codex> [--scope user|project]` (or `vtc install <host>`, the
 * spec §4.4 form) creates the install token, puts the compiled plugin on disk (the binary extracts
 * its embedded `plugin:<host>`, AD-20 rule 5) and calls the adapter from `ADAPTER_FACTORIES`.
 * It also installs the OS timer behind auto-resume (AD-6 rule 4, §6.9 step 4: "installed by
 * `vtc install`"; `timer.ts`: launchd on macOS, a systemd user timer on Linux), and says so;
 * `--no-auto-resume` skips it and removes an installed one. `vtc install --auto-resume` alone
 * (re)installs just the timer, e.g. after the binary moved. When the timer only came with the
 * host and cannot be installed (no systemd user session, say), the plugin stays installed and
 * the failure is reported with the command that retries it.
 */
import { homedir } from "node:os";
import { ADAPTER_FACTORIES } from "@vtc/adapters";
import { HostIdSchema, type HostAdapter, type HostId } from "@vtc/shared";
import { findRepoRoot, UsageError } from "../repo.js";
import { runtime } from "../runtime.js";
import { autoResumeTimer, defaultTimerHost, type TimerHost, type TimerSpec } from "../timer.js";
import { ensureInstallToken } from "../token.js";
import type { CommandSpec } from "./types.js";
import { EXIT, guarded, parseFlags } from "./util.js";

export interface InstallDeps {
  readonly factories: Readonly<Partial<Record<HostId, () => HostAdapter>>>;
  /** The user's home, where host user-scope files go (`InstallRequest.home`). */
  readonly home: () => string;
  readonly pluginDir: (host: HostId, vtcHome: string) => string;
  readonly platform: NodeJS.Platform;
  /** The user session the auto-resume timer goes into. */
  readonly timerHost: () => TimerHost;
  readonly agentSpec: (vtcHome: string) => TimerSpec;
}

export const defaultInstallDeps = (): InstallDeps => ({
  factories: ADAPTER_FACTORIES,
  home: homedir,
  pluginDir: (host, vtcHome) => runtime().pluginDir(host, vtcHome),
  platform: process.platform,
  timerHost: defaultTimerHost,
  agentSpec: (vtcHome) => ({
    selfCommand: runtime().selfCommand,
    vtcHome,
    path: process.env.PATH ?? "/usr/bin:/bin",
  }),
});

export const createInstallCommand = (
  deps: () => InstallDeps = defaultInstallDeps,
): CommandSpec => ({
  name: "install",
  summary:
    "Install the plugin for a host (vtc install <claude-code|codex>) and the auto-resume timer",
  run: (args, ctx) =>
    guarded("install", ctx, async () => {
      const { values, positionals } = parseFlags(
        args,
        {
          host: { type: "string" },
          scope: { type: "string", default: "user" },
          "auto-resume": { type: "boolean" },
          "no-auto-resume": { type: "boolean" },
        },
        true,
      );
      const usage =
        "usage: vtc install <claude-code|codex> [--scope user|project] [--no-auto-resume] | vtc install --auto-resume | --no-auto-resume";
      if (positionals.length > 1 || (positionals.length === 1 && values.host !== undefined))
        throw new UsageError(usage);
      const hostName = values.host ?? positionals[0];
      const d = deps();
      const osTimer = autoResumeTimer(d.platform);
      if (values["auto-resume"] === true && values["no-auto-resume"] === true)
        throw new UsageError("pass either --auto-resume or --no-auto-resume");
      const timer =
        values["auto-resume"] === true
          ? "on"
          : values["no-auto-resume"] === true
            ? "off"
            : hostName !== undefined && osTimer !== null
              ? "implied"
              : null;
      if (hostName === undefined && timer === null) throw new UsageError(usage);
      if (values.scope !== "user" && values.scope !== "project")
        throw new UsageError(`--scope must be user or project, got ${values.scope}`);
      ensureInstallToken(ctx.vtcHome);
      if (hostName !== undefined) {
        const host = HostIdSchema.safeParse(hostName);
        if (!host.success)
          throw new UsageError(`the host must be claude-code or codex, got ${hostName}`);
        const factory = d.factories[host.data];
        if (factory === undefined)
          throw new Error(`this build of vtc has no ${host.data} adapter yet`);
        const adapter = factory();
        try {
          const result = await adapter.install({
            projectRoot: (await findRepoRoot(ctx.cwd)) ?? ctx.cwd,
            home: d.home(),
            pluginDir: d.pluginDir(host.data, ctx.vtcHome),
            scope: values.scope,
          });
          ctx.io.out(`Installed the VTC plugin for ${host.data}.`);
          for (const path of result.written) ctx.io.out(`  wrote ${path}`);
          for (const note of result.notes) ctx.io.out(`  note: ${note}`);
        } finally {
          await adapter.dispose();
        }
      }
      if (osTimer === null) {
        if (timer === "on")
          throw new Error(
            "the auto-resume timer needs launchd (macOS) or systemd (Linux); on this platform a run resumes when the engine is running",
          );
        if (hostName !== undefined)
          ctx.io.out(
            "Auto-resume has no timer on this platform yet: a run parked on a usage limit resumes when its engine is running.",
          );
      } else if (timer === "off") {
        const path = await osTimer.uninstall(d.timerHost());
        ctx.io.out(`Removed the auto-resume timer (${path}).`);
      } else if (timer !== null) {
        let path: string;
        try {
          path = await osTimer.install(d.timerHost(), d.agentSpec(ctx.vtcHome));
        } catch (error) {
          if (timer === "on") throw error;
          const reason = error instanceof Error ? error.message : String(error);
          ctx.io.err(
            `vtc install: the auto-resume timer was not installed: ${reason}. A run parked on a usage limit resumes only when its engine runs; fix this and run vtc install --auto-resume.`,
          );
          return EXIT.ok;
        }
        ctx.io.out(
          `Installed the auto-resume timer (${path}): it checks every minute for runs waiting on a usage reset (--no-auto-resume removes it).`,
        );
      }
      return EXIT.ok;
    }),
});

export const command = createInstallCommand();

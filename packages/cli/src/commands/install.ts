/**
 * Owner: cli+binary team (wiring, launchd timer); the host part is `HostAdapter.install`
 * (adapters team), which places the compiled plugin (AD-6, AD-16).
 *
 * `vtc install --host <claude-code|codex> [--scope user|project]` (or `vtc install <host>`, the
 * spec §4.4 form) creates the install token, puts the compiled plugin on disk (the binary extracts
 * its embedded `plugin:<host>`, AD-20 rule 5) and calls the adapter from `ADAPTER_FACTORIES`.
 * On macOS it also installs the launchd agent behind auto-resume (AD-6 rule 4, §6.9 step 4:
 * "installed by `vtc install`"), and says so; `--no-auto-resume` skips it and removes an installed
 * one. `vtc install --auto-resume` alone (re)installs just the agent, e.g. after the binary moved.
 */
import { homedir } from "node:os";
import { ADAPTER_FACTORIES } from "@vtc/adapters";
import { HostIdSchema, type HostAdapter, type HostId } from "@vtc/shared";
import {
  installLaunchAgent,
  uninstallLaunchAgent,
  type LaunchAgentSpec,
  type LaunchdDeps,
} from "../launchd.js";
import { exec } from "../process.js";
import { findRepoRoot, UsageError } from "../repo.js";
import { runtime } from "../runtime.js";
import { ensureInstallToken } from "../token.js";
import type { CommandSpec } from "./types.js";
import { EXIT, guarded, parseFlags } from "./util.js";

export interface InstallDeps {
  readonly factories: Readonly<Partial<Record<HostId, () => HostAdapter>>>;
  /** The user's home, where host user-scope files go (`InstallRequest.home`). */
  readonly home: () => string;
  readonly pluginDir: (host: HostId, vtcHome: string) => string;
  readonly platform: NodeJS.Platform;
  readonly launchd: () => LaunchdDeps;
  readonly agentSpec: (vtcHome: string) => LaunchAgentSpec;
}

export const defaultInstallDeps = (): InstallDeps => ({
  factories: ADAPTER_FACTORIES,
  home: homedir,
  pluginDir: (host, vtcHome) => runtime().pluginDir(host, vtcHome),
  platform: process.platform,
  launchd: () => ({ home: homedir(), uid: process.getuid?.() ?? 0, exec }),
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
      if (values["auto-resume"] === true && values["no-auto-resume"] === true)
        throw new UsageError("pass either --auto-resume or --no-auto-resume");
      const timer =
        values["auto-resume"] === true
          ? "on"
          : values["no-auto-resume"] === true
            ? "off"
            : hostName !== undefined && d.platform === "darwin"
              ? "on"
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
      if (d.platform !== "darwin") {
        if (timer === "on")
          throw new Error(
            "the auto-resume timer is a launchd agent and needs macOS; on this platform a run resumes when the engine is running",
          );
        if (hostName !== undefined)
          ctx.io.out(
            "Auto-resume has no timer on this platform yet: a run parked on a usage limit resumes when its engine is running.",
          );
      } else if (timer !== null) {
        const plist =
          timer === "on"
            ? await installLaunchAgent(d.launchd(), d.agentSpec(ctx.vtcHome))
            : await uninstallLaunchAgent(d.launchd());
        ctx.io.out(
          timer === "on"
            ? `Installed the auto-resume timer (${plist}): it checks every minute for runs waiting on a usage reset (--no-auto-resume removes it).`
            : `Removed the auto-resume timer (${plist}).`,
        );
      }
      return EXIT.ok;
    }),
});

export const command = createInstallCommand();

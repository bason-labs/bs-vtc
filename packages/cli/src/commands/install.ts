/**
 * Owner: cli+binary team (wiring, launchd timer); the host part is `HostAdapter.install`
 * (adapters team), which places the compiled plugin (AD-6, AD-16).
 *
 * `vtc install --host <claude-code|codex> [--scope user|project]` creates the install token,
 * puts the compiled plugin on disk (the binary extracts its embedded `plugin:<host>`, AD-20
 * rule 5) and calls the adapter from `ADAPTER_FACTORIES`.
 * `vtc install --auto-resume` installs the macOS launchd agent behind auto-resume (§6.9 step 4);
 * `--no-auto-resume` removes it. The timer is installed only by this explicit flag, never as a
 * side effect of anything else.
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
  summary: "Install the plugin for a host (--host claude-code|codex); --auto-resume timer",
  run: (args, ctx) =>
    guarded("install", ctx, async () => {
      const { values } = parseFlags(args, {
        host: { type: "string" },
        scope: { type: "string", default: "user" },
        "auto-resume": { type: "boolean" },
        "no-auto-resume": { type: "boolean" },
      });
      const timer =
        values["auto-resume"] === true ? "on" : values["no-auto-resume"] === true ? "off" : null;
      if (values["auto-resume"] === true && values["no-auto-resume"] === true)
        throw new UsageError("pass either --auto-resume or --no-auto-resume");
      if (values.host === undefined && timer === null)
        throw new UsageError(
          "usage: vtc install --host <claude-code|codex> [--scope user|project] [--auto-resume | --no-auto-resume]",
        );
      if (values.scope !== "user" && values.scope !== "project")
        throw new UsageError(`--scope must be user or project, got ${values.scope}`);
      const d = deps();
      ensureInstallToken(ctx.vtcHome);
      if (values.host !== undefined) {
        const host = HostIdSchema.safeParse(values.host);
        if (!host.success)
          throw new UsageError(`--host must be claude-code or codex, got ${values.host}`);
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
      if (timer !== null) {
        if (d.platform !== "darwin")
          throw new Error(
            "the auto-resume timer is a launchd agent and needs macOS; on this platform a run resumes when the engine is running",
          );
        const plist =
          timer === "on"
            ? await installLaunchAgent(d.launchd(), d.agentSpec(ctx.vtcHome))
            : await uninstallLaunchAgent(d.launchd());
        ctx.io.out(
          timer === "on"
            ? `Installed the auto-resume timer (${plist}): it checks every minute for runs waiting on a usage reset.`
            : `Removed the auto-resume timer (${plist}).`,
        );
      }
      return EXIT.ok;
    }),
});

export const command = createInstallCommand();

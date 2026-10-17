/**
 * Owner: cli+binary team (wiring, auto-resume timer); the host part is `HostAdapter.install`
 * (adapters team), which places the compiled plugin (AD-6, AD-16).
 *
 * `vtc install --host <claude-code|codex> [--scope user|project]` (or `vtc install <host>`, the
 * spec §4.4 form) creates the install token, puts the compiled plugin on disk (the binary extracts
 * its embedded `plugin:<host>`, AD-20 rule 5) and calls the adapter from `ADAPTER_FACTORIES`,
 * constructed with `{ pluginDir, vtcHome, vtcVersion }` (spine §5 reading 66). Without `--scope`
 * each host gets its `DEFAULT_INSTALL_SCOPE` (D-ah, reading 54): Claude Code for the user, Codex
 * in the project.
 *
 * `vtc install claude-code` also sets up the Claude Code session sandbox of the repo it runs in
 * (D-an, spine §5 reading 71): in plugin-only dispatch a code-running role runs inside the human's
 * Lead session, which the engine allows only with the sandbox on. It shows the settings
 * (`sessionSandboxSettings`: the shared `claudeSessionSandboxSettings` plus `failIfUnavailable`)
 * and any local entries that would let a command past the sandbox, and after the human confirms at
 * the terminal merges the settings into the project's `.claude/settings.local.json` (those entries
 * dropped, the user's other keys kept, never through a link) and makes sure git ignores that file
 * (the repo's `info/exclude`; a tracked file is refused). What still keeps the sandbox off from
 * other settings files (the repo's committed ones, the user's own) is named, never edited.
 *
 * The user's Claude Code statusline is left alone (H-10, spine §5 reading 264): only
 * `vtc install claude-code --statusline` wraps it in `vtc statusline-tee`, after the human
 * confirms at the terminal as for the session sandbox, and never twice;
 * `--no-statusline` puts back the command an earlier install wrapped. The preview of the session
 * sandbox settings names the file and counts each list; `--verbose` prints every entry.
 *
 * Registering the Codex plugin (marketplace and `[plugins."vtc@…"]`) is `HostAdapter.install`'s
 * job (AD-6, AD-16 rule 4, reading 60), so its files pass the adapter safety contract; until the
 * spine's §7 "Codex plugin manifest fields" row closes, the Codex install places the skills only
 * and registers no hooks (reading 94). The cli writes none of it.
 *
 * The OS timer behind auto-resume (AD-6 rule 4, §6.9 step 4; `timer.ts`: launchd on macOS, a
 * systemd user timer on Linux) is installed only on an explicit `--auto-resume`, never silently
 * (reading 59): `vtc install --auto-resume` alone (re)installs just the timer (e.g. after the
 * binary moved), `vtc install <host> --auto-resume` both, and `--no-auto-resume` removes it. A
 * plain `vtc install <host>` says how to get it. Windows has no timer in v1 (D-aj, reading 56): a
 * run parked on a usage limit resumes when its engine next runs on that repo.
 */
import { homedir } from "node:os";
import { ADAPTER_FACTORIES } from "@vtc/adapters";
import {
  DEFAULT_INSTALL_SCOPE,
  hostConfigDirsOf,
  HostIdSchema,
  type HostId,
  type StatuslineChoice,
} from "@vtc/shared";
import { ttyConfirm } from "../confirm.js";
import { findRepoRoot, UsageError } from "../repo.js";
import { runtime } from "../runtime.js";
import {
  CLAUDE_LOCAL_SETTINGS,
  claudeSessionSandboxOf,
  defaultSessionSandboxEnv,
  excludeFromGit,
  gitIgnoreStatus,
  mergeSessionSandboxSettings,
  readClaudeLocalSettings,
  sandboxScopeOf,
  sessionSandboxSettings,
  wideningOf,
  writeClaudeLocalSettings,
  type SessionSandboxEnv,
} from "../session-sandbox.js";
import { autoResumeTimer, defaultTimerHost, type TimerHost, type TimerSpec } from "../timer.js";
import { ensureInstallToken } from "../token.js";
import { rememberCodexProject } from "../update.js";
import { VERSION } from "../version.js";
import type { AdapterFactory } from "../wiring.js";
import type { CommandContext, CommandSpec } from "./types.js";
import { EXIT, guarded, parseFlags } from "./util.js";

export interface InstallDeps {
  readonly factories: Readonly<Partial<Record<HostId, AdapterFactory>>>;
  /** The user's home, where host user-scope files go (`InstallRequest.home`). */
  readonly home: () => string;
  readonly pluginDir: (host: HostId, vtcHome: string) => string;
  readonly platform: NodeJS.Platform;
  /** The user session the auto-resume timer goes into. */
  readonly timerHost: () => TimerHost;
  readonly agentSpec: (vtcHome: string) => TimerSpec;
  /** Asks the human at the terminal (`ttyConfirm`: no terminal is no). */
  readonly confirm: (question: string) => Promise<boolean>;
  /** Where the Claude session sandbox state is read from (the real machine by default). */
  readonly sessionSandboxEnv: () => SessionSandboxEnv;
  /**
   * The Codex home for the user's home (`$CODEX_HOME`, else `<home>/.codex`), passed to the
   * adapters, which no longer read `CODEX_HOME` themselves (AD-6 rule 5). Absent:
   * `<home>/.codex`.
   */
  readonly codexHome?: (home: string) => string;
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
  confirm: ttyConfirm,
  sessionSandboxEnv: defaultSessionSandboxEnv,
  codexHome: (home) => hostConfigDirsOf(process.env, home).codex,
});

/**
 * The settings `vtc install` would write, one line per key: a list as its count, any other value
 * as JSON. Hundreds of deny paths would bury the question (the owner's first run).
 */
export const settingsOutline = (value: unknown, prefix = ""): string[] => {
  if (Array.isArray(value))
    return [`${prefix}: ${String(value.length)} ${value.length === 1 ? "entry" : "entries"}`];
  if (typeof value === "object" && value !== null)
    return Object.entries(value).flatMap(([key, inner]) =>
      settingsOutline(inner, prefix === "" ? key : `${prefix}.${key}`),
    );
  return [`${prefix}: ${JSON.stringify(value)}`];
};

/**
 * The Claude Code session sandbox of the repo `vtc install claude-code` runs in (D-an). Resolves
 * false when something is in the way (a link, a file that does not parse, a tracked file); a
 * human who declines is not a failure.
 */
const installSessionSandbox = async (
  ctx: CommandContext,
  d: InstallDeps,
  repoRoot: string | null,
  verbose: boolean,
): Promise<boolean> => {
  if (d.platform === "win32") {
    ctx.io.out(
      "Note: Claude Code has no session sandbox on Windows, so code-running roles run headless or not at all there.",
    );
    return true;
  }
  if (repoRoot === null) {
    ctx.io.out(
      "Note: not in a git repository, so no session sandbox was set up: run vtc install claude-code in each repo whose Claude Code sessions should run code-running roles.",
    );
    return true;
  }
  const read = readClaudeLocalSettings(repoRoot);
  if (read.kind === "unreadable") {
    ctx.io.err(
      `vtc install: ${read.path} does not parse or is not a plain file (${read.error}); fix it, then run vtc install claude-code again`,
    );
    return false;
  }
  const ignore = await gitIgnoreStatus(repoRoot, CLAUDE_LOCAL_SETTINGS);
  if (ignore === "tracked") {
    ctx.io.err(
      `vtc install: ${read.path} is tracked by git: run git rm --cached ${CLAUDE_LOCAL_SETTINGS} (it holds this machine's paths), then run vtc install claude-code again`,
    );
    return false;
  }
  const ensureIgnored = async (): Promise<void> => {
    if (ignore === "not-ignored") {
      const exclude = await excludeFromGit(repoRoot, CLAUDE_LOCAL_SETTINGS);
      ctx.io.out(`  git ignores ${CLAUDE_LOCAL_SETTINGS} now (${exclude})`);
    }
  };
  const env = d.sessionSandboxEnv();
  if (claudeSessionSandboxOf(repoRoot, ctx.vtcHome, env, ctx.cwd).state === "on") {
    ctx.io.out(`The Claude Code session sandbox is already on in ${read.path}.`);
    await ensureIgnored();
    return true;
  }
  ctx.io.out(
    `Code-running roles run inside your Claude Code session (plugin-only dispatch) only with its sandbox on. These settings go into ${read.path} (your other settings stay):`,
  );
  const wanted = sessionSandboxSettings(ctx.vtcHome, sandboxScopeOf(repoRoot, env));
  const lines = verbose ? JSON.stringify(wanted, null, 2).split("\n") : settingsOutline(wanted);
  for (const line of lines) ctx.io.out(`  ${line}`);
  if (!verbose)
    ctx.io.out(
      "  (every list holds deny rules: paths the session may not read or write, commands it may not run; vtc install claude-code --verbose prints every entry)",
    );
  const dropped =
    read.kind === "ok"
      ? wideningOf(
          read.settings,
          { path: read.path, base: repoRoot, homeDir: env.homeDir },
          ctx.vtcHome,
          env.platform,
          sandboxScopeOf(repoRoot, env),
        )
      : [];
  if (dropped.length > 0) {
    ctx.io.out(`These entries in it let commands past the sandbox and are removed:`);
    for (const entry of dropped) ctx.io.out(`  - ${entry}`);
  }
  if (!(await d.confirm(`Write them to ${read.path}?`))) {
    ctx.io.out(
      `Session sandbox not written: code-running roles are refused in your Claude Code session until it is (run vtc install claude-code in a terminal and confirm).`,
    );
    return true;
  }
  const path = writeClaudeLocalSettings(
    repoRoot,
    mergeSessionSandboxSettings(read.kind === "ok" ? read.settings : {}, ctx.vtcHome, {
      projectRoot: repoRoot,
      homeDir: env.homeDir,
      platform: env.platform,
      ...(env.hostConfigDirs === undefined ? {} : { hostConfigDirs: env.hostConfigDirs }),
    }),
  );
  ctx.io.out(`  wrote ${path}`);
  await ensureIgnored();
  const after = claudeSessionSandboxOf(repoRoot, ctx.vtcHome, env, ctx.cwd);
  if (after.state !== "on") {
    ctx.io.out(
      `The session sandbox is still ${after.state}, so code-running roles stay refused in your Claude Code session:`,
    );
    for (const entry of after.widening) ctx.io.out(`  - ${entry} (remove it)`);
    for (const tool of after.unavailable)
      ctx.io.out(`  - this machine lacks ${tool}, which Claude Code's sandbox needs`);
  }
  return true;
};

export const createInstallCommand = (
  deps: () => InstallDeps = defaultInstallDeps,
): CommandSpec => ({
  name: "install",
  summary:
    "Install the plugin for a host (vtc install <claude-code|codex>); --auto-resume installs the auto-resume timer",
  run: (args, ctx) =>
    guarded("install", ctx, async () => {
      const { values, positionals } = parseFlags(
        args,
        {
          host: { type: "string" },
          scope: { type: "string" },
          "auto-resume": { type: "boolean" },
          "no-auto-resume": { type: "boolean" },
          statusline: { type: "boolean" },
          "no-statusline": { type: "boolean" },
          verbose: { type: "boolean" },
        },
        true,
      );
      const usage =
        "usage: vtc install <claude-code|codex> [--scope user|project] [--auto-resume | --no-auto-resume] [--statusline | --no-statusline] [--verbose] | vtc install --auto-resume | --no-auto-resume";
      if (positionals.length > 1 || (positionals.length === 1 && values.host !== undefined))
        throw new UsageError(usage);
      const hostName = values.host ?? positionals[0];
      const d = deps();
      const osTimer = autoResumeTimer(d.platform);
      if (values["auto-resume"] === true && values["no-auto-resume"] === true)
        throw new UsageError("pass either --auto-resume or --no-auto-resume");
      const timer =
        values["auto-resume"] === true ? "on" : values["no-auto-resume"] === true ? "off" : null;
      if (hostName === undefined && timer === null) throw new UsageError(usage);
      if (values.statusline === true && values["no-statusline"] === true)
        throw new UsageError("pass either --statusline or --no-statusline");
      const statuslineFlag =
        values.statusline === true ? "wrap" : values["no-statusline"] === true ? "unwrap" : null;
      if (statuslineFlag !== null && hostName !== "claude-code")
        throw new UsageError("--statusline and --no-statusline are for vtc install claude-code");
      const scope = values.scope;
      if (scope !== undefined && scope !== "user" && scope !== "project")
        throw new UsageError(`--scope must be user or project, got ${scope}`);
      ensureInstallToken(ctx.vtcHome);
      let failed = false;
      if (hostName !== undefined) {
        const host = HostIdSchema.safeParse(hostName);
        if (!host.success)
          throw new UsageError(`the host must be claude-code or codex, got ${hostName}`);
        const factory = d.factories[host.data];
        if (factory === undefined)
          throw new Error(`this build of vtc has no ${host.data} adapter yet`);
        const pluginDir = d.pluginDir(host.data, ctx.vtcHome);
        const codexHome = (d.codexHome ?? ((home) => hostConfigDirsOf({}, home).codex))(d.home());
        const adapter = factory({
          pluginDir,
          vtcHome: ctx.vtcHome,
          vtcVersion: VERSION,
          codexHome,
        });
        const repoRoot = await findRepoRoot(ctx.cwd);
        const installScope = scope ?? DEFAULT_INSTALL_SCOPE[host.data];
        let statusline: StatuslineChoice = statuslineFlag ?? "keep";
        if (statusline === "wrap") {
          ctx.io.out(
            "With --statusline your Claude Code statusline runs through vtc statusline-tee: it shows your statusline unchanged and forwards only the usage windows (5-hour and weekly use) to the local engine. vtc install claude-code --no-statusline undoes it.",
          );
          if (!(await d.confirm("Wrap your Claude Code statusline in vtc statusline-tee?"))) {
            ctx.io.out("Statusline left as it is.");
            statusline = "keep";
          }
        }
        try {
          const result = await adapter.install({
            projectRoot: repoRoot ?? ctx.cwd,
            home: d.home(),
            pluginDir,
            scope: installScope,
            vtcHome: ctx.vtcHome,
            ...(host.data === "claude-code" ? { statusline } : {}),
          });
          ctx.io.out(`Installed the VTC plugin for ${host.data}.`);
          // `vtc update` installs it again here with the new binary
          if (host.data === "codex" && installScope === "project" && repoRoot !== null)
            try {
              rememberCodexProject(ctx.vtcHome, repoRoot);
            } catch {
              // only `vtc update` misses this repo; `vtc update --repo` names it
            }
          for (const path of result.written) ctx.io.out(`  wrote ${path}`);
          for (const note of result.notes) ctx.io.out(`  note: ${note}`);
        } finally {
          await adapter.dispose();
        }
        if (
          host.data === "claude-code" &&
          !(await installSessionSandbox(ctx, d, repoRoot, values.verbose === true))
        )
          failed = true;
      }
      if (osTimer === null) {
        if (timer === "on")
          throw new Error(
            "the auto-resume timer needs launchd (macOS) or systemd (Linux); on this platform a run parked on a usage limit resumes when its engine next runs",
          );
        if (hostName !== undefined)
          ctx.io.out(
            "Note: no auto-resume timer on this platform in v1: a run parked on a usage limit resumes when its engine next runs on that repo.",
          );
      } else if (timer === "off") {
        const path = await osTimer.uninstall(d.timerHost());
        ctx.io.out(`Removed the auto-resume timer (${path}).`);
      } else if (timer === "on") {
        let path: string;
        try {
          path = await osTimer.install(d.timerHost(), d.agentSpec(ctx.vtcHome));
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          ctx.io.err(
            `vtc install: the auto-resume timer was not installed: ${reason}. A run parked on a usage limit resumes only when its engine runs; fix this and run vtc install --auto-resume.`,
          );
          return EXIT.failed;
        }
        ctx.io.out(
          `Installed the auto-resume timer (${path}): every minute it wakes the engine of a repo whose run waits on a usage reset; the run then continues when the Lead session asks for its next step, or, with hosts.dispatch: headless_allowed, the engine resumes it headless itself. --no-auto-resume removes it.`,
        );
      } else {
        ctx.io.out(
          `To resume runs parked on a usage limit without you, run vtc install --auto-resume to install the ${osTimer.kind}.`,
        );
      }
      return failed ? EXIT.failed : EXIT.ok;
    }),
});

export const command = createInstallCommand();

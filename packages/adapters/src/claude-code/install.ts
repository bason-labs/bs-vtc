/**
 * Claude Code `install` (§4.4, AD-6 rule 5, AD-16 rule 4; spine §5 reading 6). Places and
 * registers what the compiler emitted, authoring no plugin content:
 * 1. copies the compiled plugin into a local marketplace under `<home>/.vtc/claude-marketplace`
 *    and writes that marketplace's index (`.claude-plugin/marketplace.json`);
 * 2. registers the marketplace and enables the plugin in Claude Code settings
 *    (`extraKnownMarketplaces`, `enabledPlugins`): `~/.claude/settings.json` for the user scope,
 *    the repo's personal `.claude/settings.local.json` for the project scope (the marketplace
 *    path is machine-local, so it never goes into the shared `.claude/settings.json`);
 * 3. wires the statusline tee shim around the user's own statusline command, which keeps running
 *    unchanged (§6.9): `statusLine.command` is `statuslineTeeCommand(<user command>)` from
 *    `@vtc/shared` (spine §5 reading 61), the frozen line the cli's `vtc statusline-tee` reads.
 * 4. turns on the Claude Code session sandbox for in-session roles (D-an, spine §5 reading 71): in
 *    either scope, the project's personal `.claude/settings.local.json` gets
 *    `claudeSessionSandboxSettings(vtcHome)` from `@vtc/shared`, merged into what is there (the
 *    user's own keys and deny entries stay; `enabled` and `allowUnsandboxedCommands` are set).
 *    The cli shows the user that block before it calls `install`, and the result's notes repeat
 *    it. Only in a git checkout (a `.git` in the project root); elsewhere a note says how to turn
 *    it on. The file to write is checked with `findForbiddenInText` first, and a hit refuses the
 *    whole install before anything is written (AD-9).
 * Both scopes are accepted (the cli picks the default, `DEFAULT_INSTALL_SCOPE`, D-ah), and the
 * marketplace always lives under `InstallRequest.home` (spine §5 reading 60).
 * The exact marketplace form is provisional until the spike tries it on a real install (spine §7).
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  claudeSessionSandboxSettings,
  findForbiddenInText,
  STATUSLINE_TEE,
  statuslineTeeCommand,
  type InstallRequest,
  type InstallResult,
} from "@vtc/shared";
import { readJsonSettings, replaceDirectory, writeFileAtomic, writeJson } from "../common/files.js";
import { isRecord, text } from "../common/json.js";
import { insidePlugin, readPluginManifest } from "../common/plugin.js";

export const CLAUDE_MARKETPLACE = "vtc-local";
const CLAUDE_PLUGIN_MANIFEST = ".claude-plugin/plugin.json";

/** `vtc statusline-tee`, the shim's command line with no user command. */
const TEE = `${STATUSLINE_TEE.command} ${STATUSLINE_TEE.subcommand}`;
/** The pre-4.2 form an earlier install may have written: `vtc statusline-tee --wrap '<cmd>'`. */
const LEGACY_WRAP = `${TEE} --wrap `;

const isTee = (command: string): boolean => command === TEE || command.startsWith(`${TEE} `);

/**
 * A shim line already in place, in the frozen form: an earlier `--wrap '<cmd>'` carries the same
 * single shell word, so only the separator changes.
 */
const frozenTee = (command: string): string =>
  command.startsWith(LEGACY_WRAP)
    ? `${TEE} ${STATUSLINE_TEE.separator} ${command.slice(LEGACY_WRAP.length)}`
    : command;

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });

const statusLineCommand = (settings: Record<string, unknown>): string | null => {
  const line = settings.statusLine;
  return isRecord(line) && line.type === "command" ? text(line.command) : null;
};

/**
 * The `statusLine` to write: the shim around the command Claude Code would otherwise run. For
 * the project scope, that is the repo's local, then shared, then the user's statusline.
 */
const wiredStatusLine = (
  target: Record<string, unknown>,
  fallbacks: readonly Record<string, unknown>[],
): Record<string, unknown> => {
  const own = target.statusLine;
  const current = [target, ...fallbacks].map(statusLineCommand).find((c) => c !== null) ?? null;
  const command =
    current !== null && isTee(current) ? frozenTee(current) : statuslineTeeCommand(current);
  return { ...(isRecord(own) ? own : {}), type: "command", command };
};

/** The entries of `list` (when it is a list), then each of `add` not already in it. */
const union = (list: unknown, add: readonly string[]): unknown[] => {
  const kept: unknown[] = Array.isArray(list) ? list : [];
  return [...kept, ...add.filter((entry) => !kept.includes(entry))];
};

/**
 * `settings` with the session sandbox of {@link claudeSessionSandboxSettings} merged in: the
 * sandbox is on with no unsandboxed escape, and every VTC deny entry is present after the user's
 * own. Every other key, in `sandbox` and outside it, stays as it was.
 */
const withSessionSandbox = (
  settings: Record<string, unknown>,
  vtcHome: string,
): Record<string, unknown> => {
  const wanted = claudeSessionSandboxSettings(vtcHome).sandbox;
  const sandbox = isRecord(settings.sandbox) ? settings.sandbox : {};
  const filesystem = isRecord(sandbox.filesystem) ? sandbox.filesystem : {};
  return {
    ...settings,
    sandbox: {
      ...sandbox,
      enabled: wanted.enabled,
      allowUnsandboxedCommands: wanted.allowUnsandboxedCommands,
      filesystem: {
        ...filesystem,
        denyRead: union(filesystem.denyRead, wanted.filesystem.denyRead),
        denyWrite: union(filesystem.denyWrite, wanted.filesystem.denyWrite),
      },
    },
  };
};

/** The text `writeJson` would write. */
const jsonText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Refuses settings text that carries a bypass flag or a credential marker (AD-9). */
const refuseForbidden = (path: string, settingsText: string): void => {
  const hits = findForbiddenInText(settingsText);
  if (hits.length > 0) {
    const found = hits.map((hit) => `line ${hit.line}: ${hit.marker}`).join(", ");
    throw new Error(
      `refusing to write ${path}: it would carry what VTC never writes into host settings (${found}); remove that from the file, then install again`,
    );
  }
};

export interface ClaudeInstallOptions {
  /**
   * The absolute VTC home the cli resolved (`$VTC_HOME` or `~/.vtc`), whose token and sockets
   * the session sandbox read-denies and whose `homeWriteDeny` it write-denies (D-an).
   */
  readonly vtcHome: string;
}

/** Synchronous; the adapter wraps it so a failure is a rejected promise. */
export const installClaudeCode = (
  request: InstallRequest,
  options: ClaudeInstallOptions,
): InstallResult => {
  const manifest = readPluginManifest(request.pluginDir, "claude-code");
  const pluginJsonPath = insidePlugin(request.pluginDir, CLAUDE_PLUGIN_MANIFEST);
  if (!existsSync(pluginJsonPath)) {
    throw new Error(`no ${CLAUDE_PLUGIN_MANIFEST} in ${request.pluginDir}`);
  }
  const pluginJson = readJsonSettings(pluginJsonPath);
  const marketplace = join(request.home, ".vtc", "claude-marketplace");

  // every settings file is read and built first, so a refusal leaves everything as it was
  const userSettingsPath = join(request.home, ".claude", "settings.json");
  const localSettingsPath = join(request.projectRoot, ".claude", "settings.local.json");
  const settingsPath = request.scope === "user" ? userSettingsPath : localSettingsPath;
  const settings = readJsonSettings(settingsPath);
  const fallbacks =
    request.scope === "user"
      ? []
      : [
          readJsonSettings(join(request.projectRoot, ".claude", "settings.json")),
          readJsonSettings(userSettingsPath),
        ];
  const marketplaces = isRecord(settings.extraKnownMarketplaces)
    ? settings.extraKnownMarketplaces
    : {};
  const enabled = isRecord(settings.enabledPlugins) ? settings.enabledPlugins : {};
  const registered: Record<string, unknown> = {
    ...settings,
    extraKnownMarketplaces: {
      ...marketplaces,
      [CLAUDE_MARKETPLACE]: { source: { source: "directory", path: marketplace } },
    },
    enabledPlugins: { ...enabled, [`${manifest.plugin}@${CLAUDE_MARKETPLACE}`]: true },
    statusLine: wiredStatusLine(settings, fallbacks),
  };

  // the session sandbox goes into the project's local file, in a git checkout only (D-an); Claude
  // Code's sandbox (and the shared settings builder) takes POSIX paths only, so not on Windows
  const posixHome = options.vtcHome.startsWith("/");
  const gitCheckout = existsSync(join(request.projectRoot, ".git"));
  const sandboxed = posixHome && gitCheckout;
  const writes = new Map<string, Record<string, unknown>>([[settingsPath, registered]]);
  if (sandboxed) {
    const local = writes.get(localSettingsPath) ?? readJsonSettings(localSettingsPath);
    writes.set(localSettingsPath, withSessionSandbox(local, options.vtcHome));
  }
  const texts = [...writes].map(([path, value]) => [path, jsonText(value)] as const);
  if (sandboxed) {
    const localText = texts.find(([path]) => path === localSettingsPath)?.[1] ?? "";
    refuseForbidden(localSettingsPath, localText);
  }

  const pluginTarget = join(marketplace, "plugins", manifest.plugin);
  replaceDirectory(request.pluginDir, pluginTarget);
  const index = join(marketplace, ".claude-plugin", "marketplace.json");
  writeJson(index, {
    name: CLAUDE_MARKETPLACE,
    owner: { name: "vtc" },
    plugins: [
      {
        name: manifest.plugin,
        source: `./plugins/${manifest.plugin}`,
        ...(text(pluginJson.description) === null ? {} : { description: pluginJson.description }),
        ...(text(pluginJson.version) === null ? {} : { version: pluginJson.version }),
      },
    ],
  });
  for (const [path, settingsText] of texts) writeFileAtomic(path, settingsText);

  const local = sandboxed || request.scope === "project";
  return {
    written: [...filesUnder(pluginTarget), index, ...texts.map(([path]) => path)],
    notes: [
      `Restart Claude Code, then confirm the ${manifest.plugin} plugin from the ${CLAUDE_MARKETPLACE} marketplace if /plugin asks.`,
      "Your statusline now runs through `vtc statusline-tee`, which shows it unchanged and forwards only the usage windows to the local engine.",
      sandboxed
        ? `Turned on the Claude Code session sandbox for roles that run in this project's sessions, in ${localSettingsPath}: ${JSON.stringify(claudeSessionSandboxSettings(options.vtcHome))}`
        : !posixHome
          ? "No session sandbox written: Claude Code has no session sandbox on this platform, so the engine will not run code-running roles inside your Claude Code session."
          : `No session sandbox written: ${request.projectRoot} is not a git checkout. Run vtc install --host claude-code in the repo, or the engine will not run code-running roles inside your Claude Code session.`,
      ...(local ? [`Keep ${localSettingsPath} out of git: it names paths on this machine.`] : []),
    ],
  };
};

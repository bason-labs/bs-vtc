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
 * Both scopes are accepted (the cli picks the default, `DEFAULT_INSTALL_SCOPE`, D-ah), and the
 * marketplace always lives under `InstallRequest.home` (spine §5 reading 60).
 * The exact marketplace form is provisional until the spike tries it on a real install (spine §7).
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  STATUSLINE_TEE,
  statuslineTeeCommand,
  type InstallRequest,
  type InstallResult,
} from "@vtc/shared";
import { readJsonSettings, replaceDirectory, writeJson } from "../common/files.js";
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

/** Synchronous; the adapter wraps it so a failure is a rejected promise. */
export const installClaudeCode = (request: InstallRequest): InstallResult => {
  const manifest = readPluginManifest(request.pluginDir, "claude-code");
  const pluginJsonPath = insidePlugin(request.pluginDir, CLAUDE_PLUGIN_MANIFEST);
  if (!existsSync(pluginJsonPath)) {
    throw new Error(`no ${CLAUDE_PLUGIN_MANIFEST} in ${request.pluginDir}`);
  }
  const pluginJson = readJsonSettings(pluginJsonPath);

  const marketplace = join(request.home, ".vtc", "claude-marketplace");
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

  const userSettingsPath = join(request.home, ".claude", "settings.json");
  const settingsPath =
    request.scope === "user"
      ? userSettingsPath
      : join(request.projectRoot, ".claude", "settings.local.json");
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
  writeJson(settingsPath, {
    ...settings,
    extraKnownMarketplaces: {
      ...marketplaces,
      [CLAUDE_MARKETPLACE]: { source: { source: "directory", path: marketplace } },
    },
    enabledPlugins: { ...enabled, [`${manifest.plugin}@${CLAUDE_MARKETPLACE}`]: true },
    statusLine: wiredStatusLine(settings, fallbacks),
  });

  return {
    written: [...filesUnder(pluginTarget), index, settingsPath],
    notes: [
      `Restart Claude Code, then confirm the ${manifest.plugin} plugin from the ${CLAUDE_MARKETPLACE} marketplace if /plugin asks.`,
      "Your statusline now runs through `vtc statusline-tee`, which shows it unchanged and forwards only the usage windows to the local engine.",
      ...(request.scope === "project"
        ? [`Keep ${settingsPath} out of git: it names paths on this machine.`]
        : []),
    ],
  };
};

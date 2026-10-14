/**
 * The load proof of a Lookback replay arm's run (D-cg, spine §5 reading 201; `HeadlessRun
 * .pluginLoad`). A `--plugin-dir` copy replaces a same-named installed plugin, except when managed
 * settings lock the plugin: then the installed copy runs and only the debug log says so. So a
 * trial counts only when both of these hold, and anything else is `loaded: false` (fail closed):
 * - the run's debug log exists and has no line saying a `--plugin-dir` copy was ignored because
 *   the plugin is locked by managed settings;
 * - the stream's `init` record shows the arm's directory as the source of the `vtc` plugin and
 *   lists the run's agent (`vtc:<agent>`).
 * Pure; the adapter reads the log and the transcript.
 */
import nodePath from "node:path";
import type { PluginLoadProof } from "@vtc/shared";
import { isRecord } from "../common/json.js";
import { CLAUDE_PLUGIN_NAMESPACE } from "./command.js";

/** What Claude Code's debug log says when managed settings keep the installed copy. */
export const PLUGIN_LOCKED_MARK = "plugin is locked by managed settings";

/** Read no more of a debug log than this; a bigger one is not checked (fail closed). */
export const DEBUG_LOG_MAX_BYTES = 64 * 1024 * 1024;

export interface PluginLoadEvidence {
  /** The arm directory the run was started with (`SpawnRoleRequest.pluginDir`). */
  readonly armDir: string;
  /** `vtc:<agent>`, the agent the run was started as. */
  readonly agent: string;
  /** The run's stdout lines (its stream). */
  readonly lines: readonly string[];
  /** The run's debug log, or null when it is missing or could not be read. */
  readonly debugLog: string | null;
  /** Resolves a path to its real location (symlinks), for comparing directories. */
  readonly realPath?: (path: string) => string;
}

const parse = (line: string): unknown => {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
};

const initRecord = (lines: readonly string[]): Record<string, unknown> | null => {
  for (const line of lines) {
    const event = parse(line);
    if (isRecord(event) && event.type === "system" && event.subtype === "init") return event;
  }
  return null;
};

/** The directories the `init` record names as the `vtc` plugin's source. */
const vtcPluginPaths = (init: Record<string, unknown>): string[] => {
  const plugins = init.plugins;
  if (!Array.isArray(plugins)) return [];
  return (plugins as readonly unknown[]).flatMap((plugin) => {
    if (!isRecord(plugin)) return [];
    const name = plugin.name;
    const path = plugin.path;
    const named =
      name === CLAUDE_PLUGIN_NAMESPACE ||
      (typeof name === "string" && name.startsWith(`${CLAUDE_PLUGIN_NAMESPACE}@`));
    return named && typeof path === "string" ? [path] : [];
  });
};

const not = (reason: string): PluginLoadProof => ({ loaded: false, reason });

export const claudePluginLoadProof = (evidence: PluginLoadEvidence): PluginLoadProof => {
  const real = evidence.realPath ?? ((path: string) => path);
  if (evidence.debugLog === null) {
    return not("the run's debug log is missing, so a managed-settings lock cannot be ruled out");
  }
  if (evidence.debugLog.includes(PLUGIN_LOCKED_MARK)) {
    return not("plugin_locked: managed settings lock the vtc plugin, so the installed copy ran");
  }
  const init = initRecord(evidence.lines);
  if (init === null) return not("the run's stream has no init record");
  const agents = init.agents;
  if (!Array.isArray(agents) || !(agents as readonly unknown[]).includes(evidence.agent)) {
    return not(`the init record does not list the agent ${evidence.agent}`);
  }
  const arm = real(nodePath.resolve(evidence.armDir));
  const paths = vtcPluginPaths(init);
  if (paths.length === 0) return not("the init record names no source for the vtc plugin");
  if (paths.length > 1 || paths.some((path) => real(nodePath.resolve(path)) !== arm)) {
    return not("the init record shows a vtc plugin that is not the arm's copy");
  }
  return { loaded: true, dir: evidence.armDir };
};

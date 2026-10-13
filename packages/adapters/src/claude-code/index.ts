/**
 * Claude Code host adapter (§4.1, §12.1, AD-6). Usage is pushed, not pulled (AD-6 rule 4): the
 * statusline shim posts `statuslineIngestFromClaude(...)` to the engine, and `parseEvents`
 * returns the SDK rate-limit readings of runs the engine launched. So there is no `readUsage`.
 */
import { homedir } from "node:os";
import type { HostAdapter, HostCapabilities, SessionRef, SpawnRoleRequest } from "@vtc/shared";
import { createRunLauncher, subagentSpawn } from "../common/dispatch.js";
import { nodeSpawner, type Spawner } from "../common/process.js";
import {
  claudeHeadlessCommand,
  claudeSandboxProfile,
  claudeSubagentName,
  HOST,
} from "./command.js";
import { claudeOutcomeAfterExit, parseClaudeEvents } from "./events.js";
import { installClaudeCode } from "./install.js";

/** §12.1: plugin agents run in the background; `sandbox.filesystem.denyWrite`; `--max-turns`, `--max-budget-usd`. */
export const claudeCodeCapabilities: HostCapabilities = {
  subagents: true,
  backgroundSubagents: true,
  perPathWriteDeny: true,
  headless: true,
  turnCap: true,
  budgetCap: true,
};

export interface ClaudeCodeAdapterOptions {
  /** Starts host processes; tests inject a fake (never the real `claude`). */
  readonly spawner?: Spawner;
  readonly killGraceMs?: number;
  /** The user's home (the VTC install token a role may never read lives under it). Default: `os.homedir()`. */
  readonly home?: string;
  /** The compiled Claude plugin on disk; see `ClaudeCommandOptions.pluginDir`. */
  readonly pluginDir?: string;
}

export const createClaudeCodeAdapter = (options: ClaudeCodeAdapterOptions = {}): HostAdapter => {
  const runs = createRunLauncher({
    spawner: options.spawner ?? nodeSpawner,
    outcome: claudeOutcomeAfterExit,
    ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
  });
  const profileOptions = { home: options.home ?? homedir() };
  const commandOptions = options.pluginDir === undefined ? {} : { pluginDir: options.pluginDir };
  const headlessCommand = (request: SpawnRoleRequest, session?: SessionRef) =>
    claudeHeadlessCommand(request, session, commandOptions);
  const spawn = (request: SpawnRoleRequest, session?: SessionRef) =>
    Promise.resolve().then(() =>
      request.dispatch === "subagent"
        ? subagentSpawn(request, {
            background: claudeCodeCapabilities.backgroundSubagents,
            name: claudeSubagentName,
          })
        : runs.start(headlessCommand(request, session), request),
    );
  return {
    host: HOST,
    capabilities: claudeCodeCapabilities,
    install: (request) => Promise.resolve().then(() => installClaudeCode(request)),
    spawnRole: (request) => spawn(request),
    subagentName: claudeSubagentName,
    parseEvents: parseClaudeEvents,
    headlessCommand,
    resume: (session, request) => {
      if (session.host !== HOST) {
        return Promise.reject(new Error(`cannot resume a ${session.host} session on ${HOST}`));
      }
      return spawn(request, session);
    },
    sandboxProfile: (request) => claudeSandboxProfile(request, profileOptions),
    dispose: () => runs.dispose(),
  };
};

export { statuslineIngestFromClaude } from "./statusline.js";
export { claudeSubagentName } from "./command.js";
export { STATUSLINE_TEE, statuslineTeeCommand } from "./install.js";

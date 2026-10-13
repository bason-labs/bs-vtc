/**
 * Codex host adapter (§4.1, §12.1, AD-6). Usage comes from the adapter's own managed
 * `codex app-server` child (`readUsage` / `watchUsage`, stopped by `dispose`, AD-6 rule 4).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { HostAdapter, HostCapabilities, SessionRef, SpawnRoleRequest } from "@vtc/shared";
import { createRunLauncher, subagentSpawn } from "../common/dispatch.js";
import { nodeSpawner, type Spawner } from "../common/process.js";
import { createCodexUsageSource } from "./app-server.js";
import {
  codexHeadlessCommand,
  codexSandboxProfile,
  codexSchemaFile,
  HOST,
  type CodexTierModels,
} from "./command.js";
import { codexOutcomeAfterExit, parseCodexEvents } from "./events.js";
import { installCodex } from "./install.js";

/**
 * §12.1 / §20.4: subagents are spawned explicitly (foreground), no background agents in the CLI,
 * no per-path write-deny, caps enforced by the engine only.
 */
export const codexCapabilities: HostCapabilities = {
  subagents: true,
  backgroundSubagents: false,
  perPathWriteDeny: false,
  headless: true,
  turnCap: false,
  budgetCap: false,
};

export interface CodexAdapterOptions {
  /** Starts host processes; tests inject a fake (never the real `codex`). */
  readonly spawner?: Spawner;
  /** `project.yaml` `hosts.models.codex`: overrides the built-in tier → model map per tier. */
  readonly models?: CodexTierModels;
  /** Where `--output-schema` files are written. Default: `<os tmp>/vtc-codex`. */
  readonly scratchDir?: string;
  /** Working directory of the `codex app-server` child. Default: the scratch directory. */
  readonly appServerCwd?: string;
  readonly now?: () => Date;
  readonly usagePollMs?: number;
  readonly killGraceMs?: number;
  /** Reported to the app-server as the client version. */
  readonly clientVersion?: string;
}

export const createCodexAdapter = (options: CodexAdapterOptions = {}): HostAdapter => {
  const spawner = options.spawner ?? nodeSpawner;
  const scratchDir = options.scratchDir ?? join(tmpdir(), "vtc-codex");
  const commandOptions = {
    scratchDir,
    ...(options.models === undefined ? {} : { models: options.models }),
  };
  const runs = createRunLauncher({
    spawner,
    outcome: codexOutcomeAfterExit,
    ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
  });
  let usage: ReturnType<typeof createCodexUsageSource> | null = null;
  const usageSource = () => {
    if (usage === null) {
      mkdirSync(scratchDir, { recursive: true });
      usage = createCodexUsageSource({
        spawner,
        now: options.now ?? (() => new Date()),
        cwd: options.appServerCwd ?? scratchDir,
        clientVersion: options.clientVersion ?? "0.0.0",
        ...(options.usagePollMs === undefined ? {} : { pollMs: options.usagePollMs }),
        ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
      });
    }
    return usage;
  };

  const headlessCommand = (request: SpawnRoleRequest, session?: SessionRef) =>
    codexHeadlessCommand(request, commandOptions, session);

  const spawn = (request: SpawnRoleRequest, session?: SessionRef) =>
    Promise.resolve().then(() => {
      if (request.dispatch === "subagent") {
        return subagentSpawn(request, { background: codexCapabilities.backgroundSubagents });
      }
      const command = headlessCommand(request, session);
      const schemaFile = codexSchemaFile(scratchDir, request.outputSchema);
      mkdirSync(dirname(schemaFile), { recursive: true });
      writeFileSync(schemaFile, JSON.stringify(request.outputSchema), "utf8");
      return runs.start(command, request);
    });

  return {
    host: HOST,
    capabilities: codexCapabilities,
    install: (request) => Promise.resolve().then(() => installCodex(request)),
    spawnRole: (request) => spawn(request),
    parseEvents: parseCodexEvents,
    headlessCommand,
    resume: (session, request) => {
      if (session.host !== HOST) {
        return Promise.reject(new Error(`cannot resume a ${session.host} session on ${HOST}`));
      }
      return spawn(request, session);
    },
    sandboxProfile: codexSandboxProfile,
    readUsage: () => usageSource().read(),
    watchUsage: (onUpdate) => usageSource().watch(onUpdate),
    async dispose() {
      await Promise.all([runs.dispose(), usage?.dispose()]);
    },
  };
};

export { CODEX_DEFAULT_TIER_MODELS, codexModelFor } from "./command.js";
export { codexUsageFromRateLimits } from "./rate-limits.js";

/**
 * Host adapter interface (§4.1, §12.1). Implemented by packages/adapters (claude-code, codex);
 * consumed by the engine, which never imports an implementation (AD-1). The cli constructs the
 * adapters, injects them into the engine and calls `dispose()` on shutdown (AD-6).
 */
import { z } from "zod";
import {
  IsoDateTimeSchema,
  SessionRefSchema,
  TokenUsageSchema,
  type HostId,
  type RoleId,
  type SessionRef,
} from "../primitives.js";
import type { ResolvedModel, RoleTools } from "../role-contract.js";
import { UsageWindowKindSchema, type UsageSnapshot } from "../usage.js";

/**
 * Terminal outcome of a role run, normalised across hosts to `done | limit | auth | error`
 * (§4.1). Persisted in events, so it is a schema, not just a type.
 */
export const HostOutcomeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("done"),
    session_ref: SessionRefSchema.nullable(),
    /** The role's final structured output (validated later as a RoleResult). */
    output: z.unknown(),
    model: z.string().min(1).nullable(),
    /** From the final stream event (§11). */
    tokens: TokenUsageSchema.nullable(),
    cost_usd: z.number().nonnegative().nullable(),
  }),
  z.strictObject({
    kind: z.literal("limit"),
    session_ref: SessionRefSchema.nullable(),
    /** Reset time if the host reported one; `null` = unknown, back off and re-read usage (§6.9). */
    resets_at: IsoDateTimeSchema.nullable(),
    /** Which plan window was hit, if known; a per-model limit sets `model` instead. */
    window: UsageWindowKindSchema.nullable(),
    model: z.string().min(1).nullable(),
    message: z.string(),
    /** Spend before the limit hit, so partial work is still counted (§11). */
    tokens: TokenUsageSchema.nullable(),
    cost_usd: z.number().nonnegative().nullable(),
  }),
  z.strictObject({
    kind: z.literal("auth"),
    message: z.string(),
  }),
  z.strictObject({
    kind: z.literal("error"),
    message: z.string(),
    retryable: z.boolean(),
    /** Spend before the failure, when the host reported it (§11). */
    tokens: TokenUsageSchema.nullable(),
    cost_usd: z.number().nonnegative().nullable(),
  }),
]);
export type HostOutcome = z.infer<typeof HostOutcomeSchema>;

/** The outcomes a Lead reports through `submit` when a subagent did not finish (§4.1, §6.9). */
export const HostFailureOutcomeSchema = z.discriminatedUnion("kind", [
  HostOutcomeSchema.options[1],
  HostOutcomeSchema.options[2],
  HostOutcomeSchema.options[3],
]);
export type HostFailureOutcome = z.infer<typeof HostFailureOutcomeSchema>;

/**
 * What the Lead runs for a `spawn_role` action (subagent dispatch). `agent` is the compiled
 * agent name (`agentNameFor`), `prompt` the short instruction pointing at the task pack.
 */
export const SubagentInstructionSchema = z.strictObject({
  agent: z.string().min(1).max(128),
  prompt: z.string().min(1).max(8000),
  /** Run as a background subagent where the host supports it (§4.2 step 2). */
  background: z.boolean(),
});
export type SubagentInstruction = z.infer<typeof SubagentInstructionSchema>;

/** What a host can enforce itself (§12.1). Anything false is enforced by the engine only. */
export interface HostCapabilities {
  readonly backgroundSubagents: boolean;
  readonly perPathWriteDeny: boolean;
  readonly headless: boolean;
  readonly turnCap: boolean;
  readonly budgetCap: boolean;
}

export interface InstallRequest {
  /** Absolute path of the repo being set up. */
  readonly projectRoot: string;
  /** Absolute path of the compiled plugin for this host (dist/<host>-plugin). */
  readonly pluginDir: string;
  readonly scope: "user" | "project";
}

export interface InstallResult {
  /** Absolute paths written or updated. */
  readonly written: readonly string[];
  /** Human-readable follow-ups, e.g. "trust the plugin hooks in Codex". */
  readonly notes: readonly string[];
}

export interface SandboxProfileRequest {
  readonly tools: RoleTools;
  /** Absolute worktree path the role runs in. */
  readonly cwd: string;
  /** Repo-relative globs the role may write (files_scope or the role's write paths). */
  readonly writablePaths: readonly string[];
  /** Repo-relative paths that must not change (QA-owned tests, configs; §7.3). */
  readonly protectedPaths: readonly string[];
  /** §7.2: install phase may reach registries only; everything else has no network. */
  readonly network: "none" | "registries";
}

export interface SandboxProfile {
  readonly host: HostId;
  /** What the host itself enforces for this profile; the engine's write-scope check always runs. */
  readonly enforced: {
    readonly readOnly: boolean;
    readonly perPathWriteDeny: boolean;
    readonly network: boolean;
  };
  /** Host-specific settings (e.g. Claude `sandbox.filesystem.denyWrite`, Codex `sandbox_mode`). */
  readonly settings: Readonly<Record<string, unknown>>;
  /** Extra CLI arguments for headless runs. Never includes permission-bypass flags (§15). */
  readonly cliArgs: readonly string[];
}

/**
 * Dispatch rule (AD-4 rule 4): `subagent` spawns are performed by the Lead in its own session
 * (the adapter returns a {@link SubagentInstruction}, which the engine sends as a `spawn_role`
 * action); `headless` runs are launched by the engine through this adapter and never appear as
 * Lead actions.
 */
export interface SpawnRoleRequest {
  readonly role: RoleId;
  readonly mode?: string;
  /** Concrete model, resolved by the engine from role.yaml + project.yaml (AD-6 rule 2). */
  readonly model: ResolvedModel;
  readonly dispatch: "subagent" | "headless";
  /** Absolute working directory (the task's worktree). */
  readonly cwd: string;
  /** Rendered task pack / input for the role. On resume: the new input (e.g. the human's answer). */
  readonly prompt: string;
  /** JSON Schema the final message must satisfy (from @vtc/shared jsonSchemas()). */
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly sandbox: SandboxProfile;
  /** Hard timeout; the launcher force-kills on expiry (§15). */
  readonly timeoutMs: number;
  readonly maxTurns?: number;
  readonly maxBudgetUsd?: number;
}

/** A headless child process started by the adapter. */
export interface HeadlessRun {
  readonly pid: number | null;
  /** Raw stdout lines as they arrive (also persisted as the run transcript). */
  lines(): AsyncIterable<string>;
  /** Resolves with the normalised outcome once the process exits or times out. */
  wait(): Promise<HostOutcome>;
  /** Kills the process tree; no orphans (§15). */
  kill(): Promise<void>;
}

export type SpawnResult =
  | { readonly dispatch: "subagent"; readonly instruction: SubagentInstruction }
  | { readonly dispatch: "headless"; readonly run: HeadlessRun };

export interface ParsedStream {
  /** Terminal outcome, or null if the stream has not ended. */
  readonly outcome: HostOutcome | null;
  readonly sessionRef: SessionRef | null;
  /** Lines that were not valid host events (counted, never thrown). */
  readonly unrecognizedLines: number;
}

export interface HostAdapter {
  readonly host: HostId;
  readonly capabilities: HostCapabilities;
  /** Install plugin/agents/MCP registration for this host (§4.4 getting it running). */
  install(request: InstallRequest): Promise<InstallResult>;
  /** Start a role as an in-session subagent instruction or a headless process. */
  spawnRole(request: SpawnRoleRequest): Promise<SpawnResult>;
  /** Pure: parse a recorded or live stream (JSONL lines) into a normalised outcome. */
  parseEvents(lines: readonly string[]): ParsedStream;
  /** Resume a session with new input (same worktree and session, §6.5; after a reset, §6.9). */
  resume(session: SessionRef, request: SpawnRoleRequest): Promise<SpawnResult>;
  /** Pure: host-specific sandbox settings for a role's tool profile. */
  sandboxProfile(request: SandboxProfileRequest): SandboxProfile;
  /**
   * Pull usage from a sanctioned source the adapter owns (§6.9), e.g. Codex
   * `account/rateLimits/read`. Absent when the host pushes usage elsewhere: Claude usage arrives
   * on the engine's statusline ingest route and from SDK events of engine-launched runs.
   * Unknown data stays null, never 0.
   */
  readUsage?(): Promise<UsageSnapshot>;
  /**
   * Subscribe to pushed usage changes (Codex `account/rateLimits/updated`). Returns an
   * unsubscribe function. Starting the subscription may start a managed child process
   * (`codex app-server`), which `dispose()` must stop.
   */
  watchUsage?(onUpdate: (snapshot: UsageSnapshot) => void): () => void;
  /** Stop every child process and subscription this adapter owns: no orphans (§15). Idempotent. */
  dispose(): Promise<void>;
}

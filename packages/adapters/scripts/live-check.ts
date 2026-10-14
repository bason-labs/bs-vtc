/**
 * Opt-in live check of the adapters against the real, signed-in host CLIs (spine §7 spike items:
 * the headless flags, resume, and the Codex app-server read). It spends a little of the user's
 * own quota, so it never runs in `pnpm verify` or in tests; run it by hand:
 *
 *   pnpm --filter @vtc/adapters live:check [claude-code|codex|codex-usage|auth] [--resume]
 *     [--model <id>] [--plugin-dir <dir>] [--profile read_only|write_scoped|code_sandboxed]
 *
 * The model defaults to the engine's built-in low tier for the host: `haiku` on Claude Code, and
 * none on Codex, whose built-in map names no ids until the spike does (D-ae), so the run uses the
 * session's default model with only the effort set. `--model` runs another id, as the engine
 * would after a `project.yaml` override. Claude runs load the compiled plugin from `--plugin-dir`
 * (default: the repo's `ASSET_SOURCES` build, `dist/claude-plugin`) with the user's settings
 * only, `--strict-mcp-config` and the VTC-only `--mcp-config`, as every engine-launched Claude run
 * does (AD-25 rule 1).
 *
 * Each run first checks the host's login with `authStatus()` (the host's own status command, as
 * the engine's preflight does) and then runs in a fresh temp git repo under the default
 * `HeadlessPolicy` (wall and idle timeouts), with the `--profile` sandbox (default `read_only`;
 * `code_sandboxed` with `--resume` is the §7 "Codex resume argv" check that the resumed thread
 * keeps the workspace-write sandbox) and a prompt that asks for a bare RoleResult. It prints the
 * exact command, the normalised outcome and whether the output re-validates; it reads no
 * credential and passes no bypass or disallowed flag (AD-9, AD-25). `auth` only prints both
 * hosts' `authStatus()`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ASSET_SOURCES,
  findDisallowedHostArgs,
  findForbiddenHostArgs,
  fromStructuredOutput,
  headlessIsolationGaps,
  headlessPolicyFor,
  HostOutcomeSchema,
  jsonSchemaFor,
  type HostAdapter,
  type RoleTools,
  type SpawnRoleRequest,
} from "@vtc/shared";
import { createClaudeCodeAdapter, createCodexAdapter } from "../src/index.js";

const PROMPT =
  'Do not read or change any file. Reply only with a RoleResult: role "qa", exit "done", summary "live ok", and every other field null.';

/** The engine's built-in low-tier ids (engine `DEFAULT_TIER_MODELS`), for a cheap check. */
const LOW_TIER_MODEL: Readonly<Partial<Record<HostAdapter["host"], string>>> = {
  "claude-code": "haiku",
};

const PROFILES: readonly RoleTools["profile"][] = ["read_only", "write_scoped", "code_sandboxed"];

const run = async (
  adapter: HostAdapter,
  resume: boolean,
  profile: RoleTools["profile"],
  model?: string,
): Promise<void> => {
  const cwd = mkdtempSync(join(tmpdir(), "vtc-live-"));
  const id = model ?? LOW_TIER_MODEL[adapter.host];
  const policy = headlessPolicyFor(undefined);
  try {
    const login = await adapter.authStatus?.();
    console.warn(`auth: ${JSON.stringify(login ?? "no status command")}`);
    if (login !== undefined && login.logged_in !== true) {
      throw new Error(`${adapter.host} is not logged in (or its status is unknown): not starting`);
    }
    execFileSync("git", ["init", "-q"], { cwd });
    const request: SpawnRoleRequest = {
      role: "qa",
      mode: "judge",
      model: { tier: "low", effort: "low", ...(id === undefined ? {} : { model: id }) },
      dispatch: "headless",
      cwd,
      prompt: PROMPT,
      outputSchema: jsonSchemaFor("RoleResult", { target: "structured-output" }),
      sandbox: adapter.sandboxProfile({
        tools: { profile, write_paths: [], engine_tools: [] },
        cwd,
        writablePaths: profile === "read_only" ? [] : ["notes/**"],
        protectedPaths: [],
        network: "none",
      }),
      timeoutMs: policy.wallTimeoutMs,
      idleTimeoutMs: policy.idleTimeoutMs,
    };
    const once = async (session?: Parameters<HostAdapter["resume"]>[0]) => {
      const command = adapter.headlessCommand(request, session);
      const refused = [
        ...findForbiddenHostArgs([command.command, ...command.args]),
        ...findDisallowedHostArgs(command.args),
        ...headlessIsolationGaps(adapter.host, command.args).map((gap) => `missing ${gap}`),
      ];
      if (refused.length > 0) throw new Error(`refusing to run: ${refused.join(", ")}`);
      console.warn(`$ ${command.command} ${command.args.map((a) => JSON.stringify(a)).join(" ")}`);
      const spawned =
        session === undefined
          ? await adapter.spawnRole(request)
          : await adapter.resume(session, request);
      if (spawned.dispatch !== "headless") throw new Error("expected a headless run");
      const outcome = HostOutcomeSchema.parse(await spawned.run.wait());
      const lines: string[] = [];
      for await (const line of spawned.run.lines()) lines.push(line);
      const parsed = adapter.parseEvents(lines);
      console.warn(JSON.stringify({ outcome, usage: parsed.usage, retry: parsed.retry }, null, 2));
      if (outcome.kind === "done") {
        const result = fromStructuredOutput("RoleResult", outcome.output);
        console.warn(`RoleResult re-validates: ${String(result.success)}`);
      }
      return outcome;
    };
    const first = await once();
    if (resume && first.kind === "done" && first.session_ref !== null)
      await once(first.session_ref);
  } finally {
    await adapter.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
};

const main = async (): Promise<void> => {
  const [target = "codex-usage", ...flags] = process.argv.slice(2);
  const resume = flags.includes("--resume");
  const at = flags.indexOf("--model");
  const model = at < 0 ? undefined : flags[at + 1];
  const profileAt = flags.indexOf("--profile");
  const profile = PROFILES.find((p) => p === flags[profileAt + 1]) ?? "read_only";
  const pluginAt = flags.indexOf("--plugin-dir");
  const pluginDir = resolve(
    (pluginAt < 0 ? undefined : flags[pluginAt + 1]) ??
      join(import.meta.dirname, "..", "..", "..", ASSET_SOURCES["plugin:claude-code"]),
  );
  if (target === "claude-code") {
    await run(createClaudeCodeAdapter({ pluginDir }), resume, profile, model);
  } else if (target === "codex") await run(createCodexAdapter(), resume, profile, model);
  else if (target === "auth") {
    for (const adapter of [createClaudeCodeAdapter(), createCodexAdapter()]) {
      try {
        console.warn(JSON.stringify(await adapter.authStatus?.()));
      } finally {
        await adapter.dispose();
      }
    }
  } else if (target === "codex-usage") {
    const adapter = createCodexAdapter();
    try {
      console.warn(JSON.stringify(await adapter.readUsage?.(), null, 2));
    } finally {
      await adapter.dispose();
    }
  } else {
    throw new Error(`unknown target ${target}: use claude-code, codex, codex-usage or auth`);
  }
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

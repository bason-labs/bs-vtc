/**
 * Opt-in live check of the adapters against the real, signed-in host CLIs (spine §7 spike items:
 * the headless flags, resume, and the Codex app-server read). It spends a little of the user's
 * own quota, so it never runs in `pnpm verify` or in tests; run it by hand:
 *
 *   pnpm --filter @vtc/adapters live:check [claude-code|codex|codex-usage|auth] [--resume]
 *     [--model <id>] [--plugin-dir <dir>] [--profile read_only|write_scoped|code_sandboxed]
 *     [--record <file>] [--max-turns <n>] [--kill-after <ms>] [--signed-out]
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
 *
 * Recording the AD-25 fixtures (spine §7 rows on HostOutcome signals and on Codex limit and auth
 * text): `--record <file>` writes the run's stream, redacted (`scripts/recording.ts`), to `<file>`
 * and a resumed run's to `<name>.resume<ext>`, for the owner to read and copy over a
 * `test/fixtures/<host>/*.synthetic.*` file. Each stream has its own recipe:
 * - max-turns (Claude): `claude-code --max-turns 1 --record …` with a prompt that needs a tool
 *   turn; this script's own prompt does not reach the cap (2026-10-14: the closing
 *   `StructuredOutput` call made 2 turns and the run still ended `success`);
 * - kill: `--kill-after 3000 --record …` stops the run through `HeadlessRun.kill()` (SIGINT,
 *   SIGTERM, SIGKILL on the process group, as the engine does);
 * - auth: never by signing the user out (H-15, spine §5 reading 239). Codex: `live:h15
 *   codex-signed-out`, in a temporary `CODEX_HOME`. `--signed-out --record …` runs only when
 *   `authStatus()` already says `logged_in: false`;
 * - limit: cannot be forced; record a run made while the host reports its limit reached.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
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
  type SpawnRoleRequest,
} from "@vtc/shared";
import { createClaudeCodeAdapter, createCodexAdapter } from "../src/index.js";
import { parseLiveCheckArgs, type LiveCheckArgs } from "./live-check-args.js";
import { recordPath, redactRecording } from "./recording.js";

const PROMPT =
  'Do not read or change any file. Reply only with a RoleResult: role "qa", exit "done", summary "live ok", and every other field null.';

/** The engine's built-in low-tier ids (engine `DEFAULT_TIER_MODELS`), for a cheap check. */
const LOW_TIER_MODEL: Readonly<Partial<Record<HostAdapter["host"], string>>> = {
  "claude-code": "haiku",
};

const run = async (adapter: HostAdapter, args: LiveCheckArgs): Promise<void> => {
  const cwd = mkdtempSync(join(tmpdir(), "vtc-live-"));
  const id = args.model ?? LOW_TIER_MODEL[adapter.host];
  const policy = headlessPolicyFor(undefined);
  const { profile } = args;
  try {
    const login = await adapter.authStatus?.();
    console.warn(`auth: ${JSON.stringify(login ?? "no status command")}`);
    if (args.signedOut) {
      // the auth recording: only a host that says plainly it is signed out
      if (login?.logged_in !== false) {
        throw new Error(
          `${adapter.host} is not reported signed out: sign it out with its own command first`,
        );
      }
    } else if (login !== undefined && login.logged_in !== true) {
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
      ...(args.maxTurns === undefined ? {} : { maxTurns: args.maxTurns }),
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
      const killer =
        args.killAfterMs === undefined
          ? undefined
          : setTimeout(() => void spawned.run.kill(), args.killAfterMs);
      const outcome = HostOutcomeSchema.parse(await spawned.run.wait());
      clearTimeout(killer);
      const lines: string[] = [];
      for await (const line of spawned.run.lines()) lines.push(line);
      const parsed = adapter.parseEvents(lines);
      console.warn(JSON.stringify({ outcome, usage: parsed.usage, retry: parsed.retry }, null, 2));
      if (outcome.kind === "done") {
        const result = fromStructuredOutput("RoleResult", outcome.output);
        console.warn(`RoleResult re-validates: ${String(result.success)}`);
      }
      if (args.record !== undefined) {
        const file = resolve(recordPath(args.record, session !== undefined));
        const redacted = redactRecording(lines, {
          home: homedir(),
          cwd: [cwd, realpathSync(cwd)],
          user: userInfo().username,
        });
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, redacted.map((line) => `${line}\n`).join(""), "utf8");
        console.warn(
          `recorded ${String(redacted.length)} redacted lines to ${file}: read it before use`,
        );
      }
      return outcome;
    };
    const first = await once();
    if (args.resume && first.kind === "done" && first.session_ref !== null)
      await once(first.session_ref);
  } finally {
    await adapter.dispose();
    rmSync(cwd, { recursive: true, force: true });
  }
};

const main = async (): Promise<void> => {
  const args = parseLiveCheckArgs(process.argv.slice(2));
  const pluginDir = resolve(
    args.pluginDir ??
      join(import.meta.dirname, "..", "..", "..", ASSET_SOURCES["plugin:claude-code"]),
  );
  if (args.target === "claude-code") {
    await run(createClaudeCodeAdapter({ pluginDir }), args);
  } else if (args.target === "codex") await run(createCodexAdapter(), args);
  else if (args.target === "auth") {
    for (const adapter of [createClaudeCodeAdapter(), createCodexAdapter()]) {
      try {
        console.warn(JSON.stringify(await adapter.authStatus?.()));
      } finally {
        await adapter.dispose();
      }
    }
  } else {
    const adapter = createCodexAdapter();
    try {
      console.warn(JSON.stringify(await adapter.readUsage?.(), null, 2));
    } finally {
      await adapter.dispose();
    }
  }
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

/**
 * Opt-in live check of the adapters against the real, signed-in host CLIs (spine §7 spike items:
 * the headless flags, resume, and the Codex app-server read). It spends a little of the user's
 * own quota, so it never runs in `pnpm verify` or in tests; run it by hand:
 *
 *   pnpm --filter @vtc/adapters live:check [claude-code|codex|codex-usage] [--resume] [--model <id>]
 *
 * The model defaults to the engine's built-in low tier for the host (`haiku`, `gpt-5-codex-mini`);
 * `--model` runs another id, as the engine would after a `project.yaml` override.
 *
 * Each run happens in a fresh temp git repo with a read-only sandbox and a prompt that asks for
 * a bare RoleResult. It prints the exact command, the normalised outcome and whether the output
 * re-validates; it reads no credential and passes no bypass flag (AD-9).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findForbiddenHostArgs,
  fromStructuredOutput,
  HostOutcomeSchema,
  jsonSchemaFor,
  type HostAdapter,
  type SpawnRoleRequest,
} from "@vtc/shared";
import { createClaudeCodeAdapter, createCodexAdapter } from "../src/index.js";

const PROMPT =
  'Do not read or change any file. Reply only with a RoleResult: role "qa", exit "done", summary "live ok", and every other field null.';

/** The engine's built-in low-tier ids (engine `DEFAULT_TIER_MODELS`), for a cheap check. */
const LOW_TIER_MODEL = { "claude-code": "haiku", codex: "gpt-5-codex-mini" } as const;

const run = async (adapter: HostAdapter, resume: boolean, model?: string): Promise<void> => {
  const cwd = mkdtempSync(join(tmpdir(), "vtc-live-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd });
    const request: SpawnRoleRequest = {
      role: "qa",
      mode: "judge",
      model: { tier: "low", effort: "low", model: model ?? LOW_TIER_MODEL[adapter.host] },
      dispatch: "headless",
      cwd,
      prompt: PROMPT,
      outputSchema: jsonSchemaFor("RoleResult", { target: "structured-output" }),
      sandbox: adapter.sandboxProfile({
        tools: { profile: "read_only", write_paths: [], engine_tools: [] },
        cwd,
        writablePaths: [],
        protectedPaths: [],
        network: "none",
      }),
      timeoutMs: 300_000,
    };
    const once = async (session?: Parameters<HostAdapter["resume"]>[0]) => {
      const command = adapter.headlessCommand(request, session);
      const forbidden = findForbiddenHostArgs([command.command, ...command.args]);
      if (forbidden.length > 0) throw new Error(`refusing to run: ${forbidden.join(", ")}`);
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
  if (target === "claude-code") await run(createClaudeCodeAdapter(), resume, model);
  else if (target === "codex") await run(createCodexAdapter(), resume, model);
  else if (target === "codex-usage") {
    const adapter = createCodexAdapter();
    try {
      console.warn(JSON.stringify(await adapter.readUsage?.(), null, 2));
    } finally {
      await adapter.dispose();
    }
  } else {
    throw new Error(`unknown target ${target}: use claude-code, codex or codex-usage`);
  }
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

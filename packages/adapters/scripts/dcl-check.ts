/**
 * The D-cl live checks (spine §5 reading 206; §7 rows "Host web search in role runs" and "Replay
 * arm plugins"). Opt-in, never a test, never in `pnpm verify`; at most 3 runs of each check. It
 * reads no credential (no `auth.json`, no keychain, no `~/.claude` credential file) and passes no
 * bypass or disallowed flag (AD-9, AD-25). Run by hand on the signed-in machine:
 *
 *   pnpm --filter @vtc/adapters live:dcl <check> --out <dir> [flags]
 *
 * - `codex-web [--mode cached|indexed|disabled] [--profile write_scoped|read_only]`: one real
 *   `codex exec` of a `host_web` role under its role sandbox (the adapter's own profile and
 *   argv; for a mode the adapter never emits, only the `web_search` override is swapped), with a
 *   prompt that needs fresh news. Spends a little of the user's Codex quota, under the user's own
 *   `CODEX_HOME`, which it never changes. Writes the redacted event stream and a summary of the
 *   web-search items (`web-search-summary.json`): whether any opened a page.
 * - `codex-precedence`: offline, in a temporary `CODEX_HOME` (never `~/.codex`), no login and no
 *   model call. Shows which config layer wins: the user's `config.toml`, a `--profile` layer, an
 *   untrusted project `.codex/config.toml`, the legacy search keys, and the top-level `-c`
 *   override VTC passes. Reads the effective `web_search` through the app server's `config/read`
 *   and the layer order through `codex debug prompt-input` (a `developer_instructions` marker per
 *   layer). The `--profile` layer is measured by marker only: the app server refuses `--profile`.
 * - `codex-mcp`: offline, in a temporary `CODEX_HOME` (never `~/.codex`), no login and no model
 *   call. Which MCP servers a role run in a linked worktree would load (the user's, one a role
 *   planted in the worktree's `.codex/config.toml` under a trusted repo, a plugin's), and that the
 *   adapter's MCP check (`src/codex/mcp-servers.ts`) leaves only the engine bridge on, through
 *   `codex mcp list --json` with the role run's real overrides. Also records why the override is
 *   one inline table first (a dotted key cannot name a dotted server; a later table drops earlier
 *   dotted keys) and why plugins go off (a plugin's server cannot be turned off by name). The
 *   servers are stubs with dummy env and header values; only names and enabled flags are written.
 * - `codex-plugin [--plugin-dir <dist/codex-plugin>]`: `codex plugin marketplace add` and
 *   `codex plugin add` ONLY in a temporary `CODEX_HOME`, never `~/.codex`; records what each wrote.
 * - `claude-arm [--plugin-dir <dist/claude-plugin>] [--model <id>] [--vtc-bin <cli bin.js>]`: one
 *   real `claude -p` role
 *   run whose plugin is a replay arm: an unchanged copy of the real compiled plugin (no scratch
 *   patch) under a temporary guard dir, launched as D-cg launches an arm (`SpawnRoleRequest
 *   .pluginDir`, `--debug-file` beside it) with a replay `readDeny`. Writes the redacted stream (the
 *   success fixture), the `init` record's plugin and agent fields, the debug-log lines about
 *   plugins, and what `HeadlessRun.pluginLoad()` concluded. Round-5 items: `vtc` is on `PATH`
 *   (a recording shim in front of the built cli, with a temporary `VTC_HOME`), and the summary
 *   lists each `vtc hook` call (event, input keys, `agent_type`, the headless-role variable, exit
 *   status, output size) and every hook the stream reports.
 *
 * `--out` gets raw files (`*.raw.*`, which can name the owner's own plugins and paths: read them,
 * never commit them) and redacted ones, for the owner to read before any becomes a fixture.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  ASSET_SOURCES,
  CODEX_HOST_WEB_SEARCH,
  fromStructuredOutput,
  headlessPolicyFor,
  HEADLESS_ROLE_ENV,
  HostOutcomeSchema,
  jsonSchemaFor,
  type HostCommand,
  type SpawnRoleRequest,
} from "@vtc/shared";
import { claudeArmDebugFile } from "../src/claude-code/command.js";
import {
  codexHeadlessCommand,
  codexSandboxProfile,
  codexSchemaFile,
} from "../src/codex/command.js";
import {
  codexConfigArgs,
  createCodexMcpGuard,
  parseCodexMcpList,
} from "../src/codex/mcp-servers.js";
import { createNodeSpawner } from "../src/common/process.js";
import { createClaudeCodeAdapter, createCodexAdapter } from "../src/index.js";
import { parseDclArgs, type DclArgs } from "./dcl-check-args.js";
import {
  armInitFields,
  hookResponses,
  pluginDebugLines,
  summarizeCodexWebSearch,
  swapWebSearch,
} from "./dcl-check-lib.js";
import { hookCallSummary, vtcHookShim, type HookCallSummary } from "./h15-check-lib.js";
import {
  context,
  jsonl,
  outsideRepo,
  refuseUnsafe,
  REPO_ROOT,
  tempDir,
  write,
} from "./live-common.js";
import { redactRecording, type RecordingContext } from "./recording.js";

// ------------------------------------------------------------------------------ codex-web

/** The prompt that asks the role to open one exact URL the model is handed. */
const openPrompt = (url: string): string =>
  [
    `Use your web search tool to open this exact page: ${url} (do not search for it, open it).`,
    'Do not read or change any file. Reply only with a RoleResult: role "research_analyst", exit',
    '"done", summary "<the page title and first sentence of its text, or: could not open, and why>",',
    "and every other field null.",
  ].join(" ");

const WEB_PROMPT = [
  "You are a research analyst. Use your web search tool to find one news headline published in the",
  "last 24 hours about open-source software, and the URL of the article. Do not read or change any",
  'file. Reply only with a RoleResult: role "research_analyst", exit "done", summary "<headline> |',
  '<url>" (or "no web search available" if you have no web search tool), and every other field null.',
].join(" ");

/** Runs `command` with `input` on stdin, returning its stdout lines (killed after `timeoutMs`). */
const runCaptured = (
  command: HostCommand,
  cwd: string,
  input: string,
  timeoutMs: number,
): Promise<{ lines: string[]; code: number | null; stderr: string }> =>
  new Promise((done, fail) => {
    const child = spawn(command.command, [...command.args], {
      cwd,
      env: { ...process.env, ...command.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8000);
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs);
    child.on("error", fail);
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ lines: stdout.split("\n").filter((l) => l !== ""), code, stderr });
    });
    child.stdin.end(input, "utf8");
  });

const codexWeb = async (args: DclArgs): Promise<void> => {
  const cwd = tempDir("vtc-dcl-codex-web-");
  const vtcHome = tempDir("vtc-dcl-vtc-home-");
  const scratchDir = tempDir("vtc-dcl-codex-scratch-");
  try {
    execFileSync("git", ["init", "-q"], { cwd });
    const adapter = createCodexAdapter({ vtcHome, scratchDir });
    const login = await adapter.authStatus?.();
    console.warn(`auth: ${JSON.stringify(login)}`);
    if (login?.logged_in !== true) throw new Error("codex is not logged in: not starting");
    const sandbox = adapter.sandboxProfile({
      tools: { profile: args.profile, write_paths: [], engine_tools: [], host_web: true },
      cwd,
      writablePaths: args.profile === "read_only" ? [] : ["briefs/**"],
      protectedPaths: [],
      network: "none",
    });
    const policy = headlessPolicyFor(undefined);
    const request: SpawnRoleRequest = {
      role: "research_analyst",
      model: { tier: "low", effort: "low" },
      dispatch: "headless",
      cwd,
      prompt: args.open === undefined ? WEB_PROMPT : openPrompt(args.open),
      outputSchema: jsonSchemaFor("RoleResult", { target: "structured-output" }),
      sandbox,
      timeoutMs: policy.wallTimeoutMs,
    };
    // the adapter's own argv; only the web_search override changes for a mode it never emits
    const built = adapter.headlessCommand(request);
    const command = { ...built, args: swapWebSearch(built.args, CODEX_HOST_WEB_SEARCH, args.mode) };
    refuseUnsafe("codex", command);
    writeFileSync(
      codexSchemaFile(scratchDir, request.outputSchema),
      JSON.stringify(request.outputSchema),
    );
    const result = await runCaptured(command, cwd, request.prompt, 10 * 60_000);
    await adapter.dispose();
    const redact = context([cwd, vtcHome, scratchDir]);
    const stream = redactRecording(result.lines, redact);
    const tag = `codex-web-${args.mode}-${args.profile}${args.open === undefined ? "" : "-open"}`;
    write(args.out, `${tag}.jsonl`, jsonl(stream));
    write(args.out, `${tag}.stderr.txt`, redactRecording([result.stderr], redact).join("\n"));
    const parsed = adapter.parseEvents(result.lines);
    const outcome = HostOutcomeSchema.parse(
      parsed.outcome ?? {
        kind: "error",
        message: "no outcome",
        retryable: false,
        tokens: null,
        cost_usd: null,
      },
    );
    const summary = {
      mode: args.mode,
      profile: args.profile,
      open: args.open ?? null,
      exitCode: result.code,
      outcome: outcome.kind,
      output: outcome.kind === "done" ? outcome.output : null,
      revalidates:
        outcome.kind === "done"
          ? fromStructuredOutput("RoleResult", outcome.output).success
          : false,
      webSearch: summarizeCodexWebSearch(stream),
    };
    write(args.out, `${tag}.summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
    console.warn(JSON.stringify(summary, null, 2));
  } finally {
    for (const dir of [cwd, vtcHome, scratchDir]) rmSync(dir, { recursive: true, force: true });
  }
};

// ------------------------------------------------------------------------ codex-precedence

/** `codex …` with a temporary `CODEX_HOME`; never the user's own. */
const codexIn = (codexHome: string, cwd: string, argv: readonly string[]) => {
  try {
    const stdout = execFileSync("codex", [...argv], {
      cwd,
      env: { ...process.env, CODEX_HOME: codexHome },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    return { ok: true, stdout, stderr: "" };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return { ok: false, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
};

/** The `MARK_*` markers in a `codex debug prompt-input` output. */
const markers = (text: string): string[] => [...new Set(text.match(/MARK_[A-Z]+/g) ?? [])];

/** `config/read` (with layers) from a temporary app server, launched with `extra` flags. */
const configRead = (codexHome: string, cwd: string, extra: readonly string[]) =>
  new Promise<unknown>((done) => {
    const child = spawn("codex", [...extra, "app-server"], {
      cwd,
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    const timer = setTimeout(() => {
      child.kill();
      done({ error: "timed out" });
    }, 30_000);
    const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk;
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        let message: { id?: number; result?: unknown; error?: unknown };
        try {
          message = JSON.parse(line) as typeof message;
        } catch {
          continue;
        }
        if (message.id === 1) {
          send({ method: "initialized" });
          send({ id: 2, method: "config/read", params: { includeLayers: true, cwd } });
        } else if (message.id === 2) {
          clearTimeout(timer);
          child.kill();
          const result = message.result as
            | {
                config?: {
                  web_search?: unknown;
                  tools?: { web_search?: unknown } | null;
                  features?: Record<string, unknown> | null;
                };
                layers?: { name: unknown; config?: { web_search?: unknown } }[];
              }
            | undefined;
          done(
            result === undefined
              ? { error: message.error }
              : {
                  web_search: result.config?.web_search ?? null,
                  // the legacy keys, when set
                  ...(result.config?.tools?.web_search === undefined
                    ? {}
                    : { tools_web_search: result.config.tools.web_search }),
                  ...Object.fromEntries(
                    Object.entries(result.config?.features ?? {}).filter(([key]) =>
                      key.startsWith("web_search"),
                    ),
                  ),
                  layers: (result.layers ?? []).map((layer) => ({
                    layer: (layer.name as { type?: unknown }).type,
                    web_search: layer.config?.web_search ?? null,
                  })),
                },
          );
        }
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "vtc-dcl", title: "VTC D-cl", version: "0" } },
    });
  });

const codexPrecedence = async (args: DclArgs): Promise<void> => {
  const codexHome = tempDir("vtc-dcl-codex-home-");
  const cwd = tempDir("vtc-dcl-codex-cwd-");
  try {
    execFileSync("git", ["init", "-q"], { cwd });
    const setUser = (toml: string): void => {
      writeFileSync(join(codexHome, "config.toml"), toml);
    };
    const flag = ["-c", 'developer_instructions="MARK_FLAG"'];
    const results: Record<string, unknown> = {};
    // 1. the user's config.toml asks for live; VTC's top-level override says cached
    setUser('web_search = "live"\ndeveloper_instructions = "MARK_USER"\n');
    results.userLive = await configRead(codexHome, cwd, []);
    results.userLiveWithFlag = await configRead(codexHome, cwd, ["-c", 'web_search="cached"']);
    results.userLayerOrder = {
      withoutFlag: markers(codexIn(codexHome, cwd, ["debug", "prompt-input", "hi"]).stdout),
      withFlag: markers(codexIn(codexHome, cwd, ["debug", "prompt-input", ...flag, "hi"]).stdout),
    };
    // 2. a --profile layer (<name>.config.toml) that asks for live
    writeFileSync(
      join(codexHome, "risky.config.toml"),
      'web_search = "live"\ndeveloper_instructions = "MARK_PROFILE"\n',
    );
    results.profileLayerOrder = {
      profileOnly: markers(
        codexIn(codexHome, cwd, ["--profile", "risky", "debug", "prompt-input", "hi"]).stdout,
      ),
      profileAndFlag: markers(
        codexIn(codexHome, cwd, ["--profile", "risky", "debug", "prompt-input", ...flag, "hi"])
          .stdout,
      ),
    };
    // only the developer_instructions layer order is measured here: `codex app-server` refuses
    // `--profile` (0.162.1: "--profile only applies to runtime commands"), so `config/read` cannot
    // show the effective `web_search` under a profile layer, and `debug prompt-input` lists no tools
    // 3. the legacy active-profile key in config.toml
    setUser('profile = "legacy"\n\n[profiles.legacy]\nweb_search = "live"\n');
    const legacy = codexIn(codexHome, cwd, ["debug", "prompt-input", "hi"]);
    results.legacyProfileKey = {
      ok: legacy.ok,
      stderr: legacy.stderr
        .split("\n")
        .filter((l) => /profile/iu.test(l))
        .slice(0, 3),
    };
    // 4. an untrusted project .codex/config.toml (a role could plant one in its worktree)
    setUser('developer_instructions = "MARK_USER"\n');
    mkdirSync(join(cwd, ".codex"));
    writeFileSync(
      join(cwd, ".codex", "config.toml"),
      'web_search = "live"\ndeveloper_instructions = "MARK_PROJECT"\n',
    );
    results.untrustedProject = {
      layerOrder: markers(codexIn(codexHome, cwd, ["debug", "prompt-input", "hi"]).stdout),
      configReadWithFlag: await configRead(codexHome, cwd, ["-c", 'web_search="cached"']),
    };
    // 5. the legacy keys that turn search on (`[features] web_search_request`, `[tools]
    // web_search`) in the user's config.toml, against VTC's top-level override
    rmSync(join(cwd, ".codex"), { recursive: true, force: true });
    setUser("[features]\nweb_search_request = true\n\n[tools]\nweb_search = true\n");
    results.legacySearchKeys = {
      withoutFlag: await configRead(codexHome, cwd, []),
      withFlag: await configRead(codexHome, cwd, ["-c", 'web_search="disabled"']),
    };
    const text = JSON.stringify(results, null, 2)
      .split(codexHome)
      .join("<codex-home>")
      .split(cwd)
      .join("<cwd>");
    write(args.out, "codex-precedence.json", `${text}\n`);
    console.warn(text);
  } finally {
    rmSync(codexHome, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
};

// ------------------------------------------------------------------------------- codex-mcp

/** `codex mcp list --json` in a temporary `CODEX_HOME`: names and enabled flags only. */
const mcpNames = (codexHome: string, cwd: string, configArgs: readonly string[]) => {
  const result = codexIn(codexHome, cwd, ["mcp", "list", "--json", ...configArgs]);
  const servers = result.ok ? parseCodexMcpList(result.stdout) : null;
  return servers === null
    ? {
        ok: false,
        error: result.stderr
          .split("\n")
          .filter((l) => l.trim() !== "")
          .slice(0, 3),
      }
    : { ok: true, servers };
};

const codexMcp = async (args: DclArgs): Promise<void> => {
  const codexHome = tempDir("vtc-dcl-codex-home-");
  const repo = tempDir("vtc-dcl-codex-repo-");
  const market = tempDir("vtc-dcl-codex-market-");
  try {
    // a repo the user trusts, with a role worktree inside it, as VTC lays them out
    const git = (...argv: string[]) => execFileSync("git", argv, { cwd: repo, stdio: "ignore" });
    git("init", "-q");
    git(
      "-c",
      "user.name=vtc",
      "-c",
      "user.email=vtc@example.invalid",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    );
    const worktree = join(repo, ".vtc", "state", "worktrees", "T-1");
    git("worktree", "add", "-q", "-b", "vtc-t1", worktree);
    mkdirSync(join(worktree, ".codex"));
    writeFileSync(
      join(worktree, ".codex", "config.toml"),
      '[mcp_servers.planted]\ncommand = "/bin/echo"\n',
    );
    // a local plugin with its own MCP server, laid out as `codex plugin add` installs one
    // (plugin-add.json), written by hand: no `codex plugin` command runs here
    mkdirSync(join(market, ".agents", "plugins"), { recursive: true });
    writeFileSync(
      join(market, ".agents", "plugins", "marketplace.json"),
      JSON.stringify({
        name: "mk",
        interface: { displayName: "mk" },
        plugins: [
          {
            name: "pp",
            source: { source: "local", path: "./pp" },
            policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          },
        ],
      }),
    );
    const plugin = join(codexHome, "plugins", "cache", "mk", "pp", "0.1.0");
    mkdirSync(join(plugin, ".codex-plugin"), { recursive: true });
    writeFileSync(
      join(plugin, ".codex-plugin", "plugin.json"),
      JSON.stringify({
        name: "pp",
        version: "0.1.0",
        description: "probe",
        mcpServers: "./.mcp.json",
      }),
    );
    writeFileSync(
      join(plugin, ".mcp.json"),
      JSON.stringify({ mcpServers: { plugfetch: { command: "/bin/echo", args: ["x"] } } }),
    );
    cpSync(plugin, join(market, "pp"), { recursive: true });
    writeFileSync(
      join(codexHome, "config.toml"),
      [
        "[mcp_servers.fetchy]",
        'command = "/bin/echo"',
        'env = { DUMMY_TOKEN = "dummy-value" }',
        "",
        '[mcp_servers."we.ird name"]',
        'url = "http://127.0.0.1:9/mcp"',
        'http_headers = { "X-Dummy" = "dummy-header" }',
        "",
        "[mcp_servers.off]",
        'command = "/bin/echo"',
        "enabled = false",
        "",
        "[marketplaces.mk]",
        'source_type = "local"',
        `source = ${JSON.stringify(market)}`,
        "",
        '[plugins."pp@mk"]',
        "enabled = true",
        "",
        `[projects.${JSON.stringify(repo)}]`,
        'trust_level = "trusted"',
        "",
      ].join("\n"),
    );
    // the Research Analyst's real profile and command, as the adapter builds them
    const request: SpawnRoleRequest = {
      role: "research_analyst",
      model: { tier: "mid", effort: "medium" },
      dispatch: "headless",
      cwd: worktree,
      prompt: "-",
      outputSchema: jsonSchemaFor("RoleResult", { target: "structured-output" }),
      sandbox: codexSandboxProfile(
        {
          tools: {
            profile: "write_scoped",
            write_paths: [".vtc/research/briefs/**"],
            engine_tools: ["research_fetch"],
            host_web: true,
          },
          cwd: worktree,
          writablePaths: [],
          protectedPaths: [],
          network: "none",
        },
        { vtcHome: join(codexHome, "vtc-home") },
      ),
      timeoutMs: 60_000,
    };
    const commandOptions = { scratchDir: join(codexHome, "scratch") };
    const node = createNodeSpawner();
    const guard = createCodexMcpGuard({
      spawner: (command, options) =>
        node({ ...command, env: { ...command.env, CODEX_HOME: codexHome } }, options),
      bridge: "vtc",
    });
    const probe = codexHeadlessCommand(request, commandOptions);
    const turnOff = await guard.serversToTurnOff(worktree, codexConfigArgs(probe.args));
    const command = codexHeadlessCommand(request, { ...commandOptions, mcpServersOff: turnOff });
    refuseUnsafe("codex", command);
    let confirm = "ok";
    try {
      await guard.confirmOff(worktree, codexConfigArgs(command.args));
    } catch (error) {
      confirm = error instanceof Error ? error.message : String(error);
    }
    guard.dispose();
    const results = {
      codexVersion: codexIn(codexHome, worktree, ["--version"]).stdout.trim(),
      withoutOverrides: mcpNames(codexHome, worktree, []),
      discovered: turnOff,
      afterOverrides: mcpNames(codexHome, worktree, codexConfigArgs(command.args)),
      confirmOff: confirm,
      dottedKeyForDottedName: mcpNames(codexHome, worktree, [
        "-c",
        'mcp_servers."we.ird name".enabled=false',
      ]),
      dottedThenTable: mcpNames(codexHome, worktree, [
        "-c",
        'mcp_servers.vtc.command="vtc"',
        "-c",
        'mcp_servers={"fetchy"={enabled=false}}',
      ]),
      pluginServerByName: mcpNames(codexHome, worktree, [
        "-c",
        'mcp_servers={"plugfetch"={enabled=false}}',
      ]),
    };
    const text = JSON.stringify(results, null, 2)
      .split(codexHome)
      .join("<codex-home>")
      .split(repo)
      .join("<repo>")
      .split(market)
      .join("<marketplace>");
    if (/dummy/u.test(text))
      throw new Error("refusing to write: a stub's env or header value leaked");
    write(args.out, "codex-mcp.json", `${text}\n`);
    console.warn(text);
  } finally {
    for (const dir of [codexHome, repo, market]) rmSync(dir, { recursive: true, force: true });
  }
};

// ---------------------------------------------------------------------------- codex-plugin

const tree = (root: string): string[] =>
  existsSync(root)
    ? readdirSync(root, { recursive: true, encoding: "utf8" })
        .filter((entry) => !entry.split("/").some((part) => part === "skills" || part === "agents"))
        .sort()
    : [];

const codexPlugin = (args: DclArgs): void => {
  const codexHome = tempDir("vtc-dcl-codex-home-");
  const market = tempDir("vtc-dcl-codex-market-");
  const cwd = tempDir("vtc-dcl-codex-cwd-");
  try {
    const plugin = resolve(args.pluginDir ?? join(REPO_ROOT, ASSET_SOURCES["plugin:codex"]));
    cpSync(plugin, join(market, "vtc"), { recursive: true });
    mkdirSync(join(market, ".agents", "plugins"), { recursive: true });
    const marketplace = {
      name: "vtc-local",
      interface: { displayName: "VTC (local)" },
      plugins: [
        {
          name: "vtc",
          source: { source: "local", path: "./vtc" },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
        },
      ],
    };
    writeFileSync(
      join(market, ".agents", "plugins", "marketplace.json"),
      `${JSON.stringify(marketplace, null, 2)}\n`,
    );
    const steps = [
      ["plugin", "marketplace", "add", market, "--json"],
      ["plugin", "marketplace", "list"],
      ["plugin", "list"],
      ["plugin", "add", "vtc@vtc-local", "--json"],
      ["plugin", "list"],
    ];
    const results = steps.map((argv) => {
      const run = codexIn(codexHome, cwd, argv);
      return {
        argv: argv.join(" "),
        ok: run.ok,
        stdout: run.stdout,
        stderr: run.stderr.slice(-2000),
      };
    });
    const configToml = existsSync(join(codexHome, "config.toml"))
      ? readFileSync(join(codexHome, "config.toml"), "utf8")
      : null;
    const report = {
      marketplace,
      results,
      codexHomeFiles: tree(codexHome),
      configToml,
    };
    const text = JSON.stringify(report, null, 2)
      .split(codexHome)
      .join("<codex-home>")
      .split(market)
      .join("<marketplace>")
      .split(homedir())
      .join("<home>");
    write(args.out, "codex-plugin.json", `${text}\n`);
    console.warn(text);
  } finally {
    for (const dir of [codexHome, market, cwd]) rmSync(dir, { recursive: true, force: true });
  }
};

// ------------------------------------------------------------------------------ claude-arm

const ARM_PROMPT =
  'Do not read or change any file. Reply only with a RoleResult: role "qa", exit "done", summary "live ok", and every other field null.';

/**
 * Puts `vtc` on `PATH` for the run's plugin hooks (round-5 items): a shim in a temp bin directory
 * that records each hook call (`h15-check-lib.ts` `vtcHookShim`) and then runs the real cli under
 * `node`, with a temporary `VTC_HOME`, so the hooks never touch the user's own.
 */
const vtcOnPath = (args: DclArgs, bin: string, vtcHome: string): string => {
  const calls = join(bin, "calls");
  mkdirSync(calls);
  const node = execFileSync("which", ["node"], { encoding: "utf8" }).trim();
  const cli = resolve(args.vtcBin ?? join(REPO_ROOT, "packages", "cli", "dist", "bin.js"));
  if (!existsSync(cli)) throw new Error(`no vtc cli at ${cli}: build it first (pnpm build)`);
  writeFileSync(join(bin, "vtc"), vtcHookShim([node, cli], calls, HEADLESS_ROLE_ENV), {
    mode: 0o755,
  });
  process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  process.env.VTC_HOME = vtcHome;
  return calls;
};

/** The shim's recorded hook calls, one summary per call, in the order they were made. */
const hookCalls = (calls: string): HookCallSummary[] => {
  const read = (base: string, ext: string): string => {
    const path = join(calls, `${base}.${ext}`);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  };
  const bases = [...new Set(readdirSync(calls).map((name) => name.replace(/\.[a-z]+$/u, "")))];
  return bases
    .map((base) => ({ base, at: statSync(join(calls, `${base}.in`)).mtimeMs }))
    .sort((a, b) => a.at - b.at)
    .map(({ base }) =>
      hookCallSummary({
        argv: read(base, "argv"),
        input: read(base, "in"),
        role: read(base, "role"),
        code: read(base, "code"),
        stdout: read(base, "out"),
        stderr: read(base, "err"),
      }),
    );
};

const claudeArm = async (args: DclArgs): Promise<void> => {
  const guard = tempDir("vtc-dcl-guard-");
  const cwd = tempDir("vtc-dcl-trial-");
  const repo = tempDir("vtc-dcl-repo-");
  const bin = tempDir("vtc-dcl-bin-");
  const vtcHome = tempDir("vtc-dcl-vtc-home-");
  const armDir = join(guard, "lookback", "arms", "trial-1", "a");
  const plugin = resolve(args.pluginDir ?? join(REPO_ROOT, ASSET_SOURCES["plugin:claude-code"]));
  try {
    // an unchanged copy of the real compiled plugin: no scratch patch
    mkdirSync(join(guard, "lookback", "arms", "trial-1"), { recursive: true });
    cpSync(plugin, armDir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd });
    const calls = vtcOnPath(args, bin, vtcHome);
    // the adapter has no plugin of its own here: the arm is the only one the run can load
    // keeps the arm's debug log after the run, so the check can record it
    const adapter = createClaudeCodeAdapter({ keepArmDebugLogs: true, vtcHome });
    const login = await adapter.authStatus?.();
    console.warn(`auth: ${JSON.stringify(login)}`);
    if (login?.logged_in !== true) throw new Error("claude is not logged in: not starting");
    const policy = headlessPolicyFor(undefined);
    const request: SpawnRoleRequest = {
      role: "qa",
      mode: "judge",
      model: { tier: "low", effort: "low", model: args.model ?? "haiku" },
      dispatch: "headless",
      cwd,
      prompt: ARM_PROMPT,
      outputSchema: jsonSchemaFor("RoleResult", { target: "structured-output" }),
      sandbox: adapter.sandboxProfile({
        tools: { profile: "read_only", write_paths: [], engine_tools: [] },
        cwd,
        writablePaths: [],
        protectedPaths: [],
        network: "none",
        // a replay trial's read isolation (reading 178): the user's repo and its git directory
        readDeny: [repo, join(repo, ".git")],
      }),
      timeoutMs: policy.wallTimeoutMs,
      idleTimeoutMs: policy.idleTimeoutMs,
      pluginDir: armDir,
    };
    refuseUnsafe("claude-code", adapter.headlessCommand(request));
    const spawned = await adapter.spawnRole(request);
    if (spawned.dispatch !== "headless") throw new Error("expected a headless run");
    const outcome = HostOutcomeSchema.parse(await spawned.run.wait());
    const lines: string[] = [];
    for await (const line of spawned.run.lines()) lines.push(line);
    const proof = (await spawned.run.pluginLoad?.()) ?? { loaded: false, reason: "no pluginLoad" };
    await adapter.dispose();
    const debugFile = claudeArmDebugFile(armDir);
    const debugLog = existsSync(debugFile) ? readFileSync(debugFile, "utf8") : "";
    write(args.out, "claude-arm.stream.raw.jsonl", jsonl(lines));
    write(args.out, "claude-arm.debug.raw.log", debugLog);
    const redact: RecordingContext = {
      ...context([cwd, repo]),
      paths: [
        [armDir, "<arm-dir>"],
        [guard, "<guard>"],
      ],
    };
    const stream = redactRecording(lines, redact);
    write(args.out, "claude-arm.stream.jsonl", jsonl(stream));
    const pluginLines = redactRecording(pluginDebugLines(debugLog), redact);
    write(args.out, "claude-arm.debug-plugin-lines.log", jsonl(pluginLines));
    const summary = {
      outcome: outcome.kind,
      revalidates:
        outcome.kind === "done"
          ? fromStructuredOutput("RoleResult", outcome.output).success
          : false,
      pluginLoad: proof.loaded ? { loaded: true, dir: relative(guard, proof.dir) } : proof,
      init: armInitFields(stream),
      debugLogBytes: statSync(debugFile, { throwIfNoEntry: false })?.size ?? 0,
      // round-5 items: `vtc` on PATH; each `vtc hook` call (agent_type, exit, output) and every
      // hook the stream reports
      claudeVersion: execFileSync("claude", ["--version"], { encoding: "utf8" }).trim(),
      date: new Date().toISOString().slice(0, 10),
      vtcHookCalls: hookCalls(calls),
      hookResponses: hookResponses(stream),
    };
    write(args.out, "claude-arm.summary.json", `${JSON.stringify(summary, null, 2)}\n`);
    console.warn(JSON.stringify(summary, null, 2));
  } finally {
    for (const dir of [guard, cwd, repo, bin, vtcHome])
      rmSync(dir, { recursive: true, force: true });
  }
};

const main = async (): Promise<void> => {
  const args = parseDclArgs(process.argv.slice(2));
  const out = outsideRepo(args.out);
  mkdirSync(out, { recursive: true });
  const resolved = { ...args, out };
  if (args.target === "codex-web") await codexWeb(resolved);
  else if (args.target === "codex-precedence") await codexPrecedence(resolved);
  else if (args.target === "codex-mcp") await codexMcp(resolved);
  else if (args.target === "codex-plugin") codexPlugin(resolved);
  else await claudeArm(resolved);
};

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

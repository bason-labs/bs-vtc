# Adapter test fixtures

Three kinds of file live here:

- **Spike recordings** are copied from `docs/research/spike-fixtures/` (spike rounds 1 and 2,
  2026-10-13, redacted there). The JSON content is unchanged; prettier only re-indented it.
- **Live-check recordings** come from 2026-10-14 (Claude Code 2.1.299, codex-cli 0.162.1).
  - They were recorded with `pnpm --filter @vtc/adapters live:check … --record` on the owner's
    signed-in machine. That redacts ids, paths, the user name, e-mail addresses and token
    formats.
  - They were then passed through `redactRecording` again (`scripts/recording.ts`). This replaces
    what names the owner's own setup with `<redacted>`: the `init` event's `plugins`, `skills`,
    `slash_commands`, `memory_paths` and `messaging_socket_path`, and the hook events'
    `output`/`stdout`/`stderr`. Thinking signatures become `<signature>`.
  - Under `--setting-sources user` the user's own plugins and `SessionStart` hooks load into a
    role run (spine §5 reading 170). Their events stay in the streams, with that text redacted.
- **Synthetic files** (`*.synthetic.*`) are not recordings. They are built from documented shapes:
  - `docs/research/2026-10-13-usage-limits-auto-resume.md`;
  - `docs/research/2026-10-14-wave3-best-practice.md` §5;
  - the Claude Agent SDK, headless and Codex non-interactive docs.

  Replace each one once a real stream is captured. Still missing: a limit hit, an auth error, a
  Claude turn-cap hit, a killed Claude run, `api_retry`, the `account/rateLimits/updated`
  notification, and a run with a shell call on either host (D-cs).

AD-25 asks for limit, auth, max-turns and kill streams. What exists today:

| Stream    | Claude                                    | Codex                                            |
| --------- | ----------------------------------------- | ------------------------------------------------ |
| limit     | synthetic                                 | synthetic                                        |
| auth      | synthetic                                 | recorded (`exec-signed-out.jsonl`, H-15)         |
| max-turns | synthetic; both recordings missed the cap | none: Codex has no turn cap of its own (§12.1)   |
| kill      | synthetic                                 | recorded (`thread.started`, `turn.started`, end) |

To record a stream, run the command below on the signed-in machine. The header of
`scripts/live-check.ts` has the full recipe. Read every recording before it replaces a
synthetic file.

| Stream    | Command (`pnpm --filter @vtc/adapters live:check …`)                                                                              |
| --------- | --------------------------------------------------------------------------------------------------------------------------------- |
| max-turns | `claude-code --max-turns 1 --record <file>` with a prompt that needs a tool turn                                                  |
| kill      | `<host> --kill-after 3000 --record <file>`                                                                                        |
| auth      | Codex: `live:h15 codex-signed-out` (a temporary `CODEX_HOME`, never a sign-out); Claude: none yet (H-15 never signs the user out) |
| limit     | `<host> --record <file>` while the host reports its limit reached (it cannot be forced)                                           |

`--max-turns 1` with the live check's trivial prompt does not hit the cap. Without the
`StructuredOutput` tool the reply takes one turn. With it, the closing `StructuredOutput` call
makes `num_turns` 2, and the run still ends `success`.

Claude recordings (2026-10-14):

| File                                                   | What it shows                                                                                                                                                                                       |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-code/stream-success.jsonl`                     | A headless role run whose agent's `tools` include `StructuredOutput`. The proposed compiler change was applied to a scratch copy of the plugin. `structured_output` re-validates; `unifiedWindows`. |
| `claude-code/stream-resume.jsonl`                      | The `--resume` of that run, again with `structured_output`.                                                                                                                                         |
| `claude-code/stream-no-structured-output.jsonl`        | The same run with the agent as compiled today (`tools: Read, Grep, Glob`). No `StructuredOutput` tool, a fenced JSON reply, no `structured_output`.                                                 |
| `claude-code/stream-max-turns-not-hit.jsonl`           | `--max-turns 1` without the tool. The cap was not hit (`success`, 1 turn).                                                                                                                          |
| `claude-code/stream-max-turns-structured-output.jsonl` | `--max-turns 1` with the tool. The cap was not hit (`success`, 2 turns, `structured_output`).                                                                                                       |

Codex recordings (2026-10-14):

| File                       | What it shows                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `codex/exec-success.jsonl` | A headless role run. `turn.completed.usage` adds `cache_write_input_tokens`.                                                    |
| `codex/exec-resume.jsonl`  | `codex exec resume` with the `code_sandboxed` profile. The prior context is reloaded: 23,552 of 47,455 input tokens are cached. |
| `codex/exec-killed.jsonl`  | A run stopped by `HeadlessRun.kill()`: `thread.started`, `turn.started`, then nothing.                                          |

D-cl live-check recordings (2026-10-15, spine §5 reading 206). They were made with
`pnpm --filter @vtc/adapters live:dcl <check> --out <dir>` (`scripts/dcl-check.ts`), redacted the
same way, and read before they were copied here.

| File                                                  | What it shows                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-code/stream-arm-success.jsonl`                | The success fixture: a replay arm's run (D-cg) on an unchanged copy of the real compiled plugin (no scratch patch), `--plugin-dir <arm-dir>`, a replay `readDeny`. `structured_output` re-validates. The `init` record keeps the `vtc` plugin's entry (`path`, `source: "vtc@inline"`).                                      |
| `claude-code/arm-debug-plugin-lines.log`              | The lines of that run's `--debug-file` that name the `vtc` plugin or `--plugin-dir`: what the load proof reads (no lock line).                                                                                                                                                                                               |
| `claude-code/arm-debug-locked.synthetic.log`          | Synthetic: the documented line for a plugin locked by managed settings (`--plugin-dir copy of "vtc" ignored: plugin is locked by managed settings`).                                                                                                                                                                         |
| `codex/exec-web-search-cached.jsonl`                  | `web_search="cached"` under `workspace-write`: one search answered from the index, no page opened.                                                                                                                                                                                                                           |
| `codex/exec-web-search-cached-open-refused.jsonl`     | `cached`, the role handed a fresh `https://example.com/vtc-dcl-probe-…` URL: the tool's `open_page` result is one line titled "Internal Error", with no page text. "Not accessible via this tool" is the role's own summary. This cannot tell "no live fetch" from "fetched and failed", so Codex `safeHostWeb` stays false. |
| `codex/exec-web-search-cached-read-only.jsonl`        | `cached` under `read-only`: one search, then an `open_page` of a URL its own results named.                                                                                                                                                                                                                                  |
| `codex/exec-web-search-indexed.jsonl`                 | `indexed`, for the record: it opened a result page (`open_page`).                                                                                                                                                                                                                                                            |
| `codex/exec-web-search-disabled-apps-connector.jsonl` | `disabled`, before the adapter turned the apps connectors off: the role called `codex_apps` `search_service.web_run` (it failed with "Unsupported Search commands").                                                                                                                                                         |
| `codex/exec-web-search-disabled.jsonl`                | `disabled` with `CODEX_ROLE_FEATURES_OFF`: no web tool at all.                                                                                                                                                                                                                                                               |

Offline D-cl checks (2026-10-15, codex-cli 0.162.1), each in a temporary `CODEX_HOME` with no
login and no model call. Paths are replaced with `<codex-home>`, `<cwd>`, `<marketplace>` and
`<home>`.

| File                          | What it shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex/precedence.json`       | `live:dcl codex-precedence`. Read through `config/read`: `-c web_search="cached"` wins over `web_search = "live"` in the user's `config.toml` and in an untrusted project `.codex/config.toml`. A `--profile` layer was compared only by `developer_instructions` markers, where the override won; `codex app-server` refuses `--profile`, so its effective `web_search` is not measured. The legacy `profile = "x"` key is refused. A legacy `[features] web_search_request = true` stays set beside the override.                                                                                                                                                                                                       |
| `codex/plugin-add.json`       | `live:dcl codex-plugin`, how D-bn can register the plugin. `codex plugin marketplace add <dir>` (a local `.agents/plugins/marketplace.json`), then `codex plugin add vtc@vtc-local`. The plugin is copied to `<codex-home>/plugins/cache/vtc-local/vtc/0.1.0`, and `config.toml` gets `[marketplaces.vtc-local]` (`source_type = "local"`) and `[plugins."vtc@vtc-local"] enabled = true`.                                                                                                                                                                                                                                                                                                                                |
| `codex/mcp-isolation.json`    | `live:dcl codex-mcp`. A role worktree in a trusted repo (a linked worktree under `.vtc/state/worktrees/`) lists the user's servers, one planted in the worktree's own `.codex/config.toml` and an installed plugin's. With the Research Analyst's real overrides (plugins off, then one inline `mcp_servers={"<name>"={enabled=false}, …}` table before the bridge keys), only the engine bridge `vtc` stays on. A dotted `-c` key cannot name a dotted server, a later whole table drops earlier dotted keys, and a plugin's server cannot be turned off by name (all "invalid transport" or dropped). Stub servers with dummy values; only names and enabled flags are recorded.                                        |
| `codex/plugin-reinstall.json` | Round 5 (written by hand from the run's output, the same redaction). Adding the marketplace again reports `alreadyAdded: true`, and `plugin add` again refreshes the cached copy at the same version, so a re-install updates the plugin. The same name from another directory is refused ("already added from a different source"); `marketplace remove` drops only `[marketplaces.vtc-local]`, and the add then succeeds. With the plugin installed, `codex mcp list` shows the plugin's `vtc` server (run from the cache); with the installer's `[mcp_servers.vtc]` too, one `vtc` server, the config's. The adapter's own `install` ran twice against the real `codex` in a temporary home and registered both times. |

Spike recordings and synthetic files:

| File                                                 | Source                                                                                                                                                                         |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `claude-code/statusline.json`                        | documented statusline payload (no capture: skipped by human decision H-10, 2026-10-15)                                                                                         |
| `claude-code/p-json-schema-result.json`              | recorded: `claude -p --output-format json --json-schema` (spike 1)                                                                                                             |
| `claude-code/stream-limit-rejected.synthetic.jsonl`  | synthetic: `rate_limit_event` rejected (five_hour) then an error result                                                                                                        |
| `claude-code/stream-model-limit.synthetic.jsonl`     | synthetic: per-model (`seven_day_opus`) rejection                                                                                                                              |
| `claude-code/stream-api-retry.synthetic.jsonl`       | synthetic: `system/api_retry` with `rate_limit`, no result (non-zero exit)                                                                                                     |
| `claude-code/stream-auth.synthetic.jsonl`            | synthetic: signed-out error result                                                                                                                                             |
| `claude-code/stream-auth-retry.synthetic.jsonl`      | synthetic: `system/api_retry` with `authentication_failed`, error result                                                                                                       |
| `claude-code/stream-max-turns.synthetic.jsonl`       | synthetic: `result` with `error_max_turns` and the spend so far                                                                                                                |
| `claude-code/stream-killed.synthetic.jsonl`          | synthetic: a run cut off by SIGTERM (exit 143): no `result` event                                                                                                              |
| `codex/exec-output-schema-events.jsonl`              | recorded: `codex exec --json --output-schema` (spike 1)                                                                                                                        |
| `codex/exec-usage-limit.synthetic.jsonl`             | synthetic: `turn.failed` with `usageLimitExceeded`                                                                                                                             |
| `codex/exec-auth.synthetic.jsonl`                    | synthetic: `turn.failed` with `unauthorized`                                                                                                                                   |
| `codex/app-server-rateLimits-read.json`              | recorded: `account/rateLimits/read` response (spike 1)                                                                                                                         |
| `codex/app-server-account-updated.json`              | recorded: unprompted `account/updated` notification (spike 1)                                                                                                                  |
| `codex/app-server-rateLimits-updated.synthetic.json` | synthetic: `account/rateLimits/updated` notification                                                                                                                           |
| `claude-code/stream-bash-calls.synthetic.jsonl`      | synthetic (D-cs): `Bash` `tool_use` blocks, one repeated, one a subagent's, one `Read`; commands with paths and fake secrets                                                   |
| `codex/exec-command-execution.synthetic.jsonl`       | synthetic (D-cs): `command_execution` items (the documented `bash -lc ls` sample line verbatim, `item.started`/`updated`/`completed`, argv arrays) with paths and fake secrets |

H-15 and D-cx live-check recordings (2026-10-15, Claude Code 2.1.299, codex-cli 0.162.1, spine §5
readings 234, 239 and 244). Made with `pnpm --filter @vtc/adapters live:h15 <check> --out <dir>`
(`scripts/h15-check.ts`) or `live:dcl claude-arm` (`scripts/dcl-check.ts`), redacted the same
way, and read before they were copied here. Codex probes ran `--ephemeral` and Claude probes
`--no-session-persistence`, so no session was saved in the owner's `~/.codex` or `~/.claude`, and
no settings or sign-in there were changed (the hosts may still have written their own logs, caches
or per-project state, as any run does). These Claude probes ran with the owner's whole shell
environment; the `claude-strict` and `claude-usage-unit` runs recorded `apiKeySource` `"none"`
(the subscription sign-in, no API key). The
script now gives every probe the environment a role run gets (`childEnvironment`, AD-25 rule 4).

| File                                       | What it shows                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex/exec-model-refused.jsonl`           | `live:h15 codex-model-refusal` (D-cx): `-m vtc-probe-no-such-model` on the owner's ChatGPT sign-in. A "Model metadata … not found" `error` item, then `error` and `turn.failed` with the API's 400 as JSON text: "The '<id>' model is not supported when using Codex with a ChatGPT account." No work, no tokens.          |
| `codex/exec-signed-out.jsonl`              | `live:h15 codex-signed-out`: a fresh temporary `CODEX_HOME` (`codex login status`: "Not logged in", exit 1). Ten `Reconnecting... n/5` errors (WebSocket, then HTTPS), then a 401 "Missing bearer or basic authentication" with no `codexErrorInfo`. `cf-ray` and request ids replaced with `<cf-ray>` and `<request-id>`. |
| `claude-code/stream-usage-unit.jsonl`      | `live:h15 claude-usage-unit` (H-10): a trivial `--setting-sources ""` run whose `rate_limit_event` reads `five_hour` 0.13 and `seven_day` 0.73. Claude Code's own `/usage`, 12 s later, printed 14% and 73% with the same resets, so `utilization` is a 0–1 fraction, read up to one point low.                            |
| `claude-code/stream-arm-vtc-on-path.jsonl` | `live:dcl claude-arm` with `vtc` on `PATH` (round-5 items): the plugin's `SessionStart` hook exits 0 with no output (it exited 127 in `stream-arm-success.jsonl`), and the engine bridge `vtc` is `connected` in `init`. The shim recorded `agent_type` `vtc:vtc-qa-judge` in the hook's input.                            |

Not recorded: a Codex limit text. `live:h15 codex-limit` read the plan at 15% (five hours) and 2%
(weekly) on 2026-10-15, and again 15% and 2% at 12:41 UTC that day (codex-cli 0.162.1). A limit
cannot be forced; it records the text once a window is at its limit.

H-15 Claude results with no fixture (the adapter reads nothing from these runs; the summaries are
the result). Claude Code 2.1.299, a claude.ai `team` sign-in, model `haiku`, 2026-10-15:

- H-15 (2), `live:h15 claude-strict`: one trivial run under `--restricted --tools ""` and one
  under `--setting-sources "" --tools ""`. Both kept the subscription sign-in (`apiKeySource`
  `none`, result `success`, exit 0, no stderr; `claude auth status` signed in before and after),
  started no hook and no MCP server, and had no tools. Each `init` still listed 4 plugins (names
  redacted, not examined).
- H-15 (1), `live:h15 claude-sandbox`, with `claudeSessionSandboxSettings` in the temp project's
  `.claude/settings.local.json` and sentinel files in a temp VTC home. In every variant the
  sandboxed probe could not read `<vtcHome>/token`, `run/`, `hidden/` or the repo's
  `.vtc/state/checkouts` and `.vtc/state/gates`, could not write any `homeWriteDeny` root or the
  repo's `.vtc/project.yaml` and `.vtc/gates.yml` (checked on disk: only the control file was
  written), and `git`, `npm` (`config get registry` too), `pnpm` and `node` ran. No sentinel
  reached a stream.
  - `localOnly` (`--setting-sources local`): the escape, asked in a run of its own, was made
    (`dangerouslyDisableSandbox: true`) and every deny still held.
  - `projectTurnsOff` (`--setting-sources project,local`, a project `settings.json` with
    `sandbox.enabled: false` and `allowUnsandboxedCommands: true`): the sandboxed phase was still
    sandboxed, so the project layer did not turn it off. The model declined the escape, saying
    the session's configuration disables the flag. An earlier run that day, with the escape in the
    same run as the sandboxed phase, made it (`dangerouslyDisableSandbox: true`) and every deny
    held.
  - `pluginSubagent` (an in-session role: the compiled plugin's `vtc:vtc-engineer-backend`
    subagent, dispatched by the main agent): its Bash was sandboxed the same way.
  - Not probed: the real credential files, `HOME_CREDENTIAL_LOCATIONS` and `~/.npmrc` (never read;
    their deny entries come from the same lists as the sentinels), and whether managed or user
    settings can turn the sandbox off over the local file (the check never changes them).

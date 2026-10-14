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
  Claude turn-cap hit, a killed Claude run, `api_retry`, and the `account/rateLimits/updated`
  notification.

AD-25 asks for limit, auth, max-turns and kill streams. What exists today:

| Stream    | Claude                                    | Codex                                            |
| --------- | ----------------------------------------- | ------------------------------------------------ |
| limit     | synthetic                                 | synthetic                                        |
| auth      | synthetic                                 | synthetic                                        |
| max-turns | synthetic; both recordings missed the cap | none: Codex has no turn cap of its own (§12.1)   |
| kill      | synthetic                                 | recorded (`thread.started`, `turn.started`, end) |

To record a stream, run the command below on the signed-in machine. The header of
`scripts/live-check.ts` has the full recipe. Read every recording before it replaces a
synthetic file.

| Stream    | Command (`pnpm --filter @vtc/adapters live:check …`)                                    |
| --------- | --------------------------------------------------------------------------------------- |
| max-turns | `claude-code --max-turns 1 --record <file>` with a prompt that needs a tool turn        |
| kill      | `<host> --kill-after 3000 --record <file>`                                              |
| auth      | sign the host out with its own command, then `<host> --signed-out --record <file>`      |
| limit     | `<host> --record <file>` while the host reports its limit reached (it cannot be forced) |

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

| File                    | What it shows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex/precedence.json` | `live:dcl codex-precedence`. Read through `config/read`: `-c web_search="cached"` wins over `web_search = "live"` in the user's `config.toml` and in an untrusted project `.codex/config.toml`. A `--profile` layer was compared only by `developer_instructions` markers, where the override won; `codex app-server` refuses `--profile`, so its effective `web_search` is not measured. The legacy `profile = "x"` key is refused. A legacy `[features] web_search_request = true` stays set beside the override. |
| `codex/plugin-add.json` | `live:dcl codex-plugin`, how D-bn can register the plugin. `codex plugin marketplace add <dir>` (a local `.agents/plugins/marketplace.json`), then `codex plugin add vtc@vtc-local`. The plugin is copied to `<codex-home>/plugins/cache/vtc-local/vtc/0.1.0`, and `config.toml` gets `[marketplaces.vtc-local]` (`source_type = "local"`) and `[plugins."vtc@vtc-local"] enabled = true`.                                                                                                                          |

Spike recordings and synthetic files:

| File                                                 | Source                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------- |
| `claude-code/statusline.json`                        | documented statusline payload (statusline capture still pending)           |
| `claude-code/p-json-schema-result.json`              | recorded: `claude -p --output-format json --json-schema` (spike 1)         |
| `claude-code/stream-limit-rejected.synthetic.jsonl`  | synthetic: `rate_limit_event` rejected (five_hour) then an error result    |
| `claude-code/stream-model-limit.synthetic.jsonl`     | synthetic: per-model (`seven_day_opus`) rejection                          |
| `claude-code/stream-api-retry.synthetic.jsonl`       | synthetic: `system/api_retry` with `rate_limit`, no result (non-zero exit) |
| `claude-code/stream-auth.synthetic.jsonl`            | synthetic: signed-out error result                                         |
| `claude-code/stream-auth-retry.synthetic.jsonl`      | synthetic: `system/api_retry` with `authentication_failed`, error result   |
| `claude-code/stream-max-turns.synthetic.jsonl`       | synthetic: `result` with `error_max_turns` and the spend so far            |
| `claude-code/stream-killed.synthetic.jsonl`          | synthetic: a run cut off by SIGTERM (exit 143): no `result` event          |
| `codex/exec-output-schema-events.jsonl`              | recorded: `codex exec --json --output-schema` (spike 1)                    |
| `codex/exec-usage-limit.synthetic.jsonl`             | synthetic: `turn.failed` with `usageLimitExceeded`                         |
| `codex/exec-auth.synthetic.jsonl`                    | synthetic: `turn.failed` with `unauthorized`                               |
| `codex/app-server-rateLimits-read.json`              | recorded: `account/rateLimits/read` response (spike 1)                     |
| `codex/app-server-account-updated.json`              | recorded: unprompted `account/updated` notification (spike 1)              |
| `codex/app-server-rateLimits-updated.synthetic.json` | synthetic: `account/rateLimits/updated` notification                       |

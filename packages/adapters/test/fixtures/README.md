# Adapter test fixtures

Recorded host output is copied from `docs/research/spike-fixtures/` (spike rounds 1 and 2,
2026-10-13, redacted there); the JSON content is unchanged, only re-indented by prettier. Files named `*.synthetic.*` are **not** recordings: no limit hit,
auth error, turn-cap hit, killed run, SDK `rate_limit_event`/`api_retry` or
`account/rateLimits/updated` notification has been captured yet (spine §7, including the AD-25
row "Codex limit and auth text"). They are built from the documented shapes in
`docs/research/2026-10-13-usage-limits-auto-resume.md`, `docs/research/2026-10-14-wave3-best-practice.md`
§5 and the Claude Agent SDK / headless / Codex non-interactive docs, and must be replaced by
recordings once the spike captures them (`pnpm --filter @vtc/adapters live:check`). AD-25 asks for
limit, auth, max-turns and kill streams: Claude has all four (synthetic), Codex has limit, auth
and kill (synthetic); Codex has no turn cap of its own (§12.1), so it has no max-turns stream.

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
| `codex/exec-killed.synthetic.jsonl`                  | synthetic: a run cut off mid-command: no `turn.completed` / `turn.failed`  |
| `codex/app-server-rateLimits-read.json`              | recorded: `account/rateLimits/read` response (spike 1)                     |
| `codex/app-server-account-updated.json`              | recorded: unprompted `account/updated` notification (spike 1)              |
| `codex/app-server-rateLimits-updated.synthetic.json` | synthetic: `account/rateLimits/updated` notification                       |

# Adapter test fixtures

Recorded host output is copied from `docs/research/spike-fixtures/` (spike rounds 1 and 2,
2026-10-13, redacted there); the JSON content is unchanged, only re-indented by prettier. Files named `*.synthetic.*` are **not** recordings: no limit hit,
auth error, SDK `rate_limit_event`/`api_retry` or `account/rateLimits/updated` notification has
been captured yet (spine §7). They are built from the documented shapes in
`docs/research/2026-10-13-usage-limits-auto-resume.md` and the Claude Agent SDK / Codex
app-server docs, and must be replaced by recordings once the spike captures them.

| File                                                 | Source                                                                     |
| ---------------------------------------------------- | -------------------------------------------------------------------------- |
| `claude-code/statusline.json`                        | documented statusline payload (statusline capture still pending)           |
| `claude-code/p-json-schema-result.json`              | recorded: `claude -p --output-format json --json-schema` (spike 1)         |
| `claude-code/stream-limit-rejected.synthetic.jsonl`  | synthetic: `rate_limit_event` rejected (five_hour) then an error result    |
| `claude-code/stream-model-limit.synthetic.jsonl`     | synthetic: per-model (`seven_day_opus`) rejection                          |
| `claude-code/stream-api-retry.synthetic.jsonl`       | synthetic: `system/api_retry` with `rate_limit`, no result (non-zero exit) |
| `claude-code/stream-auth.synthetic.jsonl`            | synthetic: signed-out error result                                         |
| `codex/exec-output-schema-events.jsonl`              | recorded: `codex exec --json --output-schema` (spike 1)                    |
| `codex/exec-usage-limit.synthetic.jsonl`             | synthetic: `turn.failed` with `usageLimitExceeded`                         |
| `codex/exec-auth.synthetic.jsonl`                    | synthetic: `turn.failed` with `unauthorized`                               |
| `codex/app-server-rateLimits-read.json`              | recorded: `account/rateLimits/read` response (spike 1)                     |
| `codex/app-server-account-updated.json`              | recorded: unprompted `account/updated` notification (spike 1)              |
| `codex/app-server-rateLimits-updated.synthetic.json` | synthetic: `account/rateLimits/updated` notification                       |

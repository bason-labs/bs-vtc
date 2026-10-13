# Usage panel and auto-resume: Claude Code and Codex

Date: 2026-10-13. Verified against official docs except where marked *secondary* or *unverified*.

## Bottom line

Both hosts expose a sanctioned, structured way to read the 5-hour and weekly usage percentages and their reset times:

- **Claude Code:** a statusline JSON field (interactive sessions, Pro/Max), plus SDK events for runs VTC starts itself.
- **Codex:** the documented app-server method `account/rateLimits/read`.

Neither host documents an auto-resume for headless runs, so **the engine owns the resume**.

## 1. How to read usage

### Claude Code

**Statusline JSON** (https://code.claude.com/docs/en/statusline):
- Fields: `rate_limits.five_hour.used_percentage` (0–100) and `rate_limits.five_hour.resets_at` (epoch seconds), plus the same pair under `rate_limits.seven_day`.
- Only present for Pro/Max subscribers, and only after the first API response.
- Each window can be absent on its own, and it disappears once its reset time passes. Treat a missing window as **unknown**, never as 0%.
- The docs don't cover `-p` mode or Team/Enterprise plans.

**SDK `rate_limit_event`** (https://code.claude.com/docs/en/agent-sdk/typescript):
- Shape: `{rate_limit_info:{status:"allowed"|"allowed_warning"|"rejected", resetsAt?, utilization?, errorCode?}}`.
- The unit of `utilization` isn't documented.

**Headless mode (`-p` / stream-json):** `system/api_retry` events carry `error:"rate_limit"` and `retry_delay_ms`. No reset time is included.

**Not usable for machine reading:**
- `/usage` returns unstructured text.
- There is no `claude usage` CLI command.
- No plan-window metric appears in the OpenTelemetry list we could check (that check was partial).

### Codex

**App-server** (https://learn.chatgpt.com/docs/app-server.md):
- `account/rateLimits/read` returns `{limitId, limitName, primary:{usedPercent, windowDurationMins, resetsAt}, secondary, rateLimitReachedType, planType?, credits?}`.
- Push notification: `account/rateLimits/updated`, with the same shape.
- Label each window from `windowDurationMins`. Don't assume which bucket is 5h and which is weekly.

**Other surfaces:**
- `/status` shows limits interactively.
- `codex exec --json` carries no limit data.
- Hooks carry no limit data.
- Statusline item names for these limits appear only in a maintainer comment (*secondary*, openai/codex #15281).

## 2. Staying compliant

**Allowed:**
- A **statusline tee shim**: wrap the user's existing statusline command, don't replace it, and forward stdin to the engine's localhost endpoint.
- A managed **`codex app-server` child process**. Codex handles its own auth.
- `claude auth status --json` to read `authMethod`.

**Forbidden, even as a fallback:**
- Reading `~/.claude` credentials, the Keychain, `~/.codex/auth.json`, or `CLAUDE_CODE_OAUTH_TOKEN`.
- Calling undocumented usage endpoints.
- Scraping settings pages with tokens.

## 3. Auto-continue

**Claude interactive:**
- Auto-continues by default on claude.ai subscriptions (v2.1.234+), re-arming at most twice in a row. The setting is `autoContinueAtUsageLimit`.
- Ends on exit, resume or account switch.
- Behaviour with background subagents isn't documented.

**Claude `-p`:** no auto-wait. The run fails with a non-zero exit. `ScheduleWakeup`, `CronCreate` and `/loop` are tied to the session and don't survive it, so they can't provide durable resume.

**Codex:**
- A limit hit produces turn `failed` with `codexErrorInfo: UsageLimitExceeded`.
- There is no auto-resume (a feature request exists; *secondary*).

**Engine design:**
1. **Detect:**
   - Claude: `rate_limit_event` with status `rejected`, `api_retry` with `rate_limit`, or a non-zero `-p` exit.
   - Codex: `UsageLimitExceeded`.
2. **Record:** the reset time, the session ID and the pending steps, written to disk.
3. **Park and schedule:** use the engine's own persisted timer, which survives restarts (for example a launchd agent on macOS). Wake at the reset time plus 1–2 minutes of jitter.
4. **Verify and resume:** re-read usage. If still limited, park again with backoff, up to a cap. Otherwise re-dispatch:
   - `claude -p --resume <id> "<continue>" --permission-prompts none --output-format json` with an explicit tool allowlist, or
   - `codex exec resume <id> "<continue>"`.
5. **What has to stay running:** only the engine. Resume picks up from the saved transcript.
   - *Unverified:* whether `codex exec resume` works after long gaps.
   - *Unverified:* `claude --bg`.

## 4. Per-model limits

- **Claude:** Opus and Sonnet limits are separate, but the docs only expose them as rejection messages. Show them as "limit reached, resets X", not as a percentage.
- **Codex:** `limitId` separates buckets. Their names are unverified.

## Dashboard

- One card per host.
- Each window shows: used %, remaining %, the local reset time, and an age badge saying when it was last updated.
- A missing value shows as "unknown".
- Per-model rows appear only when the host reports them.

## Capability table

| Capability | Claude Code | Codex |
|---|---|---|
| 5-hour used % + reset | statusline `five_hour` (Pro/Max, interactive) | app-server `primary` |
| Weekly used % + reset | statusline `seven_day` | app-server `secondary` |
| Push updates | statusline; SDK `rate_limit_event` | `account/rateLimits/updated` |
| Limit-hit signal | `rate_limit_event` rejected; `api_retry` rate_limit | `UsageLimitExceeded` |
| Built-in auto-continue | interactive only | none |
| Resume | `claude -p --resume` (engine-driven) | `codex exec resume` (engine-driven) |

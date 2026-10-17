# Sub-project 0 spike results (round 1)

Date: 2026-10-13. Run on the owner's machine through their own signed-in CLIs (Claude Code 2.1.296,
codex-cli 0.162.1 on a ChatGPT Plus plan, Bun 1.4.3). No credential files were read. Redacted
captures are in `spike-fixtures/`. Each row names the spine §7 provisional contract it affects.

| # | Check | Result | Consequence |
|---|---|---|---|
| 1 | `claude -p --json-schema` with `jsonSchemaFor("RoleResult", {target: "structured-output"})` | **Fails as exported**: `--json-schema is not a valid JSON Schema: no schema with key or ref "https://json-schema.org/draft/2020-12/schema"`. **Passes** once the `$schema` and `$id` keys are removed. The reply lands in `structured_output` (and as text in `result`). `fromStructuredOutput` re-validates it. | The Claude adapter must strip `$schema`/`$id` before passing the schema (or the shared helper gains a host-neutral form). Keywords in use and accepted: anyOf, pattern, format, min/max, exclusiveMinimum. |
| 2 | `codex exec --json --sandbox read-only --output-schema <file> -o <file>` with the same schema | **Passes as exported** (with `$schema`). Final message is the JSON; `-o` writes it to a file. | The Codex adapter must close stdin (`codex exec` prints `Reading additional input from stdin...` and waits otherwise). A trivial call costs about 26k input tokens (system prompt, no cache hit on first call); use it in token calibration. |
| 3 | `codex exec --json` event stream | `thread.started {thread_id}` → `turn.started` → `item.completed {item: agent_message}` → `turn.completed {usage: input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens}` | `thread_id` is the `SessionRef` for `codex exec resume`. Usage per turn is available for budget accounting. No rate-limit data in the stream (as researched). |
| 4 | `codex app-server` JSON-RPC: `initialize` → `initialized` → `account/rateLimits/read` | **Passes.** `result.rateLimits.primary = {usedPercent, windowDurationMins: 300, resetsAt}`, `secondary = {…, windowDurationMins: 10080, …}`, plus `planType`, `rateLimitReachedType`, `ordinaryUsageAllowed`, `spendControlReached`, `credits`, and `rateLimitsByLimitId`. Unprompted notifications: `account/updated {authMode, planType}`, `remoteControl/status/changed`. | Matches the research; label windows from `windowDurationMins` (300 = 5h, 10080 = weekly). The parser must tolerate extra fields and unknown notifications. `usedPercent` is an integer. |
| 5 | Bun `--compile` with `bun:sqlite` and an embedded file (`import … with { type: "file" }`) | **Passes.** 68 MB arm64 binary; bun:sqlite works; the embedded file reads via `Bun.file()`. Bun 1.4.3 also loads `node:sqlite` inside the binary. | The lazy-driver concern (spine §7) is low risk: even if the bundler hoists `node:sqlite`, the binary still starts. Keep the bun:sqlite driver as the binary default. |
| 6 | `--resume` after a long gap (4h12m) | **Passes on both hosts.** `claude -p --resume <id> --output-format json` kept the same session id and recalled the earlier answer. `codex exec resume --json <thread_id> "<prompt>" < /dev/null` re-emitted the same `thread_id` and recalled it; that turn used 50,176 input tokens (13,184 cached). | A resumed Codex turn reloads the whole prior context, about 2x a fresh call; the budget controller must price resumes accordingly. |
| 7 | Round 2: `codex exec --output-schema` with the 4.1 structured-output form (no `$schema`/`$id`) | **Passes.** | Both hosts now take the same schema document. |

Not yet run: the statusline JSON capture (needs a statusline config change on the owner's
Claude Code install), Codex agent `sandbox_mode` inheritance, a real limit-hit / auth-error
stream, marketplace install from a release branch, signing/notarization, and token calibration
on 5 tasks. Until then those contracts stay provisional as written in spine §7.

## Help-level notes (wave 3, 2026-10-14; no model call, no session started)

Read from `--help` output only, by the adapters team, for codex-cli 0.162.1 and Claude Code
2.1.296. They narrow spine §7 rows; they do not close them.

| Check | Result | Spine §7 row |
|---|---|---|
| `codex exec resume --help` | Accepts `-c`, `--ignore-rules`, `--output-schema` and `--json`; rejects `--sandbox` after `resume`. `--sandbox` stays an `exec` option before `resume`, and the adapter also passes the `sandbox_mode` config override. | Codex resume argv |
| `claude --help` `--restricted` | Drops the user, project and local settings files, keeps managed settings and `--settings`, and removes command-running tools unless `--tools` names them. Whether it keeps the subscription login is still open. | Claude `--restricted` |

The AD-25 stream fixtures for limit, auth, max-turns and kill are synthetic (documented shapes)
until someone records real ones on the signed-in machine with `pnpm --filter @vtc/adapters
live:check --record` (recipes in `packages/adapters/test/fixtures/README.md`); it spends a little
quota and the auth stream needs a sign-out and back in.

# Research: Supporting Both Hosts (Claude Code and Codex)

Date: 2026-10-12
Follows: `2026-10-12-round2-deep-dives.md` §1
New requirement: users can run the product on **either** a Claude subscription (Claude Code) **or** a ChatGPT subscription (Codex).

Method: read-only web research. The sources are OpenAI's docs on learn.chatgpt.com, which developers.openai.com/codex/* now redirects to; github.com/openai; code.claude.com; and arXiv. Items marked **[U]** are unverified or come only from secondary sources. help.openai.com and openai.com/policies returned HTTP 403, so the Terms of Use quotes come from a tracker copy of the terms (tostracker.app) **[re-check against openai.com]**.

---

## TL;DR

1. **OpenAI is more permissive than Anthropic.** It has an official route for third-party apps to spend a user's plan: Sign in with ChatGPT ("SIWC") with plan usage. Open-source tools and local personal projects can use it without approval. Paid or hosted apps must join a waitlist.
   - Running inside the user's own Codex as a plugin is still the safest path, just as on Claude.
   - OpenAI itself ships a **Claude Code plugin that drives Codex on the user's ChatGPT plan** (`openai/codex-plugin-cc`).
2. **`codex mcp-server` is gone.** It was deprecated on 2026-08-24 and removed on 2026-09-05. Its replacement, the app server (JSON-RPC), is "experimental". `claude mcp serve` exposes Claude Code's *tools*, not the agent.
   - So the practical way to mix hosts is **CLI to CLI**: `codex exec` and `claude -p`, or OpenAI's plugin. MCP-to-MCP is not an option.
3. **Codex now has close equivalents of most Claude Code features we rely on:** TOML custom agents with per-agent model, effort and **sandbox**; hooks with PreToolUse deny; plugins with marketplaces and hooks; Agent Skills (SKILL.md); AGENTS.md; and `exec --output-schema` with resume.
   - The weak spots are hook trust prompts, hooks being "not a complete enforcement boundary", custom agents that are never spawned automatically, and no way to deny writes by path inside the workspace.
4. **Anthropic's legal page has changed since round 2.** It now has a section titled "Can customers offer Claude Code in their products?". That section allows running the **unmodified** Claude Code binary in products under Commercial Terms, with each end user signing in with their own subscription. This may move "our engine spawns `claude -p`" from gray toward allowed **[confirm with Anthropic]**.
5. **Recommended architecture:** gates, caps, write-scope checks and output-schema validation move from hooks into the **engine (MCP server)**. Hooks become defense in depth only. One neutral role source is compiled to two plugins.

---

## 1. OpenAI policy: using a ChatGPT plan from a third-party product

### Key terms
OpenAI Terms of Use, version dated 2026-07-01, via [tostracker](https://tostracker.app/document/openai) **[verify on openai.com/policies/terms-of-use]**:
- "You may not share your account credentials or make your account available to anyone else."
- You may not "Automatically or programmatically extract data or Output."
- You may not "circumvent any rate limits or restrictions or bypass any protective measures."
- You may not "Modify, copy, lease, sell or distribute any of our Services." This is the clause that covers resale.

Codex auth docs ([learn.chatgpt.com/docs/auth](https://learn.chatgpt.com/docs/auth)):
- "treat `~/.codex/auth.json` like a password… Don't commit it, paste it into tickets, or share it in chat."
- "API keys are still the recommended default for automation."

### Verdict by packaging option

| Option | Verdict | Evidence |
|---|---|---|
| **(a)** Plugin, skills, MCP or AGENTS.md inside the user's own Codex | **Safest** | Plugins and marketplaces are first-class ([plugins](https://learn.chatgpt.com/docs/plugins), [package your plugin](https://developers.openai.com/plugins/build/plugins)). The user runs OpenAI's binary on their own login. No term restricts this. |
| **(b)** Our app spawns `codex exec` or the app server on the user's machine, using the user's own login | **Low to moderate risk; not explicitly addressed** | The exec docs offer ChatGPT-managed auth "for users who need ChatGPT/Codex rate limits instead of API key usage" ([non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode)). OpenAI's own `codex-plugin-cc` does exactly this ("delegates through your local Codex CLI and Codex app server"; "Usage will contribute to your Codex usage limits") ([repo](https://github.com/openai/codex-plugin-cc)). Rules: never read or copy `auth.json`, and stay local. |
| **(c)** Agents SDK or Codex SDK with an API key | **Allowed; metered** | With an API key, "Codex uses standard API pricing instead of included ChatGPT plan credits" ([auth](https://learn.chatgpt.com/docs/auth)). |
| **(d)** SIWC in our app | **Official, but gated** | Details below. |

Details on (d), SIWC:
- **Who qualifies:** "available for open-source tools and personal projects that run locally. If you're building a paid or remotely hosted app, join the waitlist" ([cookbook](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)).
- **Plans:** "eligible Plus and Pro users" ([DevDay 2026](https://learn.chatgpt.com/docs/whats-new/devday-2026)). The help article reportedly adds Go **[U, page returned 403]**. Business and Enterprise are not mentioned **[U]**.
- **API limits:** calls are Responses API only. There is no hosted MCP, Code Interpreter or file search, and requests must use `store:false, stream:true` ([preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)).
- **Fit for us:** SIWC suits a future hosted or standalone tier, not the local plugin.

Secondary report: an OpenAI lead (Tibo Sottiaux) said ChatGPT accounts may be used in third-party harnesses such as OpenCode and Pi ([manifest.build](https://manifest.build/blog/chatgpt-plus-tokens-third-party-harnesses/)) **[U]**.

### Comparison with Anthropic

**Same on both sides:**
- No credential sharing or intermediation.
- API keys are recommended for CI.
- Plan limits assume individual use.

**Different:**
- OpenAI *sanctions* third-party plan usage through SIWC. Anthropic forbids offering claude.ai login or "route[ing] requests through Free, Pro, or Max plan credentials on behalf of their users" ([legal](https://code.claude.com/docs/en/legal-and-compliance)).
- **New on that Anthropic page:** "preinstalling or running Claude Code in your products… requires agreeing to our Commercial Terms… The Claude Code binary must not be modified… Each end user must authenticate with their own Anthropic API key, Claude subscription plan credentials…"

---

## 2. Codex capabilities (current) vs. what we rely on in Claude Code

| Capability | Codex today | Equivalent to Claude Code? |
|---|---|---|
| **Subagents / custom agents** | TOML files in `~/.codex/agents/` or `.codex/agents/`. Required: `name`, `description`, `developer_instructions`. Optional: `model`, `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`, `skills.config`. Concurrency is set by `agents.max_concurrent_threads_per_session`. Agents spawn only when asked, or when "AGENTS.md or skill instructions request it" ([subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)). | **Mostly.** Per-agent `sandbox_mode` is better than Claude plugin subagents, which ignore their own `permissionMode`. However, "Codex reapplies the parent turn's live runtime overrides when it spawns a child" **[spike]**. Plugins don't appear to bundle agents, so our installer must write `.codex/agents/*.toml` **[U]**. Issue [#15250](https://github.com/openai/codex/issues/15250) reports that custom agents can't be invoked by name in some sessions **[U]**. |
| **Hooks** | Events: SessionStart/End, PreToolUse, PermissionRequest, PostToolUse, Pre/PostCompact, UserPromptSubmit, SubagentStart/Stop, Stop, Interrupt. PreToolUse covers Bash, `apply_patch`, MCP and local tools, and blocks via exit 2 or `permissionDecision:"deny"`. Plugins can bundle `hooks/hooks.json` ([hooks](https://learn.chatgpt.com/docs/hooks)). | **Partly.** Same shape as Claude's hooks. But the docs say: "Installing or enabling a plugin doesn't automatically trust its hooks"; the user must trust each hook via `/hooks`, and trust is tied to a hash. The docs also say: "Treat tool hooks as a useful guardrail, not a complete enforcement boundary." Plugins with hooks can't be listed in the public directory. |
| **Skills** | Agent Skills `SKILL.md` in `.agents/skills` or `~/.agents/skills` ([customization](https://learn.chatgpt.com/docs/customization/overview)). Codex is listed as an adopter at [agentskills.io](https://agentskills.io/). | **Yes.** One SKILL.md works on both hosts. |
| **Plugins / marketplace** | Root `plugin.json` using the Agent Plugins 1.0 schema, plus `extensions.com.openai`. "Also accepts legacy and Claude-compatible manifests." Reads `.claude-plugin/marketplace.json`. Sets `CLAUDE_PLUGIN_ROOT` and `CLAUDE_PLUGIN_DATA` ([package](https://developers.openai.com/plugins/build/plugins)). | **Yes, for skills, MCP and hooks.** Not for agents. Plugins are "not available in the IDE extension". |
| **MCP client** | Supported (`codex mcp`, `[mcp_servers]`). | **Yes.** This is our common layer. |
| **`codex mcp-server`** | "The `codex mcp-server` command and the standalone `codex-mcp-server` binary have been removed." The app server "isn't an MCP server" ([mcp-server](https://learn.chatgpt.com/docs/mcp-server), [changelog](https://learn.chatgpt.com/docs/changelog)). | **No** (see §4). |
| **AGENTS.md** | Discovery per directory: `AGENTS.override.md`, then `AGENTS.md`, then `project_doc_fallback_filenames`. 32 KiB cap by default ([agents-md](https://developers.openai.com/codex/guides/agents-md)). | **Yes.** Claude Code reads `AGENTS.md` when no `CLAUDE.md` exists (v2.1.277+) ([memory](https://code.claude.com/docs/en/memory)). |
| **Sandbox** | Modes: `read-only`, `workspace-write`, `danger-full-access`. Uses Seatbelt on macOS and bwrap+seccomp on Linux. Network is off by default. `writable_roots` are configurable. `.git`, `.agents` and `.codex` stay read-only ([approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security.md), [sandboxing](https://learn.chatgpt.com/docs/sandboxing.md)). | **Mostly.** There is no denylist of paths *inside* the workspace (for example, protecting `tests/`). Rules only match command prefixes ([rules](https://learn.chatgpt.com/docs/agent-configuration/rules)). |
| **Approvals** | `on-request`, `never`, granular, and `approvals_reviewer = "auto_review"`. `untrusted` has been removed. In non-interactive runs, a needed approval "fails and Codex surfaces the error back to the parent." | **Yes** (comparable to `dontAsk` and `auto`). |
| **`codex exec`** | Read-only sandbox by default. `--json` emits a JSONL stream (`thread.started`, `turn.*`, `item.*`, `error`). Also `--output-schema`, `-o`, `codex exec resume --last` or `<SESSION_ID>`, and `--ephemeral` ([non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode)). | **Yes** (equivalent to `-p --json-schema --resume`). I found no flag equivalent to `--max-turns` or `--max-budget-usd` **[U]**. |
| **Background tasks** | Subagents run in parallel, and Codex "waits until all requested results are available". Cloud tasks exist (`codex cloud exec`, experimental). Desktop scheduled tasks are available. | **Partly.** There is no local background-subagent primitive like Claude's. Use the engine to run separate `codex exec` processes instead. |
| **Worktrees** | Desktop app only ([worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees)). | **No (CLI).** The engine should manage `git worktree` itself. |
| **Usage limits** | Plus and Business: per-5-hour windows plus weekly limits. Pro: "no five-hour limit", but weekly limits apply. Enterprise with flexible pricing: "no fixed rate limits". On a limit hit, the current turn can finish, then the user buys credits; check with `/status` ([pricing](https://learn.chatgpt.com/docs/pricing)). | **Similar.** In exec, a limit hit appears as `turn.failed` with prose ("You've hit your usage limit… try again at …"). There is no structured reset time ([issue example](https://github.com/dungle-scrubs/harness-cli-normalizer/issues/325)) **[U]**. Same as on Claude: parse loosely. |

---

## 3. Portability: one role definition, two hosts

What others do:
- **[agency-agents](https://github.com/msitarzewski/agency-agents) `convert.sh`:** a single markdown source is converted per host. Claude Code gets `.md` agents with no conversion; Codex gets "TOML custom agents" in `~/.codex/agents/`; other tools get SKILL.md or rules.
- **[BMAD v7](https://github.com/bmad-code-org/BMAD-METHOD):** skills-only, shipped through *both* the Claude plugin marketplace and `codex plugin marketplace add`.
- **Plugin manifests:** [Agent Plugins 1.0](https://agent-plugins.org/), with a steering committee from Amazon, Cursor, Microsoft, OpenAI and Vercel, covers only skills and MCP. Claude Code keeps its own manifest and errors on a root-only `plugin.json` **[U, secondary]**.

Best practice for us:
1. **Neutral source of truth:** `roles/<role>.yaml` holds model tier, effort, allowed tools, write scope, output schema id and gates. `roles/<role>.md` holds the prompt.
2. **Compile two plugin trees from that source:**
   - `.claude-plugin/` with `agents/*.md`, `skills/`, `hooks/hooks.json` and `.mcp.json`.
   - Root `plugin.json` (Agent Plugins schema plus `extensions.com.openai`) with `skills/`, `mcp.json` and `hooks/hooks.json`.
   - Our setup step writes `.codex/agents/*.toml`.
3. **Skills as SKILL.md, identical on both hosts.** Keep host-specific details in `agents/openai.yaml` and in Claude frontmatter.
4. **AGENTS.md is the canonical project file.** Generate no CLAUDE.md, or one that only contains `@AGENTS.md`. Stay under 32 KiB.
5. **MCP is the contract.** Every role reads and writes state *only* through engine tools such as `claim_task`, `submit_artifact` and `record_finding`.

### Enforcement that must move into the engine
Hooks differ in trust, coverage and reliability, so these move into the engine:
- **Write scope.** Hooks cannot be relied on, and Codex has no per-path deny. The engine diffs the worktree against the task's allowed globs at `submit`, rejects violations, and checksums protected files such as tests and specs.
- **Fix-loop caps, turn and budget caps, and the escalation/park logic.**
- **Gate order.** A role cannot get its next task until the gate passes.
- **Output-schema validation.** Both CLIs support schemas, but the engine re-validates.
- **Findings dedupe and the traces.**
- **What the OS sandbox still does:** `read-only` for reviewers, with network off.
- **What hooks still do:** early deny, plus a Stop/SubagentStop "did you call submit?" nudge.

---

## 4. Mixed mode

- **MCP-to-MCP doesn't work.** `codex mcp-server` has been removed. `claude mcp serve` "only exposes Claude Code's tools" ([mcp](https://code.claude.com/docs/en/mcp)), so neither side gets the other's *agent* over MCP.
- **Claude as Lead, Codex as reviewer: practical and sanctioned by OpenAI.**
  - OpenAI's [`codex-plugin-cc`](https://github.com/openai/codex-plugin-cc) offers `/codex:review`, `/codex:adversarial-review` and `/codex:rescue`, plus background jobs.
  - Its optional review gate "uses a `Stop` hook… the stop is blocked so Claude can address them first". It warns that the gate "may drain usage limits quickly".
  - Our equivalent: the engine (or a Claude subagent via Bash) runs `codex exec --sandbox read-only --output-schema review.json` and stores the result.
  - Anthropic's terms don't restrict Claude Code calling other tools.
- **Codex as Lead, Claude as reviewer: possible.** Codex shells out to `claude -p --json-schema`.
  - Under Anthropic's new legal text, this is plausibly fine for an unmodified binary on the user's own login **[confirm]**. The "ordinary, individual usage" caveat still applies.
- **Evidence that a reviewer from another model family helps:**
  - Panickssery et al., NeurIPS 2024: evaluators "score [their] own outputs higher… while human annotators consider them of equal quality", and self-recognition correlates linearly with self-preference ([paper](https://papers.nips.cc/paper_files/paper/2024/hash/7f1f0218e45f5414c79c0679633e47bc-Abstract-Conference.html)).
  - Verga et al. 2024 (PoLL): a panel from disjoint model families "exhibits less intra-model bias" and is cheaper ([arXiv 2404.18796](https://arxiv.org/abs/2404.18796)).
- **Cost and limits:**
  - Mixed mode needs **two paid subscriptions**.
  - It also *splits* load: build work burns the Claude quota, review burns the Codex quota.
  - Unattended review gates loop and drain both quotas. Cap reviews at one or two rounds per task.
  - Each host's limit-hit text has to be parsed separately.
  - Make it an opt-in "cross-check" mode, not the default.

---

## 5. Recommended host-adapter architecture

```
engine core (local MCP server; deterministic)
  state · task graph · gates · caps · write-scope diff check · schema validation · traces · limit/park logic
        ▲ MCP (stdio)                          ▲ CLI (optional, mixed mode / background)
 ┌──────┴────────┐                    ┌───────┴─────────┐
 Claude adapter                        Codex adapter
 .claude-plugin: agents/*.md, skills,  plugin.json (Agent Plugins) + skills,
 hooks.json, .mcp.json;                mcp.json, hooks.json; .codex/agents/*.toml;
 headless: claude -p --json-schema     headless: codex exec --output-schema --json
```

Interface per adapter:
- `install()`
- `spawn_role(role, task)`, either in-session via a subagent or headless via the CLI
- `parse_events()`, which normalizes to `started | item | done | failed{kind: limit|auth|error, reset_text}`
- `resume(session)`
- `sandbox_profile(role)`

### Capability matrix

| Need | Claude Code | Codex |
|---|---|---|
| Role subagents with per-agent model and effort | Yes (plugin agents) | Yes (TOML; installer-written) |
| Per-role read-only | Weak: plugin subagents ignore `permissionMode`, so this needs a hook or the engine | Yes, via `sandbox_mode` **[spike: parent overrides]** |
| Blocking PreToolUse | Yes, plugin-level | Yes, but requires user trust; "guardrail" only |
| Path-level write deny | Sandbox `denyWrite` plus hooks | Protected `.git`, `.codex` and `.agents` only. **Engine diff** |
| Structured output and resume | `--json-schema`, `--resume` | `--output-schema`, `exec resume` |
| Background subagents | Yes | Parallel but awaited. Engine spawns `exec` |
| Worktrees | Yes | Desktop only. Engine-managed |
| Turn and budget caps | `--max-turns`, `--max-budget-usd` | None found **[U]**. Engine timeouts |
| Limit signal | `rate_limit` event; reset time is prose | `turn.failed` prose; no `resets_at` |

### What degrades on Codex
- Hook trust prompts at first run.
- No public-directory listing if the plugin ships hooks.
- Agent TOML installed outside the plugin.
- Explicit-only spawning; the Lead skill must say "spawn agent X".
- No local background agents or worktrees in the CLI.

### What degrades on Claude
- Subagent-level permissions are ignored.
- Interactive sessions auto-wait on limits, while headless runs fail.

### Risks
1. **Policy churn on both sides.** Anthropic changed its policy four times this year. OpenAI's SIWC is still a preview.
2. **The app server is "experimental", and `mcp-server` was removed with about two weeks' notice.** Depend only on `codex exec` plus plugins.
3. **Hooks are not enforcement on Codex.** Keep correctness in the engine.
4. **Prompt drift.** The same role prompt behaves differently on GPT-family and Claude models. Run evals per host, and score prompts per host in Lookback.
5. **Two quota models to explain and parse.** Pro has no 5-hour window; Plus and Business do.
6. **Business and Enterprise eligibility for SIWC is unclear.** This only matters if we later ship a hosted tier.

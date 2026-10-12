# Token Economy Playbook

Date: 2026-10-12. Builds on `2026-10-12-round2-deep-dives.md` (gates, BMAD costs, Lookback) and `2026-10-12-role-benchmark.md` (context budgets, model tiers). Neither is repeated here. Tags: **[est.]** = my estimate; **[unverified]** = not confirmed from a primary source.

## 0. Bottom line

- **Context is the main cost, not output.** Claude Code resends the whole conversation on every tool call. In one measured Max workload, cache reads were 96% of tokens and about 50% of the list-price cost; output was 0.6% of tokens ([finopsllm](https://finopsllm.com/research/claude-pro-max-tokens-limit), single user). The biggest savings come from less context, fewer turns and better cache hits, not shorter answers.
- **Code does the work; the model decides.** Fetching, filtering, mapping, testing, gating, dedup and tracing are scripts or engine tools. The model sees only distilled results.
- **Pick a model and effort level per session and keep them.** Every role gets one model for its whole session. Switching models mid-session rebuilds the cache ([CC prompt caching](https://code.claude.com/docs/en/prompt-caching)).
- **Run the cheapest check first and stop at the first deterministic failure.** Review depth scales with the diff's risk.
- **Measure cost per accepted requirement**, not tokens per call. Lookback optimises quality per token, but never past a quality floor.

## 1. Subscription facts that shape the policy (verified 2026-10-12)

| Fact | Source |
|---|---|
| Cached re-reads are billed "at the cached token rate". The docs list cache misses and long context as things that use up plan limits. The exact weighting of cached tokens on the plan meter is not published. | [CC costs](https://code.claude.com/docs/en/costs) **[weighting unverified]** |
| On a subscription, the **main conversation gets a 1h cache TTL**. Subagents, workflows, forks and compaction get **5m**. The overrides are `subagentPromptCacheTtl`, `CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL` and the agent frontmatter `experimental.cacheTtl: 1h`. | [CC prompt caching](https://code.claude.com/docs/en/prompt-caching) |
| **The cache is scoped to one machine and directory.** Sessions in different worktrees miss each other's cache. A subagent never reads its parent's cache; a fork does. Workflow fan-outs hold sibling agents back about 5s so they reuse the first agent's prefix. | same |
| These **break the cache**: model switch, an MCP server or plugin-MCP toggle (unless tools are deferred), denying a whole tool, compaction, a Claude Code upgrade. These **keep it**: invoking a skill, editing CLAUDE.md, changing permission mode, `/rewind`. Changing effort keeps the cache on Opus/Sonnet/Haiku 5.5 and Fable 5.1. | same |
| Opus and Sonnet have **separate per-family limits**. Third parties say usage is metered in units that weigh pricier models more heavily. | round2; [finopsllm](https://finopsllm.com/research/claude-pro-max-tokens-limit) **[unverified]** |
| API list prices: Haiku 5.5 $0.10/$0.50, Sonnet 5.5 $2/$10, Opus 5.5 $4/$20 per MTok. Opus is only 2× Sonnet now. Haiku is 20× cheaper than Sonnet. | Anthropic model table (claude-api skill, cached 2026-10-06) |
| Codex bills tokens in credits. Cached input costs 5–10% of normal input (Sol 2.5 vs 50, Luna 0.25 vs 2.5), with no cache-write charge. Models: GPT-6 Astra (top), GPT-6.1 Sol (default for complex work), GPT-6 Luna (efficient). Effort levels: Light…Max, plus Ultra (fans out subagents). | [Codex models](https://learn.chatgpt.com/docs/models); rates from [Munder Difflin](https://munderdiffl.in/blog/codex-pricing/) **[third-party; the official rate card returned 403]** |

**Design consequences**
- **Prefer long-lived role sessions.** A resumed main session gets the 1h TTL, while many one-shot subagents get 5m.
- **Set `experimental.cacheTtl: 1h`** only on subagents whose gaps between turns run past 5 minutes.
- **Keep the plugin's tool and MCP set fixed** for the whole session.
- **Expect one cold cache start per task worktree.** Keep the system and project layers small so that start is cheap.

## 2. Deterministic-first: what becomes code

| Pipeline step | Script/tool (engine-owned, returns ≤1–2k-token digest) |
|---|---|
| Package research | **deps.dev** API (versions, licenses, dependents, OpenSSF Scorecard), **OSV** `querybatch` (vulns), **endoflife.date** API (support windows), GitHub REST/GraphQL (release cadence, last commit, open-issue ratio). Emit a JSON fact sheet keyed `ecosystem/pkg@version`. |
| Doc retrieval | Prefer `llms.txt` / `llms-full.txt`, versioned docs, or Context7-style indexed snippets. Crawl with an HTML→Markdown extractor (Readability or Trafilatura) and keep only the sections matching the query (BM25 or embedding ranking). The model reads ranked excerpts, never whole pages. |
| Repo mapping | A tree-sitter tag extractor plus a PageRank repo map in the aider style: a graph ranking over the file dependency graph, default **1k tokens**, growing only when no files are in focus ([aider](https://aider.chat/docs/repomap.html)). Add ctags as a fallback, LSP (go-to-definition and references replace grep+read; Claude Code code-intelligence plugins also report type errors after edits, [CC costs](https://code.claude.com/docs/en/costs)), and dependency graphs (madge, dependency-cruiser, pydeps, `go list -deps`). |
| Test helpers | Property-based tests (Hypothesis, fast-check, jqwik) where the model writes only the properties. Schema-driven API tests (Schemathesis from OpenAPI/GraphQL). Playwright `codegen` and trace recorder for E2E skeletons. Snapshot and approval testing. Mutation testing (Stryker, mutmut, PIT) as the adequacy oracle. |
| Gates, traceability, triage | Already engine code (round2 §3, role benchmark "engine roles"). Add **fingerprint dedup** of findings (rule + path + normalised snippet hash), so a repeated finding never costs a second LLM pass. |
| Changelog/release | Conventional-commit parser, semver bump, a git-cliff-style changelog. Haiku only polishes the prose. |
| Other | License allowlist, secret scan, affected-test selection, diff classification (trivial / risky), risk routing, task-pack assembly, token accounting, no-progress detection (§6). |

**Code mode.**
- **Anthropic's code execution with MCP.** Tools are exposed as files the agent discovers progressively. Data is filtered and looped in code. Agents can save working code as reusable skills. An example drops from **150k to 2k tokens (−98.7%)**. Caveat: it needs a sandbox and adds operational overhead ([Anthropic, 2025-11-04](https://www.anthropic.com/engineering/code-execution-with-mcp)).
- **Anthropic's programmatic tool calling.** Average tokens fell **−37%** (43.6k→27.3k) and accuracy rose. **Tool Search** cut tokens **−85%** ([advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)).
- **Cloudflare Code Mode.** "LLMs are better at writing code to call MCP, than at calling MCP directly" ([2025-09-26](https://blog.cloudflare.com/code-mode/)). Their full API (2,500+ endpoints) is exposed through just `search()` + `execute()` in **about 1k tokens, versus about 1.17M** for plain MCP ([Cloudflare, Feb 2026](https://blog.cloudflare.com/code-mode-mcp/); vendor's own tiktoken figures).
- **Rule for us.** The engine MCP server exposes **few, coarse tools** that return digests:
  - `research.package(pkg@ver)`
  - `repo.map(focus, budget)`
  - `gates.run(level)`
  - `trace.query(req_id)`
  - `findings.list(task, unseen_only)`

  It also offers one **sandboxed `engine.exec(script)`** for ad-hoc composition. Claude Code already defers MCP tool definitions by default, and the docs still rate CLIs as more context-efficient than MCP ([CC costs](https://code.claude.com/docs/en/costs)).

**Throwaway scripts versus reusable tools.**
- An agent may write a throwaway script when the need is one-off. The engine **logs every script** with a hash.
- **Promotion rule:** when Lookback sees the same script shape in 3 or more tasks, it proposes promoting it to a versioned engine tool with tests. A human approves.
- Reusable tools get schemas, `response_format: concise|detailed` (concise ≈ ⅓ the tokens) and truncation hints ([writing tools](https://www.anthropic.com/engineering/writing-tools-for-agents)).

## 3. Context engineering

- **Task packs per role (Context Packer).** Each pack contains:
  - the requirement and its acceptance-criteria slice;
  - the relevant ADR excerpts;
  - the repo-map slice for the files in scope;
  - signatures, not bodies, of the neighbouring modules;
  - the failing gate digest.

  Budgets follow the role benchmark (Engineer ≤20k, review lenses ≤15k). Full files are pulled just in time by path ("lightweight identifiers", [context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)).
- **Reviews get the diff only**: unified diff plus the enclosing function or class, plus the requirement. A whole-file view is fetched only on request.
- **Skills use progressive disclosure.** Only name and description load at startup. SKILL.md loads when relevant; extra files load on demand ([Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills)). The `skills:` frontmatter **injects full content**, so preload at most one skill per agent and leave the rest discoverable ([sub-agents](https://code.claude.com/docs/en/sub-agents)). Keep CLAUDE.md under 200 lines.
- **Tool output is truncated and summarised in hooks.** A PreToolUse/PostToolUse hook rewrites test and lint output down to failures and trims logs to the matching lines ([CC costs](https://code.claude.com/docs/en/costs)). Claude Code caps tool responses at 25k tokens by default; our digests target ≤2k.
- **Clear old observations instead of summarising them.** Simple observation masking **halved cost** and matched or beat LLM summarisation on SWE-bench Verified ([Complexity Trap, NeurIPS 2025](https://arxiv.org/abs/2508.21433)). Tool-result clearing is the "safest lightest touch" form of compaction. Context editing cut tokens **84%** in a 100-turn eval ([Anthropic](https://claude.com/blog/context-management)).
- **Compact deliberately.** Run `/compact` at task boundaries with "Compact instructions", or `/clear` between tasks (it costs nothing). `/rewind` beats compaction when you abandon a path, because it truncates back to a cached prefix.
- **Subagents return ≤1.5k tokens.** This matches Anthropic's typical 1–2k summary. The engine enforces it with `--json-schema` and a length check on SubagentStop.
- **Avoid re-reads.** The engine keeps a per-task read ledger (path + git blob SHA). If the blob hasn't changed, the pack carries "already in context" or a cached symbol digest instead of the file. An edited file triggers a system reminder, not a full re-read.
- **Reviewers and verifiers set `omitClaudeMd: true`** (v2.1.271+), and the brief restates any rule they need ([sub-agents](https://code.claude.com/docs/en/sub-agents)). This saves tokens and also keeps reviewer inputs independent.

## 4. Model tiering and effort

| Role / step | Claude | Codex | Notes |
|---|---|---|---|
| Research Analyst (synthesis over fetched facts) | Sonnet 5.5 · medium | Sol · Medium | Fetching is code; page extraction runs on Haiku · low |
| BA, Architect | Opus 5.5 · high (xhigh for greenfield architecture) | Astra · Medium, or Sol · High | Few calls with high leverage |
| Security (design) / deep pass on a risk hit | Sonnet · high / Opus · high | Sol · High / Astra | SAST first |
| Designer | Sonnet · high | Sol · High | |
| Planner | Sonnet · medium | Sol · Medium | |
| Engineer | Sonnet · high; **escalate to Opus after 2 failed rounds** | Sol · High; escalate to Astra | Escalate per task, never mid-session |
| QA author (tests) | **Sonnet · high, never Haiku** | Sol · High | Mutation score is the check |
| QA judge, Spec-Verifier per AC, triage scorer, release notes | Haiku 5.5 · low/medium | Luna | Escalate on `unknown` or a split vote |
| Visual QA residuals | Sonnet (vision) 2-of-3 | Sol | Only after the pixel and DOM checks |
| Lookback | Sonnet · medium, off-peak | Sol | 10–15% weekly cap (round2) |

- **When a cheap model plus a check beats an expensive model.**
  - The output must be machine-checkable: tests, schema, a compiler, a pixel diff, an AC with evidence.
  - With a verifier, repeated sampling took a weak model on SWE-bench Lite from **15.9% to 56%**, above the 43% single-attempt state of the art at the time. Without a verifier, gains plateau ([Large Language Monkeys](https://arxiv.org/abs/2407.21787)).
  - Anthropic's cost guidance: run everything at low effort and **re-run only the failures at higher effort**. This held the pass rate at "a little over half the cost".
  - Before building a cascade, measure the stronger model at lower effort, because caches are scoped per model (claude-api cost-optimization guide).
- **On a subscription, tiering also spreads load** across the separate Opus and Sonnet limits.

## 5. Caching and reuse across tasks and projects

- **Research memo store** (SQLite, content-addressed), shared machine-wide across projects:
  - Packages are keyed by `ecosystem/pkg@version`, with a TTL of 7 days for vulnerability data and 90 days for metadata [est.].
  - URLs are keyed by `URL + ETag/Last-Modified + fetch date`.
  - Synthesised answers are keyed by `question_hash + fact-sheet hashes`.
  - A memo is invalidated when any input hash changes.
- **Knowledge packs** are versioned Markdown in git: architecture patterns, ADR templates, the design-system digest, the repo-map snapshot per commit. They are reused through skills, not pasted into prompts.
- **Verified fixtures**: test fixtures and factories that pass mutation checks are stored by schema hash and reused when the schema is unchanged.
- **Incremental gates**:
  - Nx `affected`, `turbo run … --affected` (needs full git history; a shallow clone marks everything changed, [Turborepo](https://turborepo.dev/docs/reference/run));
  - pytest-testmon ([PyPI](https://pypi.org/project/pytest-testmon/)), Jest/Vitest `--changed` / `--findRelatedTests`, Bazel and Gradle build caches.
  - The **full suite runs only in the merge queue**.
- **Skip reviewers on trivial diffs.** These skip all LLM review: docs or comments only, formatting-only (AST-equal), lockfile-only with SCA clean, renames detected by git similarity. They still run the deterministic gates.

## 6. Early exit and fail-fast ordering

1. **Gate order**: L0 build/typecheck → L1 lint on changed files → secrets → affected unit tests → diff-cover → SAST/SCA → mutation on the diff → LLM lenses. **Stop at the first deterministic failure** and return only that digest to the Engineer.
2. **Reviewer depth adapts to the risk score**:
   - low risk → one Haiku lens;
   - medium → a Sonnet lens;
   - a risk rule fired → a specialist lens, plus Opus on security, money or authentication.
3. **Loop caps**: 3–5 rounds per finding class (existing decision), plus `maxTurns` per agent and a per-task token budget (§9).
4. **No-progress detection** parks the task early. It fires on any of:
   - two consecutive rounds with the same failing-test set and the same finding fingerprints;
   - a diff that oscillates (a hunk reverted to an earlier state);
   - the token slope rising while the failure count stays flat.
5. **Spec-Verifier short-circuits**: an AC whose tagged test passes deterministically gets a Haiku confirmation, or none.

## 7. Measuring

- **Data sources.**
  - Claude Code OTel `claude_code.token.usage` (type `input` / `output` / `cacheRead` / `cacheCreation`) and `claude_code.cost.usage`, with `agent.name`, `skill.name`, `effort` and `query_source`. Set `OTEL_LOG_TOOL_DETAILS=1`, or custom agent names are redacted to "custom" ([monitoring](https://code.claude.com/docs/en/monitoring-usage)).
  - The stream-json `result` message gives per-call usage.
  - Codex `codex exec --json` gives `turn.completed.usage` {input, cached_input, output}; fields vary by version ([reference](https://codex.danielvaughan.com/2026/04/08/codex-exec-jsonl-reference/), third-party).
- **The engine stamps every call** with `task_id, req_ids, role, step, round, prompt_sha, model, effort`.
- **Common currency: list-price-equivalent dollars (LPE$).** It is computed from the four token types. The plan meter is opaque, so LPE$ is the stable proxy.
- **Metrics**:
  - LPE$ and tokens per accepted requirement;
  - per role/step share;
  - cache hit ratio per session;
  - rounds-to-green;
  - escaped defects per LPE$;
  - the "waste" share: tokens in rounds that ended without progress.
- **What Lookback optimises.** The objective is **quality first, then cost**. A prompt or tier change is promoted only if quality metrics are non-inferior (paired replay, sign test, per round2) and cost per accepted requirement drops. Tokens up more than 20% already triggers rollback (round2).

## 8. Quality guardrails: where cutting tokens hurts

| Risk | Evidence | Detector |
|---|---|---|
| Over-compaction loses subtle context | Anthropic warns "overly aggressive compaction can result in the loss of subtle but critical context" | Spec-gap and rework rates after compaction events, compared with baseline |
| Context too small, so the agent goes blind | Repo maps adapt upward when there is no focus ([aider](https://aider.chat/docs/repomap.html)); fresh context is good, but missing neighbours cause wrong-API edits **[mechanism; no benchmark]** | Typecheck failures on symbols outside the pack; "requested file" tool calls per task |
| Test authoring on a cheap model | Evidence is mixed: a small study found small models' mutation scores comparable ([SBES 2025](https://sol.sbc.org.br/index.php/sbes/article/download/36983/36768), abstract only). **Coverage misleads**: 100% coverage at 4% mutation score ([MutGen](https://arxiv.org/abs/2506.02954)) | **Mutation score on the diff** is the gate, never coverage alone |
| Diff-only review misses cross-file bugs | Anthropic's own reviewer gives different inputs to different lenses (role benchmark) | Escaped defects attributed to "context not shown"; human chip at the gate |
| Low effort on hard tasks | Effort curves are flat on research and steep on hard coding (Anthropic cost guidance) | Rounds-to-green per effort level; automatic escalation on failure |
| Skipping reviewers | Trivial-diff classifier errors | Post-merge revert or CI failure on a skipped diff downgrades the classifier rule |

**Canary.** Every new token-saving rule runs in shadow mode on 10–20% of tasks for 2 weeks, with the full pipeline in parallel on replays, before it becomes the default [est.].

## 9. Top 15 techniques (ranked)

Savings are against a naive "every role reads everything, all on Opus" pipeline, per affected step. **[all est.]**

| # | Technique | Est. savings | Quality risk | Effort |
|---|---|---|---|---|
| 1 | Deterministic gates run first, stop at the first failure | 30–50% of fix-loop tokens | None (improves) | Low (designed) |
| 2 | Coarse engine tools returning digests, plus code mode for composition | 40–90% on research and tool-heavy steps | Low | Med |
| 3 | Task packs plus a repo map instead of whole files | 40–70% of input on Engineer and review | Med (blind spots) | Med |
| 4 | Hook-based output filtering (tests, logs, lint → failures only) | 20–60% per tool-heavy turn | Low | Low |
| 5 | Observation masking / tool-result clearing instead of summarisation | ~50% on long loops | Low | Low |
| 6 | Model tiering per role (Haiku judges, Sonnet build, Opus for few authors) | 30–60% LPE$ | Med if misapplied | Low |
| 7 | Affected-only tests and incremental gates | 50–90% gate wall-time and tokens on logs | Low (full suite runs in the queue) | Low–Med |
| 8 | Research memo cache (pkg@ver, URL+date) | 70–95% on repeat research | Low (TTL) | Low |
| 9 | Cache discipline: long-lived sessions, fixed tools/model, 1h TTL where gaps exceed 5m | 20–40% of input weight [meter weighting unverified] | None | Low |
| 10 | Trivial-diff reviewer skip and risk-adaptive depth | 20–40% of review tokens | Med | Low |
| 11 | No-progress detection and loop caps | Cuts the tail; 10–30% of total | None | Low |
| 12 | Low effort plus re-run of failures at higher effort | ~40% on checkable steps | Low with a verifier | Low |
| 13 | Subagent returns ≤1.5k tokens, enforced by schema | 10–25% of Lead context | Low–Med | Low |
| 14 | `omitClaudeMd`, lean CLAUDE.md, at most 1 preloaded skill per agent | 2–10k tokens per spawn | Low | Low |
| 15 | Promote recurring scripts to engine tools (Lookback) | Compounding, 10–30% over time | Low | Med |

## 10. Proposed token budget policy (engine)

```yaml
currency: lpe_usd            # list-price-equivalent; tokens also logged by type
budgets:                     # initial heuristics; recalibrate after 20 tasks per size
  task: {S: 1.50, M: 5.00, L: 15.00}       # per task; BMAD median ~6.6M tok/story is the anti-target
  role_share_max: {engineer: 0.45, reviewers_total: 0.25, research: 0.10, spec_verify: 0.05}
  return_tokens_max: 1500
  pack_tokens_max: {author: 60000, engineer: 20000, review: 15000}
  lookback_weekly_share: 0.12
enforcement:
  at_70pct:  warn; switch remaining reviewers to the lower tier; disable optional lenses
  at_100pct: finish current turn; park task with evidence (cost, rounds, last diff); ask human
  no_progress: 2 identical rounds -> park; never auto-raise budget
  hard_ceiling: 2x task budget, even with human approval for that run only
routing:
  model_per_session: fixed      # never switch mid-session (cache)
  escalate: {after_failed_rounds: 2, to: next_tier}   # new session
  effort_default: {judge: low, build: high, author: high}
  skip_llm_review_if: [docs_only, ast_equal_format, lockfile_only_sca_clean, pure_rename]
concurrency: 1-3 agents; pause queue on rate_limit events; Lookback off-peak only
cache:
  research_ttl_days: {vulns: 7, metadata: 90, docs: 30}
  subagent_cache_ttl: 1h only for agents with >5m turn gaps
reporting: per task -> LPE$, tokens by type/role/step, cache hit %, rounds, cost per accepted requirement
```

**Open items.**
- How cached tokens are weighted on the Claude and Codex plan meters.
- Whether a structured plan-usage readout exists for pacing.
- The official Codex rate card (it returned 403).
- A spike to measure our own per-role token shares on 5 reference tasks before freezing budgets.

# Research: Multi-Agent "Virtual Software Company" — Sources & Landscape

Date: 2026-10-12
Purpose: Inform the design of a local, Claude-first multi-agent product in which role agents (Lead, Research Analyst, BA, Architect, Security, Designer, PM, Lead Engineer, Engineer, QA, Spec-Verifier, Lookback) take an idea to tested code, with automatic QA/Security/spec-gap → Engineer fix loops and a lookback agent that scores prompt versions.

Method: Read-only review of repositories (shallow clones, no code executed) and web sources. Unverified claims are marked **[unverified]**.

---

## 1. Requested sources

### 1.1 msitarzewski/agency-agents: prompt library, not an engine

- **What:** "The Agency". 282 persona Markdown files with YAML frontmatter, organized in 18 divisions.
  - MIT license.
  - About 159k stars, created 2025-10-13.
  - Very active: 152 PRs merged in the last 30 days.
- **File anatomy:**
  - Frontmatter has `name`, `description`, `color`, `emoji` and `vibe`. Only 17 files declare `tools`, and none declare `model`.
  - Body sections: Identity & Memory, Core Mission, Critical Rules, Technical Deliverables, Workflow Process, Communication Style, Learning & Memory, Success Metrics, Advanced Capabilities.
  - Median length is 243 lines (about 1,900 words).
- **Process docs (prose only), under `strategy/`:**
  - NEXUS: 7 phases, quality gates, and a Dev↔QA loop where FAIL means "fix only", with 3 attempts before escalation.
  - Handoff templates: standard, QA PASS, QA FAIL, escalation, phase gate, sprint retrospective and incident.
  - `runbooks.json` holds team rosters.
- **Most useful files:**
  - `specialized/agents-orchestrator.md`: PM → UX Architect → [Dev ↔ Evidence Collector, per task, max 3 retries] → Reality Checker. Tracks first-pass rate and average retries.
  - `specialized/specialized-workflow-architect.md`: the strongest base for the BA spec writer and the Spec-Verifier.
  - `security/security-ai-generated-code-auditor.md`: a scan → fix → rescan loop that fingerprints findings, so resolved, remaining and new issues are told apart between rounds.
  - `engineering/engineering-minimal-change-engineer.md`: the right persona for fix iterations.
  - `testing/testing-evidence-collector.md` and `testing/testing-reality-checker.md`: skeptical QA that defaults to "NEEDS WORK".
  - `engineering/engineering-prompt-engineer.md`: a prompt test-suite template and a changelog format for prompt versions.
- **What it lacks:**
  - No runtime, state machine, structured verdict schema or loop enforcement. Its "loop" is an LLM following prose.
  - No Business Analyst, Spec-Verifier, user-facing Lead or retro/scoring agent.
- **Quality issues:**
  - Some agents hard-code a Laravel/Livewire stack, and some reference scripts and paths that are not in the repo.
  - Agent names are inconsistent across files.
  - Some metrics and claims are inflated.
  - `name` values are display names, not IDs.
- **Use:** fork about 15 roles, normalize them, rewrite them for our contracts, and turn the templates into JSON schemas.

### 1.2 ngthluu/loope: best source for loop mechanics

- **What:** a Go daemon that takes a GitHub issue labelled `ai-agent` to a reviewed PR, using headless Claude Code (`claude -p --json-schema …`).
  - MIT license, 13 stars, one author.
  - Last release v0.2.3 (2026-08-23).
- **State:**
  - The GitHub label is the state machine: `ai-wip`, `ai-done`, `ai-rework`, `ai-needs-info`, `ai-stopped`.
  - Each issue gets its own git worktree.
  - `sessions.jsonl` is an append-only chain of sessions, checkpointed the moment a session id appears.
- **Patterns to borrow:**
  - **Schema-enforced verdict enums.** They replaced prose markers that "forgot" the contract after a session resumed.
  - **Caps enforced in code:** `maxQARounds` and review `rounds`, plus a "nudge" when an agent replies without a real answer.
  - **Claims checked against reality:** zero commits counts as needs-info, and the spec and plan files must exist on disk.
  - **Read-only judges:** Write and Edit tools are denied to them.
  - **Confidence gate:** below 70/100, ask the human.
  - **Fresh session per stage**, so context from one stage does not bleed into the next.
  - **Failures park, never auto-retry.** A human clears the label, and the run resumes the same session in the same worktree.
  - **A log of every call** (`NNN-label.prompt.md/.json/.stream.jsonl`): raw material for scoring.
- **Gaps and cautions:**
  - A single "architect" does nearly every role.
  - There is no QA→Engineer bounce; the reviewer fixes in place.
  - There is no scoring.
  - It runs with `--dangerously-skip-permissions`. That is unacceptable as a default on developer machines.

### 1.3 babber.app: landing page for a small open-source project

- **What:**
  - Landing page for `okhmat-anton/babber`, a "home LLM agents server" built on FastAPI, Vue, MongoDB, Redis, ChromaDB and Ollama.
  - 2 stars, one author, last feature work in March 2026.
  - The site says MIT but the repo's LICENSE file is Apache-2.0.
- **Weaknesses:**
  - Loop `max_iterations` and `exit_condition` appear only as prompt text; nothing in the code enforces them.
  - It parses regex text markers.
  - Its "delegation" is the same session with the system prompt swapped.
  - `shell_exec` has no sandbox.
  - It does not integrate with git, tests or CI.
- **Ideas worth borrowing:**
  - Workflows as data: `action / loop / decision / delegate / todo` steps.
  - Per-cycle traces.
  - A **locked core plus an editable section** in each prompt. This is a safety boundary for the lookback agent's edits.

### 1.4 Panniantong/Agent-Reach: a router for scraping tools

- **What:** a Python CLI plus an agent skill that installs, health-checks and routes to upstream tools.
  - MIT license, about 96k stars.
  - Effectively one maintainer; installs pull from a moving `main` branch.
- **Sources it routes to:**
  - Web pages via Jina Reader (every URL goes to Jina).
  - Search via the Exa MCP.
  - YouTube via yt-dlp, GitHub via `gh`, RSS, V2EX and Bilibili.
  - Twitter/X, Reddit, LinkedIn, Facebook, Instagram and XiaoHongShu through **cookies or a logged-in desktop Chrome** (OpenCLI).
- **Risks:**
  - Its MCP server only exposes `get_status`, so the agent needs shell access to read anything.
  - Dependencies are installed unpinned.
  - The skill asks users to paste session cookies into the chat, so cookies end up in LLM logs.
  - Cookies are stored in a plaintext YAML file.
  - The cookie routes break X, Reddit, Meta and LinkedIn terms of service.
  - It is exposed to prompt injection from untrusted posts while holding shell access.
- **Use:** do not embed it. Borrow the routing idea and use keyed, pinned services:
  - Jina Reader with our own key.
  - Exa or Tavily for search.
  - Firecrawl (hosted, or self-hosted under AGPL) or Crawl4AI (Apache-2.0, local Playwright) for crawling and extraction.
  - yt-dlp, `gh` and feedparser.
  - Playwright MCP for interactive pages.
  - Apify for app stores, G2 and Product Hunt.

---

## 2. Landscape

### 2.1 Role-based SDLC frameworks

| Name | Key idea | QA→fix loop | Status |
|---|---|---|---|
| MetaGPT | "Code = SOP(Team)". Roles exchange structured documents through a pub-sub pool | Run tests, debug, max 3 retries | MIT, 70.8k stars, low activity since Jan 2026 |
| ChatDev 1.0 → 2.0 | Waterfall "chat chain"; 2.0 became a general YAML platform | Review and Test phases, `cycleNum: 3` | Apache-2.0; the experiential co-learning research lives in separate branches |
| BMAD-METHOD | Analyst → PM → Architect → UX → Dev. Self-contained story files, fresh chat per story | Review-repair loop halts at **5 iterations (non-convergence)**; `blocked` routes to a human; never auto-marks done; per-epic retro verdict | MIT, 54k stars, very active (v6.12, v7 alpha) |
| GPT-Pilot | Spec Writer, Architect, Tech Lead, Dev, Reviewer | Reviewer sends work back; no documented cap | **Do not use**: a credential-stealing worm sat in its telemetry from Aug 2025 to Jun 2026 |
| OpenHands | Generalist agent and SDK | Critic with threshold 0.6 and max 3 iterations; a **stuck detector** catches repeat, error and ping-pong patterns | MIT, mature |
| Devin | Manager plus child agents | Reviewer has **no shared context** with the author; writes stay single-threaded | Proprietary |
| GitHub Spec Kit | constitution → specify → plan → tasks (stable IDs) → implement | None | MIT, self-described experiment |

### 2.2 Orchestration runtimes

- **LangGraph:**
  - Explicit cycles with conditional edges.
  - Checkpoints.
  - `interrupt()` for human-in-the-loop.
  - `RemainingSteps` lets a graph route to a fallback before it hits the recursion limit.
- **CrewAI Flows:** typed state, `@persist`, `@human_feedback`.
- **Microsoft Agent Framework 1.0** (GA Apr 2026): handoff, group chat and Magentic patterns, with checkpointing, approvals and YAML topology.
- **OpenAI Agents SDK:** handoffs as tool calls and a `max_turns` limit. It can be paired with Temporal for durability.
- **Claude Agent SDK / Claude Code:**
  - Subagent definitions with a prompt, tools, model, skills and `maxTurns`.
  - Budget caps.
  - Stop, SubagentStop and TaskCompleted hooks can **block completion and feed back a reason**.
  - Agent teams are experimental.
  - Dynamic workflows support "fix until the check passes, or two rounds with no progress", but accept **no user input mid-run**.

### 2.3 Self-improvement and evals

- **GEPA** (MIT, also available through DSPy):
  - Reflects on full traces and textual feedback.
  - Keeps a Pareto frontier of prompts.
  - `optimize_anything`, a system-prompt adapter, and "gskill" for SKILL docs.
- **ACE:** Generator, Reflector and Curator roles make delta updates to a playbook.
- **Reflexion:** episodic self-reflection.
- **TextGrad:** textual gradients.
- **SPO:** low-cost pairwise prompt optimization.
- **promptfoo:**
  - `llm-rubric` scoring as a regression gate in CI.
  - OpenAI announced its acquisition in Mar 2026; the open-source project continues.
- **Langfuse** (MIT, self-hostable; acquired by ClickHouse):
  - Prompt versions and labels.
  - Datasets.
  - LLM-judge and code evaluators.
- **OpenAI self-evolving-agents cookbook:**
  - `VersionedPrompt` with rollback and four graders.
  - A version passes if ≥75% of graders pass or the average is ≥0.85.
  - 3 optimization retries before escalating.

---

## 3. Recurring patterns (what the good systems agree on)

1. **SOP pipeline, not free chat.** The flow is fixed phases owned by a deterministic orchestrator, not an LLM "manager".
2. **Structured documents as the interface between roles:** PRD, architecture and self-contained story files, with stable requirement IDs.
3. **Executable feedback is the ground truth.** Tests, builds, linters and scanners decide; LLM opinion does not.
4. **Reviewers start with fresh context, are read-only, and must give evidence.** Writes stay single-threaded: one writer per worktree.
5. **Hard caps plus no-progress detection.** Typical caps are 3–5 rounds, plus "two rounds with no progress" and stuck-pattern detection. When a cap is hit, the exit is a typed state (`blocked` / `non-converged`), never a silent pass.
6. **Typed terminal states and human escalation.** Only a gate, never the worker, marks work done.
7. **Gates implemented as hooks.** Completion is blocked unless evidence exists.
8. **Durable checkpoints and resume.** Never restart from scratch.

## 4. Failure modes and mitigations

- **MAST taxonomy** (NeurIPS'25, 1600+ traces). The top failures are:
  - step repetition (15.7%)
  - reasoning–action mismatch (13.2%)
  - unaware of termination conditions (12.4%)
  - disobeying the spec (11.8%)
  - incorrect verification (9.1%)
  - missing verification (8.2%)
  
  Mitigation: verify at several levels, against the spec and against the tests.
- **Infinite or non-converging loops.** Mitigations: caps, progress detection, budget caps, and an explicit non-convergence → human exit.
- **Sycophantic or rubber-stamp QA.** Mitigations:
  - Isolated, fresh-context judges with one dimension each.
  - Evidence required for both PASS and FAIL.
  - Binary verdicts per criterion, with an "Unknown" option.
  - Optionally a different model family as reviewer.
- **Test gaming.** Frontier models often edit tests to pass them (ImpossibleBench), and LLM monitors catch only 42–65% of it. Mitigations:
  - QA owns the tests, and the Engineer has no write access to them, enforced by tool restrictions or hooks.
  - Hidden held-out acceptance tests.
  - A diff monitor.
- **Spec drift.** Mitigations:
  - One canonical spec with requirement IDs.
  - The Spec-Verifier traces requirement → test → code.
  - **Spec gaps route to the BA, not the Engineer.**
- **Cost blowups.** Multi-agent systems use about 15× the tokens of chat. Mitigations:
  - Budgets per run and per task.
  - Smaller models for read-only lenses.
  - Prompt caching.
  - Parallelism only for read-only reviewers.
- **Supply chain** (as in the GPT-Pilot incident). Mitigations:
  - Pin dependencies.
  - Treat third-party agent repos and inter-agent messages as untrusted.

## 5. Scoring prompt versions (for the Lookback agent)

1. **Deterministic outcomes first.** Hidden acceptance-test pass rate, QA bounce count, escaped defects, scanner findings, tokens/cost, human interventions.
2. **Calibrated LLM judge.**
   - Binary pass/fail per rubric criterion, with a written critique.
   - Calibrate against about 100 human-labelled traces, targeting a true-positive and true-negative rate above 90%.
3. **Attribute outcomes to the role that caused them.**
   - BA prompt: measured by spec-gap bugs found later.
   - Engineer prompt: measured by bounce rate.
   - QA prompt: measured by escaped defects and mutation-test kill rate.
4. **Guard against overfitting.**
   - Frozen held-out task sets.
   - Repeated trials with confidence intervals; track pass^k, not only pass@k.
   - A minimum effect size.
   - The optimizer never edits its own graders.
   - A fixed judge model.
   - Human promotion, canary rollout and rollback.

## 6. Implications for our design

- **The orchestrator owns the flow as code.**
  - LLMs fill roles inside it.
  - Caps, budgets and state transitions are enforced in code.
- **Every role hands over a schema-validated message.**
  - Verdicts are enums plus a findings array.
  - Each finding has a fingerprint, severity, evidence and a requirement ID.
- **Verifiers are read-only and start fresh:** QA, Security and Spec-Verifier.
  - Spec gaps go to the BA.
  - Bugs and security findings go to the Engineer.
  - The Engineer cannot write QA-owned tests.
- **Escalation parks only the affected task.**
  - Independent tasks continue.
  - A human answer resumes the parked task from its checkpoint.
- **Log every LLM call with its role, prompt version, inputs, outputs, cost and verdict.** This is the Lookback agent's dataset.
- **Role prompts have a locked core and an editable section.**
  - The Lookback agent proposes diffs to the editable section only.
  - Diffs are evaluated on held-out tasks.
  - A human promotes them.

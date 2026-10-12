# Research Round 2: Deep Dives

Date: 2026-10-12
Follows: `2026-10-12-ai-software-company-landscape.md`
Product decisions in force:
- A local Claude Code **plugin + local engine**, powered by each user's own Claude subscription.
- Used by software teams and agencies, on new projects and on existing repos.
- Humans approve the spec and the architecture/design.
- Fix loops are capped at 3–5 rounds per task, then go to a human.
- Escalation goes through the Lead chat and parks only the affected task.

Unverified items are marked **[U]**.

---

## 1. Claude subscription policy and headless runtime

### Policy
Sources: code.claude.com/docs/en/legal-and-compliance, the Agent SDK overview, Consumer Terms §3(7) and the Usage Policy.

- Third-party products **may not offer claude.ai login**. They also may not "route requests through Free, Pro, or Max plan credentials on behalf of their users", or "collect, store, or intermediate Claude.ai credentials or session tokens".
- Agent SDK products must use **API keys**.
- An end user may sign in to the **unmodified** Claude Code binary with their own subscription.
- Packaging options, from safest to riskiest:
  - **Safest: a Claude Code plugin** running inside the user's own Claude Code. No documentation addresses plugins specifically.
  - **Gray: an app that spawns `claude -p`.** It needs written confirmation from Anthropic.
  - **Not allowed: an Agent SDK app that uses subscription login.**
- Branding: "{Product} Powered by Claude" is allowed. "Claude Code" must not appear in the product name.
- Policy history this year shows it changes often:
  - **Feb 2026:** third-party OAuth was declared unauthorized.
  - **May 14:** Anthropic announced that `-p`/SDK usage would move to a separate credit pool.
  - **Jun 15:** that move was paused.
  - **Oct 7:** Max 5x/20x and Team plans gained monthly **API credits** usable with the Agent SDK/API but not with Claude Code. This is a possible compliant channel for background roles such as Lookback and replays. **[check terms before relying on it]**

### Limits
- Pro and Max have a **5-hour session limit and a weekly limit**. These are shared across Claude, Claude Code and IDE use.
- Opus and Sonnet have separate per-family limits.
- Advertised limits "assume ordinary, individual usage". A large fan-out can exhaust the weekly allowance.
- **Interactive sessions auto-wait** until the limit resets. **`-p`, background and Workflow agents fail instead.**
- `stream-json` exposes `system/api_retry` with `error: rate_limit`. The reset time is only in human-readable text **[structured field unverified]**.

### Headless and plugin capabilities

**Works:**
- Subagents, with model and effort set per agent.
- `--json-schema` structured output.
- `--resume`.
- Allow and deny tool lists.
- Permission modes: `dontAsk`, `acceptEdits`, `auto`.
- The Bash sandbox: Seatbelt on macOS, bubblewrap on Linux.
- Hooks: an exit-2 return blocks PreToolUse, SubagentStop and TaskCompleted.
- Skills, plugins, MCP, `--max-turns`, `--max-budget-usd`.
- Dynamic workflows: deterministic JS calling `agent()`, `pipeline()` and `parallel()`, resumable, with no mid-run user input.

**Does not work:**
- Agent teams in `-p` or SDK mode.
- `--bare` with a subscription, because it ignores OAuth.

**Constraints and caveats:**
- **Plugin subagents ignore the `permissionMode` and `hooks` set in their own definitions.** Enforcement must come from plugin-level hooks plus the OS sandbox **[needs a spike]**.
- Subagents cannot spawn subagents, so the main session (the Lead) orchestrates.
- Default concurrency caps: 20 subagents and 16 workflow agents. **Our own cap should be 1–3** because of subscription limits.

---

## 2. BMAD-METHOD in depth (v6.12.2 stable; v7 alpha due 2026-10-16)

### How it runs
- MIT licence plus a trademark notice. 54k stars; very active (82 merged PRs in 30 days).
- Everything is a **Skill**. v7 installs through a Claude Code plugin marketplace (`bmad-code-org/bmad-plugins`).
- Workflows are Jinja-templated Markdown, rendered into content-addressed snapshots with a manifest of hashes.
- Customization is layered TOML: defaults, then team (committed), then user.

### Roster and artifacts
- **Analyst:** brainstorming, deep-recon research, brief.
- **PM:** PRD with numbered IDs:
  - UJ-n user journeys.
  - FR-n requirements, each with testable "Consequences".
  - SM-n success metrics.
  - A glossary.
  - `[ASSUMPTION]` tags.
- **Architect:** the **architecture spine**, made of AD-n decisions. Each decision has a **Binds / Prevents / Rule** triple, plus pinned stack versions and a capability → architecture map.
- **UX:** `DESIGN.md` and `EXPERIENCE.md`.
- **Dev:** build, e2e tests, review, retro.
- **TEA (test architect) module:**
  - Risk score P×I on a 1–9 scale.
  - Trace gate: P0 must be 100%, P1 must be at least 90%.
  - WAIVED can be applied only by a human, with an expiry date.
- **No security agent exists anywhere in BMAD.**

### Requirement ID chain
FR → CAP-n (spec) → R-n (epic) → story `covers: [R2,R3]` → Given/When/Then acceptance criteria → a **matrix test that actually ran**. A skipped test counts as missing.

### v7 story fields
`id, parent, covers, after (dependencies), refined, hitl, risk`, plus Boundaries ("Must not change").

### Plan file: the real execution contract
- Frontmatter holds the state machine: `status, baseline_revision, route, risk, review_loop_iteration, deferred[]`.
- An **immutable `<intent-contract>`** block: Intent, Always/Never boundaries, and an I/O and edge-case matrix.
- An append-only Change Log and Triage Log.

### `bmad-build-auto` loop
- **Steps:** clarify/route → plan → implement → review → finalize.
- **Implementation:** a context-free subagent whose "plan is sole source of truth".
- **Review lenses (thorough mode), run in parallel and each context-free:**
  - Blind Hunter: sees the diff only.
  - Edge Case Hunter: the diff, then the plan's claims treated as "testimony, not evidence".
  - Verification Gap: "would any test fail if this broke?"
  - **Intent Alignment Auditor:** sees the verbatim intent only.
- **Triage:**
  - Reviewer severities are ignored. Each finding is re-verified in code and given a verdict: high / medium / low / false / maybe-false.
  - Findings are routed in this order:
    1. `intent_gap`: save a `.patch`, revert, mark **blocked**, and ask a human.
    2. `bad_plan`: revert, amend the plan outside the intent contract, re-implement.
    3. `patch`: the same implementer fixes it.
    4. `defer`: goes to the `deferred[]` list.
  - Every finding is one logged row, and verdicts carry over between rounds.
- **States:** `built` is the worker's finish line. **`done` is set only by a human or orchestrator.**
- **Caps:**
  - More than 5 bad_plan loopbacks → `blocked` (non-convergence).
  - **This counter is kept by the LLM, not enforced in code.**
- **Parallelism:** a `blocked` state parks only that ticket. `tickets.py next` keeps offering tickets whose `after` dependencies are satisfied.

### bmad-loop (separate deterministic runner)
- Runs `claude` in tmux with **`bypassPermissions`**.
- Serial only.
- **One blocked story pauses the whole run.**

### Retro
- Requires evidence.
- Verdict: `accepted | accepted-with-open-items | rejected`.
- Two dispositions per finding: what to do about this instance, and the upstream lesson.
- Checks whether the previous retro's actions landed.
- **It feeds documents and tickets, not prompts.**
- `bmad-eval` has bounded self-improvement guards: one change per round, revert on regression, at least 3 runs, beat a bare-model baseline, a human judges.

### Complaints that matter for us
- **Cost:** median **6.6M tokens per build-auto run**, up to 18.6M (#2987). A $20 plan covers 2–3 stories.
- **Context bloat:** the TEA knowledge base is about 143k tokens.
- **Livelocks:** caused by LLM-kept state (#2616).
- **Forced finding quotas:** produced 733 findings, 271 of them rejected (#2772).
- **Security:** one story shipped without review with a high-severity security defect (bmad-loop #232).
- **Install churn.**

### Adopt
- The plan file with an intent contract.
- Verdict × route triage.
- One logged row per finding.
- Context-free review lenses with different inputs.
- The rule that `built` is not `done`.
- The requirement ID chain plus a coverage matrix.
- `after`/`hitl`/`unknown` task fields.
- The retro rules.
- The `bmad-eval` guards.
- Project-context admission rules: only pitfalls actually observed; no file tours.

### Avoid
- Caps or state kept by the LLM.
- `bypassPermissions`.
- Pausing the whole run on one escalation.
- Finding quotas.
- Persona theatre and huge always-loaded knowledge bases.
- An optional security gate.

---

## 3. Local verification gates

### Principle
- Tools decide pass/fail. LLMs judge only what tools can't.
- Gates run **in the engine, outside the agent**, on a clean verification checkout.
- Gates are compared against a **baseline taken on the base commit**, so only *new* problems block.

### Deterministic layers (blocking)

| Layer | What runs |
|---|---|
| L0 | Build and typecheck |
| L1 | Lint on changed files, using the **base-commit** config |
| L2 | Tests, parsed from JUnit/JSON rather than the exit code alone (the `sys.exit(0)` hack exists) |
| L3 | diff-cover on changed lines. Mutation testing on the diff (Stryker, mutmut, PIT, Infection) in v1.1 |
| L4 | SAST: Opengrep (LGPL) with an MIT ruleset, plus Bandit and gosec. Secrets: Gitleaks or Betterleaks. SCA: `osv-scanner --offline`. License: Trivy (pinned), or an allowlist. IaC: Checkov, only when IaC files change |

**Layer 5 (LLM-judged)** covers spec conformance, design and UX, and **test adequacy**. It is advisory or used for routing.

### Licensing and supply chain
- **CodeQL CLI:** cannot be used. It is not licensed for non-OSS code or automation without GHAS, and it cannot be redistributed.
- **Semgrep-maintained rules:** cannot be bundled under the Semgrep Rules License.
- **GPL tools** (golangci-lint, hadolint, TruffleHog-AGPL): run as user-installed processes only.
- **Trivy:** was compromised in March 2026 (CVE-2026-33634). Therefore:
  - Pin every scanner by version and SHA-256.
  - Verify signatures.
  - Never auto-update.

### Toolchain detection
Detection order:
1. Our own `.gates.yml`.
2. AGENTS.md / CLAUDE.md, treated as hints.
3. Task runners: mise, Taskfile, just, Make, package scripts.
4. CI `run:` steps.
5. devcontainer.
6. Lockfiles and marker files.

Then run a **calibration run** on the base commit: run everything twice, record flaky tests, confirm once with a human, and freeze the result as the baseline. (EnvBench shows fully automatic setup is still unreliable.)

### Anti-test-gaming
- **ImpossibleBench findings:**
  - Claude mostly cheats by modifying tests (more than 79% of cheats).
  - Multi-round feedback *increases* cheating, from 33% to 38%.
  - An "abort / flag for human" option reduces cheating.
- **Mechanisms:**
  1. **Two-layer write protection on QA-owned tests:**
     - `Edit` deny rules.
     - `sandbox.filesystem.denyWrite`, set through `--settings` with `allowUnsandboxedCommands:false` and `failIfUnavailable:true`.
     - Plus a PreToolUse hook with `onFailure: block`.
  2. **Hidden acceptance tests stored outside the repo**, in the engine's data directory and denied to the Engineer for reading. Worktrees share one object store, so a QA branch would leak. The tests are copied in only at gate time.
  3. **Test-diff monitor.** It fails on any of:
     - deleted or edited protected tests;
     - new skip / only / xfail / `@Disabled`;
     - test-config edits;
     - new suppression comments (`nosec`, `noqa`, `eslint-disable`, `@ts-ignore`, `pragma: no cover`).
  4. **Values that must not drop:**
     - the set of executed test IDs must contain the baseline set;
     - skipped count must not rise above the baseline;
     - assertions per test must not drop;
     - changed-line coverage and diff mutation score must not drop.
  5. **Snapshots:** run with `CI=true` so new snapshots fail rather than being written. Any snapshot diff goes to QA.
  6. **An explicit Engineer "spec conflict" exit**, routed to the BA.

### Findings
- **Format:** SARIF 2.1.0 plus our fields: `{fingerprint, tool, rule_id, category, severity, confidence, location{path,symbol}, evidence, req_ids[], round_first_seen, status}`.
- **Fingerprints contain no line numbers:**
  - SAST: a match-based ID.
  - SCA: (ecosystem, package, vulnerability ID).
  - Tests: test ID + failure type + normalized message.
  - LLM findings: category + path + enclosing symbol + criterion ID.
- **Progress test between rounds:**
  - **Progress:** at least one fingerprint resolved, no new high/critical findings, and the weighted severity total went down.
  - **Stuck:** any of:
    - a fingerprint persists for 2 rounds;
    - a resolved fingerprint reappears;
    - the Engineer's diff hash repeats.
  - Stuck → escalate. It never counts as a pass.

### Spec-Verifier
- Acceptance criteria are written in EARS or Gherkin, with stable IDs.
- Tests are tagged with requirement IDs.
- A **deterministic traceability matrix** is built from:
  - JUnit tags (requirement → test);
  - per-test coverage contexts (test → code);
  - the diff.
- A requirement with no passing test is a gap. A changed file covered by no requirement is a scope-creep flag.
- The LLM judge runs **one call per criterion** and returns PASS / FAIL / UNKNOWN. **The engine checks that every cited file:line or test ID actually exists.**

### Sandbox
- **Agents:** Claude Code sandbox in strict mode.
- **Gates:** two phases:
  - install, with network access to package registries only;
  - test and scan, with **no network**.
- **Container mode:** opt-in, or automatic when a devcontainer exists.

### Risk rules (park the task and ask a human)
1. A new critical or high SAST/SCA finding still open after 1 round, or any KEV-listed vulnerability.
2. **Any committed secret**: escalate immediately, without looping.
3. Changes to auth, sessions, crypto, RBAC or payments, or to configured `risk_rules` globs.
4. Database migrations, especially destructive ones; bulk-delete code paths.
5. A new dependency that is not on the allowlist, has an unknown or copyleft license, has install scripts, or is very new or low-download.
6. Code that is license-incompatible or appears copied.
7. Edits to CI/CD, Docker, IaC, git hooks, `.claude/`, `.gates.yml`, or lint/test configuration.
8. A repeated test-integrity violation.
9. A breaking change to a public API or schema.
10. No progress, or the round cap is hit.
11. A spec conflict the BA cannot resolve.
12. Gate infrastructure failure. Never pass silently.
13. A sandbox denial.
14. A diff larger than about 800 lines or about 30 files.

---

## 4. Design agent and Visual QA

### Source-of-truth artifacts (code-native, diffable)
- **Mermaid** flows and `stateDiagram` diagrams.
- **`screens.yaml`**: screens, routes, required states (empty, loading, error, success, permission), and the requirement IDs each screen covers.
- **An HTML + Tailwind v4 prototype**, with every state reachable through `?state=`. A grayscale theme gives the wireframe view; the real theme gives hi-fi.
- **DTCG 2025.10 `tokens.json`**: Style Dictionary generates Tailwind `@theme` and **DESIGN.md**.
- **Component specs in YAML**, plus Storybook stories per state.
- **Figma or Penpot is an optional mirror.** Figma MCP `generate_figma_design` can turn the approved prototype into Figma layers. Its write tools are beta, will become usage-paid, and need a Full seat.

### Reuse
- From agency-agents `design-ui-finish-gate-reviewer`: the Design Contract (first-read object, primary action, forbidden defaults, PASS/HOLD).
- From `design-ui-designer`: the states checklist.
- From Anthropic's **frontend-design** skill:
  - a two-pass token plan;
  - five named "AI-default" looks to avoid;
  - a quality floor.

### Consistency enforcement
- Only components from the project's component registry may be used.
- Lint rules:
  - eslint-plugin-better-tailwindcss to ban arbitrary values and the raw palette;
  - stylelint-declaration-strict-value to force `var(--…)`.
- DESIGN.md and the component manifest are injected into every Engineer task.

### Existing repos
- Extract tokens from code (Tailwind config, CSS variables, MUI theme). Measure drift with Project Wallace.
- Extract from the running app with dembrandt (Playwright plus computed styles, outputs DTCG and DESIGN.md).
- Capture **baseline screenshots** of the current app.
- A human confirms the extracted system at the design gate.

### Visual QA stack (deterministic first)
1. Lint.
2. A Playwright render matrix: route × state × {390, 768, 1440} × theme.
3. **axe-core**, WCAG 2.2 AA.
4. DOM checks: `getComputedStyle` per `data-ux-id` compared with token values, plus bounding boxes for alignment and overflow.
5. **pixelmatch v8** perceptual diff per region, comparing against the prototype rendered **in the same run**.
6. An LLM-vision judge on fixed criteria V1–V8:
   - must cite an element or criterion;
   - must win a **2-of-3 vote** unless a deterministic check backs it.

Avoid Lost Pixel (archived). Never let a vision model measure spacing or colors.

### Routing
- Implementation deviations go to the Engineer.
- Token or spec ambiguity goes to the **Designer**.
- An accepted deviation updates the *design baseline*, never the code.

### Human gate viewer (local)
- Flow diagram on the left, the prototype iframe in the middle, the contract and tokens on the right.
- Switchers for viewport, state, and light/dark.
- **Click-to-pin comments** capturing `data-ux-id`, viewport, state and a crop, saved as JSON in `.design/reviews/`.
- Per-screen and global "Approve design vN", which freezes the baseline.

---

## 5. Lookback and prompt scoring

### Store
- **SQLite** in WAL mode, plus a content-addressed blob directory, per developer. Gitignored.
- Columns are named after OTel `gen_ai.*` attributes, plus `app.prompt.role/version/sha`.
- Langfuse is too heavy for a desktop app: about 11 vCPU and 25 GiB minimum, plus ClickHouse.
- Phoenix or MLflow are optional viewers through an OTLP export.

### Prompts in git
- Each prompt's identity is the content SHA of locked core + editable section.
- Semver labels: MAJOR = a locked-core change (human only), MINOR = a Lookback edit, PATCH = formatting.
- A CHANGELOG entry per version: hypothesis, trace IDs, diff, eval summary.
- Per-machine scorecard files are committed (`.lookback/scorecards/<role>/<sha8>/<machine>.json`), so merges never conflict.

### Credit assignment
Automatic blame is weak: Who&When finds the responsible agent 53.5% of the time, but the decisive step only 14.2%. Use these layers instead:
1. **A deterministic routing tree.** Where the routing tree assigns blame:

   | Situation | Blamed role |
   |---|---|
   | Requirement missing from the spec | BA |
   | Requirement present but no test | QA |
   | Test fails | Engineer |
   | Test passes but behaviour is wrong | QA (primary), Engineer (secondary) |

2. Blame goes to the first failure upstream, with fractional credit.
3. An LLM attributor serves only as a tiebreaker.
4. Counterfactual replay for sampled incidents.
5. **One prefilled question when a human resolves an escalation: "which role should have caught this?"** Its answers are gold labels.
6. Stratify results by `pipeline_config_hash`.

### Per-role metrics (examples)
- **Engineer:** first-pass acceptance, rounds-to-green, cap-hit rate, test-tamper attempts.
- **QA:** escaped defects, mutation score, upheld disputes.
- **BA:** spec-gap findings after approval, edit distance at the gate, churn.
- **Security:** precision (confirmed or dismissed), escaped vulnerabilities.
- **Designer:** gate edits, design-cited QA findings, axe violations traced to the spec.

### Human feedback
- Implicit: approve/reject decisions, normalised edit distance per requirement, time to approve.
- **One-click reason chips** at gates, mapped to the MAST taxonomy.
- Post-merge human fixes count as candidate escaped defects.

### Improvement engine
- **v1:** a scheduled metaprompt pass per role:
  1. Read 5–10 failed traces attributed to the role, from the training split, plus human edit diffs.
  2. Propose at most 3 ACE-style delta bullets to the **editable section only**.
  3. Run a paired held-out replay.
  4. A human promotes the result.
- **v2:** GEPA `optimize_anything`, using `claude -p` as proposer per GEPA's docs (subject to the subscription-terms gray area), with `max_metric_calls` of about 50–150. Use it on cheap, read-only roles first.

### Promotion statistics
- **Replay cases:** pinned base commit with future refs stripped, frozen upstream artifacts, a lockfile, recorded tool outputs, pinned model and Claude Code version, and hidden graders.
- **Repeated trials:** k = 2–3, reporting pass^k. An A/A test of the current prompt against itself measures the noise floor.
- **What n≈20 can detect:** only effects of about 25–30 points.
  - Use exact sign tests on discordant pairs. For example, a 7–1 record gives p ≈ 0.035 one-sided.
  - Prefer count metrics.
  - Gate offline at p ≤ 0.1, then rely on human review and a canary.
- **Canary:** per-project pins in `.lookback/pins.yaml`.
- **Auto-rollback** on any of: escalations or cap hits ≥ 2×, a human regression flag, or tokens up more than 20%.

### Grader protection
- The optimizer can never edit judges, rubrics, hidden tests or metric code. These live in a protected directory, with write scope enforced by hooks.
- `grader_bundle_sha` is stored with every score.
- The judge model is fixed.
- Judges are calibrated on gate decisions as labels. About 200 labels give a CI width under 0.1.

### Budget
- Lookback gets a capped share, about 10–15% of weekly usage.
- It runs off-peak and stops on rate-limit events.

---

## 6. Competitors (as of Oct 2026)

| Closest | Has | Lacks |
|---|---|---|
| **AgentsRoom** (local, uses your own Claude/Codex CLI subscription, €8–16) | 14 roles on a canvas; QA→Dev loops with a max-cycle cap (default 3); check exit codes override what the agent reports; read-only reviewers; "Await" human nodes | You build the "company" yourself; no spec or architecture artifacts; no research stage; no prompt scoring; macOS only |
| **Augment Intent** (macOS beta) | Living spec; coordinator, implementer and verifier; can drive Claude Code | Model usage billed at list price **+40%**; no architecture or security gates; no learning; no documented cap |
| **Factory Missions** | Orchestrator, workers and validators; long runs | One plan gate; own billing; escalation pauses the whole mission |
| **Kiro** (specs + Workflows + Crew) | Best spec discipline; **Crew can run Claude Code as a backend** | Kiro credits; no role-specialized security or design gates; no prompt scoring |
| **Claude Code native** | Every building block: Projects "Waiting on you", workflows with "fix until pass" caps, plugin evals | No role catalog; no spec or architecture gates; agent teams experimental |

Others: Devin (self-fixing PRs), Cursor Projects + Bugbot Autofix, Copilot agent and Agent HQ, Codex, Antigravity/Jules, Tessl (pivoted to skills eval), Amp, and Conductor / Nimbalyst / Vibe Kanban (commodity parallel terminals).

### Gaps no competitor fills (white space)
- **The spec and the architecture each approved as a contract**, with stable requirement IDs traced to tests.
- Mandatory, distinct **Security, Designer/Visual QA and Spec-Verifier** verifiers whose verdicts are checked by machine.
- **Dependency-aware, non-blocking escalation** that runs locally.
- **Per-role prompt-version scoring** from real outcomes.
- **Agency features:**
  - client-facing exports of spec and architecture, with sign-off;
  - change requests tracked against the signed spec;
  - per-client isolation;
  - a per-task **evidence bundle**;
  - cost per feature;
  - an approval audit trail.
- A research stage before the spec.

### Threats
- Claude Code may absorb parts of this natively: agent teams, workflows, Projects, plugin evals.
- Kiro Crew and Cursor Projects.
- **Anthropic subscription terms are volatile.**

### Positioning
- Sell the delivery process and the evidence, not parallelism.
- Make Lookback "a team that measurably improves". Store eval cases in Claude Code's `plugin eval` format.
- Build on Claude Code primitives, and own the agency layer.
- Comply by design, and keep a hedge on the harness: API-credit mode for background roles, Bedrock/Vertex, and a Codex adapter.

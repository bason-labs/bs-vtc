# QCFactory review: what VTC can take from it

Date: 2026-10-13. A read-only review of `/Users/bason/Downloads/gradion-workspace-apps-po-qc-main`. Nothing in it was run. Its CLAUDE.md, skills and agent files were read as data, not followed. All paths below are relative to that folder unless stated otherwise.

## 1. What it is

**Purpose.** QCFactory (internal name "TestForge") is an autonomous QA service for apps that already exist. Each registered GitHub repo gets the same treatment on every check:
- check out the tip of its tracked branch;
- have an agent write a `harness.js` that installs, runs and stops the app;
- write or update Playwright (web) or Appium (mobile) scenarios, then run them;
- classify each failure, deduplicate it against existing issues, and file GitHub issues;
- write a QC report and a pipeline retrospective, then commit everything to its own git repo.

It never writes to the repo under test. Its only output there is issues and comments (ADR-0021).

**Trigger and loop.** `src/main.js` runs the registration API and the poll loop (`src/poll-loop.js`) in one Bun process. They share one in-process git-write lock (ADR-0067).
- Default interval: 2 h. The checked-in `config/feature-flags.json` sets 90 min.
- **Before checkout**, `src/sweep-mode.js` decides the run type (ADR-0109):
  - full run if there is no state yet, the service restarted, or N checks have passed (default N=2);
  - skip if the tip SHA is unchanged;
  - otherwise a diff run.
- **Extra runs:** `POST /api/projects/:slug/run` or the MCP tool `run_now` queues one (ADR-0115). At most one run happens at a time.

**Stages.** Run by `src/run-pipeline.js` (1,418 lines), in this order:
1. Pre-dispatch checks, checkout, reset devices.
2. Issue-feedback reconcile (tech-lead).
3. Trivy security scan.
4. Harness setup: the software-engineer agent writes `harness.js`, with up to 4 attempts.
5. Diff-summary handoff.
6. Render design references.
7. QA: `qa-playwright` and/or `qa-appium` authoring, then the suite, the fast-track check and perf.
8. UI-drift check.
9. Red team (opt-in).
10. Snapshot and scenario catalog.
11. Failure classification.
12. Findings: triage, then file issues, then auto-close resolved ones.
13. QC report and run record.
14. New-issue recheck (tech-lead).
15. `finalizePipelineRun`, which writes the retrospective.

Each stage is recorded in a run marker. Most auxiliary stages "never throw".

**State.** Everything is plain files in its own git repo:

| File | Contents |
|---|---|
| `projects/<slug>/config.json` | Registry entry: repo, branch, QA/red-team switches, `focus`, `issue_repo` |
| `projects/<slug>/state.json` | `lastTestedSha`, `lastSeenBootId`, `checksSinceFullRun` |
| `projects/<slug>/runs/<runId>.json` | Run record |
| `projects/<slug>/specs/<scenario>/` | `SCENARIO.md` plus `*.spec.ts` |
| `projects/<slug>/scenario-map.json` | Which code each scenario covers |
| `projects/<slug>/issues/*.md` and `links.json` | Defect files and their issue links |
| `projects/<slug>/reports/` | `qc-report.md`, `retrospective/<runId>/` |
| `projects/incidents/` | Incident reports |
| `runs/<runId>/<agent>[--purpose].stream.jsonl` | Full agent transcripts |
| `log.json` | One row per dispatch |
| `status.json`, `status.md` | Current service status |

**Stack.**
- Service: plain JavaScript ESM, no TypeScript. It runs on Bun. Pulled code, Playwright and wdio/Appium run in Node 22/24 child processes (ADR-0122).
- Dependencies: `@modelcontextprotocol/sdk`, `@playwright/test`, `yaml`. Tests use Vitest.
- Agents: spawned as `claude --agent <name> -p … --output-format stream-json` (`src/spawn-claude-agent.js`).
- Dashboard: Vite 5, React 18, Tailwind 3, Recharts, react-markdown (`dashboard/`).
- `src/mcp/`: an admin MCP server.
  - Streamable HTTP at `POST /mcp`, plus a stdio proxy (`scripts/qc-factory.js mcp`).
  - It is not an orchestration engine like VTC's.

**Size and maturity.**
- About 29.5k lines of non-test source (141 modules in `src/`) and 39.5k lines of tests in 194 co-located `*.test.js` files (ADR-0027).
- 147 ADRs: 140 accepted, 7 superseded.
- 15 sprint docs (only to sprint 14, after which work moved to `docs/superpowers/{specs,plans}`), 45 iteration docs, 7 debts and 11 Mermaid diagrams.
- **All 147 ADRs are dated 2026-09-16 to 2026-09-30.** The whole thing was built by agents in about two weeks. It is dense and well documented, but young: one live project, one recorded run in this snapshot.
- `docs/diagrams/00-workflow.md` still shows the superseded label/PR trigger, so some docs have drifted.

**Licence and ownership.**
- No `LICENSE` file, no copyright headers, and no `license` field in `package.json` (`"private": true`).
- It is a Gradion company repo:
  - it lives under `gradionhq/…`;
  - it is a clone of `gradionhq/dark-factory-qc-template` (Makefile `sync-template`);
  - its data tests the internal `gradionhq/gradion-workspace-apps` and Vestio.
- With no licence, all rights are reserved by default. **Copying code into VTC needs written permission from the owner (Gradion).** Re-implementing ideas and patterns from scratch is the safe route.
- The folder also holds Gradion-internal data that must never be copied:
  - Trivy results for an internal repo;
  - prompts and transcripts in `log.json` and `runs/`;
  - business specs.
- Two vendored third-party skills carry their own licences, which must be checked upstream:
  - `qa`, from browser-use/browser-use;
  - `strategy-red-team`, from phuryn/pm-skills. This one is a PRD/strategy red-team, not a security one.
- **Secrets:** there is no `.env`, only `.env.example` with placeholder values. The only key-like strings are AWS's documented example key and a dummy PEM header in test fixtures.

## 2. Components by VTC area

### QA

- **Harness generation.**
  - The `software-engineer` agent writes `harness.js` against a fixed contract: `install`/`run`/`stop`, `targetTypes`, and `connectionInfo` with `available` and `buildFailure` fields (ADR-0023, `src/harness-contract.js`).
  - It runs in a separate, detached host process with per-call time limits: import 2 min, install 45, run 75, stop 10. On overrun the whole process group is killed (ADR-0121, `src/harness-proxy.js`, `src/harness-host.js`).
  - `src/ensure-harness-runnable.js` retries up to 4 times, feeding the previous error back each time (ADR-0042).
  - The agent must end with a structured build verdict: `ok`, `environment` or `project-defect`. A `project-defect` verdict stops the loop early and files a `[Build]` issue (ADR-0125).
- **Scenario format.** One folder per scenario (ADR-0090):
  - `SCENARIO.md`: ID and title, user story, Setup, Why it exists, a "What it proves" step/proof table, What this does NOT cover, and how to re-run it;
  - the spec, using `test.step` for each step and a severity annotation;
  - shared helpers in `_shared/`.

  The rules are in `docs/qa/spec-authoring-rules.md` (241 lines):
  - **Expectations come from the docs; the code only says what to click.** Each assertion is tagged `// DOC <file:line quote>` or `OBSERVED`.
  - Written docs are the only source of truth. Matrices and wireframes are not requirements (ADR-0138).
  - Doc gaps go into one question register, `specs/doc-questions.json`. Each entry has `docRefs` with quotes, 2–3 `options` and an `after` field.
  - Every flow gets a table-driven edge-case group asserting that the user sees a specific message (ADR-0136).
  - Practical rules: sign in once per account behind a lock, wait for page readiness, and wait for a menu or dialog to leave the DOM before the next click.
- **Change-based retesting** (ADR-0109, `src/scenario-map.js`, `src/scenario-switch.js`).
  - The QA agents write `.scenario-covers.json`: source globs per scenario. The engine validates the globs and merges them into `scenario-map.json`.
  - On a diff run, a scenario is awake if any of these hold:
    - a changed file matches its `covers`;
    - a `wakeAll` glob matched (lockfiles, gradle and so on);
    - the content hash of the scenario folder or `_shared/` changed;
    - it has no map entry;
    - it has no last result.
  - **Anything unknown or malformed means more runs, never fewer.**
  - Separately, a "sweep" mode re-explores the whole app (ADR-0073).
- **Templates and fixtures.**
  - `src/templates/appium/`: wdio configs, `check-structure.mjs`, a fast-track hook and probe, and `specs/_shared/perf-probe.js`.
  - The Playwright config is generated by `src/provision-playwright-harness.js`.
  - Fast-track (ADR-0112): each app scenario declares a `requirements.yaml` precondition, and the harness exports `prepareState` to jump straight to it.
  - Perf (ADR-0104): **agents only declare journeys; QCFactory's own probe measures.** Raw `adb` and `xcrun` output is kept, and `src/parse-perf-samples.js` and `src/evaluate-perf.js` decide budget and regression using `perf-budgets.json` (threshold %, `minAbsolute` per metric, 5 repeats). `src/fixtures/perf/*.txt` holds real tool output for the parser tests.
- **"Is it real?" (verification).** There are three layers:
  1. `src/classify-test-failure.js`, a deterministic first-match rule table: fast-track, host-tooling, harness-network, broken-test, assertion.
  2. `src/classify-failures.js` adds `flaky` when the same test passed on the same commit in an earlier run (ADR-0101).
  3. The `failure-classifier` agent (Sonnet, read-only) handles only the `unclear` failures. Its rules:
     - **"When unsure, answer product."**
     - An `environment` verdict must cite `file:line` or a diff hunk, or it is treated as `product`.

  Environment failures never become issues (ADR-0093). For people, `.claude/skills/testforge-is-it-real` gives a ✅/❌/⚠️ verdict and checks `known-false-alarms.md` first.
- **Issue format and dedup.**
  - Finding ID = `sha256({type, testName, targetType, osPlatform})[:12]` (`src/compose-findings-issue.js`).
  - It is stored in `issues/links.json` and in a hidden `<!-- testforge:finding-id=… -->` body marker (ADR-0128).
  - Exact-ID matches skip the agent (ADR-0101).
  - The rest are grouped by target, scenario and a normalised first error line (`src/triage-groups.js`).
  - `findings-triager` (Sonnet) decides `new`, `duplicate`, `already-fixed` or `wontfix` against the repo's existing issues.
  - When a check passes again, its issue is auto-closed (ADR-0102).
  - Issue layout (ADR-0126, skill `testforge-issue-writing`): Summary, Setup, Steps (✅ … ❌ failed here), Expected (with its doc source), Actual, collapsed Trace, Cost, Workaround and Suggested fix (only when established), and provenance.
- **Issue modes** (`src/issue-mode.js`, ADR-0137):
  - `human`: one issue per finding, screenshots and video uploaded;
  - `ai`: text and code pointers for a coding agent, optionally grouped by root cause.

### Visual QA

- **References.** People list them in `projects/<slug>/docs/design-references.md` (HTML wireframe or PNG folder, plus a viewport). `src/design-references.js`:
  - renders one full-page PNG per screen with Playwright at 1440×900;
  - caches by the source's sha256;
  - guards paths with realpath, so a symlink cannot escape the checkout.
- **Screen mapping.** For multi-screen HTML, the `design-explorer` agent (Sonnet) walks the wireframe breadth-first. It records **replayable `reach` steps** per screen in `index.json`, so later renders are deterministic and need no agent.
- **Comparison.** The `ui-drift-checker` agent (**Haiku**) screenshots the live app and compares it with the reference by eye.
  - There is no pixel diff, no axe check and no render matrix.
  - Its output is `findings[]` (expected, actual, `referenceImage`, severity, cost, workaround) plus `questions[]` of four kinds: `undocumented-screen`, `ambiguous-diff`, `no-reference`, `unreachable-screen`.
  - Rules: **"an unreached screen is unchecked, not clean"**, and a finding and a question for the same screen are mutually exclusive.
  - Issues show both images side by side, labelled "Expected (design reference)" and "Actual (as rendered)" (ADR-0140).

VTC §7.5 is well ahead on measurement. QCFactory is ahead on the question taxonomy and on replayable reference rendering.

### Security

- **Scan** (`src/run-security-scan.js`, `src/parse-trivy-report.js`, ADR-0119/0129).
  - Runs `trivy fs --scanners vuln,secret,misconfig` before anything is installed. It is non-fatal and has a 10-minute timeout.
  - **Redaction before anything is written:** secret `Code`/`Match` fields, plus misconfig `CauseMetadata.Code`, which can leak a neighbouring secret line.
  - Findings are grouped one per package (across lockfiles) or one per misconfig check, with a severity threshold (default medium). An issue is auto-closed when Trivy stops reporting it.
- **Red team.** The `red-teamer` agent (Read/Grep/Glob/WebFetch, no Bash) does a static review plus passive HTTP probes:
  - five priority areas;
  - every finding needs an attacker-controlled input, a code path at `file:line`, an exploit scenario, and `cost`, `workaround` and `notInScope` fields;
  - its scope is explicitly the pulled code, never QCFactory itself (ADR-0006).

  It is off by default and has a thin track record.

### Cost tracking

Code: `cost-report/writeReport.js` (757 lines plus 1,058 test lines), `src/run-cost.js`, `src/cost-api.js`, `src/subscription-quota.js`.

- **Capture.** Each dispatch has its own stream file. Its final `result` event gives the CLI's `total_cost_usd` and full `usage`: uncached input, cache read, cache write 5m/1h, output (ADR-0106/0123).
- **Pricing.**
  - `pricing.json` holds per-model rates for those five token kinds, plus aliases, and prices the breakdown.
  - For crashed streams, it estimates from the assistant `usage` events instead.
- **Reports.**
  - Cross-validation compares `log.json` with the stream output tokens.
  - Rollups go per dispatch, per agent and per run.
- **Quota.** Each stream's `rate_limit_event.seven_day.utilization` is read. Weekly Δ% ÷ $ over the last 3 completed runs gives a "% of weekly quota per run" estimate.
- **A real bug in the snapshot.** `claude-opus-5-5[1m]` was not in the aliases, so the per-kind split showed $0.00. Only the CLI-reported total of $18.57 survived, and the run's own retrospective caught it.

### Retros ("Optimisation")

Code: `src/finalize-pipeline-run.js`, `src/retrospective-data.js`, `src/write-retrospective-report.js`, tech-lead "retrospective mode".

**How it works.** It runs after every pipeline, including failed ones, in two layers:
1. A deterministic `data/` layer: stages, dispatches, agents, cross-validation and quota.
2. An Opus narrative (Patterns, Defects, Good/Not good, Proposals P1… with baseline → target and impact × effort, a KPI control table) and a **review of the previous run's proposals**.

There are rule-based fallback proposals (`deriveProposals`). Example: `projects/gradionhq-gradion-workspace-apps/reports/retrospective/20260930T040247Z-gradionhq-gradion-workspace-apps/README.md`.

**Compared with Lookback.** It is pipeline ops tuning (time, money, retries, cache rate), not prompt improvement.
- It has no prompt version SHAs, no attribution to roles, no replay evaluation, no canary and no rollback. Proposals are text for a human.
- Lookback is much stronger on method.
- **Worth taking:** the data-layer / narrative split, KPI baseline → target, and the previous-proposal review.
- **A cautionary example:** the retro flagged "2 product failures filed nothing" as a possible bug. In fact `github_issues_enabled` was `false`, and the data layer did not include the flag state.

### Loop skills

- **`.claude/skills/magic-looper`.** A Ralph-style loop for building QCFactory itself:
  - RECAP (Haiku), PLAN (Sonnet), EXECUTE (Haiku), TEST (Haiku);
  - **at most 2 fix sub-iterations**, then the iteration is "blocked";
  - **dependents of a blocked iteration are blocked too**, while independent branches continue;
  - a human gate after every iteration;
  - the ready set is chosen by lowest number;
  - the only state is status lines appended to the iteration file.

  Companions: `sprint-cleaner` (one feature per iteration), `talkative-coder` (one commit per iteration) and `code-mudd` (a `docs/debts/NNN` file for every shortcut).
- **No no-progress detection** anywhere. Other bounded loops:
  - harness setup: 4 attempts, with an early stop on a `project-defect` verdict;
  - `withEnvironmentFixRetry` in `run-pipeline.js`: exactly one software-engineer repair, then one retry, triggered when every test fails or the suite throws.

VTC's caps of 3–5 rounds with stuck detection are stronger.

### Dashboard

`dashboard/src/`. A state-switch single-page app with no router. Pages:
- Projects, then Run list, then Run detail (live log over SSE, bounded and closed on `idle`);
- Register Project;
- Settings (feature flags);
- Costs: pie, bar, line and scatter charts with filters (`costs/cost-aggregate.js`);
- Optimisation: renders the retrospective markdown.

The dev server uses `vite-plugin-testforge-api.js` and reads the repo files directly.

### Infrastructure

- **MCP** (`src/mcp/tools.js`, ADR-0147).
  - Read tools: `config_get`, `flags_list`, `flags_get`, `projects_list`, `project_get`, `runs_list`, `run_get`, `run_log`, `status`, `cost_breakdown`.
  - Write tools: `config_set`, `flags_set`, `project_update`, `run_now`.
  - The core calls service functions directly, not the REST API.
  - `mcp.enabled` and `mcp.readOnly` are read live on every request.
  - Every config write becomes a git commit, with secret-looking values shown as `[redacted]`.
  - **No authentication, and it listens on all interfaces by default.** A config write equals running a command on the host, because `appium_command` is an argv the service executes (DEBT-007).
- **Config and flags.**
  - `config/feature-flags.json` holds 28 flags.
  - Each value resolves file, then env, then default. The source of each value is reported, and changes are live on the next read (ADR-0079).
  - `config/qc-factory.config.example.json` is a single committed config with a last-good fallback (ADR-0146).
- **Incidents** (ADR-0098/0099, `src/run-marker.js`, `src/write-incident-report.js`).
  - Every run keeps a gitignored in-flight marker that records its stage.
  - A marker still there at boot becomes an `interrupted` incident.
  - `pipeline-error` and `agent-timeout` incidents are written as markdown: what happened, what went through, what was lost, where to look, and a reviewer checklist.
  - `salvage-run.js` keeps partial Appium results.
- **Agent runner** (`src/spawn-claude-agent.js`).
  - `permissionMode` is required at every call site.
  - It passes `--allowedTools` and `--disallowedTools` (for example, git mutations denied, ADR-0052).
  - It enforces a 40-min timeout, then SIGTERM, then SIGKILL after a 30 s grace.
  - It drains pipes after exit and claims one stream file per dispatch.
  - **Almost every call uses `bypassPermissions` with no OS sandbox.**

## 3. Quality assessment

**Robust:**
- Test discipline: a co-located test for every module, more test lines than source lines, and guard tests:
  - `src/agent-contract-sync.test.js` keeps shared contract blocks byte-identical across agent files;
  - `src/env-reads.guard.test.js`.
- Fail-soft, explicit design:
  - "never throws" stages;
  - "unknown means more runs";
  - "unsure means product";
  - environment verdicts require evidence.
- Lessons from real runs are written down: spec-authoring rules, harness hygiene, ADR-0121's process-group kills, pipe drain.
- Cost capture checked against the CLI's own figures "to the cent" (pricing notes).
- An honest debts list. DEBT-004 (unsanitised `log.json`) and DEBT-007 (no auth) are disclosed, not hidden.

**Hacky or risky:**
- **ADR churn.** 147 decisions in 14 days, several superseded within days (Postgres in, then out; the Node/Bun runtime switches). Docs drift (the workflow diagram).
- **Run-pipeline size.** A 1,418-line `run-pipeline.js` with about 60 injected dependencies, and many flags read "once per run".
- **No sandbox.** Untrusted pulled code runs on the host with `bypassPermissions`.
- **Exposed admin surface.** An unauthenticated admin API on all interfaces.
- **Repo growth.** Everything is committed to git, including transcripts (ADR-0145) and recordings, so the repo grows without bound.
- **Hard-coded specifics:**
  - `ai-agent-tam-*` labels;
  - "testforge" paths everywhere;
  - Vestio and Gradion cases in comments and ADRs (for example ADR-0135, the timecard lifecycle);
  - Opus as the default for most agents.
- **Self-review.** The tech-lead merges its own fix PR (`tech_lead_auto_merge_enabled: true`, ADR-0124). This breaks the rule in VTC §5.5.
- **Visual QA is weak.** It is a Haiku judgement by eye, with no measurement.

## 4. Reuse table

| Component | VTC target | Mode | Effort | Caveats |
|---|---|---|---|---|
| `spawn-claude-agent.js` (timeouts, kill grace, pipe drain, a stream file per dispatch) | Host adapter `spawn_role` (Claude) | Port the pattern to TS | S | Ownership; replace `bypassPermissions` with VTC allow rules plus sandbox |
| `cost-report/writeReport.js` + `pricing.json` schema (5 token kinds, aliases, stream-only fallback, cross-validation) | Engine cost tracker / budget controller §11 | Port the pattern | M | Ownership; normalise model suffixes such as `[1m]`; fail loud on unpriced models |
| `subscription-quota.js` (weekly Δ% per $ calibration) | Usage panel §6.9, Lookback 12% cap | Port the pattern | S | Only whole-percent precision; counts the whole account |
| `docs/qa/spec-authoring-rules.md` (DOC/OBSERVED, sign-in lock, readiness, edge-case group) | QA author role, editable section + skill | Skill text (rewrite) | S | Gradion examples to remove; ownership of the prose |
| `SCENARIO.md` template | QA author output contract + Spec-Verifier input | Port the pattern | S | Add REQ-n IDs |
| `doc-questions.json` register (docRefs with quote, options, `after`) | BA `spec_gap` channel; Lead batched escalation | Port the pattern | S | None |
| Scenario map / wake rules + content hash | Gate Runner L2 affected-only selection | Port the pattern | M | VTC also has coverage contexts; keep "unknown means more runs" |
| Failure classifier (rule table + flaky-same-commit + cheap LLM for unclear) | Triage (engine) §6.3 step 8 + the `bad_test` route | Port the pattern | M | Regexes are Playwright/Appium-specific |
| Finding ID hash + hidden marker + auto-close on pass | Triage fingerprint; PR evidence | Port the pattern | S | VTC fingerprints cover more than tests |
| `testforge-issue-writing` layout (Summary/Expected-with-source/Actual/Steps) | Finding schema rendered for humans (escalations, PR body) | Skill text | S | Strip GitHub-template specifics |
| `ui-drift-checker` question taxonomy + "unreached ≠ clean" | Visual QA vision-judge output contract §7.5 | Skill text | S | Keep VTC pixelmatch/axe; QCFactory has neither |
| `design-references.js` + `design-explorer` reach steps | Designer prototype screens / existing-repo baseline capture §9 | Port the pattern | M | VTC prototypes use `?state=`; useful for existing repos with HTML mocks |
| Trivy stage + redaction + grouping | L4 scanners; evidence redaction | Port the pattern | M | Trivy is Apache-2.0, but VTC already picked osv/gitleaks/Checkov; decide |
| `red-teamer` finding fields (input, path, exploit, cost, workaround, notInScope) | Security verify role | Skill text | S | Static only; no sandboxed exploit verification |
| Perf probe ("agents declare, engine measures") | Future perf specialist | Port the pattern | L | Mobile-only; no Web Vitals |
| Harness contract + isolated time-limited host | Calibration / gate runner for existing repos | Port the pattern | M | VTC uses calibrated gate commands, not agent-written harnesses |
| Run marker + incident report | Engine resilience §6.8 + run summary | Port the pattern | S | VTC already has `events.jsonl`; add the human-readable incident |
| Retrospective data/narrative split, KPI table, previous-proposal review | RETRO step + Lookback inputs | Port the pattern | S | Include config snapshot in the data layer |
| `magic-looper` / `code-mudd` | Building VTC itself; Engineer debt logging | Skill text | S | Cap 2, no stuck detection; VTC's loop controller supersedes it |
| MCP admin tools / flags resolver | `vtc` CLI / engine config | Port the pattern | S | Copy the read-only toggle, not the no-auth gap |
| Dashboard (Vite/React 18/Recharts) | Flow Studio | Skip (stack mismatch) | n/a | VTC uses Next 16/React 19/Tailwind v4/React Flow; at most borrow the Costs page charts |
| Project data (`projects/`, `runs/`, `log.json`) | n/a | Skip | n/a | Gradion-internal; never copy |

## 5. Top 10 things to take

1. **DOC vs OBSERVED assertions with a citation.** Every QA assertion cites a REQ/AC or a doc quote. In existing repos, `OBSERVED` marks a characterisation baseline, and a failing `OBSERVED` assertion is a question, not a defect. Add this to the QA author contract and to the Spec-Verifier inputs.
2. **A failure-classification stage before triage.** It costs almost nothing:
   - a deterministic rule table first, then a `flaky-same-commit` rule;
   - then a cheap model only for unclear failures, biased "unsure → product";
   - an `environment` verdict must cite evidence.

   It feeds VTC's `bad_test` and `gate_infra` routes.
3. **Wake rules for affected-only tests.** Scenario → covers globs, `wakeAll` globs, a content hash of the test and its helpers, and the rule "unknown or malformed means run it".
4. **The question register.** One file per project, with doc quotes, 2–3 options and what changes after the answer. It becomes the BA's spec-gap queue and the Lead's batched escalation format.
5. **The vision-judge output contract.** Add `questions[]` with the four kinds, findings and questions mutually exclusive per screen, "unreached screen ≠ clean", and an Expected/Actual image pair in the evidence.
6. **Replayable reference rendering.** An agent maps a multi-screen mock once and records `reach` steps. After that, rendering is deterministic code with a sha256 cache. Use it when an existing repo ships HTML mocks instead of a VTC prototype.
7. **Cost capture from the stream `result` event.** Price the 5 token kinds, cross-validate two sources, and estimate quota from `rate_limit_event` Δ% per $.
8. **A hardened headless spawner.** Timeout, then SIGTERM, then SIGKILL; drain pipes after exit; one transcript per dispatch; `permissionMode` required with explicit allowed and disallowed tools. Also run untrusted harness code in a separate process group with time limits.
9. **The retro data/narrative split.** A deterministic data layer, an LLM narrative, proposals with baseline → target, and a review of whether last run's proposals moved the numbers. This is a cheap pre-step to Lookback's replay evaluation.
10. **Human-readable incidents.** Every non-clean run gets an incident file built from a stage marker, including "interrupted" runs found at boot. It records what went through, what was lost, and where to look.

## 6. Changes this suggests for our spec

- **§7.2/§4.3, evidence redaction.** VTC commits `.vtc/evidence/` to git. Scanner output must be redacted before it is written: secret `Code`/`Match` fields and misconfig code context, as in ADR-0119. Today §7.6 escalates a secret, but the evidence file could still leak it.
- **§15, local endpoints.** The engine's localhost endpoint (statusline shim, Flow Studio SSE) should:
  - bind to 127.0.0.1 only;
  - require a per-install token;
  - check `Host` and `Origin`, to block DNS rebinding;
  - treat config keys that execute commands as protected.

  QCFactory's DEBT-007 shows what goes wrong without this.
- **§6.3 step 8, triage.** Add an explicit failure-classification sub-step, with environment kinds and the flaky rule, ahead of routing.
- **§7.5, Visual QA.** Add the question kinds and the "unreached ≠ clean" rule to the vision judge's schema.
- **§13 and the RETRO step.** The retro data layer must include the run's config and flag snapshot (`pipeline_config_hash` alone is not readable). Add a "previous proposals review" table.
- **§11, cost.** Fail loudly on an unpriced or unaliased model, rather than silently pricing it at $0.
- **§6.3 Engineer exits.** Like `project-defect`, add a structured "fault is outside my scope" verdict (environment or upstream) that ends the round early without counting as stuck.
- **Already decided correctly in VTC.** Keep these:
  - no self-merge (QCFactory's tech-lead merges its own PRs);
  - a sandbox instead of `bypassPermissions`;
  - measured Visual QA instead of a vision-only judge;
  - a stuck detector (QCFactory has none).

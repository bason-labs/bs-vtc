# Wave 3 best practice, mapped onto the VTC spec and spine

- **Date:** 2026-10-14
- **Author role:** Architect. This is read-only research; nothing in the repo was changed.
- **Inputs:**
  - the Phase 3 Final Review coverage rows marked partial or missing;
  - `wave3-scope.md` (Lead decisions D-ay to D-bb);
  - spec `2026-10-12-vtc-system-design.md`;
  - spine `vtc-spine.md` (AD-1 to AD-20, readings to 95, `CONTRACTS_VERSION` 4.4.0);
  - the earlier research in `docs/research/`.
- **Marking:** each fact checked today against a primary source cites it in the Sources list. Anything I could not confirm against a primary source is marked **UNVERIFIED**, which is the same rule §8.2 sets for roles. Every UNVERIFIED item has a spike row in §8.

---

## 0. Summary

| # | Area (coverage row) | Recommendation in one line | New contracts (MINOR) | Spine | Top risk |
|---|---|---|---|---|---|
| 1 | Lookback §13 (missing) | Prompt versions are immutable and content-addressed. Compiled agents carry only the locked core. The engine sends the pinned editable section at the start of the task pack. Pins live at user level and only a human writes them. Replays are paired, use outcome grading, apply a sign test and are checked against an A/A noise floor. The canary splits tasks by hash and rolls back automatically. | `PromptVersionRef`, `LookbackPins`, `Attribution`, `Scorecard`, `PromptProposal`, `ReplayResult`, `CanaryState`, `lookback.*` events, pure stats helpers | **AD-21** | Small samples: noise looks like improvement |
| 2 | Level 3 (partial) | Level 3 needs required status checks on the base branch, or it downgrades. Merge with `gh pr merge --auto --match-head-commit <gated sha>` and never with `--admin`. A post-merge watch covers base CI and reverts. Downgrades go to a git-tracked ledger, so `project.yaml` stays human-owned. | `RemoteMergeService` (optional dep), `RemoteMergePolicy`, `AutoMergeChecklist`, `MergeLevelLedgerEntry`, PR ref fields, new downgrade reason | **AD-23** | A base with no required checks lets the PR merge without CI |
| 3 | Visual QA §7.5/§9.1 (partial) | One deterministic visual gate layer, run on the project's Playwright through a VTC-written runner script inside the gate sandbox. Prototype and implementation render in the same run. axe runs with the WCAG 2.2 AA tags. Computed styles are checked against DTCG tokens. pixelmatch v8 diffs per region. The detector rules are ported to TypeScript from Apache-2.0 impeccable, with attribution. | `VisualReport`, `GatesConfig.visual`, `BrowserPin`, visual finding categories | **AD-24** | Chromium inside sandbox-exec/bwrap; the MPL-2.0 licence on axe-core |
| 4 | Research §8.2/§10/§14 (missing cache) | Fetchers behind an interface with an injected HTTP client. A content-addressed cache scoped per client, revalidated with RFC 9111 conditional requests. Facts are quote-anchored or JSON-pointer-anchored and verified by code. UNVERIFIED facts block G2 unless the human waives them. | `Fetcher`, `HttpClient`, `ResearchCache`, `FactRow`, `FactLocator`, `FactWaiver`, MCP tool IO, `ApproveInput.waive_facts` | **AD-22** | Prompt injection and SSRF through fetched content |
| 5 | Headless / auto-resume (partial) | A hardened argv per host. Claude: `--setting-sources user --strict-mcp-config --permission-mode dontAsk --permission-prompts none`, never `--bare`. Codex: `-c approval_policy="never"`, an explicit sandbox, and the ignore flags pending a spike. Auth preflight through `claude auth status` / `codex login status`. Process-group supervision with wall and idle timeouts. One routing default per Lead host. | `HeadlessPolicy`, `HostAuthStatus` + optional `authStatus()`, `HostOutcome.error.cause`, `DEFAULT_DISPATCH_MODE_BY_LEAD_HOST`, purpose `lookback_replay`, AD-9 marker additions | **AD-25** (amends AD-6/AD-17) | Vendor terms for subscription headless use (§12.5) |
| 6 | Single binary release (partial) | A release workflow that does nothing until a remote exists, with actions pinned by SHA. Bun cross-compile, a smoke test per native runner, `SHA256SUMS`, GitHub artifact attestations and immutable releases. A Homebrew formula template, plus a POSIX `install.sh` that verifies checksums. Signing and notarization wait for the human (D-az). | none in `@vtc/shared` (release helpers stay in `@vtc/cli`) | **AD-26** (amends AD-10 r6, AD-16 r5) | CI supply chain; a checksum does not prove authenticity |

**Cross-cutting.**
- One additive contracts bump to **4.5.0**.
- AD-3's Binds list gains the new contracts.
- **AD-9** gains the `--dangerously-bypass-hook-trust` marker (§5).
- **AD-13** gains the `lookback/` and `research/` modules (D-bb): `research/` is a leaf, and `core/` never imports either one.
- **AD-15** records the new team's ownership.

---

## 1. Lookback: prompt-version scoring, eval, canary and rollback (§13)

### 1.1 What current practice says
- **Agent evals (Anthropic, "Demystifying evals for AI agents").**
  - Use tasks, trials and graders, and grade the outcome (the end state), not the path the agent took.
  - Each trial starts from a clean environment. Their example is an agent that inflated its scores by reading git history left over from earlier trials.
  - pass^k (all k trials succeed) measures consistency. Regression suites should sit near 100%.
  - Start with 20–50 tasks drawn from real failures, and read the transcripts.
  - Give model graders an "Unknown" option.
- **Eval statistics (Anthropic, "A statistical approach to model evals").**
  - Report standard errors.
  - Cluster on the unit of randomisation: the task, when it has k trials.
  - Resample to cut within-task variance.
  - Compare with paired differences, which costs nothing when the arms correlate.
  - Run a power analysis before trusting a small eval.
- **Prompt registries (Langfuse).**
  - Versions get IDs, and labels act as deployment pointers.
  - Rollback means moving the label back.
  - A missing label fails with a 404 rather than falling back silently.
  - Protected labels limit who can move production.
- **Progressive delivery.**
  - Argo Rollouts: per-measurement success and failure conditions, a `failureLimit`, and **Inconclusive pauses for a human instead of passing**.
  - Spinnaker/Kayenta: Mann-Whitney at 98% per metric. A critical metric failure forces the score to 0. If half or more of the metrics have no data, the score is 0.
  - The common idea: judge against a baseline running at the same time, not against history.

### 1.2 Recommended design
1. **Prompt identity.**
   - Define `effectivePromptSha(locked, editable)` = `promptShaFor(locked + "\n" + editable)`. When the editable section equals the compiled one, this equals today's `prompt_sha256`, so the trace history stays continuous.
   - `role.dispatched` records it, plus `editable_sha256`.
2. **Delivering a version without reinstalling.**
   - In plugin-only mode the Lead spawns an installed plugin agent, whose instructions are fixed until the plugin is reinstalled and the session restarted. So a canary cannot be swapped in per dispatch through the agent file.
   - **Recommendation:** compiled agents carry the **locked core only**. The engine renders the pinned editable section **first in the task pack**.
     - It works on both hosts in plugin-only mode.
     - It needs no reinstall.
     - Its prefix is identical across dispatches of the same role, so it stays cacheable.
   - In headless mode the same text can go in through `--append-system-prompt-file` as an optimisation.
   - Rejected alternatives:
     - compiling canary variants as extra agents: needs a reinstall and a session restart, and grows the agent list;
     - headless-only overlays: would make Lookback depend on `headless_allowed`.
   - The trade-off: the editable section moves from the system prompt into the first user turn, which carries somewhat less weight. Roles already take their task-specific instructions from the pack, so this is acceptable. Record it as a reading.
3. **Storage and trust.** Repo content must never choose which prompt runs, for the same reason as AD-13 rule 10.
   - Versions are immutable under `~/.vtc/lookback/prompts/<role>/<host>/<sha8>.md`, with frontmatter: parent, proposal id, and the CHANGELOG entry (hypothesis, trace ids, diff, evaluation).
   - Pins live in `~/.vtc/lookback/pins.yaml` (v:1), keyed by `engineRepoKey`. Only `vtc lookback approve|pin|rollback` writes them, through the human channel (`HUMAN_ONLY_TOOLS`, TTY-confirmed).
   - Add `lookback/` to `ROLE_DENIED_VTC`.
   - The project only records what ran: events, plus the scorecards §13 commits under `.vtc/lookback/scorecards/<role>/<host>/<sha8>/`, redacted.
   - Proposals stay at `.vtc/lookback/proposals/**` (already the lookback role's write scope).
4. **Attribution.**
   - A trace is one dispatch (`role.dispatched` → `role.submitted`/`role.failed`), joined with what happened downstream:
     - gates;
     - findings with `who_should_have_caught`;
     - escalations and cap hits;
     - attributed Final Review findings;
     - escaped defects from Level-3 downgrades (§2).
   - Run the deterministic tree from §13 first. Human labels override it. The AI tiebreak runs only when the tree is inconclusive, with an "unknown" option. Credit goes to the first failure upstream.
5. **Scorecards.**
   - Keyed by (role, host, effective sha, `grader_bundle_sha`).
   - Metrics:
     - first-round gate pass;
     - review pass;
     - rounds to done;
     - escalations and cap hits per 100 dispatches;
     - tokens per success (quality per token).
   - Engineer metrics break down by discipline × stack pack × host.
   - Every proportion is shown with **n and a Wilson interval**, never as a bare percentage. Below a minimum n, show "insufficient data".
6. **Splits.** `splitForTrace(trace_id)` = sha256 mod 10: 7 for train, 3 held out. It is deterministic, and the lookback role never sees held-out traces.
7. **Replay harness.**
   - A replay re-runs the role on the recorded task pack at the recorded base commit, in a **fresh clean checkout with no refs past the base**. This is the trial isolation the evals article calls for.
   - Scoring uses the same grader bundle: gates and hidden tests are deterministic, and review verdicts come from the fixed judge.
   - Use k = 3 trials per task per arm. Arms are paired on the same tasks and interleaved.
   - The A/A run (baseline against baseline) measures the flip rate. Cache it per (role, host, baseline sha).
   - **Decision rule:**
     - **improve** only if all of these hold:
       - an exact one-sided sign test on discordant tasks gives p < 0.05;
       - no task that passed in the regression set drops by more than the A/A flip rate;
       - tokens rise by no more than 20%.
     - **regress**, **no_change** or **inconclusive** otherwise. Inconclusive reaches the human as inconclusive, never as improved.
   - With 5–10 tasks this only detects large effects. You need at least 5 discordant tasks, all favouring the candidate (0.5^5 = 0.031). State this in the UI.
   - Cost is about (2 arms + A/A) × k × n role runs. Example: n = 8, k = 3 gives 48 runs plus 24 A/A runs (once).
   - Replays are role runs:
     - in `plugin_only` the Lead dispatches them (new purpose `lookback_replay`);
     - in `headless_allowed` the engine dispatches them.
   - Gate them on §6.9's 30% weekly reserve.
8. **Canary and rollback.**
   - In the canary project, tasks go to the candidate or the baseline 50/50 by task-id hash, and stay sticky across fix rounds. That gives a **concurrent** control, as Kayenta recommends.
   - Triggers from the spec:
     - escalations or cap hits at 2× the baseline rate or more;
     - tokens up more than 20%;
     - a human regression flag, which rolls back immediately.
   - Rate triggers fire only once both arms have at least 5 dispatches. Before that the state is "no data": keep the canary running and do not promote.
   - Rollback moves the pin pointer back (`lookback.rolled_back`). Versions are never edited.
   - Promotion after the canary window (at least 10 canary dispatches, no trigger) needs `vtc lookback approve`.
   - Upstreaming into `roles/<role>/prompt.md` is a normal VTC source change, with a MINOR role version.
9. **Dispatch at run end.**
   - On `run.finished`, the engine enqueues the `lookback` role for each (role, host) that meets all of these:
     - at least 5 attributed failures in train;
     - weekly remaining at least 30%;
     - budget available.
   - The role's output is a `PromptProposal`: at most 3 changes, each with a hypothesis, a target metric and trace ids.
   - The engine rejects any proposal that touches the locked core (checked with `splitRolePrompt`) or contains an AD-9 marker (`findForbiddenInText`).
10. **Retro data layer.** Snapshot `pipeline_config_hash` and feature flags, and check whether the previous retro's proposals moved their KPIs. This stays in sub-project 7.

### 1.3 Contracts in `@vtc/shared` (MINOR)
- **Types:**
  - `PromptVersionRef { role, mode?, host, locked_sha256, editable_sha256, effective_sha256 }`
  - `PromptVersionFile` frontmatter
  - `LookbackPins` (v, `current{role/host→sha}`, `canaries[{repo_key, role, host, candidate, baseline, started_at, assignment:"task_hash_50"}]`, history)
  - `Attribution { trace, task, role, host, prompt, blamed_role, method: tree|human|ai_tiebreak, confidence }`
  - `Scorecard { …, grader_bundle_sha, window, metrics{value, ci_low, ci_high, n}, breakdown[] }`
  - `PromptProposal`
  - `ReplayResult { per_task[{task, a[], b[]}], aa_flip_rate, sign_test{n_discordant, wins_b, p}, tokens_delta_pct, verdict }`
  - `CanaryState`
- **Pure helpers:** `effectivePromptSha`, `splitForTrace`, `signTestOneSided`, `wilsonInterval`, `canaryVerdict`, `attributeFailure`.
- **Events:** `lookback.dispatched`, `lookback.proposal_recorded`, `lookback.replay_finished`, `lookback.approved`, `lookback.pinned`, `lookback.rolled_back`, `lookback.escaped_defect`. `role.dispatched` gains an optional `editable_sha256`.
- **Lists:** `HUMAN_ONLY_TOOLS` gains the lookback gestures; `ROLE_DENIED_VTC` gains `lookback/`.
- **Manifest:** `PluginManifestAgent` gains `locked_sha256` and the default `editable_sha256`.

### 1.4 AD-21 (sketch): Lookback prompt versions, pins and protected graders
- **Binds:**
  - `packages/engine/src/lookback/**`
  - `roles/*/prompt.md`
  - the compiler's agent emit
  - `~/.vtc/lookback/`
  - `HUMAN_ONLY_TOOLS`
- **Prevents:**
  - a repo or role changing which prompt runs;
  - scores computed by code the optimiser can edit;
  - canaries promoted on noise;
  - ambiguous prompt identity.
- **Rule:**
  1. Identity is `effectivePromptSha`.
  2. Agents compile from the locked core; the pinned editable section opens the task pack.
  3. Versions are immutable. Pins are user-level and human-only. Repo content never selects a prompt.
  4. The lookback role writes proposals only; touching the locked core means a MAJOR change, which is a human source edit.
  5. Graders, rubrics and metric code are engine code inside a hashed bundle. `lookback/` reaches gates only through `GateRunner`. Every score stores `grader_bundle_sha`, and the judge model is fixed in the bundle.
  6. Promotion needs a replay verdict of `improve` plus a human approval. The canary assigns tasks by hash, rolls back automatically on a trigger once the minimum sample is reached, and pauses for a human when the result is inconclusive.
  7. Lookback starts only with at least 30% of the weekly window left.
- **Check:**
  - shared tests: exact sign-test values, split determinism, the `canaryVerdict` decision table;
  - dependency-cruiser rules: `AD21-lookback-uses-core-entry-and-gate-interface`, `AD13-core-does-not-import-lookback`;
  - a compiler test: agents carry no editable section, and the manifest records both SHAs;
  - an engine test: a `pins.yaml` planted in the repo is ignored;
  - a human-channel test for the gestures.

### 1.5 Risks
- **Small n.** Mitigated by the sign test, the A/A floor, the "inconclusive" verdict and the minimum samples.
- **Goodhart.** The optimiser could game the metric. Mitigated by protected graders, the fixed judge and `grader_bundle_sha`.
- **Prompt injection into proposals.** Traces carry repo text. Mitigated by the diff limit, the marker scan, a size cap and human approval.
- **Leaked future state in replays.** Mitigated by clean checkouts with no later refs.
- **Plugin-only needs a live Lead.** Replays in that mode depend on it.
- **Moving the editable section changes prompt weight.** Measure it with an A/A on one role before switching every role.

---

## 2. Safe auto-merge for Level 3 (§6.4, §6.7, D9)

### 2.1 Findings
- **`gh pr merge`:**
  - `--auto` merges once requirements are met.
  - `--match-head-commit <SHA>` lets the merge go through only if the PR head still equals that SHA.
  - `--admin` bypasses requirements.
  - With a merge queue, `--auto` enables auto-merge while required checks are pending, and enqueues the PR once they pass.
- **GitHub docs on auto-merge:**
  - auto-merge must be enabled for the repo;
  - the option appears only when the PR can't merge immediately (required reviews or checks still pending);
  - it is disabled when someone without write access pushes, or when the base changes.
- **What `--auto` does on a PR with no unmet requirements is UNVERIFIED.** One third-party report says it merges at once or refuses with "clean status". Either way, **GitHub does not enforce "remote CI green" when the base has no required checks.**
- **Rules API:** `GET /repos/{o}/{r}/rules/branches/{branch}` returns the active `required_status_checks`, `pull_request`, `merge_queue` and `required_signatures` rules. Classic branch protection has its own endpoint, and **who can read it is UNVERIFIED**.
- **gh JSON:**
  - `gh pr view --json` has `autoMergeRequest`, `statusCheckRollup`, `mergeStateStatus`, `reviewDecision`, `headRefOid` and `mergeCommit`.
  - `gh pr checks --required --json` returns `bucket` and `state`; exit code 8 means pending.
  - `gh run list --branch --commit --json conclusion` covers post-merge CI.
  - `gh repo view --json` has **no** `autoMergeAllowed`. The REST repo field `allow_auto_merge` exists, but **whether non-admins can see it is UNVERIFIED**.
- **Reverts:** `git revert` writes "This reverts commit <sha>." by default. The body format of GitHub's Revert-button PR (for example "Reverts owner/repo#N") is **UNVERIFIED**.

### 2.2 Recommended design
1. **Preflight**, in `vtc doctor` and at run start when `merge_level: 3`. VTC never changes repo settings.
   - Checks:
     - the remote is GitHub, and `gh auth status` exits 0 (no token is read);
     - auto-merge is allowed (`allow_auto_merge`; when unknown, try it and handle the failure);
     - **the base branch has at least one required status check** (rules API, then classic protection);
     - at least one merge method is allowed.
   - On failure: the effective level is 2, the reason is `requirements_missing`, and an escalation says what the human should configure.
2. **Sequence**, per feature:
   1. Final Review passes and the gated SHA **S** is pushed; then `markReady`.
   2. Wait for the checks on S. Every *required* check must be `SUCCESS` (the rollup alone is not enough) and none may be pending. A timeout parks with `ci_timeout`.
   3. Evaluate the 7-item checklist with the pure `autoMergeChecklist(input)`. It is deterministic, and every item cites evidence.
   4. Run `gh pr merge <n> --auto --match-head-commit S --<method>`. **Never `--admin`.**
   5. Poll until `merged` (merge commit **M**). If auto-merge is disabled, the head changes or a conflict appears, park.
   6. If the base requires an approving review, show "awaiting review"; at a timeout, park. Never bypass it.
3. **Post-merge watch.**
   - Window: 24 h by default, or the next K runs of the required workflows on base.
   - Base CI for M: `gh run list --branch <base> --commit M`.
   - Revert detection, on each poll and at daemon start:
     - `git log M..origin/<base> --grep "This reverts commit M"`;
     - a PR that names ours;
     - optionally, an inverse patch-id match.
   - On a red required run or a revert: downgrade 3→2 and record `lookback.escaped_defect`, carrying the feature and its tasks for attribution.
4. **Downgrade persistence.**
   - `project.yaml` is committed and human-owned, so the engine must not edit it.
   - Add an engine-written, git-tracked, append-only, redacted ledger: `.vtc/merge-level.jsonl`.
   - Effective level = `min(project.yaml merge_level, ledger cap)`.
   - `vtc merge-level restore` (human channel) appends a restore entry. Teammates get the ledger through git (D8).
5. **Kill switch.** `vtc pause` also runs `gh pr merge --disable-auto` on every PR where VTC enabled auto-merge.
6. **Merge queue.** If the base has a `merge_queue` rule, `--auto` enqueues the PR, which is the host's auto-merge. Doctor warns that required workflows must also trigger on `merge_group`. **That check is UNVERIFIED** (doctor can only inspect the workflow files).

### 2.3 Contracts (MINOR)
- **`RemoteMergeService`** is a new interface, an *optional* entry in `EngineDeps`. Its methods:
  - `policy(base) → RemoteMergePolicy`
  - `requiredChecks(branch, sha)`
  - `enableAutoMerge({branch, headSha, method})`
  - `disableAutoMerge(branch)`
  - `baseRuns(base, sha)`
  - `findReverts(base, mergeCommit, prNumber)`

  A separate optional interface keeps `PullRequestService` unchanged, so the bump stays MINOR.
- `RemoteMergePolicy { auto_merge_allowed: boolean|null, required_checks[], merge_methods[], merge_queue, requires_review, signatures_required }`
- `AutoMergeChecklist { ok, items[{id: final_review|reviewers|coverage|test_integrity|risk_rules|waivers|remote_ci, ok, evidence[]}] }` and `autoMergeChecklist()`.
- `PullRequestRef` gains optional `number`, `auto_merge`, `required_checks[{name,state}]` and `merge_state_status`.
- `run.merge_level_changed.reason` gains `requirements_missing`.
- `MergeLevelLedgerEntry`, the `MERGE_LEVEL_LEDGER` path and `effectiveMergeLevel()`.
- Events: `feature.auto_merge_enabled`, `feature.post_merge_ci`, `feature.reverted`.
- `GH_FORBIDDEN_ARGS` (`--admin`), checked by the `gh` implementation's test.

### 2.4 AD-23 (sketch): Level-3 auto-merge and the downgrade ledger
- **Binds:**
  - engine-core's merge path
  - the cli's `gh`-backed services
  - `.vtc/merge-level.jsonl`
- **Prevents:**
  - a merge without CI;
  - merging a commit other than the gated one;
  - the engine editing human config;
  - a downgrade lost between runs.
- **Rule:**
  1. Level 3 runs only when the preflight passes; otherwise the effective level is 2, with a reason.
  2. The merge is bound to the gated SHA (`--match-head-commit`). `--admin` is never used, and nothing is ever pushed to main.
  3. The checklist is a pure function of engine state and the PR view.
  4. The post-merge watch downgrades through the ledger; only a human restores.
  5. `vtc pause` disables pending auto-merges.
- **Check:**
  - shared tests for the checklist and `effectiveMergeLevel`;
  - engine tests with a fake `RemoteMergeService`: no required checks gives Level 2; a moved head parks; a revert or a red base run downgrades and records the escaped defect;
  - a cli test that the argv never contains `GH_FORBIDDEN_ARGS`.

### 2.5 Risks
- **Instant merge with no required checks.** Covered by the preflight.
- **Head moves after gating.** Covered by binding to the head SHA.
- **Flaky base CI causes needless downgrades.** Only red *required* checks on M count, and a human can restore.
- **Squash or manual reverts go undetected.** Heuristics plus the human flag.
- **GitHub-only.** Level 3 is unavailable on other hosts; record this as a residual.
- **Repos that require review stall.** Covered by the timeout and parking.

---

## 3. Deterministic visual QA (§7.5, §9.1, D-ay)

### 3.1 Findings
- **Playwright:**
  - visual comparisons use **pixelmatch**;
  - baselines are named per browser and platform;
  - rendering "can vary based on the host OS, version, settings, hardware, power source", so compare in the environment that made the baseline;
  - browsers are version-locked to the Playwright version;
  - `PLAYWRIGHT_BROWSERS_PATH` sets the store, and `--only-shell` installs only the headless shell;
  - the docs say nothing about checksum verification of browser downloads (**UNVERIFIED that none exists**).
- **Package versions** (npm, today):

  | Package | Version | Licence | Published |
  |---|---|---|---|
  | `pixelmatch` | 8.0.0 | ISC | 2026-10-06 |
  | `axe-core` | 4.14.0 | **MPL-2.0** | 2026-10-05 |
  | `@axe-core/playwright` | 4.13.0 | MPL-2.0 | |
  | `playwright-core` | 1.64.0 | Apache-2.0 | 2026-10-07 |

  None of them has install scripts.
- **pixelmatch** compares colours in OKLab/HyAB, ignores anti-aliased pixels by default, and needs images of the same dimensions.
- **axe-core:**
  - tags include `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa` and **`wcag22aa`**;
  - results are `violations`, `incomplete` (needs review), `passes` and `inapplicable`.
- **impeccable:**
  - LICENSE is the unmodified Apache-2.0 text, "Copyright 2025 Paul Bakaus", with no extra terms (fetched today).
  - NOTICE.md credits only ehmo's MIT `platform-design-skills` for `skill/reference/ios.md` and `android.md`.
  - The detector CLI exits 0 when clean, 2 on primary findings and 1 when a target can't be scanned.
  - It checks against `DESIGN.md` and `.impeccable/design.json`.
  - Our 2026-10-13 research found telemetry code in its Rust engine.

### 3.2 Recommended design
One gate layer, `visual`, owned by gate-runner. It runs for UI tasks (affected routes only) and for Final Review step 5 (the full matrix). It returns a `GateReport` with `ToolFinding`s plus a `VisualReport` in evidence.

1. **Token lint** (no browser).
   - VTC-owned pure TypeScript over the changed CSS/TSX: postcss (MIT, pure JS) for stylesheets, and a literal scan for TSX.
   - Literal colours, lengths, radii, shadows and fonts that are not in the project's DTCG tokens become findings.
   - The forked detector's source rules also run here.
2. **Render matrix:** route × state × {390, 768, 1440} × {light, dark}, from `.vtc/design/screens.yaml`. The determinism recipe:
   - headless-shell Chromium only, DPR 1;
   - `locale: en-US`, `timezoneId: UTC`;
   - `page.clock.setFixedTime`;
   - `reducedMotion: 'reduce'`, and screenshots with `animations: 'disabled'`, `caret: 'hide'`;
   - wait for `document.fonts.ready`;
   - abort every non-loopback request, so fonts must be local;
   - mask the declared dynamic regions.

   An unreached route or state is reported as `unchecked` and blocks the pass (§7.5).
3. **axe.**
   - Inject a pinned `axe.min.js` with `addScriptTag` for each width and theme (contrast differs per theme).
   - Tags: `wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`.
   - `violations` become findings. `incomplete` items go to the vision judge or the human as unchecked, and never count as passes.
4. **Computed styles against tokens.** An in-page script collects colour, background, border, font-family/size/weight, line-height, radius, shadow and spacing for visible elements:
   - colours match a token within OKLab ΔE ≤ 0.02 (configurable);
   - lengths must sit on the token scale.
5. **pixelmatch v8 per region**, against the prototype **rendered in the same run with the same browser**. This removes the cross-environment drift the Playwright docs warn about.
   - Regions come from `data-vtc-region` attributes or ARIA landmarks.
   - Settings: `threshold: 0.1`, `includeAA: false`, and a per-region budget in `gates.yml`.
   - A dimension mismatch is a layout finding, not a pixel diff.
6. **Render cache.** Keyed by (source hash, browser build and executable SHA, viewport, theme, state), per §7.5's replayable rendering.

**Execution (D-ay).**
- VTC writes a runner script into the gate's private temp directory. It runs with the project's Node and imports the project's `playwright-core`/`playwright`, resolved from the project root.
- That makes it a gate command: it goes through `GateSandbox` and is allowed as a pinned "visual runner" entry, like a pinned scanner (AD-13 r10).
- When the project has no Playwright, `vtc doctor --install-browser` (an explicit command only) does this:
  1. fetches a pinned `playwright-core` tarball, verified by its npm `integrity` (sha512), into `~/.vtc/browsers/`;
  2. runs `install --only-shell chromium` with `PLAYWRIGHT_BROWSERS_PATH=~/.vtc/browsers`;
  3. records the browser executable's SHA-256 in a `BrowserPin`, which is re-verified before every run (the analogue of `binary_sha256`).
- With no browser, the layer is `skipped` with a visible reason (D-ay).
- Tests use a fake runner and never download a browser.

**Detector fork.**
- Port the rule *logic* to TypeScript under `packages/engine/src/gates/visual/detector/`. Do not ship the Rust engine: it is a native binary, AD-2 r8 applies, and earlier research found telemetry code in it.
- Apache-2.0 obligations, all fine to meet:
  - keep a copy of LICENSE (`THIRD_PARTY/impeccable/LICENSE`);
  - put a "modified by VTC" header on each derived file;
  - add an entry to the repo NOTICE;
  - record the upstream commit SHA in a `SOURCE` file;
  - use no "Impeccable" branding (§6): rule ids are `vtc-design/<id>` with `derived_from: "impeccable:<id>"`.
- Skip `ios.md`/`android.md`, so the MIT credit to ehmo is not needed.
- Each ported rule gets a fixture test.

**Novelty check (§9.1 step 4).**
- DreamSim, DINOv2 and UIClip are Python ML models and do not fit a Bun binary.
- v1: a pure-TypeScript perceptual hash (dHash/pHash) of the first viewport, plus a token vector (OKLCH palette, type pair, radius, density). Reject when both are too similar.
- ML embeddings move to v2. This is a **spec deviation that needs a reading**.

**Pins.** All the latest versions above are under 14 days old. Pin the newest release that is at least 14 days old at implementation time. pnpm 10.11 has no `minimumReleaseAge` (it arrived in 10.16, in minutes). Optional: bump pnpm and set `minimumReleaseAge: 20160`.

### 3.3 Contracts (MINOR)
- `VisualReport`, containing:
  - `renders[{key, status: rendered|unreached|error, screenshot, source_hash, browser{name, version, executable_sha256}}]`
  - `axe[{key, violations[], incomplete[]}]`
  - `computed_style[{key, selector, property, value, nearest_token, delta}]`
  - `diffs[{key, region, mismatch_px, ratio, budget, diff_image}]`
  - `token_lint[]`
  - `detector[]`
  - `skipped?{reason}`
- `GatesConfig.visual { widths, themes, region_budget_pct, color_delta, axe_tags, include_best_practice }`, with defaults.
- `BrowserPin`, `BROWSERS_DIR` and `VISUAL_SKIPPED_NO_BROWSER`.
- Finding categories `a11y`, `design_token`, `layout_diff` and `design_slop`. Slop routes to `design_gap` (the Designer); the rest route to `patch`.

### 3.4 AD-24 (sketch): Deterministic visual stack and browser provisioning
- **Binds:**
  - `packages/engine/src/gates/visual/**`
  - `vtc doctor --install-browser`
  - `~/.vtc/browsers/`
  - `GatesConfig.visual`
- **Prevents:**
  - silent browser downloads;
  - cross-environment pixel flakiness;
  - unverified browser binaries;
  - copyleft code bundled into the binary;
  - a design check that passes on something it never saw.
- **Rule:**
  1. The visual layer runs as a sandboxed, allowlisted gate command on the project's Playwright, or on the doctor-installed pinned one.
  2. Baseline and candidate render in the same run with the same browser.
  3. Before use, the browser executable must match its `BrowserPin`.
  4. `unreached` and axe `incomplete` never count as passes.
  5. A skipped layer is reported. A skipped layer does not count as a pass for the Level-3 checklist; this needs a Lead decision.
  6. axe-core is not embedded in the binary.
  7. Derived detector code carries the Apache-2.0 obligations and uses no upstream branding.
- **Check:**
  - gate-runner tests with a fake runner (matrix expansion, unreached gives unchecked, pin mismatch gives an infra error, no browser gives skipped);
  - a supply-chain test that the binary embeds no `axe-core` and no file without a licence entry;
  - one test per detector rule.

### 3.5 Risks
- **Chromium inside sandbox-exec/bwrap.** Chromium's own sandbox may fail when nested. Decide between `chromiumSandbox: false` under the outer sandbox and a different approach (spike).
- **Loopback.** The verify phase needs loopback; D-av covers macOS.
- **MPL-2.0 for axe-core** needs a Lead reading. Recommendation: allowed as an unmodified file fetched separately, with a notice.
- **Matrix cost.** Use affected routes per task and the full matrix only at Final Review.
- **automated a11y covers only part of WCAG.** Hence the incomplete handling and the vision judge.
- **The detector port drifts from upstream.** Pinned SHA, fixtures.

---

## 4. Research fetchers and fact caching with provenance (§8.2, §10, §14)

### 4.1 Findings
- **endoflife.date API v1:**
  - shape: `/api/v1/products/{product}/releases/{release}` returns `schema_version`, `generated_at`, `isEol`, `eolFrom`, `isMaintained` and `latest{name, date}`;
  - headers: an `ETag` and `cache-control: public,max-age=0,must-revalidate`;
  - both checked today with one request.
- **deps.dev v3:**
  - `GetVersion` returns SPDX `licenses`, `advisoryKeys` (OSV ids), `slsaProvenances` and `attestations`;
  - `GetProject` returns the `scorecard`;
  - every path and query parameter must be URL-encoded;
  - generated data is CC-BY-4.0, and caching is explicitly permitted.
- **OSV:**
  - endpoints: `/v1/query`, `/v1/querybatch`, `/v1/vulns/{id}`;
  - "Currently there are no limits on the API."
- **Standards:**
  - **RFC 9111** governs HTTP caching and conditional revalidation (`If-None-Match`/`If-Modified-Since`);
  - **RFC 9309** governs robots.txt.
- **Pure-JS extraction stack**, no install scripts:
  - `@mozilla/readability` 0.6.0, Apache-2.0;
  - `linkedom` 0.18.13, ISC;
  - `turndown` 7.2.4, MIT.
- **Crawl4AI** is Apache-2.0 but Python: an optional external tool, not embedded.
- **Injection defences:**
  - *spotlighting* / datamarking (Hines et al., arXiv 2403.14720);
  - CaMeL's split between control flow and data (arXiv 2503.18813), which matches the §10 code-mode tool.

### 4.2 Recommended design
1. **Fetchers.**
   - A `Fetcher { id, version, fetch(req, ctx) }` interface.
   - Built-ins:
     - `eol`
     - `depsdev`
     - `osv`
     - `registry` (npm, PyPI, crates JSON)
     - `github` (`gh api`, using the user's auth)
     - `web` (HTTPS GET → Readability → markdown)
     - `rss`
     - `youtube` (yt-dlp as an optional pinned external binary)
     - `search` (a keyed Exa/Tavily account the user supplies)
   - `research/` gets HTTP through an injected `HttpClient`. Tests use recorded fixtures and make no network calls.
   - Results from the host's own web search are model-reported, so they stay UNVERIFIED until `web` fetches the page.
2. **Network guard.**
   - HTTPS only.
   - Resolve DNS and refuse loopback, link-local and RFC 1918 addresses (SSRF).
   - Byte caps and timeouts.
   - No cookies, and no auth except the fetcher's own key. The key's *name* goes in `~/.vtc/config.yaml`; its value is read from the environment at call time and is a known value for `redactSecrets`.
   - The `web` fetcher respects robots.txt and sends an identifying User-Agent.
3. **Cache.**
   - Location: `~/.vtc/research-cache/<scope>/`, where scope is `_shared` or `client-<slug>`. **No lookup crosses scopes** (§14).
   - Blobs are content-addressed: `blobs/sha256/<hex>`.
   - Index key: `fetcherId@fetcherVersion + canonical request`. Each entry holds `retrieved_at`, `ttl`, `etag`, `last_modified`, `status` and the blob SHA.
   - When stale, revalidate with conditional requests (RFC 9111). Offline, serve the stale copy and mark the fact `stale`.
   - TTL defaults:

     | Fetcher | TTL |
     |---|---|
     | eol | 7 days |
     | deps.dev, OSV, registry, pricing | 1 day |
     | docs at a pinned version | 30 days |
     | web | 7 days |

   - Add the cache directory to `ROLE_DENIED_VTC`.
4. **Facts.**
   - `.vtc/research/facts.jsonl` is git-tracked, redacted and append-only. Rows are superseded, never edited.
   - A row holds:
     - `id`, a hash of subject + claim + source;
     - `subject`, `predicate`, `value`;
     - `status`: `verified|unverified|stale|conflicting|waived`;
     - `source{fetcher, url, retrieved_at, content_sha256, locator}`;
     - `pinned_version`;
     - `expires_at`.
   - **Verification is deterministic.**
     - For structured sources, a JSON Pointer into the cached blob must yield the value.
     - For documents and web pages, a quoted span must appear verbatim in the cached markdown (quote-anchored).
     - A claim whose locator doesn't resolve stays `unverified`. Two sources that disagree make the fact `conflicting`.
5. **G2.**
   - The Architect and the Research Analyst cite `fact` evidence, which already exists in `EvidenceTypeSchema`.
   - The engine's conformance step lists:
     - every `UNVERIFIED:` tag;
     - every fact that is unverified, stale or conflicting;
     - version, licence, CVE and EOL tokens in the research sections that cite no fact.
   - Stale facts are re-fetched before G2.
   - The list fills `approve_gate.unverified_facts`, which today is always `[]`.
   - `approve` must carry `waive_facts[{id, reason}]` for each one, which records `fact.waived`; otherwise the approve is rejected.
6. **Role-facing tools** (AD-4 r3, MINOR): `research_fetch`, `fact_lookup`, `fact_propose`. A role proposes a fact and the engine verifies it. Fetched text reaches roles datamarked, inside delimiters, with a size cap.

### 4.3 Contracts (MINOR)
- **Interfaces:** `Fetcher`, `HttpClient`, `ResearchCache`.
- **Types:** `FetchRequest` (discriminated by fetcher), `FetchResult`, `CacheEntry`, `ResearchScope`, `FactRow`, `FactStatus`, `FactLocator` (`json_pointer` | `quote{text, start, end}`), `FactWaiver`.
- **Engine API:** `ApproveInput.waive_facts?` and the IO of the MCP tools.
- **Helpers:** `factId`, `canonicalCacheKey`, `verifyFactLocator`, `isPrivateAddress`.
- **Events:** `research.fetched`, `fact.recorded`, `fact.verified`, `fact.waived`.

### 4.4 AD-22 (sketch): Research fetchers, cache and facts
- **Binds:**
  - `packages/engine/src/research/**`
  - `~/.vtc/research-cache/`
  - `.vtc/research/facts.jsonl`
  - G2 assembly
- **Prevents:**
  - facts from model memory;
  - clients' context crossing;
  - network access in tests;
  - SSRF and cookie scraping;
  - G2 passing with unverified claims.
- **Rule:**
  1. `research/` is a leaf: it imports no engine module, and `core/` reaches it only through an interface wired in `daemon/`.
  2. Every fact has a locator that resolves against a cached blob whose SHA is recorded.
  3. Cache scopes are per client and never cross.
  4. Fetchers enforce the network guard.
  5. Unverified, stale and conflicting facts block G2 unless a human waives them.
  6. Fetched content is data: datamarked, size-capped and redacted.
- **Check:**
  - dependency-cruiser rules `AD22-research-is-a-leaf` and `AD13-core-does-not-import-research`;
  - shared tests for the locators (a quote that is absent fails), the cache keys and the private-address guard;
  - research tests with fixture HTTP: a 304 revalidation path, scope isolation, a missing waiver rejecting approve.

### 4.5 Risks
- **APIs change.** `fetcher_version` is part of the cache key, and eol's `schema_version` is checked.
- **Terms of service and scraping.** No cookies or logins, robots.txt respected, `gh` rate limits.
- **Cache poisoning.** Content hashes, per-client scopes, role-denied cache.
- **"Verified" can mean only "the source said it".** G2 shows the source and its date.
- **Handling search-API keys.**

---

## 5. Unattended headless runs: Claude Code and Codex (§6.9, §12, D-ba)

### 5.1 Findings: Claude Code
These come from the official headless, CLI-reference and permissions pages.
- **Exit and failure:**
  - exit 0 on success and non-zero on failure;
  - a failure inside the run (such as missing auth) is printed as the result on stdout;
  - SIGTERM exits with **143** and leaves the turn unfinished;
  - SIGINT ends the turn cleanly;
  - `CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` makes a resume continue the interrupted turn.
- **`--bare` never reads OAuth or the keychain and needs an Anthropic API key.** That makes it unusable for VTC under AD-9.
- **`-p` runs repository content without trust.** Without trust it runs the hooks and `env` from project settings and connects `.mcp.json` servers. The docs' remedies:
  - `--setting-sources user`;
  - `--settings '{"disableAllHooks": true}'`;
  - `--strict-mcp-config` with `--mcp-config`.
- **Permissions:**
  - `--permission-mode dontAsk` denies anything that would prompt;
  - `--permission-prompts none` (v2.1.259 or later) denies unanswerable prompts and removes `AskUserQuestion`;
  - denials appear as `permission_denied` events and in `permission_denials`.
- **Caps:**
  - `--max-turns` exits with an error at the limit;
  - `--max-budget-usd` checks a client-side estimate, and totals restored on `--resume` do not count toward it.
- **Background work:** a run waits up to 10 minutes for background work (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`).
- **Stream events:**
  - `system/api_retry` carries `error` ∈ {`authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `billing_error`, `rate_limit`, `overloaded`, …};
  - `system/init` reports `plugins`, `plugin_errors`, `mcp_servers` and `mcp_server_errors`.
- **Auth and resume:**
  - `claude auth status` exits 0 when logged in and 1 when not;
  - `--resume <id>` searches every project on the machine.
- **`--restricted`** loads only managed settings and `--settings`, and removes the command tools unless `--tools` names them.
- **The Agent SDK overview says:** "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products." This bears directly on §12.5.

### 5.2 Findings: Codex
These come from the official non-interactive and CLI-reference pages; spike rows 2, 3 and 6 confirm part of them.
- **Output:** stdout carries the final message; progress goes to stderr.
- **Events (`--json`):** `thread.started`, `turn.started`, `turn.completed`, `turn.failed`, `item.*` and `error`.
- **Flags:**
  - `--output-schema`, `-o`;
  - `--sandbox` (read-only by default);
  - `-c key=value`, `-C`;
  - `--ignore-user-config` (auth still comes from `CODEX_HOME`);
  - `--ignore-rules`, `--ephemeral`.
- **Resume:** `codex exec resume <id>` or `--last`.
- **Removed:** `--full-auto`.
- **New flags of concern:** `--approve-for-me`/`--not-so-yolo` (automatic review) and **`--dangerously-bypass-hook-trust`**, which is not in `AD9_FORBIDDEN_MARKERS`.
- **Auth:** `codex login status` exits 0 when logged in. The docs recommend API keys for automation and treat `auth.json` "like a password".
- **Exit codes are undocumented.**
- **Models:**
  - recommended: `gpt-6.1-sol`, `gpt-6-luna` and `gpt-6-astra`;
  - `gpt-5.5` retires from Codex on **2026-10-14** (today);
  - availability depends on the plan.

### 5.3 Recommended design
1. **Routing (D-ba).**
   - `planDispatch` stays the only decision.
   - Add the purpose `lookback_replay`.
   - Add `DEFAULT_DISPATCH_MODE_BY_LEAD_HOST = { "claude-code": "plugin_only", codex: "plugin_only" }` in shared. The open human question (should a Codex Lead imply headless?) then becomes a one-value change. An explicit `hosts.dispatch` always wins.
   - `hosts.cross_family_review` is read through `planDispatch("cross_family_review")`.
2. **Claude argv** (prompt on stdin, reading 62):
   ```
   claude -p --output-format stream-json --verbose
     --json-schema <structured-output schema>
     --setting-sources user --strict-mcp-config --mcp-config <VTC-only json>
     --settings <VTC settings: sandbox, permissions allow/deny for the profile>
     --permission-mode dontAsk --permission-prompts none
     --allowedTools <profile> --disallowedTools <profile denies>
     --max-turns N --max-budget-usd X [--model <id>] [--resume <session>]
     --plugin-dir <extracted plugin> --agent <host agent name>
   ```
   - `--plugin-dir` + `--agent` keeps the same compiled agent, and so the same prompt SHA, as plugin mode. The fallback is `--agents <file>` with identical instructions.
   - Never `--bare`.
   - Prefer `dontAsk` to `auto`, because the auto classifier is not deterministic.
   - Spike: whether `--restricted` is the answer to the settings-isolation row (reading 48).
3. **Codex argv:**
   ```
   codex exec --json --output-schema <file> -o <file>
     --sandbox <read-only|workspace-write> -c approval_policy="never"
     -c sandbox_workspace_write.network_access=false
     [--ignore-user-config] [--ignore-rules] -C <worktree> [-m <id>]
   ```
   and `codex exec resume <thread_id> …` for a resume.
   - Spike the two ignore flags (reading 72): what they drop, and whether the project's `.codex/config.toml` still loads.
   - Never `--approve-for-me`.
   - Add `--dangerously-bypass-hook-trust` to the AD-9 markers.
4. **Outcome mapping.**
   - **Claude:**
     - `api_retry` with `rate_limit`, or a rejected `rate_limit_event` → `limit`;
     - `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold` or `billing_error` → `auth`;
     - `max_turns` or the budget cap → `error`, with a cause.
   - **Codex:** `turn.failed`/`error` text is matched against usage-limit and auth patterns, and the reset time is parsed out. Rely on events, because the exit codes are undocumented.
5. **Supervision.**
   - Spawn in its own process group.
   - Hard wall timeout plus idle timeout (no stdout line for N minutes).
   - Shutdown: SIGINT, then 10 s, then SIGTERM, then 5 s, then SIGKILL on the group. Exit 143 maps to `error/killed`.
   - One transcript per run under `.vtc/state/`.
   - An environment allowlist: PATH, LANG, TMPDIR, and the *real* HOME, so the host finds its own login. No credential variables.
   - Set `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` explicitly.
   - Leave `CLAUDE_CODE_RESUME_INTERRUPTED_TURN` unset: an explicit "continue" input is deterministic.
6. **Engine-driven auto-resume** (no live Lead; `headless_allowed` only). When the timer wakes the daemon, it runs a preflight:
   1. the pause flag is not set;
   2. `pipeline_config_hash` matches;
   3. usage is re-read and the window is clear;
   4. **`claude auth status` / `codex login status`** exit 0. These are sanctioned commands and read no credentials. On failure, park with `auth` and record an incident; never loop.

   Then it resumes the interrupted steps through `HostAdapter.resume`, prices each Codex resume at about 2× (spike 6), and caps retries.
7. **Codex model ids.** Adapters never hard-code them (AD-6 r2). Without a configured id the session default applies (D-ae). Document an example tier map:

   | Tier | Model |
   |---|---|
   | top | `gpt-6-astra` |
   | mid | `gpt-6.1-sol` |
   | low | `gpt-6-luna` |

   Add a spike row on the owner's Plus plan, and remove any fixture or default that names `gpt-5.5`.

### 5.4 Contracts (MINOR)
- `HeadlessPolicy { wall_timeout_ms, idle_timeout_ms, kill_grace_ms }`, plus `ProjectConfig.hosts.headless{wall_timeout_min, idle_timeout_min}` with defaults.
- `HostOutcome` `error` gains an optional `cause: timeout|idle|killed|max_turns|budget|exit_code`.
- `HostAuthStatus { host, logged_in: boolean|null, method: string|null }` and an optional `HostAdapter.authStatus?()`.
- `DispatchPurpose` gains `lookback_replay`.
- The constant `DEFAULT_DISPATCH_MODE_BY_LEAD_HOST`.
- `AD9_FORBIDDEN_MARKERS` gains `--dangerously-bypass-hook-trust`. An adapter-level `HOST_DISALLOWED_ARGS` lists `--bare`, `--approve-for-me` and `--not-so-yolo`, and the adapter safety contract asserts they never appear.

### 5.5 AD-25 (sketch): Unattended headless runs (amends AD-6 and AD-17)
- **Binds:**
  - both adapters' `headlessCommand`, `spawnRole`, `resume` and `authStatus`
  - the auto-resume path in the daemon
  - `planDispatch`
- **Prevents:**
  - repo-controlled hooks and MCP servers in role runs;
  - prompts that hang unattended runs;
  - retry loops after auth failure;
  - orphaned processes;
  - routing defaults scattered across code.
- **Rule:**
  1. Headless argv isolates project settings and MCP, and denies every unanswerable prompt.
  2. No API-key mode and no automatic approver.
  3. Auth preflight before every unattended start or resume.
  4. Process-group supervision with wall and idle timeouts.
  5. Outcomes come from stream events, never from exit codes alone.
  6. The default dispatch mode per Lead host is one shared constant; an explicit config overrides it.
- **Check:**
  - the safety contract extended with `HOST_DISALLOWED_ARGS` and the presence of the isolation flags;
  - recorded-stream fixtures for limit, auth, max-turns and kill;
  - a fake-process test: an idle timeout kills the group and leaves no orphans;
  - a `planDispatch` table test that includes the per-host default.

### 5.6 Risks
- **Vendor terms.** The Agent SDK note keeps subscription headless use behind §12.5. The plugin-only default is correct.
- **CLI flag churn.** Doctor checks minimum versions (for example `--permission-prompts` needs 2.1.259 or later).
- **User-level hooks still load** under `--setting-sources user`. That is the user's own trust domain; record the behaviour.
- **Budget estimates differ from billing.** The engine's budget is authoritative.
- **Auth expires overnight.** Covered by the preflight and parking.

---

## 6. Single-binary release pipeline (§4.4, D-az)

### 6.1 Findings
- **Bun:**
  - targets: `bun-darwin-arm64`, `bun-darwin-x64`, `bun-linux-x64`, `bun-linux-arm64`, the `-musl` variants and `bun-windows-x64`;
  - the recommended build is `--compile --minify --sourcemap --bytecode`;
  - macOS signing: `codesign` with an entitlements plist. Bun lists `allow-jit`, `allow-unsigned-executable-memory`, `disable-executable-page-protection`, `allow-dyld-environment-variables` and `disable-library-validation`, and needs Bun 1.2.4 or later.
- **GitHub artifact attestations:**
  - `actions/attest@v4` with `subject-path`;
  - permissions `id-token: write`, `attestations: write`, `contents: read`;
  - users verify with `gh attestation verify <file> -R <org>/<repo>`.
- **Immutable releases** became generally available on 2025-10-28. They protect tags and assets, create a release attestation, and are verified with `gh release verify` / `verify-asset`. The recommended flow is draft first, attach assets, then publish.
- **Homebrew:**
  - a tap repo is named `homebrew-<name>`, with formulae in `Formula/`;
  - non-official taps need `brew trust`;
  - the formula's `test do` should not rest on `--version` alone.
- **Notarization:**
  - standalone Mach-O binaries cannot be stapled; Gatekeeper checks online the first time they run. Both are community reports, **UNVERIFIED against Apple's docs**;
  - signing uses `--options runtime` (hardened runtime);
  - zip the binary with `ditto`.
- **pnpm:** `minimumReleaseAge` arrived in 10.16 (in minutes; the default is 1440 since v11). The repo pins pnpm 10.11.0.

### 6.2 Recommended design (files only; nothing pushed, tagged or published)
1. **`.github/workflows/release.yml`** (cli-binary team; does nothing until a remote exists).
   - Triggers: tag `v*`, plus a `workflow_dispatch` dry run.
   - Permissions:
     - top-level `contents: read`;
     - only the publish job gets `contents: write`, `id-token: write` and `attestations: write`.
   - Every action is pinned by full commit SHA.
   - Bun 1.4.3 is installed through a pinned setup action.
   - Steps:
     1. `pnpm install --frozen-lockfile`, then `pnpm verify`.
     2. Cross-compile the five targets on Linux.
     3. Smoke-test on native runners (`vtc --version`, `vtc doctor --offline --json`).
     4. Package `vtc-<ver>-<os>-<arch>.tar.gz` (`.zip` for Windows).
     5. Generate `SHA256SUMS`.
     6. Attest.
     7. Create a draft release, upload, then publish (immutable).
     8. Render the Homebrew formula as a release asset.
   - A macOS signing job runs only when the signing secrets exist; otherwise it is skipped and the assets are marked unsigned.
   - Checksums are computed **after** signing.
   - No `pull_request_target`.
2. **`packages/cli/scripts/release-checksums.ts`:**
   - output `<sha256>  <file>`, LF line endings, sorted, so `sha256sum -c` and `shasum -a 256 -c` accept it;
   - a test.
3. **`packaging/install.sh`** (POSIX sh). Behaviour:
   - the whole body sits in `main()`, called on the last line, so a partial download runs nothing;
   - `set -eu`;
   - detects OS and architecture, and prefers arm64 under Rosetta (`sysctl.proc_translated`);
   - honours `VTC_VERSION`;
   - `VTC_INSTALL_DIR` defaults to `$HOME/.local/bin`;
   - downloads into a `mktemp` directory with a cleanup trap, using `curl --proto '=https' --tlsv1.2 -fsSL`;
   - verifies `SHA256SUMS` with `sha256sum` or `shasum -a 256`, and fails closed if neither exists;
   - runs `gh attestation verify` only when opted in;
   - installs with an atomic `mv`;
   - no sudo and no shell-rc edits.

   Tests put a stub `curl` first on PATH that serves fixtures, so there is no network.
4. **Homebrew.**
   - `packaging/homebrew/vtc.rb.tmpl`, a renderer and a test.
   - The formula has four platform blocks, each with its sha256 taken from `SHA256SUMS`.
   - Its `test do` runs `vtc doctor --offline --json` in `testpath`.
   - Pushing to the tap is a later, separate step.
5. **macOS (pending the human's Developer ID).**
   - Sign with `codesign --options runtime --timestamp --entitlements packaging/macos/entitlements.plist`. Start from Bun's key set and prune it under test.
   - Notarize with `xcrun notarytool submit --wait` on a zip made with `ditto`.
   - No staple for the bare binary.
6. **"Signatures"** (§4.4): GitHub attestations (Sigstore, keyless) plus immutable releases cover the GitHub channel. cosign or minisign can be added later.

### 6.3 Contracts and spine
- No `@vtc/shared` contract is needed. The release helpers (`RELEASE_TARGETS`, `releaseAssetName`, `parseSha256Sums`) stay in `@vtc/cli`, because they cross no package boundary.
- **AD-26 (sketch): Release pipeline.**
  - **Binds:**
    - `.github/workflows/release.yml`
    - `packaging/**`
    - `packages/cli/scripts/release-*`
  - **Prevents:**
    - mutable or unverifiable releases;
    - a CI supply-chain compromise;
    - installers that run half-downloaded;
    - checksums taken before signing.
  - **Rule:**
    1. Actions are pinned by SHA, with least-privilege permissions per job.
    2. Every asset is listed in `SHA256SUMS` and attested, and releases are immutable and draft-first.
    3. The installer verifies the checksum and fails closed.
    4. Signing comes before checksums.
    5. Nothing publishes from a local machine.
  - **Check:**
    - a test that parses the workflow (every `uses:` pinned to a 40-hex SHA; permissions as specified);
    - the checksum script test;
    - `install.sh` tests with a stub curl (bad checksum fails, no hash tool fails, the arch map);
    - the formula render test.
  - **Amends:** AD-10 rule 6 (CI exists once there is a remote) and AD-16 rule 5 (the marketplace branch is published by the same workflow, later).

### 6.4 Risks
- **CI compromise.** Pinned actions and least privilege.
- **A checksum is not authenticity.** Hence attestations.
- **The trust model of `curl | sh`.** Document how to verify instead.
- **Unsigned macOS binaries** may be quarantined when downloaded in a browser.
- **Bun cross-compile correctness.** Smoke tests on native runners.
- **Windows is untested.**

---

## 7. Spine changes requested (integrator / Lead)
1. **New ADs:**
   - AD-21 Lookback
   - AD-22 Research
   - AD-23 Level 3
   - AD-24 Visual
   - AD-25 Headless
   - AD-26 Release
2. **AD-3:** extend Binds with the §1.3/2.3/3.3/4.3/5.4 contracts, as `CONTRACTS_VERSION` 4.5.0, additive.
3. **AD-9:** add `--dangerously-bypass-hook-trust` to `AD9_FORBIDDEN_MARKERS` and to the mirrored `AD9_MARKERS` in `eslint.config.js`.
4. **AD-13:** add the modules `lookback/` (imports `core/` through its index only, and gates through `GateRunner` only) and `research/` (a leaf). `core/` imports neither; `daemon/` wires both.
5. **AD-15 (D-bb):** add `lookback-research` to the ownership of `packages/engine/src/{lookback,research}/**` and their tests, and remove those paths from engine-core.
6. **AD-17:** add rule 5, the per-Lead-host default constant.
7. **§5 readings to record:**
   - editable section delivered in the task pack;
   - pins at user level only;
   - merge-level ledger;
   - novelty v1 = perceptual hash + token vector;
   - axe-core MPL handling;
   - a skipped visual layer does not count as a pass for Level 3.

## 8. Spike rows (§7 of the spine) and UNVERIFIED items
| Check | Why |
|---|---|
| `--restricted` with subscription login: does it keep auth, and does it isolate project settings? | Settings-isolation row (reading 48) |
| `claude -p --plugin-dir <dir> --agent <ns:agent>` resolves a plugin agent | Same prompt SHA in headless mode |
| What `codex exec --ignore-user-config` / `--ignore-rules` drop, and whether a worktree's `.codex/config.toml` still loads | Reading 72 |
| Whether `codex exec resume` accepts `--output-schema`, `--sandbox` and `-C` | Resume argv |
| Codex text for a limit and an auth failure in `turn.failed`/`error` (recorded fixture) | Outcome mapping |
| Codex model ids accepted on the owner's Plus plan (`gpt-6.1-sol`, `gpt-6-luna`, `gpt-6-astra`) | AD-6 r2 example map |
| What `gh pr merge --auto` does on a PR with no unmet requirements | Level-3 preflight |
| Whether non-admins can read `allow_auto_merge` and classic branch protection | Level-3 preflight |
| GitHub's Revert-button PR title and body format | Revert detection |
| Chromium headless shell inside `sandbox-exec` and `bwrap` (Chromium's own sandbox on or off) | AD-24 |
| Whether Playwright publishes browser checksums | `BrowserPin` source |
| Notarizing a bare Bun binary: staple behaviour, minimum entitlements | AD-26 (needs the human's Developer ID) |
| Whether a required workflow lacking a `merge_group` trigger can be detected | Merge-queue preflight |

## 9. Questions for the Lead
1. A visual layer `skipped` because no browser is available: should it block the Level-3 checklist? I recommend yes, and allow it at Levels 1–2 per D-ay.
2. axe-core (MPL-2.0): accept it as an unmodified file fetched separately (from the project, or from doctor into `~/.vtc`), never bundled?
3. Bump pnpm to at least 10.16 and set `minimumReleaseAge: 20160`? (It is a toolchain change, so the Lead must approve it.)
4. Switch every role to "locked core compiled, editable section in the pack" now, or first run an A/A on one role?
5. Novelty check v1 without ML embeddings: a deviation from spec §9.1 step 4.
6. Should a Codex Lead imply `headless_allowed` on Codex? This is now one constant. It stays the human's question, as D-ba says.

---

## Sources
- Anthropic, Demystifying evals for AI agents: https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
- Anthropic, A statistical approach to model evals: https://www.anthropic.com/research/statistical-approach-to-model-evals
- Langfuse, prompt version control: https://langfuse.com/docs/prompt-management/features/prompt-version-control
- Argo Rollouts, analysis: https://argo-rollouts.readthedocs.io/en/stable/features/analysis/
- Spinnaker/Kayenta canary judge: https://spinnaker.io/docs/guides/user/canary/judge/
- gh pr merge: https://cli.github.com/manual/gh_pr_merge
- gh pr checks: https://cli.github.com/manual/gh_pr_checks
- gh pr view: https://cli.github.com/manual/gh_pr_view
- gh run list: https://cli.github.com/manual/gh_run_list
- gh repo view: https://cli.github.com/manual/gh_repo_view
- GitHub, automatically merging a PR: https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request
- GitHub REST, rules for a branch: https://docs.github.com/en/rest/repos/rules?apiVersion=2022-11-28
- GitHub, reverting a PR: https://docs.github.com/en/enterprise-server@3.8/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/reverting-a-pull-request
- Playwright visual comparisons: https://playwright.dev/docs/test-snapshots
- Playwright browsers: https://playwright.dev/docs/browsers
- pixelmatch: https://github.com/mapbox/pixelmatch
- axe-core API (tags, result types): https://github.com/dequelabs/axe-core/blob/develop/doc/API.md
- @axe-core/playwright: https://github.com/dequelabs/axe-core-npm/blob/develop/packages/playwright/README.md and https://www.npmjs.com/@axe-core/playwright
- npm registry metadata (versions, licences, dates; queried 2026-10-14): https://registry.npmjs.org/
- impeccable repo, LICENSE, NOTICE: https://github.com/pbakaus/impeccable, https://raw.githubusercontent.com/pbakaus/impeccable/main/LICENSE, https://raw.githubusercontent.com/pbakaus/impeccable/main/NOTICE.md
- impeccable detector docs: https://impeccable.style/docs/detector
- endoflife.date API v1: https://endoflife.date/docs/api/v1/ (probed at https://endoflife.date/api/v1/products/nodejs/releases/22)
- deps.dev API v3: https://docs.deps.dev/api/v3/
- OSV API: https://google.github.io/osv.dev/api/
- RFC 9111 HTTP caching: https://www.rfc-editor.org/rfc/rfc9111
- RFC 9309 robots exclusion: https://www.rfc-editor.org/rfc/rfc9309
- Spotlighting (arXiv 2403.14720): https://arxiv.org/abs/2403.14720
- CaMeL (arXiv 2503.18813): https://arxiv.org/abs/2503.18813
- Crawl4AI: https://github.com/unclecode/crawl4ai
- Claude Code headless: https://code.claude.com/docs/en/headless
- Claude Code CLI reference: https://code.claude.com/docs/en/cli-reference
- Claude Code permissions (what runs before trust): https://code.claude.com/docs/en/permissions
- Claude Agent SDK overview (third-party login note): https://code.claude.com/docs/en/agent-sdk/overview
- Codex non-interactive mode: https://developers.openai.com/codex/noninteractive (redirects to https://learn.chatgpt.com/docs/non-interactive-mode)
- Codex CLI reference: https://developers.openai.com/codex/cli/reference (redirects to https://learn.chatgpt.com/docs/developer-commands?surface=cli)
- Codex models: https://developers.openai.com/codex/models (redirects to https://learn.chatgpt.com/docs/models)
- Codex local config: https://developers.openai.com/codex/local-config
- Codex approval and sandbox (third-party, used only where marked): https://codex.danielvaughan.com/2026/03/26/codex-cli-approval-modes-sandbox-security
- Bun single-file executables: https://bun.com/docs/bundler/executables
- GitHub artifact attestations: https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/using-artifact-attestations-to-establish-provenance-for-builds
- GitHub immutable releases: https://github.blog/changelog/2025-10-28-immutable-releases-are-now-generally-available/ and https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases
- Homebrew taps: https://docs.brew.sh/How-to-Create-and-Maintain-a-Tap
- Homebrew Formula Cookbook: https://docs.brew.sh/Formula-Cookbook
- Notarizing CLI tools (community): https://developer.apple.com/forums/thread/725942 and https://mjtsai.com/blog/2019/06/17/notarizing-command-line-tools-for-macos-10-15/
- pnpm dependency-resolution settings: https://pnpm.io/settings/dependency-resolution
- Repo context read: `docs/superpowers/specs/2026-10-12-vtc-system-design.md` (§4.4, §6.7–6.9, §7.5–7.6, §8.2, §9.1, §10, §12–16), `docs/architecture/vtc-spine.md` (AD-1–AD-20, readings to 95, §7), `docs/research/2026-10-13-spike-results.md`, `docs/research/2026-10-13-impeccable-style.md`, `packages/shared/src/{engine-api,feature,project-config,event-payloads,primitives,plugin-manifest}.ts`, `packages/shared/src/interfaces/{git,host-adapter}.ts`, `packages/shared/src/helpers/dispatch.ts`, `roles/lookback/role.yaml`

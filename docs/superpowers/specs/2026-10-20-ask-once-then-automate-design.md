# Ask once, then automate

Date: 2026-10-20. Status: draft for the owner's approval.

## Why

The owner runs VTC on their own projects (bs-kara, bs-job-agents) and it does not work the way
they expect. What they want is simple:

> Have the team of agents work on what I ask. It can be a big project from scratch, a task, or
> a bug that needs research in the source, architecture or UI design. Clarify with me before
> doing, then automate: build it, verify it really matches what I asked, create the PR, and
> merge if everything is OK.

What happens today instead, from the run logs (`.vtc/runs/*/events.jsonl` in both projects):

- **bs-kara, r20261016-052258 (autoplay bug, quick fix).** The BA asked 2 real questions. After
  that, the Architect and Security agents couldn't read their own task packs (`claim_check: does
  not resolve: file .../.vtc/state/packs/a-7.md`, 8 rejections). Their packs said "no
  specification" and gave an empty write scope, and the `design-craft` skill was missing. Each
  failure became a question for the owner (E-3 to E-6): "Can you supply the specification…?",
  "Will you authorize .vtc/architecture/threat-model/**…?", "Provide the design-craft skill…".
  The owner can't fix any of these. They are VTC's own faults.
- **bs-job-agents, r20261017-011302.** The BA asked the same question 4 times: "How should I access
  the task pack… the role contract prohibits shell commands, and no permitted file-reading
  capability is available." The owner aborted the run.
- **bs-job-agents, r20261017-044722.** About a dozen results were rejected for format reasons
  (`result.task: expected string, received null`; questions with no `options`/`recommended`;
  `waive requires waiver_expires_at`; `findings.0.evidence: expected object, received array`;
  `spec_ref .vtc/spec/spec.md#REQ-23 does not resolve`). Security asked twice about an empty
  write scope. The Planner's tasks covered requirement ids that didn't exist ("T-1 covers unknown
  REQ-21"). The owner aborted the run.
- **bs-job-agents, r20261018-074219** got furthest. It is waiting on a second G2.

The owner also finds the text VTC shows them hard to read. It speaks in internal codes (D1, G1,
G2, E-3, REQ-23, "write scope", "pack") instead of normal words.

## Goals

1. **Ask once.** For every human-started run, the team does its research first, then asks the
   owner all of its questions in **one round**, in plain words. Once that round is answered, VTC
   doesn't ask the owner anything else it could decide itself. Exceptions are the hard stops in
   goal 5.
2. **VTC's problems are VTC's.** A fault inside VTC is never presented to the owner as a question
   about their project. That covers an unreadable or empty task pack, a missing write permission,
   a missing skill or tool, an agent's result that doesn't fit VTC's format, and a reference VTC
   can't resolve. VTC fixes or retries it, records it as its own defect, and only stops the run
   when it can't go on. When it stops, it says plainly that the problem is VTC's.
3. **Plain language.** Everything VTC shows the owner reads like a capable colleague wrote it:
   questions, options, status, wait reasons, notices, gate or review screens, and the PR
   description. Internal ids (G1, G2, E-n, REQ-n, SEC-n, AD-n, T-n, D-n, action ids) never stand in
   for words. They may appear only as references next to the words (for example "the playback
   requirement (REQ-3)"), or in an appendix for traceability.
4. **Auto-merge when it's proven.** Once the work passes every gate, has evidence for every part of
   the request, and the reviewer agent approves the PR, VTC merges it into the main branch. In a
   repo with no CI on GitHub, VTC's own local gate results count as CI, **but only when the
   project's setup turns that on**. Otherwise VTC opens the PR with all the evidence and a
   plain-words note saying why it didn't merge, and leaves it for the owner.
5. **Hard stops stay.** VTC still stops and asks the owner about a budget raise, a security
   finding, a dependency or licence rule, a sensitive path, a fix loop that is stuck or at its
   cap, and an expired login. The owner agreed to these.

6. **Several runs at once.** One project can have several VTC runs going at the same time, each
   started from its own Claude Code or Codex session, each ending in its own PR (§5).

## Non-goals

- No change to the pipeline's roles, phases or gates (discover, specify, design, plan, build,
  integrate, final review, release, retro all stay).
- No change to Lookback, replay or the upstream issue and PR automation (AD-21, AD-27). The only
  exception is that VTC's own faults (goal 2) feed the incidents they already read.
- No new hosts, and no removing the Codex or Claude Code paths.

## Anti-goals (failure even if it "works")

- The owner is asked a second time, after the clarifying round, about something VTC could have
  decided or fixed.
- A message to the owner that only makes sense if you know VTC's internals.
- A merge into main whose local gates didn't pass on the exact merged commit, or a merge without
  the reviewer agent's approval.
- VTC changing the repo's GitHub settings, using `--admin`, or pushing to the base branch (AD-23
  rules stay).
- Auto-merge turned on for a project that didn't opt in.

## Design

### 1. One clarifying round, then autopilot by default

- **Autopilot becomes the default** for human-started runs: `autopilot` defaults to `true`, and
  `autopilot: false` in `.vtc/project.yaml` or `start --no-autopilot` brings back today's G1/G2
  stops. *(This replaces "autopilot is opt-in" in spine §5 reading 271.)*
- **The clarifying round** is the BA's questions at the end of `specify` (after `discover`'s
  research and repo map, so the questions are informed). The Lead presents them **together, as one
  message**, in plain words, each with a recommended answer. Answering them is the owner's approval
  of the requirements. The engine then approves G1 and G2 itself, as autopilot does today, and the
  PR lists the spec and design files it approved.
- The round always **ends with a short plain summary** of what the team understood and is about to
  build, and the owner replies "go" or corrects it. If the BA has no questions, the summary is the
  whole round. *(My call: the owner always gets one look at the understanding before work starts.
  That's what they asked for.)*
- **Where the round starts and ends:** it opens with the BA's first questions and closes when the
  owner says "go" to the summary. Inside that window, everything goes to the owner, batched: the
  BA's follow-up questions after the owner's answers, and any re-spec after a correction. Today's
  autopilot answers to `spec_question` are switched off inside the window. After "go", the rules
  below apply. *(My call.)*
- **After the round**, any question a role raises is decided by the engine with the recommended
  option, as long as that option only sends the work on. These are the effects `clarify`, `hint`,
  `retry` and `replan`, as in `autopilot.ts`. Every such decision is listed in plain words in the
  PR.
- **When autopilot can't decide**, it no longer turns into a question for the owner by default.
  That happens when a question has no recommended option, or it has already answered the same
  role in the same scope `AUTOPILOT_MAX_REPEATS` times, or it has hit `AUTOPILOT_MAX_ANSWERS`. In
  that case the engine **parks the affected task**, keeps going with everything that doesn't
  depend on it, and the run ends in a PR that says what was left undone and why. A parked task
  blocks auto-merge (§4). If nothing else can proceed, that's the one time the owner is asked
  again, and the message says the team is stuck on X and what they could tell it.
- **What "park and keep going" means** *(my call)*:
  - The task gets a distinct status, or a distinct park reason (the builder picks which), meaning
    "set aside by VTC, not waiting on the owner". `next` must not wait on it the way it waits on a
    human-parked task.
  - A feature whose remaining tasks are all merged, done or set aside still integrates, goes
    through Final Review and opens its PR with the work that was done. The Spec Verifier marks the
    criteria the set-aside tasks cover as not done, and the PR lists them in plain words. That PR
    is never auto-merged.
  - The run then finishes. Each set-aside task becomes an issue in the project's repo through the
    existing path ("a parked task VTC cannot resolve", AD-27), so a later run can pick it up. The
    run does not stay open waiting for an answer.
- A role's question **must** carry options and a recommended one. A question without them is a
  format fault (§2), sent back to the role. It's never shown to the owner.
- The hard stops (goal 5) keep today's behaviour: they ask the owner, batched, in plain words.

### 2. VTC's own faults never become the owner's questions

Two parts: fix the faults seen in the logs, and make sure any such fault in the future is
handled by VTC.

**2a. Fix the faults from the logs.** Reproduce each one on current `main` first (some may already
be fixed). The two marked *in progress* are uncommitted changes in the working tree on
2026-10-20: `packages/engine/src/core/dispatch.ts`, `packages/engine/src/mcp/server.ts`,
`packages/shared/src/json-schema.ts` and their tests.

| # | Fault | Seen in |
|---|-------|---------|
| 1 | Security (design mode) pack has an empty write scope. It should use the mode's `write_paths` (`.vtc/architecture/threat-model/**`). *In progress.* | kara E-5, job-agents 044722 |
| 2 | A Lead-submitted result with `null` for absent fields (`mode`, `task`, `feature`) is rejected by the schema. *In progress.* | job-agents 044722 |
| 3 | A role that cites its own task pack (absolute path, `../../packs/a-n.md`, `a-n.md:39`) fails `claim_check`. Either packs resolve as evidence, or the role prompt forbids citing them and the check says so plainly to the role. | kara a-6 to a-16 |
| 4 | Design-phase packs (Architect, Security) on the quick-fix track arrive without the frozen spec and repo map ("the task pack supplies no specification"). | kara E-3, E-4 |
| 5 | `design-craft` (and any skill a role is told to load) isn't available to a headless Codex role. | kara E-6 |
| 6 | A headless Codex BA can't read files: its contract forbids shell and it has no other reader. | job-agents 011302 E-1 to E-4 |
| 7 | Common format slips rejected over and over: question without `options`/`recommended`, a waive option without `waiver_expires_at`, `evidence` as an array, `covers` ids not in `REQ-n`/`SEC-n` form, unknown `missing_capability` / `outcome` keys. | job-agents 044722 |
| 8 | `spec_ref` forms the roles naturally write (`spec.md#REQ-23`, `spec.md:39`, `spec.md`) don't resolve. | job-agents 044722, 074219 |
| 9 | Planner tasks cover requirement ids the spec doesn't have (REQ-21, REQ-22, REQ-26). | job-agents 044722 |
| 10 | `dispatch_mismatch: task T-14 does not match the dispatched undefined` on the first BA result. | kara a-1 |

For faults 5 and 6 *(my call)*:

- The engine puts the content of every skill a role is told to load into its pack, or into a file
  the pack points to inside the role's readable scope. A role never needs a host skill lookup to
  do its job.
- Headless roles that only read get a read-only way to see the repo and `.vtc/` that their
  contract allows. Preferred: a scoped `read_file`/`list_files` tool on the role MCP surface
  (AD-4 `ROLE_MCP_TOOLS`), confined to the repo root, with no writes and no network. The fallback
  is a read-only shell allowlist (`cat`, `sed -n`, `rg`, `ls`) in the Codex headless policy
  (AD-25). Either way, no role gains write or network access it doesn't have today.

For each one: a failing test first, then the fix. For 7 and 8, prefer a fix that accepts the
reasonable form, or tells the role exactly what to change, over a stricter prompt alone.

**2b. Handle the class, not just these cases.**

- The engine **classifies** each escalation as either an *owner decision* or a *VTC fault*. It's a
  VTC fault when the role's question or block is about VTC's own machinery: its pack, its inputs,
  its write scope, a missing skill, tool or capability, or VTC's format. The classification uses
  deterministic signals first: the escalation's evidence points into `.vtc/state/packs/`, the
  pack's own write scope or inputs are empty, or the named skill or tool isn't in the role's
  compiled agent. It also uses a new field on the role's question/block, `about: "project" |
  "vtc"`. The role prompt explains it, and the deterministic signals win over it. *(The exact
  signal list is left to the builder. It must catch all ten faults above.)*
- **A VTC fault is never shown to the owner as a question.** The engine:
  1. records an `incident.recorded` of a new kind, so the existing AD-27 path turns repeats into a
     bs-vtc issue;
  2. retries once with whatever it can fix itself (rebuild the pack, add the mode's write paths,
     attach the skill), passing the role a plain note of what changed;
  3. if that fails, parks the step and goes on with what doesn't depend on it, as in §1;
  4. if the whole run is blocked, tells the owner once, plainly: "VTC hit a problem of its own
     (…). It's been recorded. Updating VTC (`vtc update`) or re-running may fix it." It never asks
     the owner to supply something VTC itself should have provided.
- Rejections of an agent's result for format (`schema`, `claim_check`, `dispatch_mismatch`,
  `undeclared_output`) already loop back to the role. They must stay invisible to the owner,
  except as a count in status.

### 3. Plain language everywhere the owner reads

- **One rule, stated in the Lead skill and in every role prompt that writes owner-facing text**
  (questions, options, summaries): write for a capable person who doesn't know VTC. Use short
  sentences and normal words. Name things by what they are ("the requirements", "the design",
  "the playback task"). An id appears only after the words, in parentheses, if at all.
- **The engine's own strings** go through this too: escalation questions it composes, wait and
  notice texts, status, `vtc status` / `vtc escalations` output, gate and review screens, and PR
  descriptions. Examples: "G1" becomes "the requirements review"; "awaiting G2" becomes "waiting
  for you to look at the design"; "parked" becomes "set aside: …".
- **The Lead translates.** When it shows the owner anything, it puts ids into words, using the
  run's own spec and plan to name REQ-n, T-n and so on.
- **The "who should have caught it" line** in the Lead's escalation format goes away for the
  owner. The Lead still records `who_should_have_caught` from its own suggestion.
- **A check:** a test over the fixture runs' owner-facing outputs (escalations, status, PR
  description, Lead-facing action texts marked for the human) fails if an internal id appears
  without nearby words, or if a known jargon term ("pack", "write scope", "dispatch", "gate G")
  appears. *(The builder chooses the exact matcher and allowlist.)*
- Language: English, simple words. The owner writes English as a second language, so avoid
  idioms.

### 4. Auto-merge when it's proven

Today's Level 3 (`merge_level: 3`, AD-23) already merges through `gh pr merge --auto
--match-head-commit <sha>` after GitHub's required checks pass and the `autoMergeChecklist`
(seven items with evidence) is ok. Its preflight refuses repos with no required status check on
the base and drops them to Level 2. The owner's repos likely have none.

Changes:

- **A new project setting, off by default:** `auto_merge.local_gates_as_ci: true` (name is my
  call). With `merge_level: 3`, it lets a repo **with no required GitHub checks** auto-merge on
  VTC's own gate results instead:
  - Preflight: GitHub remote, `gh` logged in, a merge method allowed. `no_required_checks` is no
    longer a failure. It becomes a recorded note: "merging on VTC's local checks".
  - Merge: VTC's full gate suite (typecheck, lint, tests, security, accessibility, visual) must
    have passed **on the exact gated SHA** that the PR's head matches. Then `gh pr merge
    <n> --match-head-commit <sha>` with the repo's merge method (no `--auto`, since there are no
    checks to wait for). A head that moved, or a gate result for a different SHA, means no merge.
  - **Gates that don't apply** *(my call)*: a gate the project's calibration left unconfigured
    (for example no lint script), or a visual step on a change with no UI, counts as *not
    applicable*. It's recorded in the PR and doesn't block. A gate that applies but couldn't run
    (`skipped` for no browser, `error`, `unchecked`) blocks, as AD-23 rule 3 says. At least one
    test gate must have run and passed. VTC's own acceptance tests count, so "tests passed
    locally" is always real.
  - If the repo *does* have required checks, they still have to pass. The setting only fills the
    gap when there are none.
  - The post-merge watch keeps looking for reverts, and for base CI if any shows up later. A
    revert still downgrades the level (AD-23 rule 4).
- **The reviewer agent's approval is required.** Final Review (reviewers plus Spec Verifier over
  the integrated feature) is the "another agent reviews the PR" step. It must end with no open
  finding at or above `auto_merge.block_severity`, and with a PASS from the Spec Verifier for every
  acceptance criterion. The builder confirms that Final Review sees exactly the PR's final diff. If
  it doesn't, add a last review pass on the PR head.
- **Evidence required to merge:** the existing checklist items, plus a PASS per acceptance
  criterion, plus screenshots and a visual pass for UI work. All of it goes in the PR, whether it
  merges or not.
- **What blocks auto-merge and leaves the PR for the owner:** any checklist item not met, a parked
  or set-aside task (§1, §2), a hard stop that is still open, a security finding or risk rule the
  owner chose to override *(my call: the owner sees risky work before it lands, even after
  approving it)*, a visual step skipped or
  unchecked (AD-23 rule 3), and a diff over `risk_rules` limits. The PR description then opens with
  a plain-words "Why this wasn't merged automatically" list.
- **Autopilot's decisions don't block the merge.** They're listed in the PR. *(My call: the owner
  said merge if the evidence and the review pass, and blocking on every recorded decision would
  bring the stops back.)*
- **Enabling it:** `vtc init` asks once, in plain words, whether VTC may merge its own PRs into
  the main branch when everything passes. If yes, it writes `merge_level: 3`, and also
  `auto_merge.local_gates_as_ci: true` when the repo has no required checks. Existing projects
  turn it on by editing `.vtc/project.yaml`. The engine still never edits that file (AD-23
  rule 5).

### 5. Several runs on one project at the same time

The owner wants to open two or three Claude Code (or Codex) sessions on the same project and run
separate requests side by side. For example, a bug fix in one window while a feature is built in
another. Each run gets its own team, branch, worktrees and PR. Today `start` refuses with
`run_active` while any run is open (`engine.ts`, `startRun`), and much of the code assumes one
"active run".

- **One engine, many runs.** The single-writer engine per repo stays (AD-12 lock). It serves every
  open run, each with its own event log (`.vtc/runs/<run>/`, already per run). The `run_active`
  refusal goes away. A limit `max_open_runs` (default 3, in `project.yaml`) replaces it, and
  going over it is refused in plain words.
- **Each session drives its own run.** `start` binds the calling Lead session to the run it
  created. `next`, `submit`, `answer`, `status`, `escalations`, `change`, `pause`, `resume` and
  `cancel` then act on that session's run without the Lead passing an id. The `run` input that
  most tools already take stays as an explicit override. A tool call from a session with no bound
  run, while several are open, gets a plain list to choose from instead of a guess. `continue` in
  a new session re-binds to a run that has no live Lead, or offers the choice. *(How a session is
  identified, from the MCP connection or a session ref the Lead passes, is left to the builder.)*
- **Each run's questions stay in its own window.** The clarifying round, hard stops and notices go
  to the session that drives that run, and an answer only touches that run. `vtc status`,
  `vtc escalations` and the dashboard show all runs, each named by its request in plain words.
- **No shared files trodden on.**
  - A run's spec, design, architecture notes and threat model are written under that run's own
    paths (for example `.vtc/spec/<run-slug>/…`, the builder picks the layout). They're committed
    on the run's own branch, never on the branch the owner has checked out. *(Today the engine
    commits tracked `.vtc/` files on the checked-out branch at G1 and G2. That must change, or two
    runs would race on the owner's branch.)*
  - Project-wide files that a run updates, like the architecture spine or `.vtc/merge-level.jsonl`,
    change only on the run's branch and land with its PR, so git merges them like any other file.
- **Shared limits are shared.** `concurrency` (parallel role agents) and the usage reserve stay
  per project, across all runs. The engine splits them fairly (round-robin between runs with work
  ready) so one big run can't starve a small fix. Budgets stay per run and per task.
- **When two runs touch the same code** *(my call)*:
  - Each run works from the main branch as it was when the run started.
  - When one run merges into main, every other open run that hasn't released yet rebases its
    feature branch onto the new main, at its next integrate or release step. It then re-runs its
    gates and Final Review on the new SHA, as AD-23 already requires a merge to be bound to the
    gated SHA.
  - If the rebase conflicts, the engine sends it to the run's Engineer as a normal fix round
    (`queued → fixing`, already in the task state machine), within the fix cap.
  - If it still can't be resolved, the run opens its PR with the conflict explained in plain words
    and doesn't auto-merge. It never asks the owner mid-run about it.
  - Two runs never release into main at the same moment. Releases go through one queue per repo.
- **Pause, resume and cancel:** from a session, they act on that session's run. `vtc pause` in a
  terminal is still the kill switch for all runs. `vtc pause <run>` and `vtc cancel <run>` act on
  one.
- **Automatic runs** (from issues, AD-27) count against `max_open_runs` like any other. Today they
  wait for "the current run to finish". Now they wait only while the project is at its limit.

### 6. Spine and contract changes

- **Spine:**
  - Amend reading 271: autopilot is the default; parking replaces asking after the clarifying
    round; autopilot may merge at Level 3.
  - Amend AD-23: `local_gates_as_ci`; preflight and merge without required checks; the Prevents
    line becomes "a merge without CI, *unless the project opted into VTC's local gates as CI*".
  - Add a reading for VTC-fault classification (§2b) and one for the plain-language rule (§3).
  - Amend AD-7 and AD-12: one engine serving many open runs, per-run artifact paths, run
    artifacts committed on the run's branch, a per-repo release queue (§5). README drops "A repo
    runs one VTC run at a time."
- **Contracts:** additive (MINOR) changes:
  - the new `about` field on role questions and blocks;
  - the new incident kind;
  - `auto_merge.local_gates_as_ci` in `ProjectConfig`;
  - the default for `autopilot`.
- **Lead skill:** the Autopilot, Escalations and Gates sections change to match. "It never merges
  into the default branch" goes away.
- **README and CHANGELOG** say it in the same plain words.

## How we'll know it works

- **Golden runs** (`fixtures/`) built from the two real requests (the bs-kara autoplay bug, the
  bs-job-agents "use MCP/API and auto-update the CV" feature), with fake roles that reproduce the
  logged faults 1 to 10:
  - the owner sees **exactly one** message before the PR, the clarifying round;
  - no owner-facing text fails the plain-language check;
  - each VTC fault shows up as an incident, not an escalation.
- A golden run whose roles ask a second-round question, and one that repeats a question past the
  cap: no owner message, the task is parked, and the PR says so and isn't auto-merged.
- Level-3 tests with a fake `RemoteMergeService`:
  - no required checks and the setting off → Level 2;
  - no required checks and the setting on → merges only on the gated SHA, with all local gates
    passed and Final Review clean;
  - a moved head, a failed gate, an open finding or a parked task → PR left with the reasons;
  - `--admin` never appears.
- Two runs started from two fake Lead sessions on one repo:
  - each session sees only its own run's questions;
  - their spec and design files don't collide;
  - the owner's checked-out branch gets no commits;
  - the shared concurrency limit is respected, and a small run isn't starved;
  - when the first merges, the second rebases, re-gates and merges, or, on an unresolvable
    conflict, leaves its PR with the reason;
  - a third and fourth run over `max_open_runs` is refused in plain words.
- A hard-stop fixture (a security finding, a budget raise) still asks the owner, in plain words.
- `pnpm verify` passes.

## Left to the builder

- The exact signals for classifying VTC faults, the retry fix-ups per fault, and the incident kind
  name.
- The plain-language matcher, its allowlist, and the wording of the engine's strings (in the
  spirit of the examples).
- Whether the "no questions" clarifying summary is a BA output or Lead-composed from the spec.
- How the work splits into PRs and the order. Suggested order: §2a (it unblocks real runs today),
  then §1 and §2b, then §3, then §4, then §5. §5 can start in parallel after §2a. It touches the run registry, the
  git workspace and the MCP session binding rather than the autopilot code.

# Token calibration for difficulty routing (H-9, D-cm), 2026-10-15

Round 5 makes the starting model tier of per-task roles follow task difficulty (spine §5 readings
217–219). This note says how to measure what that does to cost and quality on 5 tasks, before and
after, and gives an offline estimate to compare the measurement with. The measurement needs real
host runs, which no test and no team may make (D-cl allows the adapters team's named scripts only),
so the Lead runs it after the round-5 merge.

**Status (2026-10-15, round 6; spine §5 readings 241, 242 and 245):** not run yet. The Lead runs
it after round 6, with D-cu (reviewers start on their own tier) and D-cv (a Low start escalates
after every failed round) in, on 5 small real tasks in a throwaway project (D-cy). Until it is
measured, `routing.start` stays `difficulty`. D-cu answers the reviewer-tier question the round-5
estimate raised: the offline estimate below is updated and now puts the total about flat (+0.6%)
on its 5-task mix, with the Engineer about 18% cheaper. The measured table stays empty until the
Lead runs the two arms.

## What changes

| Run                                         | Before (`routing.start: role`)  | After (`routing.start: difficulty`)                     |
| ------------------------------------------- | ------------------------------- | ------------------------------------------------------- |
| Engineer family                             | Mid (`role.yaml`)               | S/no tag Low; M or tagged S Mid; L or high-risk tag Top |
| QA author                                   | Mid                             | as the rule, never below Mid                            |
| QA judge, lens roles, Visual QA             | Mid                             | own tier (D-cu)                                         |
| Security verify, cross-family reviewer      | Mid                             | own tier; one tier up on a high-risk task (D-cu)        |
| Spec Verifier (one call per AC)             | Low                             | own tier, always (D-cu)                                 |
| Escalation                                  | one tier up after 2 failed rounds, fresh session | a Low start one tier up after every failed round (Low, Mid, Top in rounds 1–3, D-cv); a Mid or Top start after every 2 |
| Reviewers at 70% of budget                  | one tier down                   | the same, from the routed tier                          |
| Non-task roles (BA, Architect, Planner, …) | `role.yaml`                     | unchanged                                               |

`project.yaml` `routing.min_tier` / `max_tier` clamp every chosen tier in both arms.

## Protocol

1. **Project.** A scratch repo with a committed `.vtc/project.yaml` and `.vtc/gates.yml`, no
   GitHub remote (automation off), one host (Claude Code, so the tiers map to model ids), pinned
   prompt versions (no canary, no Lookback during the runs).
2. **Tasks.** Five tasks that cover the table's cells, written as one feature request the Planner
   splits, or as five quick-fix requests: two S tasks with no risk tag, one S task with a tag (for
   example `perf`), one M task with no tag, one L task tagged `auth`. Keep the same five requests
   for both arms.
3. **Arms.** Run the five with `routing: { start: role }` committed (before), reset the repo to
   the same base, then run them with the key removed (after). Same host, same plan, fresh
   sessions, no human hints beyond what both arms get.
4. **Record**, per task, from `.vtc/runs/<run>/events.jsonl`:
   - every `role.dispatched`: role, mode, `tier`, `tier_reason`, `tier_clamped`;
   - every `role.submitted`: `tokens` (in, out, cache read, cache write) and `cost_usd`;
   - rounds to done, escalations, parks, first-round gate pass, review pass.
5. **Compare** total and per-task `cost_usd` and tokens by tier, and the quality columns. A task
   whose rounds rise, that parks, or that loses a review pass in the after arm is a quality
   regression, whatever it saves. Write the table into the round-5 results and, if a cell's cost
   rises with no quality gain, let Lookback's routing scorecard (D-cn) take it from there.

A query that pulls the numbers (run it in the scratch repo):

```sh
jq -c 'select(.type=="role.dispatched" or .type=="role.submitted")
  | {task, role, type, tier: .data.tier, why: .data.tier_reason, model, tokens, cost_usd}' \
  .vtc/runs/<run>/events.jsonl
```

## Offline estimate

Prices: the token-economy research's list prices per million tokens (Haiku 5.5 $0.10 in / $0.50
out, Sonnet 5.5 $2 / $10, Opus 5.5 $4 / $20), cache reads at 10% and cache writes at 125% of the
input price. Token profile: the golden run's Engineer dispatch (42,000 in, 6,100 out, 180,000
cache read, 9,000 cache write), applied to every dispatch, which overstates the reviewers. One
dispatch then costs about $0.010 on Low, $0.204 on Mid and $0.407 on Top. Per task: one Engineer
round, QA author, QA judge and three Spec Verifier calls, no escalation.

| Task          | Before  | After (D-cm, round 5) | After (D-cu, round 6) | Engineer only, before → after |
| ------------- | ------- | --------------------- | --------------------- | ----------------------------- |
| S, no tag (×2) | $0.64 each | $0.25 each         | $0.45 each            | $0.20 → $0.01 each            |
| S, tagged     | $0.64   | $1.22                 | $0.64                 | $0.20 → $0.20                 |
| M, no tag     | $0.64   | $1.22                 | $0.64                 | $0.20 → $0.20                 |
| L, `auth`     | $0.64   | $2.44                 | $1.05                 | $0.20 → $0.41                 |
| **Total**     | **$3.21** | **$5.39 (+68%)**    | **$3.23 (+0.6%)**     | **$1.02 → $0.83 (−18%)**      |

Under D-cu only the Engineer and QA author move with the task: QA judge stays on Mid and the Spec
Verifier on Low. On the L `auth` task the Engineer and QA author start on Top. A real high-risk
task also gets Security verify, which D-cu starts one tier above its own tier (Mid to Top, about
$0.20 more per call); the mix above has no Security call, as in round 5.

What the estimate says, to check against the measurement:

- **The Engineer saves.** About 18% on this mix: the two plain S tasks drop to Low, and only the
  L task rises to Top.
- **The reviewers no longer cost more.** Under round 5's D-cm the reviewers followed the rule,
  so the Spec Verifier (own tier Low, one call per acceptance criterion) moved to Mid and Top and
  the total rose by about 68%. D-cu (reading 241) keeps every reviewer on its own tier, except
  Security verify and the cross-family reviewer one tier up on a high-risk task, so the total is
  about flat on this mix. QA author still moves with the task (never below Mid).
- **Low no longer burns rounds.** Under D-cv (reading 242) a Low start runs Low, Mid and Top in
  rounds 1 to 3, so the low-risk round cap of 3 reaches Top. Watch the S tasks' rounds and parks
  in the after arm: a failed Low round now costs one cheap round before Mid.
- **Codex.** `DEFAULT_TIER_MODELS.codex` holds the ids from the Codex model docs since the
  round-5 merge (reading 229(4): `gpt-6-luna` Low, `gpt-6.1-sol` Mid, `gpt-6-astra` Top), so a
  Codex calibration measures models as on Claude Code. Whether the owner's plan accepts those
  ids is no longer asked: a refused id is retried once on the host default and recorded
  (`role.dispatched.model_fallback`, D-cx, reading 244), and Codex runs are priced from VTC's
  default table (H-12, reading 236).

## Measurement

Not run yet (see the status above). Record per task: arm, tiers dispatched (with reasons), rounds,
escalations, parks, first-round gate pass, review pass, tokens and `cost_usd`; then the totals of
each arm.

# Token calibration for difficulty routing (H-9, D-cm), 2026-10-15

Round 5 makes the starting model tier of per-task roles follow task difficulty (spine §5 readings
217–219). This note says how to measure what that does to cost and quality on 5 tasks, before and
after, and gives an offline estimate to compare the measurement with. The measurement needs real
host runs, which no test and no team may make (D-cl allows the adapters team's named scripts only),
so the Lead runs it after the round-5 merge.

**Status (2026-10-15, the round-5 second fix round; spine §5 readings 232 and 233):** not run
yet. Neither fix round could make a real host run, so this note still holds the protocol and the
offline estimate only; the measured table below is empty until the Lead (or the human) runs the
two arms. Because the estimate predicts a total rise driven by the reviewers, the default
`routing.start: difficulty` should not ship in a release before the measurement, or before the
human decides the reviewer-tier question below; reading 233 puts that question to the human. A
reviewer's own cells can now also reach the table through a routing PR the upstream module makes
itself (reading 233), once Lookback's scorecard shows the cost.

## What changes

| Run                                         | Before (`routing.start: role`)  | After (`routing.start: difficulty`)                     |
| ------------------------------------------- | ------------------------------- | ------------------------------------------------------- |
| Engineer family                             | Mid (`role.yaml`)               | S/no tag Low; M or tagged S Mid; L or high-risk tag Top |
| QA author                                   | Mid                             | as the rule, never below Mid                            |
| QA judge, lens roles, Security verify       | Mid                             | as the rule                                             |
| Spec Verifier (one call per AC)             | Low                             | as the rule                                             |
| Escalation after 2 failed rounds            | one tier up, fresh session      | one tier up from the routed start after every 2 failed rounds (Low → Mid → Top) |
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

| Task          | Before  | After   | Engineer only, before → after |
| ------------- | ------- | ------- | ----------------------------- |
| S, no tag (×2) | $0.64 each | $0.25 each | $0.20 → $0.01 each           |
| S, tagged     | $0.64   | $1.22   | $0.20 → $0.20                 |
| M, no tag     | $0.64   | $1.22   | $0.20 → $0.20                 |
| L, `auth`     | $0.64   | $2.44   | $0.20 → $0.41                 |
| **Total**     | **$3.21** | **$5.39** | **$1.02 → $0.83 (−18%)**     |

What the estimate says, to check against the measurement:

- **The Engineer saves.** About 18% on this mix: the two plain S tasks drop to Low, and only the
  L task rises to Top.
- **The reviewers cost more.** D-cm routes them by the same rule, so the Spec Verifier, whose own
  tier is Low and which runs once per acceptance criterion, moves to Mid on M and tagged tasks and
  to Top on L or high-risk ones. On this mix the total rises by about 68%. If the measurement
  agrees, the cheaper fix is a per-role cell in the routing table (`DEFAULT_ROUTING_TABLE.roles`,
  for example the Spec Verifier keeping Low below L), which Lookback can propose with evidence
  (D-cn), or a human decision that reviewers never start below their own tier.
- **Low burns rounds.** A Low start escalates to Mid after 2 failed rounds and to Top after 2
  more (reading 232). With the low-risk round cap of 3, an S task that fails twice on Low still
  has only one Mid round left before it parks, and it reaches Top only under a cap of 5. Watch
  the parks and rounds of the S tasks in the after arm.
- **Codex.** `DEFAULT_TIER_MODELS.codex` holds the ids from the Codex model docs since the
  round-5 merge (reading 229(4): `gpt-6-luna` Low, `gpt-6.1-sol` Mid, `gpt-6-astra` Top), so a
  Codex calibration measures models as on Claude Code. Whether the owner's plan accepts those
  ids is still the §7 row "Codex model ids on the owner's plan".

## Measurement

Not run yet (see the status above). Record per task: arm, tiers dispatched (with reasons), rounds,
escalations, parks, first-round gate pass, review pass, tokens and `cost_usd`; then the totals of
each arm.

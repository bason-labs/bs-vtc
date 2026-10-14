# Golden run fixture

A small recorded run (`golden-1`, feature track) for building and testing against the engine's
frozen surfaces without a running engine (AD-5, AD-7, AD-12).

- `events.jsonl`: the run's event log, exactly as the engine writes `.vtc/runs/<run>/events.jsonl`.
  It covers the replay-only fields too: the request in `run.started` (the feature is named from
  its first line), the intent contract in `task.created`, `feature.created`,
  `task.workspace_assigned`, `task.session_updated`, the snapshot commit (`head`) of the built
  submit, the trace fields of role events, L2 test metrics with their inventory path, the
  traceability report path, and a feature budget.
- `api/*.json`: the response of each `ENGINE_HTTP` read route for this log: `health`, `runs`,
  `status`, `events` (`/api/runs/golden-1/events`), `tasks`, `task-T-1` / `task-T-2`,
  `task-T-1-diff`, `features`, `artifact-spec` (`?path=.vtc/spec/spec.md`, the spec G1 froze),
  `escalations`, the three graph zoom levels `graph-project` (`?scope=project`), `graph-task_dag`
  (`?scope=task_dag`) and `graph-task-T-2` (`?scope=task&task=T-2`, with a `loop_guard`
  back-edge), and `usage`.
- `packs/a-1.json`: the `TaskPack` behind the one recorded dispatch (`a-1`), rendered by
  `renderTaskPack` to `.vtc/state/packs/a-1.md`.

- `samples/`: wave-3 shapes beside the run (contracts 4.10.0), not part of `golden-1`, so the `api/`
  snapshots do not change:
  - `wave3-events.jsonl`: a short log (`golden-wave3`) with a G2 `gate.requested` carrying
    `directions`, `facts`, `design_coverage` and `design_exits`; `headless.preflight` / `started` /
    `ended` (a replay preflight among them); `merge.preflight`; `feature.checklist`,
    `feature.auto_merge_enabled` and `feature.auto_merge_disabled`; `final_review.step_finished`;
    `fact.recorded` (one row with a host-reported `reported_source`, H-3), `fact.verified` and
    `fact.waived`; `lookback.dispatched`, `proposal_recorded`, `replay_finished` (its `sha256` is
    that of `replay-p-engineer-1.json`'s bytes), `canary_assigned`, `canary_evaluated`,
    `rolled_back` and `escaped_defect`; and a `prompt_selection` incident (reading 176);
  - `replay-p-engineer-1.json`: the `ReplayResult` that event names. The replay is an Engineer's on
    a Codex-led headless run, a replay this engine can produce today: it refuses replays of verdict
    roles such as `spec_verifier` (they change no file, so the gates would grade the same base for
    both arms), an open deviation from spine readings 166 and 176 that waits for the Lead;
  - `gate-report-visual.json`: a `GateReport` whose `visual` summary names its `toolchain`;
  - `usage-billing.json`: a `UsageReport` with each host's `billing` (D-bq).

  `packages/engine/test/core/golden-samples.test.ts` validates each against its contract and
  replays the log through the engine's loader.

Who uses it:

- **Dashboard (sub-project 6):** serve `api/` from a dev fixture server, or point `next dev` at it,
  and replay `events.jsonl` as the SSE stream.
- **Engine core (sub-project 1):** the golden replay test must rebuild exactly these responses from
  `events.jsonl` (AD-7 Check).
- **Roles + compiler (sub-project 3):** `packs/` shows what a role receives.

`packages/shared/test/golden-run.test.ts` validates every file against its contract and checks the
snapshots against the log. Changing a contract means regenerating this fixture in the same change.

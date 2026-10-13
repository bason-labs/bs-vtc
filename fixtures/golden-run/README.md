# Golden run fixture

A small recorded run (`golden-1`, feature track) for building and testing against the engine's
frozen surfaces without a running engine (AD-5, AD-7, AD-12).

- `events.jsonl`: the run's event log, exactly as the engine writes `.vtc/runs/<run>/events.jsonl`.
  It covers the replay-only fields too: `feature.created`, `task.workspace_assigned`,
  `task.session_updated`, the trace fields of role events, and a feature budget.
- `api/*.json`: the response of each `ENGINE_HTTP` read route for this log: `health`, `runs`,
  `status`, `events` (`/api/runs/golden-1/events`), `tasks`, `task-T-1` / `task-T-2`,
  `task-T-1-diff`, `features`, `artifact-spec` (`?path=.vtc/spec/spec.md`, the spec G1 froze),
  `escalations`, the three graph zoom levels `graph-project` (`?scope=project`), `graph-task_dag`
  (`?scope=task_dag`) and `graph-task-T-2` (`?scope=task&task=T-2`, with a `loop_guard`
  back-edge), and `usage`.
- `packs/a-1.json`: the `TaskPack` behind the one recorded dispatch (`a-1`), rendered by
  `renderTaskPack` to `.vtc/state/packs/a-1.md`.

Who uses it:

- **Dashboard (sub-project 6):** serve `api/` from a dev fixture server, or point `next dev` at it,
  and replay `events.jsonl` as the SSE stream.
- **Engine core (sub-project 1):** the golden replay test must rebuild exactly these responses from
  `events.jsonl` (AD-7 Check).
- **Roles + compiler (sub-project 3):** `packs/` shows what a role receives.

`packages/shared/test/golden-run.test.ts` validates every file against its contract and checks the
snapshots against the log. Changing a contract means regenerating this fixture in the same change.

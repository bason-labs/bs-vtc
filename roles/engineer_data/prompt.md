<!-- vtc:locked -->

## Data and database profile

This task is data work: schema, queries and indexes, pipelines, data contracts and backfills. On a
stateful system there is no revert, so every change is planned to be safe while old and new code
run side by side.

### Rules

1. Migrations are expand then contract, each step safe with the code already deployed: add before
   use, backfill, switch, and remove only in a later task. Set a short lock timeout, keep
   statements bounded, and give every migration a tested down path or a written reason why it is
   forward-only.
2. Know the locks: even metadata-only column additions take a brief exclusive lock on some
   engines; create indexes concurrently where the engine supports it.
3. Backfills run in bounded, resumable batches and reconcile: rows read = rows written + rows
   quarantined, checked and reported. A backfill that cannot account for every row is not done.
4. Pipelines are idempotent: a re-run produces the same result and never duplicates. Schema drift
   in an input fails loudly; it never corrupts silently.
5. Data contracts are explicit: names, types, nullability, keys, units and freshness. A consumer
   reads only through the published contract.
6. Nulls are handled on purpose; no implicit null propagation into reported values.
7. Queries: every new query on a large table has an index that serves it or a measured reason; no
   unbounded scan or query inside a loop; read the plan for anything that runs per request.
8. Never delete or overwrite data without a recoverable path (soft delete, archive or backup the
   task names), and never run a destructive statement against a non-test database.
9. Personal data stays where the specification allows; never copy it into logs, fixtures or test
   data.

### Before `built`

Run the gate commands, including migration dry-runs, query-plan checks and data tests when the
pack lists them. Run every migration up, down and up again on the test database.
<!-- vtc:editable -->

### Data heuristics

- Write the reconciliation query before the backfill.
- When a migration and the code that uses it are in one task, check the order in which they
  deploy.

---
name: lens-db
description: Database and migration review lens (VTC spec 5.3). Use when a task adds or changes a schema migration, a backfill, a bulk delete or update, or a query on a large table; check the diff against these rules and cite the rule id.
---

# Database and migration lens

Applies to: schema migrations, backfills, bulk deletes or updates, new queries on large tables.
The migration dry-run and query-plan gates run first; this lens judges what they cannot.

- **DB-1** Expand then contract: a change that removes or renames a column, table or constraint
  in the same release as the code that stops using it is a finding. Old and new code must both
  work while the migration runs.
- **DB-2** Every DDL statement runs with a short lock timeout and bounded duration; index
  creation on a populated table uses the engine's concurrent or online form where it exists.
- **DB-3** Adding a NOT NULL column, a foreign key or a check constraint to a populated table is
  staged: add it unvalidated or nullable, backfill, then validate.
- **DB-4** Backfills and bulk changes run in bounded, resumable batches, never one statement over
  the whole table.
- **DB-5** A backfill or data fix reconciles: rows read = rows written + rows quarantined, checked
  in code or a test.
- **DB-6** Every migration has a down path that works with the code already deployed, or states
  why it is forward-only.
- **DB-7** Destructive operations (drop, truncate, delete without a narrow predicate) have a
  recoverable path: soft delete, archive, or a backup step named in the task.
- **DB-8** New queries on large tables are served by an index or carry a measured reason; no query
  inside a loop over rows (N+1); no unbounded result set returned to a client.
- **DB-9** Reads that must see their own writes do not go to a replica that may lag.
- **DB-10** Money is integer minor units or decimal, never floating point; time is stored with its
  zone or in UTC.

Sources: forked from msitarzewski/agency-agents (MIT, see NOTICE):
engineering-database-reliability-engineer.md, engineering-database-optimizer.md (its migration
advice dropped), engineering-ai-data-remediation-engineer.md (row reconciliation).

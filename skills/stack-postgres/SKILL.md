---
name: stack-postgres
description: "PostgreSQL stack pack (VTC spec 5.2a). Load for a task whose code uses PostgreSQL (detected from a Postgres driver, ORM dialect or migration files): conventions, pitfalls and test commands."
---

# PostgreSQL stack pack

Detect: a Postgres driver or ORM dialect in dependencies, SQL migrations using Postgres syntax.

## Conventions

- Migrations through the project's tool, one concern per migration, reversible where possible.
- Create indexes on populated tables concurrently; set a short lock_timeout for DDL.
- Use constraints (NOT NULL, foreign keys, unique, check) to enforce invariants, added in
  validated stages on large tables.
- Use transactions for multi-statement writes; pick the isolation level deliberately.

## Pitfalls

- Even metadata-only ALTER TABLE takes a brief ACCESS EXCLUSIVE lock and queues behind long
  transactions.
- Adding a column with a volatile default rewrites the table on some versions; check the version
  notes.
- OFFSET pagination degrades on large tables; prefer keyset pagination.
- Read the query plan (EXPLAIN) for any query that runs per request on a large table.

## Tests and checks

- Use the repository's own scripts first (the gate commands in the pack); add no new test runner.
- Run migrations up, down and up on the test database; the gates name the migration dry-run and
  plan checks.

## Version notes

Version-specific APIs come from the official documentation the engine fetched for the pinned
version, in your task pack, never from memory. When the pack has no note and an API may differ
between major versions, read the installed package's types or bundled docs before using it.

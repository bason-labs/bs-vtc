---
name: stack-mysql
description: "MySQL or MariaDB stack pack (VTC spec 5.2a). Load for a task whose code uses MySQL or MariaDB (detected from a MySQL driver, ORM dialect or migration files): conventions, pitfalls and test commands."
---

# MySQL and MariaDB stack pack

Detect: a MySQL or MariaDB driver or ORM dialect, SQL migrations using MySQL syntax.

## Conventions

- Migrations through the project's tool; large-table DDL through the online method the project
  uses.
- InnoDB, utf8mb4 for text, explicit collations as the project sets them.
- Constraints and indexes declared in migrations, not only in the ORM.

## Pitfalls

- Some ALTER TABLE operations copy the whole table and block writes; check the algorithm and lock
  clauses or use an online schema change tool.
- Implicit type conversion in WHERE clauses defeats indexes.
- Strict SQL mode matters: without it, invalid data is silently truncated.
- Gap locks under REPEATABLE READ can deadlock concurrent inserts; keep transactions short.

## Tests and checks

- Use the repository's own scripts first (the gate commands in the pack); add no new test runner.
- Run migrations up and down on the test database; read EXPLAIN for new queries on large tables.

## Version notes

Version-specific APIs come from the official documentation the engine fetched for the pinned
version, in your task pack, never from memory. When the pack has no note and an API may differ
between major versions, read the installed package's types or bundled docs before using it.

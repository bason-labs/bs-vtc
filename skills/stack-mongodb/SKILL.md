---
name: stack-mongodb
description: "MongoDB stack pack (VTC spec 5.2a). Load for a task whose code uses MongoDB (detected from a MongoDB driver or ODM in dependencies): conventions, pitfalls and test commands."
---

# MongoDB stack pack

Detect: a MongoDB driver or an ODM (for example Mongoose) in dependencies.

## Conventions

- Schemas are enforced in code (ODM schemas or JSON Schema validation) even though the database is
  schemaless.
- Indexes declared in code or migrations for every query pattern; compound index order follows
  equality, sort, range.
- Multi-document invariants use transactions or a document design that keeps them in one document.

## Pitfalls

- Unbounded arrays inside documents grow past size limits; model them as separate collections.
- Query operators built from user input allow operator injection; validate input types.
- Changing a field's shape needs a backfill or code that reads both shapes.

## Tests and checks

- Use the repository's own scripts first (the gate commands in the pack); add no new test runner.
- Integration tests against the test database the gates provide; check new queries with explain.

## Version notes

Version-specific APIs come from the official documentation the engine fetched for the pinned
version, in your task pack, never from memory. When the pack has no note and an API may differ
between major versions, read the installed package's types or bundled docs before using it.

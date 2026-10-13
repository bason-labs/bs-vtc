<!-- vtc:locked -->

## Backend and API profile

This task is server-side work: endpoints, validation, authentication and authorisation flows,
transactions, idempotency, concurrency, observability and schema migrations.

### Rules

1. Contract first. When the task provides an interface contract, write or update it (OpenAPI,
   GraphQL, protobuf or event schema) before the implementation, and implement exactly it. When it
   consumes one, call exactly what it defines.
2. A published contract changes additively only: new optional fields, new endpoints, new optional
   parameters. Removing or renaming a field, changing a type, tightening validation or changing an
   error's shape is a breaking change: stop with `spec_conflict` unless the task says the break is
   approved.
3. Validate every input at the boundary against the contract; reject unknown or malformed input
   with the project's error shape and the correct status code. Never answer success with an error
   inside the body.
4. Authorisation on every entry point, using the server-side identity: check that the caller may
   act on this specific record, not only that they are signed in.
5. Writes that a client may retry are idempotent (an idempotency key or a natural unique
   constraint). Multi-step writes are one transaction or have explicit compensation.
6. Concurrency: assume two requests on the same record at once; use the database's constraints or
   locking rather than read-then-write races.
7. Schema changes are expand then contract: add new structures first, backfill in bounded batches,
   switch readers and writers, and only a later task removes the old ones. Every migration has a
   short lock timeout, no long-running statement in the deploy path, and a down path compatible
   with the code already deployed.
8. Log with the project's structured logger and trace context; never log secrets, tokens or
   personal data.
9. Time, money and identifiers: store time in UTC, money in integer minor units or decimals, never
   floats; never expose internal sequential ids where the contract uses opaque ones.

### Before `built`

Run the gate commands, including contract tests, integration tests and migration checks when the
pack lists them. Exercise the failure paths of each endpoint you changed: invalid input,
unauthorised caller, missing record, duplicate request.
<!-- vtc:editable -->

### Backend heuristics

- Read one existing endpoint end to end before adding one; copy its error handling and logging.
- Put the authorisation check next to the data access it protects, where a later change cannot
  skip it.

---
name: lens-api
description: Public API contract review lens (VTC spec 5.3). Use when a task changes an OpenAPI, GraphQL or protobuf contract, an event schema, a public route, an SDK or developer-facing errors; check the diff against these rules and cite the rule id.
---

# Public API contract lens

Applies to: published contracts (OpenAPI, GraphQL, protobuf, event schemas), public routes, SDKs,
developer-facing errors. The contract-diff gate runs first.

- **API-1** Additive only without a version: new optional fields, endpoints and optional
  parameters are safe; removing or renaming a field, changing a type or format, making a parameter
  required, tightening validation, removing an enum value or changing an error's shape or status
  meaning is breaking.
- **API-2** A breaking change has a new version, a deprecation signal on the old one and a
  migration note; a silent break is a finding.
- **API-3** The implementation matches the contract exactly: no undocumented fields, no
  documented field missing.
- **API-4** Conventions are uniform across endpoints: field casing, ISO 8601 dates, id format,
  pagination style, error shape.
- **API-5** Errors use correct status codes and the shared error shape with a stable
  machine-readable code and a message that says what to do next; never success with an error in
  the body.
- **API-6** Creates and other retried writes accept an idempotency key or are naturally
  idempotent.
- **API-7** Rate limits are signalled with 429 and Retry-After and limit headers.
- **API-8** Lists are paginated with a stable order; no unbounded list endpoints.

Sources: forked from msitarzewski/agency-agents (MIT, see NOTICE):
engineering-api-platform-engineer.md, product-dx-engineer.md (error messages as product copy).

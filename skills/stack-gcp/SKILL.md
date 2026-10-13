---
name: stack-gcp
description: "Google Cloud stack pack (VTC spec 5.2a). Load for a task whose code uses Google Cloud (detected from Google Cloud client libraries or the Google provider in IaC): conventions, pitfalls and test commands."
---

# Google Cloud stack pack

Detect: Google Cloud client libraries, the Google provider in Terraform, or deployment configs.

## Conventions

- Service accounts per workload with the narrowest predefined or custom roles; workload identity
  instead of key files.
- Buckets with uniform access and no public members unless specified.
- Project and region from configuration.

## Pitfalls

- Primitive roles (owner, editor) on workloads are findings.
- Service account key files must never be created or committed.
- List calls are paginated.

## Tests and checks

- Use the repository's own scripts first (the gate commands in the pack); add no new test runner.
- Unit tests mock clients at the boundary; IaC is checked by plan and policy gates, never applied.

## Version notes

Version-specific APIs come from the official documentation the engine fetched for the pinned
version, in your task pack, never from memory. When the pack has no note and an API may differ
between major versions, read the installed package's types or bundled docs before using it.

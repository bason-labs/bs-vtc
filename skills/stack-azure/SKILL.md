---
name: stack-azure
description: "Microsoft Azure stack pack (VTC spec 5.2a). Load for a task whose code uses Microsoft Azure (detected from Azure SDKs, Bicep or ARM templates, or the azurerm provider): conventions, pitfalls and test commands."
---

# Microsoft Azure stack pack

Detect: Azure SDK dependencies, Bicep or ARM templates, or the azurerm provider in Terraform.

## Conventions

- Managed identities for workloads, role assignments scoped to the resource; no connection strings
  with keys where identity works.
- Secrets and keys in Key Vault; storage without public blob access unless specified.
- Resource names, regions and tags from configuration.

## Pitfalls

- Owner or Contributor at subscription scope for a workload is a finding.
- Some resource property changes force replacement; read the plan or what-if output.
- List operations are paged.

## Tests and checks

- Use the repository's own scripts first (the gate commands in the pack); add no new test runner.
- Unit tests mock clients at the boundary; templates are checked by build, what-if or plan and
  policy gates, never deployed.

## Version notes

Version-specific APIs come from the official documentation the engine fetched for the pinned
version, in your task pack, never from memory. When the pack has no note and an API may differ
between major versions, read the installed package's types or bundled docs before using it.

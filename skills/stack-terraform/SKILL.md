---
name: stack-terraform
description: "Terraform or OpenTofu stack pack (VTC spec 5.2a). Load for a task whose code uses Terraform or OpenTofu (detected from *.tf files): conventions, pitfalls and test commands."
---

# Terraform and OpenTofu stack pack

Detect: `*.tf` files, a `.terraform.lock.hcl` file.

## Conventions

- Modules for reuse, variables with types and descriptions, outputs for what consumers need.
- Provider and module versions pinned; the lock file committed.
- Remote state with locking as the project configures it; never commit state files.
- Tags and naming follow the project's conventions.

## Pitfalls

- Renaming a resource destroys and recreates it unless a moved block records the rename.
- Changing an immutable attribute forces replacement of stateful resources; read the plan.
- Secrets in variables end up in state; mark them sensitive and source them from a secret store.
- Never run apply; produce the plan only.

## Tests and checks

- Use the repository's own scripts first (the gate commands in the pack); add no new test runner.
- Format and validate checks, then plan through the gate command; policy checks (for example
  Checkov or conftest) when the gates list them.

## Version notes

Version-specific APIs come from the official documentation the engine fetched for the pinned
version, in your task pack, never from memory. When the pack has no note and an API may differ
between major versions, read the installed package's types or bundled docs before using it.

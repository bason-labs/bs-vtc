---
name: lens-compliance
description: Compliance mapping lens (VTC spec 5.3). Use only when the specification declares a compliance scope (SOC 2, ISO 27001, HIPAA, PCI DSS, FedRAMP); map the diff's controls to the declared framework and cite the rule id.
---

# Compliance mapping lens

Applies to: projects whose specification declares a compliance scope. The scope comes only from
the specification; this lens never adds one.

- **COMP-1** Every control the task implements maps to a named requirement of the declared
  framework and to a SEC-n or REQ-n.
- **COMP-2** A control is shown by code, configuration or a test, never only by a description.
  Never describe a control the diff does not implement.
- **COMP-3** Audit-relevant events (access to regulated data, permission changes, configuration
  changes) are logged immutably with who, what and when.
- **COMP-4** Regulated data is encrypted at rest and in transit and stays inside the declared
  boundary.
- **COMP-5** An exception names its approver, reason, expiry and compensating control.
- **COMP-6** Evidence is collected automatically where the framework requires periodic proof.

Sources: forked from msitarzewski/agency-agents (MIT, see NOTICE): security-compliance-auditor.md,
specialized-fedramp-rmf-compliance.md (prove every control).

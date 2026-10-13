---
name: lens-privacy
description: Privacy review lens (VTC spec 5.3). Use when a task collects, stores, logs, exports or shares personal data, adds tracking or analytics, sends data to a third party or changes retention; check the diff against these rules and cite the rule id.
---

# Privacy lens

Applies to: new personal-data fields, logging, analytics and tracking, third-party data flows,
retention and deletion.

- **PRIV-1** Minimise at collection: every new personal-data field has a purpose stated in the
  specification; a field without one is a finding.
- **PRIV-2** Consent and purpose are enforced where the data is written or used, not only
  recorded.
- **PRIV-3** No personal data in logs, error messages, analytics events, URLs or test fixtures.
- **PRIV-4** Deletion reaches every store that holds the data (primary, replicas, caches, search
  indexes, exports and processors) and leaves an auditable record.
- **PRIV-5** Retention is enforced by code (expiry, scheduled deletion), not by intention.
- **PRIV-6** A new flow to a third party, another region or a new purpose is named in the
  specification with its basis; an unlisted flow is a finding.
- **PRIV-7** "Anonymised" or "aggregated" data must not be re-identifiable from the remaining
  fields; pseudonymous identifiers are still personal data.
- **PRIV-8** Data subject requests (access, export, deletion) keep working for the new data.

Sources: forked from msitarzewski/agency-agents (MIT, see NOTICE): engineering-privacy-engineer.md,
data-privacy-officer.md (assessment triggers), support-legal-compliance-checker.md (data
categories only).

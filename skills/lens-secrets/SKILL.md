---
name: lens-secrets
description: Secret-leak response lens (VTC spec 5.3). Use when a secret scanner reports a finding or a task changes credentials, CI variables or secret handling; check the diff and the scanner report against these rules and cite the rule id.
---

# Secret-leak response lens

Applies to: secret-scanner hits, credential and CI-variable changes, secret loading code. A
committed secret always escalates to a human; this lens describes what the escalation needs.

- **SECRET-1** A secret that reached a commit, a log or a build artefact is compromised from that
  moment. Removing it from the code is necessary and never sufficient: it must be revoked and
  rotated at its provider, by a human.
- **SECRET-2** Report the secret's type, file and line, and a redacted preview at most; never its
  value, in any output.
- **SECRET-3** Nothing client-reachable holds a secret: browser bundles, public build-time
  variables, mobile apps, container image layers.
- **SECRET-4** Secrets are loaded at run time from the platform's secret store, scoped to one
  workload and purpose, with the shortest practical lifetime.
- **SECRET-5** No secret in URLs, query strings, analytics, error messages or test fixtures.
- **SECRET-6** A test or fixture value that looks like a real secret is replaced by an obviously
  fake one so scanners stay quiet without allowlisting.
- **SECRET-7** Never rewrite git history as part of a task; history clean-up is a human decision
  in the escalation.

Sources: forked from msitarzewski/agency-agents (MIT, see NOTICE):
security-secrets-credential-engineer.md, security-ai-generated-code-auditor.md (client-reachable
secrets).

---
name: lens-infra
description: Infrastructure, CI and operations review lens (VTC spec 5.3). Use when a task changes infrastructure as code, container files, Kubernetes or Helm manifests, CI/CD workflows, deploy scripts or monitoring; check the diff against these rules and cite the rule id.
---

# Infrastructure, CI and operations lens

Applies to: infrastructure as code, Dockerfiles, Kubernetes and Helm, CI/CD workflows, deploy and
rollback scripts, alerting. Plan, policy and workflow-lint gates run first.

- **INFRA-1** Nothing deploys to production automatically on a branch push; production needs an
  explicit approval step.
- **INFRA-2** Every change has a rollback and a validation step.
- **INFRA-3** Least privilege: no wildcard IAM actions or resources, no public buckets or open
  ingress the specification does not require, management ports never exposed to the internet.
- **INFRA-4** Secrets come from a secret store at run time; never in code, images, workflow files,
  plain environment definitions or logs.
- **INFRA-5** Long-lived credentials are replaced by workload identity or short-lived federation
  where the platform supports it.
- **INFRA-6** Versions are pinned: base images by digest or exact tag, CI actions and modules by
  version or commit.
- **INFRA-7** Workflows that run code from forks or untrusted input get no secrets and no write
  token.
- **INFRA-8** Containers run as non-root with health checks and only the ports they serve; data at
  rest and in transit is encrypted.
- **INFRA-9** The plan contains no destroy or replace of a stateful resource the task did not
  intend.
- **INFRA-10** Rollouts are progressive with a predefined halt condition; alerts are SLO burn-rate
  alerts on user-facing symptoms with a runbook.

Sources: forked from msitarzewski/agency-agents (MIT, see NOTICE): engineering-devops-automator.md
(rewritten; automatic production deploy removed), security-cloud-security-architect.md,
engineering-sre.md, support-infrastructure-maintainer.md.

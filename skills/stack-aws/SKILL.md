---
name: stack-aws
description: "AWS stack pack (VTC spec 5.2a). Load for a task whose code uses AWS (detected from AWS SDKs, CDK, CloudFormation or AWS providers in IaC): conventions, pitfalls and test commands."
---

# AWS stack pack

Detect: AWS SDK dependencies, CDK apps, CloudFormation templates, or the AWS provider in
Terraform.

## Conventions

- IAM policies grant specific actions on specific resources; roles for workloads, never long-lived
  access keys.
- Encryption at rest and in transit on by default; buckets private with public access blocked.
- Region and account come from configuration; tags as the project requires.
- SDK clients created once and reused; retries and timeouts configured.

## Pitfalls

- Wildcard actions or resources in IAM are findings unless the task justifies them.
- Pagination: list calls return pages; loop until done.
- Eventual consistency: a resource just created may not be visible to the next call.

## Tests and checks

- Use the repository's own scripts first (the gate commands in the pack); add no new test runner.
- Unit tests mock the SDK at the client boundary; IaC is checked by synth or plan and policy
  gates, never deployed.

## Version notes

Version-specific APIs come from the official documentation the engine fetched for the pinned
version, in your task pack, never from memory. When the pack has no note and an API may differ
between major versions, read the installed package's types or bundled docs before using it.

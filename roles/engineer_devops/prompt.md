<!-- vtc:locked -->

## DevOps and platform profile

This task changes how software is built, shipped or run: CI/CD workflows, infrastructure as code,
containers, deploy and rollback, monitoring and alerting. You change definitions; you never change
a live environment.

### Rules

1. Never apply, deploy, push images or change cloud resources. Produce the change and its plan
   (for example a plan or diff output from the tool the pack names); applying it is a human and
   pipeline decision outside this task.
2. Production deploys are never automatic from a branch push: a deploy to production needs an
   explicit approval step in the pipeline.
3. Every change ships with its rollback and a validation step: how to tell it worked, and how to
   undo it.
4. Least privilege: every identity, role, token scope, network rule and container gets only what
   its job needs. No wildcard permissions, no public storage, no open ingress the specification
   does not ask for.
5. Secrets come from the platform's secret store at run time; never in code, images, workflow
   files or logs.
6. Pin versions: base images by digest or exact tag, actions and modules by version or commit,
   tool versions in the repository's version files.
7. Containers run as non-root, with a read-only filesystem where possible, health checks, and only
   the ports they serve.
8. Rollouts are progressive (canary or percentage, then full) with a halt condition defined in
   advance.
9. Alerts are on symptoms users feel: service-level objectives with multi-window burn-rate alerts
   on the golden signals (latency, traffic, errors, saturation), each with a runbook link.

### Before `built`

Run the gate commands, including the plan, policy and lint checks for workflows, containers and
infrastructure code when the pack lists them. Read the plan output for any destroy or replace you
did not intend.
<!-- vtc:editable -->

### DevOps heuristics

- Prefer changing one environment's definition and promoting it over editing several in place.
- A workflow step that needs a secret should not also run untrusted code from a fork.

---
name: stack-kubernetes
description: "Kubernetes or Helm stack pack (VTC spec 5.2a). Load for a task whose code uses Kubernetes or Helm (detected from manifests, kustomizations or Helm charts): conventions, pitfalls and test commands."
---

# Kubernetes and Helm stack pack

Detect: Kubernetes manifests, `kustomization.yaml`, or a Helm `Chart.yaml`.

## Conventions

- Every workload declares resource requests and limits, liveness and readiness probes, and runs as
  non-root with a read-only root filesystem where possible.
- Configuration in ConfigMaps, secrets from the cluster's secret mechanism or an external secret
  operator.
- Images pinned by digest or exact tag; no latest.
- Network policies and service accounts with least privilege.

## Pitfalls

- A missing readiness probe sends traffic to pods that are not ready.
- Changing a selector or immutable field requires replacing the resource.
- Privileged containers and host mounts are rarely needed; treat them as findings to justify.

## Tests and checks

- Use the repository's own scripts first (the gate commands in the pack); add no new test runner.
- Render and lint (for example helm template and the project's manifest linter); never apply to a
  cluster.

## Version notes

Version-specific APIs come from the official documentation the engine fetched for the pinned
version, in your task pack, never from memory. When the pack has no note and an API may differ
between major versions, read the installed package's types or bundled docs before using it.

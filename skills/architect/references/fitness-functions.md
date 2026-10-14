# Fitness functions: every AD gets an automatable Check

Paraphrased from Ford, Parsons and Kua, Building Evolutionary Architectures (fitness functions),
and from the tools named in VTC spec §8.5. The engine compiles each Check into a tool config that
runs in gate L6, as blocking or warning; waivers are human-only and expire.

## What makes a good Check

- **Automatable:** a tool decides pass or fail with no human judgement.
- **Specific:** names the files, modules, endpoints or metric it covers (the AD's Binds).
- **Cheap enough to run on every task** for blocking Checks; slow ones (load tests) run per
  feature or nightly and are usually warnings.
- **Fails for the right reason:** the Check fails exactly when the Rule is broken.
- **Stated with its severity:** blocking (the task cannot merge) or warning (reported).

## Checks by kind of rule

| Rule kind                      | Tool examples (by ecosystem)                                                                                                   | Check example                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Dependency direction, layering | dependency-cruiser, eslint-plugin-boundaries (JS/TS); import-linter (Python); ArchUnit (JVM); Deptrac (PHP); go-arch-lint (Go) | "domain/ imports nothing from adapters/"                          |
| Module privacy                 | the same tools; package visibility                                                                                             | "only billing/ imports billing/internal"                          |
| API contract and compatibility | Spectral (OpenAPI lint), oasdiff (breaking-change diff)                                                                        | "no breaking change to /v1 without a new version"                 |
| Performance budget             | k6 (load), Lighthouse CI (web vitals, bundle size)                                                                             | "p95 under 300 ms at 50 requests/s"; "JS bundle under its budget" |
| Infrastructure and policy      | conftest (OPA policies on Terraform, Kubernetes, Dockerfiles)                                                                  | "no public bucket"; "every container runs as non-root"            |
| Data ownership                 | a schema-ownership test; database grants per service                                                                           | "only orders/ migrations touch the orders schema"                 |
| Dependency hygiene             | the supply-chain gates (lockfile, licence and vulnerability scans)                                                             | "no dependency with a banned licence"                             |
| Configuration                  | a lint or test against hard-coded hosts, secrets or environment names                                                          | "no URL literal outside config/"                                  |

## Writing the Check line

Use this form in each AD: `Check: <tool> <rule or command target>, blocking|warning`. Examples:

- `Check: dependency-cruiser rule no-domain-to-adapters, blocking`
- `Check: oasdiff breaking-changes against the last release's openapi.yaml, blocking`
- `Check: k6 scenario S1 (50 rps, p95 < 300 ms) per feature, warning`
- `Check: conftest policy deny_public_buckets on infra/, blocking`

Name the ecosystem's tool only when the stack is decided; otherwise name the rule and say which
kind of tool will check it.

## When no Check exists

If no tool can check the rule, the AD is a preference: move it to the design notes, or split it
into a part that can be checked and a part that is guidance. A spine decision without a Check
cannot be enforced, so it does not belong in the spine.

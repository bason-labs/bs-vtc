# Fitness functions: every AD gets an automatable Check

Paraphrased from Ford, Parsons and Kua, Building Evolutionary Architectures (fitness functions),
and from the tools named in VTC spec §8.5. The engine compiles each `vtc-check` block in the
spine into a check that runs in gate L6, as `blocking` or `warn`; waivers are human-only and
expire.

## What makes a good Check

- **Automatable:** a tool decides pass or fail with no human judgement.
- **Specific:** names the files, modules, endpoints or metric it covers (the AD's Binds).
- **Cheap enough to run on every task** for blocking Checks; slow ones (load tests) run per
  feature or nightly and are usually warnings.
- **Fails for the right reason:** the Check fails exactly when the Rule is broken.
- **Stated with its mode:** `blocking` (the task cannot merge) or `warn` (reported only).

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

Dependency direction, module privacy, banned packages and forbidden code patterns (such as a URL
literal outside config/) are written as `vtc-check` blocks (below), whatever the stack: the
engine checks them itself. The tools in the table are what a prose Check names for the rest.

## Writing the Check

The spine lives at `.vtc/architecture/spine.md`. Each AD is a heading (`### AD-3: <title>`), and
its Checks sit under that heading with no other heading between them: write Binds, Prevents and
Rule as bold list items, not as sub-headings, or the engine will not know which AD a block
belongs to. A Check takes one of two forms.

### A `vtc-check` block: compiled into gate L6

When the rule is one of the three kinds below, write one fenced block per Check, info string
`vtc-check`, whose body is YAML. The engine compiles these blocks, and only these, into L6
checks; a block that does not parse or breaks a limit is reported at G2 as invalid.

- Every block: `kind`, `mode` (`blocking`, the default, or `warn`; never "warning"), and an
  optional `message` (one sentence that names the AD). No other keys are allowed.
- `import-boundary`: `from` (globs of the files whose imports are checked, at least one),
  `forbid` (globs of files they may not import), `forbid_packages` (package names, `a` or
  `a/sub`, they may not import), `except` (globs exempt from the check).
- `forbidden-dependency`: `packages` (at least one): names no manifest may add (package.json,
  requirements\*.txt, pyproject.toml, go.mod).
- `forbidden-pattern`: `paths` (globs, at least one), `pattern` (a JavaScript regular expression
  matched against each line), `except` (globs exempt).

Globs are repo-relative (`src/search/**`). Quote a pattern in single quotes so YAML keeps its
backslashes as written. A pattern is refused when it has a backreference (`\1`, `\k<name>`), a
repeated group that itself repeats or holds an alternation (`(a+)+`, `(a|ab)*`), or more than
two unbounded quantifiers (`*`, `+`, `{n,}`): it runs inside the engine with no timeout.

An AD with one example of each kind:

````markdown
### AD-3: Search module owns its tables

- **Binds:** src/search/ and the search tables.
- **Prevents:** other modules querying the search tables directly.
- **Rule:** only src/search/ imports the search table definitions or the search engine client.
- **Check:**

```vtc-check
kind: import-boundary
mode: blocking
from: ["src/**"]
except: ["src/search/**"]
forbid: ["src/search/tables/**"]
forbid_packages: ["@elastic/elasticsearch"]
message: Only the search module reads the search tables (AD-3).
```

```vtc-check
kind: forbidden-dependency
mode: blocking
packages: ["mongodb", "mongoose"]
message: One relational database; no second datastore client (AD-3).
```

```vtc-check
kind: forbidden-pattern
mode: warn
paths: ["src/**"]
except: ["src/search/**"]
pattern: '\bFROM\s+search_\w+'
message: SQL on the search tables belongs in src/search/ (AD-3).
```
````

### A prose `Check:` line: any other tool

When no kind fits (an API diff, a load test, a policy engine, a named lint rule), write one line:
`Check: <tool> <rule or command target>, blocking|warn`. Prose is never compiled: it runs only
as a calibrated gate or in review, so prefer a block whenever a kind expresses the rule.
Examples:

- `Check: oasdiff breaking-changes against the last release's openapi.yaml, blocking`
- `Check: k6 scenario S1 (50 rps, p95 < 300 ms) per feature, warn`
- `Check: conftest policy deny_public_buckets on infra/, blocking`

Name the ecosystem's tool only when the stack is decided; otherwise name the rule and say which
kind of tool will check it.

## When no Check exists

If no tool can check the rule, the AD is a preference: move it to the design notes, or split it
into a part that can be checked and a part that is guidance. A spine decision without a Check
cannot be enforced, so it does not belong in the spine.

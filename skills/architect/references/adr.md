# Architecture decision record (ADR) template

Adapted from MADR, Markdown Architectural Decision Records (adr.github.io/madr), shortened for VTC. Use it for a task triaged `changes` (§8.4): a new service,
datastore or integration, a cross-cutting concern, a performance target, a breaking interface, a
new trust boundary or an irreversible migration. Return it as the artifact type your contract
lists for an architecture decision record.

```markdown
# ADR-<n>: <short title in the imperative: "Use a queue for invoice rendering">

- Status: proposed
- Date: <YYYY-MM-DD>
- Change request: <yes, when the spine is already approved; no otherwise>
- Requirements: <REQ-n, NFR-n it serves>
- Decisions touched: <AD-n it amends or supersedes; "none" when new>

## Context and problem

<Two to five sentences: the forces, the scenario and its measure, and why the current spine does
not settle it. Facts cite a fact row or are marked UNVERIFIED.>

## Options considered

1. <Option A, usually "keep the current spine">: <one line>
2. <Option B>: <one line>
3. <Option C, only when a driver demands it>

## Decision

<The chosen option, in one sentence, as a rule.>

### As a spine decision

- Binds: <code, modules, artifacts>
- Prevents: <the failure it rules out>
- Rule: <what must hold>
- Check: <the tool and rule that verify it>, blocking | warning

## Consequences

- Good: <what gets better, with the scenario it serves>
- Bad: <what it costs: components, operations, lock-in, migration>
- Reversibility: <how to undo it and what that costs>

## Pros and cons of the options

| Option | Scenario measure | 12-month cost | Ops burden | Reversibility |
| ------ | ---------------- | ------------- | ---------- | ------------- |
| A      |                  |               |            |               |
| B      |                  |               |            |               |
```

## Rules

- One decision per ADR. Two decisions are two ADRs.
- "Keep the current spine" is always an option, so the change has to beat it.
- An ADR is immutable once accepted; a later change is a new ADR that supersedes it.
- The Check must be automatable; see the fitness-function reference.

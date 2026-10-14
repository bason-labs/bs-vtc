---
name: architect
description: VTC Architect method references (spec §8.1) - quality-attribute scenarios, Well-Architected pillars, patterns with use-when and avoid-when, 12-factor, C4 and arc42 skeletons, the ADR template, DDD strategic design, security NFRs from OWASP ASVS, SLOs and fitness functions that become automatable Checks. Load when deciding or reviewing an architecture spine, a design note or an ADR.
---

# Architect references

Sources: written for VTC; paraphrased from and linked to the C4 model (c4model.com), arc42
(arc42.org), MADR (adr.github.io/madr), The Twelve-Factor App (12factor.net), the AWS, Azure and
Google Cloud Well-Architected frameworks, microservices.io, ISO/IEC 25010, OWASP ASVS, the Google
SRE books, Building Evolutionary Architectures, and agency-agents' software-architect role (MIT,
see NOTICE). Nothing here is a fact about a product version, licence, price or support window:
those come only from the engine's fact rows.

## How to use these references

Read one reference when a step of your procedure needs it, not all of them up front. Each is a
checklist to apply, not text to copy into the architecture.

| Step                                     | Read                                                 |
| ---------------------------------------- | ---------------------------------------------------- |
| Turning NFRs into scenarios              | ${CLAUDE_SKILL_DIR}/references/quality-attributes.md |
| Checking the candidates for blind spots  | ${CLAUDE_SKILL_DIR}/references/well-architected.md   |
| Choosing a pattern or rejecting one      | ${CLAUDE_SKILL_DIR}/references/patterns.md           |
| Runtime, config and deployment decisions | ${CLAUDE_SKILL_DIR}/references/twelve-factor.md      |
| Drawing C4 levels 1 and 2, or the doc    | ${CLAUDE_SKILL_DIR}/references/c4-arc42.md           |
| A `changes` triage: the ADR              | ${CLAUDE_SKILL_DIR}/references/adr.md                |
| Module and service boundaries            | ${CLAUDE_SKILL_DIR}/references/ddd-strategic.md      |
| Security requirements and trust bounds   | ${CLAUDE_SKILL_DIR}/references/security-asvs.md      |
| Availability and latency targets         | ${CLAUDE_SKILL_DIR}/references/slos.md               |
| Writing each AD's Check                  | ${CLAUDE_SKILL_DIR}/references/fitness-functions.md  |

## The core method in one page

1. **Drivers first.** Write each driving NFR as a scenario: source, stimulus, environment,
   artifact, response, response measure. A scenario without a measure is a wish. Rank by
   importance times difficulty; 3 to 7 drive the decision.
2. **Constraints are filters, not scores.** The team's approved stack, banned technologies,
   the existing system, licences and budget remove options before anything is scored.
3. **Candidates.** A is the boring baseline: a modular monolith, one relational database, the
   house stack. B is the smallest change from A that serves the top driver better. C exists
   only when a driver demands it. Never present a candidate nobody would choose.
4. **Scorecard.** Columns: each driving quality, team skills, 12-month cost, operational burden,
   reversibility, new technologies introduced (innovation tokens, budget 0 to 1). Every score
   cites a scenario. A missing column is not a zero.
5. **Robustness.** Move each weight by one point; if the winner changes, say "close call" and
   name the weight that decides it.
6. **Decisions as rules.** Each AD-n has Binds (what it covers), Prevents (the failure it rules
   out), Rule (what must hold) and Check (how a tool verifies it, `blocking` or `warn`; a
   `vtc-check` block in the spine whenever one of its kinds expresses the rule). If you
   cannot name the Check, it is a preference, not a decision; see the fitness functions.
7. **Facts.** A version, licence, support window, vulnerability or price in your output either
   cites a fact (evidence type `fact`, with the fact id the research brief in your task pack
   cites) or is written `UNVERIFIED: <claim>`. The engine lists every `UNVERIFIED:` tag at G2, and each one blocks
   approval until a human waives it with a reason.

## Triage outputs (§8.4)

- **fits:** no Architect work.
- **extends:** a one-page design note: what changes, which ADs apply, interfaces touched, how
  each touched AD's Check still passes.
- **changes:** an ADR (template in the ADR reference), flagged as a change request when the
  spine is already approved. A new service, datastore, integration, trust boundary, breaking
  interface, cross-cutting concern, performance target or irreversible migration is always
  `changes`.

## Red flags to call out at G2

- A component or pattern that no scenario needs (architecture astronautics).
- A decision that is hard to reverse made earlier than it has to be.
- Inner policy that imports a framework, a database driver or a transport.
- Two components that share a database table without a named owner.
- A dependency, or a product's support window, that the facts show is unmaintained or near its
  end of life, or a fact that is stale or conflicting.
- More than one innovation token spent without a driver that needs it.

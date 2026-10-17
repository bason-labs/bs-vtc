# Quality attributes and scenarios

Paraphrased from ISO/IEC 25010 (product quality model; iso25000.com) and the SEI
quality-attribute scenario format (Bass, Clements, Kazman, Software Architecture in Practice).

## Scenario template

| Part        | Question                                | Example                     |
| ----------- | --------------------------------------- | --------------------------- |
| Source      | Who or what causes the stimulus?        | an authenticated customer   |
| Stimulus    | What happens?                           | searches the catalogue      |
| Environment | Under which conditions?                 | at peak load, 50 requests/s |
| Artifact    | Which part of the system is stimulated? | the search API              |
| Response    | What the system does                    | returns ranked results      |
| Measure     | How the response is judged, as a number | p95 latency under 300 ms    |

Write the measure so a tool can check it later (see the SLO and fitness-function references).
"Fast", "secure" and "scalable" are not measures.

## Catalogue: what to ask per attribute

- **Performance efficiency.** Latency (which percentile, at which load), throughput, resource use
  per request, cold start. Ask: what is the busiest hour, and what is the slowest acceptable
  answer the user still waits for?
- **Reliability.** Availability target and its window, recovery time (RTO) and data-loss
  tolerance (RPO), behaviour when a dependency is down (degrade, queue, fail fast). Ask: what
  happens to an in-flight request when one instance dies?
- **Security.** Confidentiality, integrity, non-repudiation, accountability, authenticity. Ask:
  which data is personal or regulated, who may read it, and how is every access logged? See the
  security reference.
- **Maintainability.** Modularity, reusability, analysability, modifiability, testability. Ask:
  which change is most likely next year, and how many modules does it touch?
- **Compatibility.** Co-existence and interoperability: the APIs, file formats and protocols the
  system must keep. Ask: who calls us, and can they upgrade at the same time as we do?
- **Usability / interaction capability.** Learnability, accessibility (WCAG level), error
  protection. Usually the Designer's; the Architect owns the latency and offline parts.
- **Portability / flexibility.** Adaptability, installability, replaceability: hosts, clouds,
  regions, on-premises. Ask: is a second cloud or region a requirement, or a guess?
- **Safety** (where it applies): fail-safe states, hazard warnings.
- **Cost.** Not in ISO 25010, but always a driver: 12-month run cost at the expected load and at
  ten times that load.
- **Operability.** Deploy frequency, rollback time, observability (logs, metrics, traces), the
  on-call burden. Ask: who is woken up, by what, and what can they do then?

## Ranking

Score each scenario 1 to 3 for business importance and 1 to 3 for technical difficulty; the
product orders them. Keep the top 3 to 7 as drivers. A scenario that is important but easy is a
requirement to meet, not a driver of the architecture.

## Common gaps

- NFRs stated as averages; ask for a percentile.
- Availability with no window ("99.9%" per month allows about 43 minutes of downtime).
- No load figure, so no scenario can be checked; ask the human, or mark the measure as an
  assumption.
- Security stated as "secure"; translate it into concrete ASVS requirements.

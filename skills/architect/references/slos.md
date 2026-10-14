# Service level objectives

Paraphrased from and linked to the Google SRE books (sre.google/books: Site Reliability
Engineering, chapter "Service Level Objectives", and The Site Reliability Workbook, chapter
"Implementing SLOs").

## Terms

- **SLI (indicator):** a measured ratio, good events divided by valid events, over a window.
  Example: the share of search requests answered successfully in under 300 ms.
- **SLO (objective):** the target for an SLI over a window. Example: 99% over 28 days.
- **Error budget:** 1 minus the SLO; the failures you may spend on change. Example: 1% of
  search requests per 28 days may be slow or fail.
- **SLA:** a contract with consequences; looser than the SLO, owned by the business.

## Choosing SLIs per kind of component

| Component        | SLIs                                                            |
| ---------------- | --------------------------------------------------------------- |
| Request/response | availability (non-5xx share), latency (share under a threshold) |
| Data pipeline    | freshness (share of data newer than X), correctness, coverage   |
| Storage          | durability, availability of reads and writes, latency           |
| Batch job        | share of runs finishing within the deadline                     |

Measure as close to the user as practical (the load balancer or client), not inside the process.

## Setting the target

1. Start from the driving scenario's measure, not from "five nines".
2. Each extra nine costs roughly an order of magnitude more effort; ask what the user would
   notice.
3. A component cannot be more available than what it depends on in series: multiply the
   availabilities of hard dependencies to see the ceiling.
4. Write the window (28 or 30 days rolling) and the exact good-event definition.

| Availability | Downtime allowed per 30 days |
| ------------ | ---------------------------- |
| 99%          | about 7.2 hours              |
| 99.5%        | about 3.6 hours              |
| 99.9%        | about 43 minutes             |
| 99.95%       | about 22 minutes             |
| 99.99%       | about 4.3 minutes            |

## Turning an SLO into a Check

- Pre-production: a load test (for example k6) that runs the scenario's load and fails when the
  latency SLI misses its threshold; blocking in gate L6 when the scenario is a driver.
- Production: a burn-rate alert (budget consumed faster than the window allows), named in the
  operations section; it is a warning-level Check from the engine's point of view.
- Record the error-budget policy: what stops when the budget is spent (feature releases, for
  example) and who decides.

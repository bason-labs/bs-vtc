# Patterns index: use when, avoid when

Paraphrased from and linked to microservices.io (Chris Richardson), the Azure Architecture
Center's cloud design patterns (learn.microsoft.com/azure/architecture/patterns), the
system-design-primer (github.com/donnemartin/system-design-primer) and agency-agents'
software-architect role (MIT, see NOTICE). Every pattern must solve a named scenario; "best
practice" is not a reason.

| Pattern                     | Use when                                                       | Avoid when                                                          |
| --------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------- |
| Modular monolith            | One team or a few; boundaries still moving; default baseline   | Parts need independent scaling or release cadence the team can run  |
| Microservices               | Independent teams own independent capabilities and deploys     | One team; shared database; no platform or on-call to run them       |
| Layered / hexagonal         | Domain logic must be tested without frameworks or I/O          | A thin CRUD service where the layers would only forward calls       |
| CQRS                        | Reads and writes differ sharply in shape or scale              | Simple CRUD; the team cannot afford two models                      |
| Event sourcing              | The history itself is a requirement (audit, temporal queries)  | Only current state matters; schema evolution of events is unplanned |
| Publish/subscribe events    | Several consumers react to one fact; producers must not wait   | One consumer that needs the answer now (use a call)                 |
| Message queue / work queue  | Smoothing bursts; retrying slow or flaky work                  | The caller needs the result in the same request                     |
| Saga (orchestrated)         | A business transaction spans services and needs compensation   | One database can hold the transaction                               |
| Transactional outbox        | A DB change and its event must not diverge                     | No events leave the service                                         |
| API gateway / BFF           | Several clients with different needs; one place for auth, rate | One client and one backend                                          |
| Strangler fig               | Replacing a legacy system step by step                         | The legacy system is small enough to replace at once                |
| Anti-corruption layer       | Integrating a model you do not control                         | Both sides share one model you own                                  |
| Cache-aside                 | Read-heavy data that tolerates bounded staleness               | Data that must be read-your-writes consistent everywhere            |
| Circuit breaker + timeout   | Calls to a dependency that can hang or fail                    | In-process calls                                                    |
| Bulkhead                    | One noisy workload must not starve others                      | A single workload                                                   |
| Retry with backoff + jitter | Transient failures on idempotent operations                    | Non-idempotent operations without an idempotency key                |
| Idempotency key             | Clients may retry writes (payments, orders)                    | Pure reads                                                          |
| Sharding / partitioning     | One node cannot hold the data or the write rate                | The data fits; it adds cross-partition queries                      |
| Read replicas               | Read load dominates and replica lag is acceptable              | Reads must see the latest write                                     |
| Serverless functions        | Spiky, short, stateless work; scale to zero matters            | Long-running or latency-critical work with cold-start limits        |
| Feature flags               | Separating deploy from release; gradual rollout                | Flags that are never removed (track their expiry)                   |

## Rules

1. Name the scenario the pattern serves, and the cost it adds (components, operations,
   cognitive load). If you cannot, drop it.
2. Prefer the pattern that is easiest to remove later.
3. A distributed pattern (microservices, sagas, event sourcing) needs operational capability:
   tracing, on-call, a platform. If the team lacks it, the boring alternative wins.
4. Patterns combine into new failure modes: retries plus a queue plus non-idempotent handlers
   duplicate work. Check each combination against its scenario.

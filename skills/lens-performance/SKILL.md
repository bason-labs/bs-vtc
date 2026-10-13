---
name: lens-performance
description: Performance review lens (VTC spec 5.3). Use when the specification sets a performance budget (latency, throughput, Core Web Vitals, bundle size, memory) and the task touches a measured path; judge only against the specification's numbers and cite the rule id.
---

# Performance lens

Applies to: tasks on a path with a performance requirement in the specification. Thresholds come
only from the specification's non-functional requirements, never from this lens.

- **PERF-1** A performance claim needs a before and after measurement under the same conditions;
  an unmeasured "optimisation" is not evidence.
- **PERF-2** No work that grows with data inside a request without a bound: N+1 queries,
  unbounded loops over collections, loading whole tables or files into memory.
- **PERF-3** Expensive results that are read often are cached with an explicit invalidation rule;
  a cache without one is a finding.
- **PERF-4** Network calls on a hot path have timeouts, and independent calls run concurrently.
- **PERF-5** Web: no layout shift from late content, no long task in input handlers, images sized
  and lazy below the fold, code split at route boundaries (LCP, INP and CLS budgets).
- **PERF-6** Bundle and payload sizes stay within the specification's budget; a new heavy
  dependency on a measured path needs a reason.
- **PERF-7** Load tests encode the specification's thresholds as pass or fail conditions.

Sources: forked from msitarzewski/agency-agents (MIT, see NOTICE):
testing-performance-benchmarker.md (FID replaced by INP; its hard-coded thresholds removed),
engineering-wordpress-performance.md and engineering-drupal-performance.md (measure first).

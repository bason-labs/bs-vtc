---
name: domain-search-relevance
description: "Search relevance domain pack (VTC spec 5.2a). Load when the repository or the specification shows a search index or ranking code (Elasticsearch or OpenSearch mappings and queries, vector or hybrid retrieval); adds the domain's rules to the Engineer and the reviewers. Cite rule ids in findings."
---

# Search relevance domain pack

Load when: a search index or ranking code (Elasticsearch or OpenSearch mappings and queries,
vector or hybrid retrieval).

## Rules

- **SRCH-1** Never tune by anecdote: changes are judged against a judgment list sampled from real
  queries (head, torso and tail).
- **SRCH-2** Recall before precision: check that the right documents can match (analyse and
  explain) before changing scores.
- **SRCH-3** Analysers are a contract: index-time and query-time analysis change together and are
  tested on real vocabulary.
- **SRCH-4** Version indices behind an alias and reindex sideways; the alias flip is the rollback.
- **SRCH-5** Score fields separately; no single catch-all field that erases signal.
- **SRCH-6** Hybrid by default: vectors complement lexical matching for exact identifiers and rare
  terms.
- **SRCH-7** Track zero-result and reformulation rates for tail queries.
- **SRCH-8** Stay within the latency budget; no leading wildcards or expensive scripts on hot
  paths.

Sources: forked from msitarzewski/agency-agents (MIT, see NOTICE): engineering-search-relevance-
engineer.md.

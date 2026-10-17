# DDD strategic design: boundaries that hold

Paraphrased from Eric Evans, Domain-Driven Design (2003), Vaughn Vernon, Implementing
Domain-Driven Design, and the DDD Crew's context-mapping material (github.com/ddd-crew). Use it to decide module and service boundaries, not to rename classes.

## Subdomains

| Kind       | What it is                                          | Architectural consequence                                 |
| ---------- | --------------------------------------------------- | --------------------------------------------------------- |
| Core       | What makes the product different                    | Build it, model it carefully, give it the best people     |
| Supporting | Needed, specific to the business, not an advantage  | Build simply; a modular-monolith module is usually enough |
| Generic    | Solved the same way everywhere (auth, billing, PDF) | Buy or adopt; wrap behind an anti-corruption layer        |

Spend innovation tokens only on the core.

## Bounded contexts

- A bounded context is where one model and its language apply consistently. The same word
  ("account", "order") may mean different things in two contexts; that is fine as long as the
  boundary is explicit.
- Heuristics for finding boundaries: different words for the same thing; different rates of
  change; different owners; different consistency needs; a step in a business process handed
  from one group of people to another.
- One bounded context maps to one module (in a monolith) or one service, never the other way
  round: a context split across services shares a model through the network.
- Each context owns its data. No other context reads its tables; they use its API or its events.

## Context map relationships

| Relationship          | Meaning                                                       | Use it when                                         |
| --------------------- | ------------------------------------------------------------- | --------------------------------------------------- |
| Partnership           | Two teams succeed or fail together; coordinate releases       | Tightly coupled goals, same planning cycle          |
| Shared kernel         | A small shared model both sides change only together          | Very small and stable overlap                       |
| Customer-supplier     | Upstream plans for downstream's needs                         | Upstream is willing to prioritise downstream        |
| Conformist            | Downstream adopts upstream's model as is                      | Upstream will not change and its model is adequate  |
| Anti-corruption layer | Downstream translates upstream's model into its own           | Upstream's model would distort yours (legacy, SaaS) |
| Open host service     | Upstream offers a documented protocol to all consumers        | Many consumers                                      |
| Published language    | A shared, documented exchange format (schema, event contract) | Integration across teams or companies               |
| Separate ways         | No integration; duplicate the little that is shared           | Integration costs more than duplication             |

## Turning it into spine decisions

- One AD per boundary: Binds the context's modules; Prevents other contexts from importing its
  internals or reading its tables; Rule: access only through its public interface; Check: an
  import-boundary rule (blocking) and a schema-ownership check.
- An anti-corruption layer is a decision too: Rule: upstream types never appear outside the
  layer; Check: an import rule on the upstream client package.
- Aggregates (consistency boundaries inside a context) belong to design notes, not the spine,
  unless a scenario's measure depends on them.

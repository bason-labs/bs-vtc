<!-- vtc:locked -->

## Focus

Risk rule 6 fired: the task may break a public API. Judge whether existing consumers keep
working: compare the old and new contract field by field, and check that the implementation
matches the new contract exactly. A breaking change without a version, a deprecation and a
migration note fails.
<!-- vtc:editable -->

## Heuristics

- Tightened validation breaks clients as surely as a removed field.
- Check error responses as part of the contract, not only success bodies.

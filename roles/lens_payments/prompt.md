<!-- vtc:locked -->

## Focus

Risk rule 2 fired: the task changes how money moves. Judge whether every money-moving
operation is idempotent, driven by verified provider events, exact in its amounts, and safe when
it is retried, delayed or delivered twice.
<!-- vtc:editable -->

## Heuristics

- Trace one payment from creation to fulfilment and one refund, through every changed line.
- Look for floating-point arithmetic anywhere an amount is computed or compared.

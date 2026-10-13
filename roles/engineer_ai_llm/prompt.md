<!-- vtc:locked -->

## AI and LLM feature profile

This task builds a product feature on a language model: prompts, retrieval and embeddings, agents
and tool calls, guardrails, evaluation, cost and latency. Model output is untrusted input to the
rest of the system.

### Rules

1. Define the output format first: a schema the code validates, with a defined behaviour for
   invalid output (retry once, fall back, or fail visibly). Never parse free text where a schema
   fits.
2. No change without an evaluation: the task's golden set (at least the cases the specification
   names) runs before and after, with the result recorded. "It looks better" is not a result.
3. Change one variable at a time (prompt, model, chunking, retrieval, re-ranking) so a result can
   be attributed.
4. Prompts are versioned files in the repository, never strings scattered through code, and
   carry their test cases.
5. Untrusted content (user input, documents, web pages, tool results) goes in its own message or
   delimited field, never into system instructions. A call that both takes untrusted content and
   can use tools gets the narrowest tool set and confirmation for any side effect.
6. Least privilege for agents: each tool does one thing, validates its arguments, and returns an
   explicit error; no tool runs generated code or shell commands.
7. Every model call has a timeout, a bounded retry, a token budget and a fallback; cost and latency
   stay within the budgets the specification sets.
8. Retrieval: chunk and filter by metadata for the queries users ask; add re-ranking only when the
   evaluation shows precision is the bottleneck and the latency budget allows it.
9. Personal data sent to a model provider only where the specification allows; never log raw
   prompts or completions that contain it.
10. Model ids and endpoints come from configuration, never hard-coded.

### Before `built`

Run the gate commands, including the golden-set evaluation and the cost and latency budget checks
when the pack lists them. Report the evaluation scores before and after in the summary.
<!-- vtc:editable -->

### LLM heuristics

- Add a test case for each failure you fix, so the golden set grows with the bugs.
- When output quality varies between runs, fix the format and the instructions before reaching
  for a larger model.

---
name: lens-llm
description: LLM feature review lens (VTC spec 5.3). Use when a task adds or changes model calls, prompts, retrieval or vector search, agents or tool definitions; check the diff against these rules and cite the rule id.
---

# LLM feature lens

Applies to: model calls, prompts, embeddings and retrieval, agents and tools.

- **LLM-1** Model output is validated against a schema before use; invalid output has a defined
  path (one retry, fallback or visible failure).
- **LLM-2** Untrusted content (user input, documents, web pages, tool output) is kept out of system
  instructions and delimited as data.
- **LLM-3** A call that takes untrusted content and can use tools gets the narrowest tool set; side
  effects need confirmation; no tool executes generated code or shell commands.
- **LLM-4** Every model call has a timeout, a bounded retry, a token limit and a fallback.
- **LLM-5** A prompt or retrieval change comes with a golden-set evaluation before and after; the
  result is recorded.
- **LLM-6** Prompts are versioned files with test cases; model ids come from configuration.
- **LLM-7** Personal data reaches a model provider only where the specification allows it, and raw
  prompts and completions containing it are not logged.
- **LLM-8** Retrieval filters by the caller's permissions before ranking, so the model never sees
  documents the user may not.
- **LLM-9** Tools have descriptive names, typed and validated parameters, one responsibility each,
  and return explicit errors.

Sources: forked from msitarzewski/agency-agents (MIT, see NOTICE):
engineering-multi-agent-systems-architect.md, engineering-rag-pipeline-engineer.md,
engineering-prompt-engineer.md, specialized-mcp-builder.md, security-ai-generated-code-auditor.md
(model sinks).

---
name: lens-docs
description: Documentation review lens (VTC spec 5.3). Use when a task changes a public API, a CLI, configuration, setup steps or a README, or ships a breaking change; check that the docs change in the same diff and cite the rule id.
---

# Documentation lens

Applies to: public API, CLI, configuration and setup changes; breaking changes; README edits.

- **DOCS-1** A user-visible change updates its documentation in the same diff.
- **DOCS-2** A breaking change has a migration note: what changed, who is affected, what to do.
- **DOCS-3** Code examples in docs run as written against this version.
- **DOCS-4** A README answers, in its first screen: what this is, why use it, how to start.
- **DOCS-5** One concept per section; second person, present tense, active voice.
- **DOCS-6** CLI help and error messages say what happened and what to do next.
- **DOCS-7** Changelog entries describe the user-visible effect, not the implementation.

Sources: forked from msitarzewski/agency-agents (MIT, see NOTICE): engineering-technical-writer.md,
product-dx-engineer.md, specialized-developer-advocate.md (runnable samples).

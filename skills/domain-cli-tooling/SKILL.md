---
name: domain-cli-tooling
description: "CLI and developer tooling domain pack (VTC spec 5.2a). Load when the repository or the specification shows a command-line tool or developer tool (a bin entry, a CLI framework, shell completions); adds the domain's rules to the Engineer and the reviewers. Cite rule ids in findings."
---

# CLI and developer tooling domain pack

Load when: a command-line tool or developer tool (a bin entry, a CLI framework, shell
completions).

## Rules

- **CLI-1** Every error says what happened and the next action to take.
- **CLI-2** Detect a terminal: colour and progress for humans, plain stable output when piped;
  honour NO_COLOR.
- **CLI-3** Exit codes are an API: 0 for success, non-zero for failure, distinct codes for
  distinct failure classes.
- **CLI-4** Startup is fast: no network call and no heavy initialisation on the common path.
- **CLI-5** Flags mean the same thing in every subcommand.
- **CLI-6** Flags, output formats and exit codes are a contract; breaking changes are versioned
  and announced.
- **CLI-7** Help text has a one-line summary, flag descriptions and real examples.
- **CLI-8** Destructive actions confirm or need an explicit force flag; state-changing commands
  offer a dry run.
- **CLI-9** Machine-readable output (for example JSON) is stable and documented.

Sources: forked from msitarzewski/agency-agents (MIT, see NOTICE): engineering-developer-tooling-
engineer.md.

<!-- vtc:locked -->

## Focus

Risk rule 5 fired: the task changes CI/CD, infrastructure, containers or git hooks. Judge
whether the change keeps least privilege, keeps secrets out of definitions, cannot deploy to
production without approval, and can be rolled back. Read the plan output in the gate report for
destroy and replace actions.
<!-- vtc:editable -->

## Heuristics

- Workflows triggered by pull requests from forks are where tokens leak.
- An unpinned image or action is a supply-chain change even when the diff looks cosmetic.

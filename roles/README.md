# roles/

Neutral role sources (spec §5.1), one directory per role:

```
roles/<role>/
  role.yaml   # contract: validated by RoleContractSchema in @vtc/shared
  prompt.md   # locked core + editable section, about 150 lines at most
```

- Contracts, not personas: no identity, emoji or "vibe" sections (principle 6).
- A role with different tools or outputs per mode (QA `author`/`judge`, Security `design`/`verify`)
  declares `modes` in `role.yaml`; each mode compiles to its own agent (AD-14).
- `prompt.md` starts with `<!-- vtc:locked -->` (the locked core, human-only) and has exactly one
  `<!-- vtc:editable -->` line; everything after it is the editable section Lookback may propose
  changes to (AD-14, `splitRolePrompt`).
- Compiled per host by `packages/compiler` into `dist/claude-plugin` and `dist/codex-plugin`, with
  agent names from `agentNameFor` (`vtc-<role>[-<mode>]`).
- Forked sources keep the agency-agents MIT notice (spec §5.1).

Populated in sub-project 3.

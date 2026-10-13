# roles/

Neutral role sources (spec §5.1), one directory per role:

```
roles/<role>/
  role.yaml   # contract: validated by RoleContractSchema in @vtc/shared
  prompt.md   # locked core + editable section, about 150 lines at most
```

- Contracts, not personas: no identity, emoji or "vibe" sections (principle 6).
- Compiled per host by `packages/compiler` into `dist/claude-plugin` and `dist/codex-plugin`.
- Forked sources keep the agency-agents MIT notice (spec §5.1).

Populated in sub-project 3.

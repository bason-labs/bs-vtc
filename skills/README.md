# skills/

`SKILL.md` packs shared by both hosts (spec §4.4), copied into both compiled plugins. Each pack is
one directory with a `SKILL.md` whose frontmatter `name` equals the directory name and whose
`description` says when to load it. Other files in the directory (references) are copied too.

| Prefix    | What                                                                          | Pack id the engine and the Planner use                           |
| --------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `stack-`  | Stack packs (§5.2a): conventions, pitfalls, test commands; at most 3 per task | the rest of the name (`stack-react-next` → `react-next`)         |
| `domain-` | Domain packs (§5.2a), one per `DOMAIN_PACKS` entry in `@vtc/shared`           | the rest with `-` → `_` (`domain-embedded-iot` → `embedded_iot`) |
| `lens-`   | Reviewer lenses (§5.3): numbered rules a reviewer cites as `rule_id`          | the rest of the name; `lens_<x>` roles embed it                  |

The compiled plugins list every skill with its kind and pack id in `vtc-manifest.json`.

- Stack packs never carry version-specific API facts from memory: the engine fetches official
  docs at the pinned version into the task pack (§5.2a, §8.2).
- Forked material names its sources in a `Sources:` line; the agency-agents MIT notice is in
  `roles/NOTICE`, copied into both plugins as `NOTICE`.
- Role skills (no prefix) are preloaded by the agents that need them (`ROLE_SKILLS`,
  `TOOL_SKILLS` in the compiler): `architect` (the §8.1 core file and ten reference checklists
  under `references/`), `research-fetch` (the `research_fetch` tool and its fetchers) and
  `research-facts` (`fact_lookup`, `fact_propose`, citing facts and `UNVERIFIED:` tags). A skill
  links its own files as `${CLAUDE_SKILL_DIR}/references/<file>.md`; the Codex copy drops the
  prefix.
- The Designer method references forked from impeccable (§9.1: the Direction contract, the
  playbooks, the font blocklist) are not written yet; the detector rules are the gate-runner
  team's port (AD-24 rule 7).

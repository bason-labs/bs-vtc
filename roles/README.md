# roles/

Neutral role sources (spec §5.1, spine AD-14), one directory per role, compiled by
`packages/compiler` into one agent per role or per mode on each host (`agentNameFor`:
`vtc-<role>[-<mode>]`).

```
roles/<role>/
  role.yaml   # the contract, validated by RoleContractSchema in @vtc/shared
  prompt.md   # locked core, then the editable section; 150 lines at most
roles/_shared/
  result-protocol.md   # appended to every agent: how to read the task pack and return a RoleResult
  lens-reviewer.md     # the procedure every lens reviewer shares
roles/NOTICE           # the agency-agents MIT notice; copied into both compiled plugins
```

## The roster (v1)

| Kind              | Roles                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Core (§5.2)       | repo_cartographer, research_analyst, ba, architect, security (modes design, verify), designer, planner, engineer, qa (modes author, judge), spec_verifier, visual_qa, lookback |
| Engineer profiles | engineer_frontend, engineer_backend, engineer_mobile, engineer_data, engineer_devops, engineer_ai_llm (§5.2a)                                                                  |
| Lens reviewers    | lens_db, lens_auth, lens_payments, lens_secrets, lens_infra, lens_api, lens_supply_chain (§5.3, one per park-the-task risk rule)                                               |

The Lead is not a compiled agent: it is the main session, driven by the Lead skill in
`plugins/common/skills/lead`. Advisors (§5.4) are not written yet.

## Prompt rules

- Contracts, not personas (principle 6): no identity, memory, emoji or "vibe" sections.
- Prompts name artifact types and task pack sections, never other roles, agents or paths
  (principle 2). The compiler's repo test rejects agent names and run-state paths.
- `prompt.md` starts with `<!-- vtc:locked -->` (human-only, a MAJOR version change) and has
  exactly one `<!-- vtc:editable -->` line; everything after it is the editable section Lookback
  may propose changes to (MINOR; proposals go to `.vtc/lookback/proposals/<role>/editable.md`).
- Mode blocks: lines between `<!-- vtc:mode <mode> -->` and `<!-- vtc:mode-end -->` reach only
  that mode's agent; text outside blocks reaches every mode. Blocks may appear in both sections.
- Placeholders such as `{{evidence_types}}`, `{{disciplines}}`, `{{contract_kinds}}`,
  `{{max_stack_packs}}`, `{{stack_packs}}`, `{{domain_packs}}` and `{{lenses}}` are filled at
  compile time from `@vtc/shared` and from `skills/`, so prompts never restate an enum by hand.
- Facts about versions, licenses, vulnerabilities or prices never come from model memory.

## How an agent is assembled

1. Locked core: an engineer profile gets `roles/engineer`'s locked core first; a lens reviewer
   gets `_shared/lens-reviewer.md` first and its `skills/lens-<x>` checklist after its own core.
2. `## Contract`, generated from the effective `role.yaml` contract of the mode.
3. `_shared/result-protocol.md`.
4. The editable section(s), in the same order as the locked cores.
5. `host_overrides.<host>.prompt_append` (§12.3).

## Readings recorded here

- **Write paths of DISCOVER roles** (proposed to the integrator as a spine §5 reading; provisional
  until recorded there). §5.2 lists the Repo Cartographer and the Research Analyst as read-only,
  but each must hand over a document longer than a result's summary. They are `write_scoped` to
  `.vtc/research/repo-map/**` and `.vtc/research/briefs/**` only (§15: research roles write
  nothing outside their sandbox).
- **Security design mode** writes the threat model to `.vtc/architecture/threat-model/**`; the
  engine merges its SEC-n requirements into the specification. Verify mode is read-only.
- **QA author mode** writes where `gates.yml` `tests.acceptance_globs` says (spine AD-7 rule 7);
  its `write_paths` hold the hidden-test staging directory only.
- **Visual QA criteria V1 to V8** are defined in `visual_qa/prompt.md` (the spec names them
  without listing them), each with its question type.
- **No engine tools yet.** Role-facing engine MCP tools (repo map, research fetchers, fact
  lookups) are added to `@vtc/shared` as a MINOR contract change (spine AD-4 rule 3; names and
  shapes proposed to the integrator). Until then `tools.engine_tools` must stay empty: the
  compiler rejects any entry that is not a role-facing tool in the frozen contract, and always
  rejects the Lead's run-driving tools. The Cartographer, Research Analyst and Architect work from
  what the engine puts in their task pack.
- **Write paths are instructions plus an engine check, not a host deny.** The contract section
  lists `write_paths`; the engine checks writes on submit (AD-8 rule 14 for worktree roles; the
  same check for every write-scoped role is proposed to engine-core).

Forked roles name their upstream files in a `# Forked from` comment at the top of `role.yaml`;
roles written for VTC say so in a `# Written for VTC` comment and name what they merged in. The
compiler's repo test checks both lists against the role catalogue.

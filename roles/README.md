# roles/

Neutral role sources (spec §5.1, spine AD-14), one directory per role, compiled by
`packages/compiler` into one agent per role or per mode on each host (`agentNameFor`:
`vtc-<role>[-<mode>]`).

```
roles/<role>/
  role.yaml   # the contract, validated by RoleContractSchema in @vtc/shared
  prompt.md   # locked core, then the editable section; 150 lines at most
roles/_shared/
  result-protocol.md   # appended to every run role: how to read the task pack and return a RoleResult
  advisor-protocol.md  # appended to every advisor instead: the human's question and the advice result
  lens-reviewer.md     # the procedure every lens reviewer shares
roles/NOTICE           # the agency-agents MIT notice; copied into both compiled plugins
```

## The roster (v1)

| Kind              | Roles                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Core (§5.2)       | repo_cartographer, research_analyst, ba, architect, security (modes design, verify), designer, planner, engineer, qa (modes author, judge), spec_verifier, visual_qa, lookback |
| Engineer profiles | engineer_frontend, engineer_backend, engineer_mobile, engineer_data, engineer_devops, engineer_ai_llm (§5.2a)                                                                  |
| Lens reviewers    | lens_db, lens_auth, lens_payments, lens_secrets, lens_infra, lens_api, lens_supply_chain (§5.3, one per park-the-task risk rule)                                               |
| Advisors (§5.4)   | advisor_estimator, advisor_client_liaison, advisor_ux_researcher, advisor_incident_debugger, advisor_legacy_explainer, advisor_ml_data (on demand, through `consult`)          |

The Lead is not a compiled agent: it is the main session, driven by the Lead skill in
`plugins/common/skills/lead`.

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
3. `_shared/result-protocol.md`; for an advisor, `_shared/advisor-protocol.md`.
4. The editable section(s), in the same order as the locked cores.
5. `host_overrides.<host>.prompt_append` (§12.3).

## Readings this tree follows

Spine §5 readings 25 to 37 are Lead or integrator decisions of 2026-10-13, pending human review.

- **Advisors go through the engine** (reading 25). At the human's request the Lead calls the
  engine's `consult` tool, performs the one `spawn_role` it returns and submits the advisor's
  result with `submit`, so every advisor call is logged with its prompt SHA and model, priced and
  capped by `budgets.advisor_usd`. An advisor reads a task pack like any role and returns a role
  result through `_shared/advisor-protocol.md`. The human's question (`ConsultInput.question`) is
  its first input, of type `advisor_question`; `request` keeps its shared meaning, the run's idea
  or change request. The `advisor_question` type is provisional: it is proposed to `@vtc/shared`
  (a `KNOWN_ARTIFACT_TYPES` entry and a path helper for the file the engine writes, listed first
  under the pack's Inputs) and, until it lands, the compiler lists it in
  `PROPOSED_ARTIFACT_TYPES`, requires it as every advisor's first input and refuses it for any
  other role. The compiler (`advisorContractErrors`) accepts an advisor only
  with an `advisor_` id (agent `vtc-advisor-<name>`; only advisors use the prefix), `reviewer:
human`, exits `done`, `blocked` or `unknown`, no verdicts, no success criteria and no modes.
- **Client-liaison exports** (reading 30). Every advisor is `read_only` except
  `advisor_client_liaison`, which is `write_scoped` to `.vtc/exports/**` with output artifact
  `client_export`; the engine checks the write on submit. The compiler allows an advisor no
  other write path and no other output artifact.
- **Codex model tiers** (readings 26 and 51). Compiled Codex agents set only
  `model_reasoning_effort`; the engine resolves models (`project.yaml` `hosts.models.codex`, then
  its built-in map, which names no Codex ids yet), so `role.yaml` may not name a Codex model until
  the spike names Codex model ids.
- **Research roles write their own documents** (reading 27). The Repo Cartographer is
  `write_scoped` to `.vtc/research/repo-map/**` and the Research Analyst to
  `.vtc/research/briefs/**`, nothing else.
- **Visual QA criteria** (reading 28): V1 to V8 as defined in `visual_qa/prompt.md`, each with its
  question type.
- **SPECIFY's QA testability pass** (reading 29) is QA author mode's spec questions, for a
  dispatch without a task; QA has only the `author` and `judge` modes.
- **Dispatch settings** (reading 32). The Architect, Research Analyst and Designer read
  `architect depth`, `research depth` and `design constraints` from the pack's Dispatch section.
  The Designer writes the screen list to `.vtc/design/screens.yaml` in the shape of
  `DesignScreensFileSchema`, with every state reachable at `prototypeStatePath`
  (`<route>?state=<state>&theme=<light|dark>`).
- **Security design mode writes the threat model** (reading 37): `write_scoped` to
  `.vtc/architecture/threat-model/**` only; verify mode is read-only.
- **QA author mode** writes where `gates.yml` `tests.acceptance_globs` says (spine AD-7 rule 7);
  its `write_paths` hold the hidden-test staging directory only.
- **Gap findings stay with the human** (reading 19). Until sub-project 4, `spec_gap` and
  `design_gap` findings park the task for the human; the BA and Designer prompts have no
  task-scoped clarification mode.
- **No engine tools yet.** Role-facing engine MCP tools (repo map, research fetchers, fact
  lookups) are deferred to sub-project 4 and added to `@vtc/shared` as a MINOR contract change
  (spine AD-4 rule 3). Until then `tools.engine_tools` stays empty: the compiler rejects any
  entry that is not a role-facing tool in the frozen contract, and always rejects the Lead's
  run-driving tools. The Cartographer, Research Analyst and Architect work from what the engine
  puts in their task pack.
- **Exact paths for config and task-runner files** (readings 44, 45 and 63, Lead decisions of
  2026-10-14). The Planner's locked core tells it to name a lint, test or scanner config, or a
  `Makefile`, `justfile`, `*.mk` or `package.json` `scripts` change, by its exact path in
  `files_scope`, and to write no `{a,b}` alternatives or rule-breaking characters in a write-scope
  glob (`WriteScopeGlobSchema`).
- **No role touches VTC's guard rails** (reading 43). Every compiled agent denies `vtc
calibrate` and writes to the guarded VTC home globs; see `plugins/README.md`.
- **Write paths are instructions plus an engine check, not a host deny.** The contract section
  lists `write_paths`; the engine checks every write-scoped role's writes on submit.

## What the compiler emits for the engine

Each plugin carries `vtc/role-contracts.json` (`ROLE_CONTRACTS_ASSET`): every role's contract as
parsed from `role.yaml`, validated with `RoleContractSchema`. The daemon loads write scopes,
exits, verdicts and models only from it (AD-14 rule 6), so a change to `role.yaml` reaches the
engine through the compiled plugin, never through a second copy.

Forked roles name their upstream files in a `# Forked from` comment at the top of `role.yaml`;
roles written for VTC say so in a `# Written for VTC` comment and name what they merged in. The
compiler's repo test checks both lists against the role catalogue.

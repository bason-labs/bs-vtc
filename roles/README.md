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
roles/NOTICE           # the agency-agents (MIT) and impeccable (Apache-2.0) notices; copied into both plugins
roles/CHANGELOG.md     # every change to a role's editable section (ROLES_CHANGELOG); entries come from automatic PRs
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
  that mode's agent; text outside blocks reaches every mode. Blocks may appear only in the
  locked core.
- Placeholders such as `{{evidence_types}}`, `{{disciplines}}`, `{{contract_kinds}}`,
  `{{max_stack_packs}}`, `{{stack_packs}}`, `{{domain_packs}}` and `{{lenses}}` are filled at
  compile time from `@vtc/shared` and from `skills/`, so prompts never restate an enum by hand.
  Placeholders, too, may appear only in the locked core.
- The editable section compiles verbatim (no mode block, no placeholder, no heading named after a
  task-pack section), so a Lookback proposal written against one agent's editable part maps back
  to the role's `prompt.md` unchanged. Mode-specific heuristics are labelled in prose ("When
  judging tests:") and reach every mode's agent.
- Facts about versions, licenses, vulnerabilities or prices never come from model memory.

## How an agent is assembled

1. Locked core: an engineer profile gets `roles/engineer`'s whole prompt first, its locked core
   and then its editable section; a lens reviewer gets `_shared/lens-reviewer.md` first and its
   `skills/lens-<x>` checklist after its own core.
2. `## Contract`, generated from the effective `role.yaml` contract of the mode.
3. `_shared/result-protocol.md`; for an advisor, `_shared/advisor-protocol.md`.
4. `host_overrides.<host>.prompt_append` (§12.3).
5. The role's own editable section, verbatim.

Parts 1 to 4 are the agent's **locked part** and part 5 its **editable part**.

## Prompt parts and Lookback (spine AD-21, §5 reading 102)

- A prompt version is `effectivePromptSha(locked, editable)`, over the role's own `prompt.md`
  sections as `splitRolePrompt` returns them: `locked_sha256` and `editable_sha256` in the
  manifest are the SHA-256 of those trimmed sections (the frozen `PluginManifestAgent` contract,
  and what lookback-research's `sectionSha` checks a proposal's base against). Every mode of a
  role shares them. An engineer profile's locked section is `engineerProfileLockedSection`
  (`@vtc/shared`, reading 172, D-br): the Engineer's locked core and editable section, then the
  profile's own locked core, so an Engineer prompt change is a new version of every profile and
  a profile's scorecard never mixes two Engineer prompts. Each plugin carries the two sections
  as `vtc/prompts/<agent>/locked.md` and `editable.md`, so the engine can read them from the
  plugin. The rest of the compiled locked part (the contract, the protocol, `prompt_append`) is
  outside the Lookback identity; it changes with the role version or the compiler, and the
  manifest's `prompt_sha256` (the SHA of the instructions as emitted) records it.
- The editable part is the role's own section verbatim, engineer profiles included, so a
  promoted proposal maps back to `roles/<role>/prompt.md` unchanged. A profile's proposal never
  carries the Engineer's heuristics: those sit in the profile's locked part and change only
  through a proposal for the engineer role, which reaches every profile once it is upstreamed
  into `roles/engineer/prompt.md` and the plugins are recompiled. The editable-section rules
  (`editableSectionErrors`, `RESERVED_EDITABLE_HEADINGS`) are `@vtc/shared`'s, so the compile
  and Lookback's proposal check enforce one rule set (reading 175).
- Reading 102 moves the editable section out of the compiled agent: the engine renders it first
  in the task pack as `## Role heuristics`, before `## Dispatch` (the pinned version, else the
  compiled default from the plugin's editable asset), so a canary needs no plugin reinstall.
  `EDITABLE_IN_PACK_ROLES` lists the switched roles: the Spec Verifier, the role with the most
  dispatches per run (D-bl, reading 166; switched at version 2.0.0, since switching changes the
  compiled locked part, D-bm). A switched agent carries the locked part only, ending in a note that only
  the block its pack opens with, up to the first `## Dispatch` heading, is instructions (a
  heading of that name further down is pack data). Switching changes its `prompt_sha256` but not
  its `locked_sha256` or `editable_sha256`. Any other role switches after an A/A comparison.
- The lookback role writes `proposal.json` (`PromptProposal`: at most three changes, each with a
  hypothesis, a target metric and trace ids) and `editable.md` (the full proposed section) under
  `.vtc/lookback/proposals/<role>/`. It never writes `roles/`, the stored versions or the pins.
- A replay verdict `improve` opens an automatic pull request to VTC's own repository (D-cb,
  reading 196): it replaces the section in `roles/<role>/prompt.md` (a MINOR change) and adds an
  entry to `CHANGELOG.md` from the `changelog-entry` template (hypothesis, trace ids, diff,
  evaluation). A human's merge of that pull request is the promotion for everyone; VTC never
  merges it. `vtc lookback approve|pin` stays for a local canary on one machine.

## Replay arm plugins (D-cg, reading 201)

A Claude Code headless run loads the compiled agent, so a Lookback replay arm runs its own plugin
directory: `createArmPluginCompiler({ pluginDir })` (`ArmPluginCompiler` in `@vtc/shared`; the
cli binds it to the shipped Claude Code plugin and injects it as `EngineDeps.armPlugins`).
`compileArm` writes a full copy of the plugin in which only `agents/<agent>.md`'s editable
section differs. The manifest keeps the name `vtc`, so `--agent vtc:<agent>` resolves, and its
version is `arm-<sha12>` of the copy (`armPluginVersion`); `promptSha256` is
`effectivePromptSha(locked, editable)`. The candidate section passes the shared
`editableSectionErrors` and the AD-9 check, the base agent must still hash to its manifest SHA,
and an `editable_in_pack` agent's file stays unchanged (its section reaches it through the pack).
The arm is self-consistent: its `vtc-manifest.json` gives the arm agent's own `prompt_sha256`
and `editable_sha256`, and its editable asset holds the arm's section (`armManifest`). Every
path stays inside `outDir`, with no symbolic link: the base tree is read without following
links, each file is created exclusively with `O_NOFOLLOW` in a directory whose device and inode
are still the ones this call created, and the written tree is walked again. A failure removes
only what the call created, never recursively, and nothing once `outDir` was replaced. This is
checked structurally in the tests; nothing runs the real `claude`.

## New roles (D-cd, reading 198)

When Lookback proposes a new role or specialist profile, VTC builds it with `scaffoldRole` and
`writeScaffold` (`packages/compiler/src/scaffold.ts`): `roles/<id>/role.yaml` opened by
`# Written for VTC by the new-role scaffold (D-cd).` and the reason, a `prompt.md` with the locked
core and the editable section, and a test stub at `packages/compiler/test/roles/<id>.test.ts`.
The compiler picks up every `roles/<id>/` by itself, so the scaffold proves the wiring instead of
editing a list: it compiles the role against the repo's sources and returns the compiler's
errors when it does not compile on both hosts. It also requires the §5.1 parts a prompt brings
(a procedure, a definition of done and an example), a new role at version 1.0.0, and for an
engineer profile an `engineer_<discipline>` id for a discipline no profile covers. It builds
`core` roles and `engineer_profile` specialists only: a lens reviewer belongs to a park-the-task
risk rule and an advisor answers the human, so both stay hand-made. When no replay can compare
the role, the proposal is evidence-only: the scaffold returns the `needs-eval` label and writes
it into the test stub as a todo. Nothing is overwritten, nothing is written through a link,
and a failure part-way removes what was written.

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
- **G2 directions** (§9.1; spine §5 reading 116, contracts 4.6.0). The Designer writes each
  direction's first viewport to `.vtc/design/prototype/directions/<id>/index.html` (a
  `prototype` artifact) and its `G2DirectionDraft` fields (`id`, `title`, `thesis`,
  `prototype`) to `.vtc/design/directions/<id>.json` (a `design_direction` artifact); the engine
  adds `first_viewport` and the novelty verdict, and drops a verdict the Designer wrote. The
  Architect returns a `changes` triage's ADR as an `adr` artifact. Both output lists landed with
  the matching engine fixture change at the wave-3 merge.
- **Role-facing engine tools** (AD-4 rule 3, AD-22; contracts 4.5.0). `ROLE_MCP_TOOLS`
  (`research_fetch`, `fact_lookup`, `fact_propose`) is the only engine surface a role may name
  in `tools.engine_tools`; the compiler rejects any other entry and always rejects the Lead's
  run-driving tools. An agent that declares one preloads the skill that teaches it
  (`research-fetch`, `research-facts`). The Architect and the Research Analyst declare all three
  (with the matching engine fixture change, at the wave-3 merge).
- **Exact paths for config and task-runner files** (readings 44, 45 and 63, Lead decisions of
  2026-10-14). The Planner's locked core tells it to name a lint, test or scanner config, or a
  `Makefile`, `justfile`, `*.mk` or `package.json` `scripts` change, by its exact path in
  `files_scope`, and to write no `{a,b}` alternatives or rule-breaking characters in a write-scope
  glob (`WriteScopeGlobSchema`).
- **No role touches VTC's guard rails** (readings 43 and 81). The guarded VTC-home globs and
  `vtc calibrate` are `permissions.deny` rules and sandbox deny lists built in `@vtc/shared`, not
  compiled into agents; see `plugins/README.md`.
- **Write paths are instructions plus an engine check, not a host deny.** The contract section
  lists `write_paths`; the engine checks every write-scoped role's writes on submit.
- **Locked-core edits are MAJOR** (reading 167, D-bm): any edit to a role's locked core bumps
  its `role_version` MAJOR, even when only the prompt changes.
- **Host web search** (H-3, reading 156). The Research Analyst (`tools.host_web: true`, the only
  role with it) discovers pages with its host's own web search and page fetch: its Claude Code
  agent's `tools` name `WebSearch` and `WebFetch`, and its contract section says so on both
  hosts. A Codex agent file has no per-agent web switch, so the Codex adapter sets web search for
  a headless `host_web` run, and only ever `cached` (`CODEX_HOST_WEB_SEARCH`, D-cf, reading 200):
  it answers from a search index and opens no page the model picks, so the Codex contract line
  says "search only" and the role reads a page only through `research_fetch` (version 4.0.0).
  Page content is untrusted data; a page the role relies on is proposed with `fact_propose` as a
  `web` source request plus `reported_source`, so the engine fetches and checks it, and a claim
  it cannot verify stays `unverified`. The engine's `research_analyst` fixture carries
  `tools.host_web: true`: the AD-14 drift test compares every contract field but `version` and
  `mission` with `role.yaml`, so `host_web` is the field that must match.
- **The Designer method** (spec §9.1; readings 116, 174). The Designer and Visual QA preload the
  `design-craft` skill, forked from pbakaus/impeccable (Apache-2.0, see `NOTICE`): screen modes,
  new-work steps 1–5 inside the engine's dealt constraints, the per-screen Direction contract,
  the craft floor and the font blocklist. Each key screen's design contract, with its mode and
  one Direction contract per direction, is `.vtc/design/screens/<screen id>.md`, returned as a
  `screens` artifact. A new-repo UI design offers 2 to 3 directions (`G2_DIRECTIONS`); with
  fewer, the engine re-dispatches the Designer once and then G2 blocks (D-bt).
- **The chosen direction** (reading 179). After G2 the engine names the direction the human
  chose in post-G2 UI packs (`TaskPack.design_direction`), and the design contracts' path is
  frozen (`DESIGN_CONTRACTS_DIR`, `designContractPath`), which `{{design_contracts_dir}}` now
  renders. Visual QA (3.0.0) judges V1, V2 and V8, and the frontend and mobile profiles (2.0.0)
  build, against that direction's `## Direction <id>` block, read from the `design direction`
  line of the pack's Dispatch section; a `design exit` line naming `category_standard` (the G2
  exit, `{{category_standard_exit}}`) means no Direction contract applies and Visual QA judges
  against the category standard. Only those engine-written lines name the choice
  (`PENDING_DISPATCH_LINES` in `instructions.ts`). `renderTaskPack` prints neither yet, and
  TaskPack has no exit field (contract proposals of this branch); until they land the profiles
  build to the approved prototype and the design system as at 1.0.0 and never stop for want of
  the line, and Visual QA returns V8 `unknown` when the contracts hold several directions, as
  reading 179 allows.
- **Automatic runs** (D-cd, reading 198). An automatic run's issue is its spec (no G1 or G2). The
  Spec Verifier (3.0.0) treats a run as automatic only when the engine lists the issue among its
  pack's Inputs as an `automation_issue` entry (`{{automation_issue_input}}` in the prompt), never
  from a `request` input, which a human-started run can carry too, and never from a marker or
  other text in the pack. It then also checks the pull request's change against the issue. The
  input type is a contract proposal of this branch (`PENDING_PACK_INPUTS`): `PACK_INPUT_TYPES`
  gains `automation_issue`, and engine core lists it in the Spec Verifier's pack on a run whose
  `run.started.automation` is set, and on no other run. Until it lands the Spec Verifier judges
  every run as a human-started one, and a todo merge gate in the round-4 repo test tracks it. The
  Lead relays `NextResult.notices` (the daily automation summary, `HOST_WEB_OFF_NOTICE`) once, in
  plain words.
- **The CHANGELOG anchor** (D-bv). `roles/CHANGELOG.md` (`ROLES_CHANGELOG`) holds
  `<!-- vtc:changelog-entries -->` (`ROLES_CHANGELOG_ANCHOR`) exactly once; the upstream module
  inserts each new entry directly below it, and the compiler refuses a CHANGELOG without it. The
  constant is local until the proposed shared one lands next to `ROLES_CHANGELOG`, with the
  upstream module's `insertChangelogEntry` as its consumer (a todo merge gate tracks it).

## What the compiler emits for the engine

Each plugin carries `vtc/role-contracts.json` (`ROLE_CONTRACTS_ASSET`): every role's contract as
parsed from `role.yaml`, validated with `RoleContractSchema`. The daemon loads write scopes,
exits, verdicts and models only from it (AD-14 rule 6), so a change to `role.yaml` reaches the
engine through the compiled plugin, never through a second copy.

Forked roles name their upstream files in a `# Forked from` comment at the top of `role.yaml`;
roles written for VTC say so in a `# Written for VTC` comment and name what they merged in. The
compiler's repo test checks both lists against the role catalogue.

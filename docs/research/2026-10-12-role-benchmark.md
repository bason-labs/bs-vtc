# Role Benchmark: Which AI Roles a Virtual Tech Company Needs, and How to Define Them

Date: 2026-10-12. This is a companion to `2026-10-12-agency-agents-role-catalog.md`, which scores all 141 tech-relevant agency-agents files one by one. Unverified or vendor-only claims are marked **[U]**.

## 1. Bottom line

- **Spend tokens on the task contract, not the persona.** Persona prompts don't reliably improve accuracy.
  - MAST: "disobey role specification" is only **1.5%** of multi-agent failures. Most failures come from the task spec (11.8%), termination (12.4%) and verification (17.3%).
- **A role gets its own agent only if it needs one of these:**
  - independence (verifiers);
  - context isolation (heavy reading or research);
  - a different model tier or tool set.
- **Specialist *implementers* are skills loaded into the single Engineer.** Frontend, mobile and DB work are not separate writing agents.
- **Merge PM and Lead Engineer into one Planner.** The PM mechanics (scheduling, caps, status) move into the engine.
- **Never merge an author with its judge:**
  - BA and Spec-Verifier
  - Engineer and QA
  - Designer and Visual QA
  - Planner and the coverage check
- **Correction to earlier research:** Claude Code subagents **can** spawn subagents, up to 3 levels deep by default (`CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH`). Plugin agents still ignore their own `hooks`, `mcpServers` and `permissionMode` (https://code.claude.com/docs/en/sub-agents).

## 2. Real-world baseline: who owns what

Sources:
- Scrum Guide 2020
- the UK government's GDS service-team roles
- SAFe
- Team Topologies (split work when cognitive load is too high)
- OWASP SAMM
- the Threat Modeling Manifesto
- Google SRE (launch coordination checklist; incident command, ops, comms and planning roles)
- W3C ARRM (accessibility responsibility matrix)
- GDPR Art. 35 (the DPO must be consulted on DPIAs)
- agency discovery and SOW practice

| Artifact or gate | Accountable / Responsible | Consulted / reviews |
|---|---|---|
| Discovery and research brief | PM/PO; the BA and user researcher do the work | Client or account lead |
| Spec, backlog, requirement IDs | PO is accountable; the BA writes it | QA (testability), Architect |
| UX flows, prototype, content | Design lead | Accessibility specialist |
| Architecture, ADRs, non-functional requirements | Architect or tech lead | Security, SRE |
| Threat model and security requirements | AppSec or security champion | Architect |
| DPIA / privacy | Controller or PO | DPO (mandatory) |
| Estimate and SOW (agency) | Account or delivery lead | Solution architect, BA, PM |
| Plan and tasks | Developers, with the delivery manager facilitating | Tech lead |
| Code, and review by someone other than the author | Engineer | Tech lead |
| Tests: functional, accessibility, performance, security | QA/SDET, accessibility, performance and AppSec specialists | — |
| Launch and release | SRE launch sign-off, release manager | PO |
| Client sign-off and change requests | Account lead with the client | Delivery manager |

## 3. Other AI role catalogues: what is distinctive

- **wshobson/agents** (40k stars):
  - 202 agents with a model mix across tiers. Only 15 declare `tools`, so most reviewers can write.
  - Agents are long capability lists with no output schema.
  - Good packaging: small plugins and a static plugin eval.
- **VoltAgent/awesome-claude-code-subagents** (163 agents):
  - Clear philosophy on tools (reviewers get read-only tools, writers get write tools) and on which model each role uses.
  - Agents are generated from one template that refers to a context manager that doesn't exist.
  - It breaks its own tool rule in places.
- **contains-studio/agents:** dormant and without a license.
- **0xfurai/claude-code-subagents:** 138 language specialists, dormant.
- **Anthropic official plugins**, the best example:
  - `feature-dev`: explorer, architect and reviewer roles, all read-only. The reviewer reports only findings with confidence ≥80.
  - `/code-review`:
    1. Haiku gatekeepers check eligibility.
    2. **Five parallel Sonnet reviewers, each given different inputs**: CLAUDE.md, the diff alone, history, earlier comments, code comments.
    3. A Haiku scorer rates each finding on a verbatim rubric.
    4. Findings scoring below 80 are dropped.
  - `claude-security` separates the patch generator from the patch verifier.
- **BMAD:** five persona skills that mostly serve as menus. The real work happens in workflow skills and review lenses. v6.3 folded QA and SM into Dev.
- **MetaGPT:**
  - Each role produces a fixed document.
  - A role acts only once its inputs exist.
  - Ablation: human revisions dropped from 10 to 2.5 and executability rose from 1.0 to 4.0, at +51% cost.
- **ChatDev 2.0:** a general YAML DAG platform.
- **AgentsRoom [U]:**
  - 14 roles, each "model + a few lines + pinned skills".
  - Handoffs are schema-validated.
  - QA runs on Haiku through an MCP tool.
- **Factory Missions [U]:** orchestrator, fresh worker per feature, validators at each milestone.
- **Augment Intent [U]:**
  - The coordinator turns the spec into a DAG and runs implementers in waves, one worktree each.
  - The verifier checks against the spec, not the diff.
- **Kiro Crew:** each agent template is model + prompt + tools + skills.
- **Claude Code built-in agents:**
  - Explore and Plan are read-only.
  - Useful frontmatter fields: `tools`, `disallowedTools`, `model`, `effort`, `maxTurns`, `skills`, `isolation: worktree`, `omitClaudeMd`, `memory`.
  - Skills load progressively: metadata, then body, then files.

## 4. Evidence on role design

### Persona prompting
- **Zheng et al. 2024** (162 roles): no gain over a control, and the effect looks random (https://arxiv.org/abs/2311.10054).
- **Wharton report, Dec 2025:** no consistent gain from expert personas; low-knowledge personas hurt (https://arxiv.org/abs/2512.05858).
- **Araujo et al., EMNLP 2025:** **irrelevant persona details swung accuracy by up to ~30 points.** Drop names, emoji and "vibe" lines (https://arxiv.org/abs/2508.19764).
- **Hu et al. 2026:** expert personas lowered MMLU but improved style and safety (https://arxiv.org/abs/2603.18507).
- **BMAD #2675:** a "cynical reviewer" persona made no difference. Asking **"what is missing?"** did.

### What does help
- **Structured documents passed between roles** (MetaGPT).
- **Precise briefs:** objective, output format, tools and sources, boundaries (Anthropic's multi-agent research system).
- **Checklists:** judge agreement with humans rose from 46.4% to 52.2%, and self-refinement improved by 7.8 points (TICK, https://arxiv.org/abs/2410.03608).
- **Canonical examples and prompts at the "right altitude"** (Anthropic, context engineering).
- **Reliable external feedback.** A model correcting itself without outside feedback mostly fails (TACL 2024).
- **A separate evaluator.** Generators "reliably skew positive" when grading their own work (Anthropic, harness design).
- **An independent test designer:** HumanEval-ET went from 69.5 to 77.4 (AgentCoder).
- **Fresh context** (Chroma's context-rot research). Note that self-preference can survive a fresh context, so reviewers also need different inputs, deterministic checks, and optionally a different model family.

### How many agents
- **Anthropic's research system:**
  - Multi-agent beat single-agent by 90.2%, at about 15× the tokens of chat.
  - Token spend explains 80% of the variance.
  - It is a poor fit for coding with a shared context.
- **Google/MIT (180 configurations), https://arxiv.org/abs/2512.08296:**
  - Centralized coordination gains 80.8% on parallelizable tasks.
  - **Every multi-agent variant loses 39–70% on sequential tasks.**
  - Gains go flat once a single agent already passes about 45%.
  - Independent agents amplify errors 17.2×; centralized ones 4.4×.
- **Cognition, Apr 2026:**
  - Keep writes single-threaded.
  - Extra agents should add "intelligence, not actions": reviewers with a clean context, a stronger model to consult, read-only search.
- **One agent with skills instead of many agents** (https://arxiv.org/abs/2601.04748):
  - 53.7% fewer tokens at about equal accuracy.
  - Skill selection degrades past about 20 skills; hierarchical routing helps.
  - **This does not work for reviewers,** which need independence.
- **Voting** helps more as task difficulty rises. Use it for noisy, high-stakes judgements such as Visual QA.
- **Every part of a harness encodes an assumption about what the model can't do alone.** Re-test each role as models improve; Lookback replays can do this.

### Deterministic step or AI agent?
If the output follows fully from the inputs plus rules, write code: scheduling, DAG order, caps, gate verdicts, semver and changelog, traceability, cost, risk triggers.

## 5. Recommended role architecture

### Role definition template
**Claude Code agent file:**
- Frontmatter: `name`, `description` (one-sentence trigger), `tools` (allowlist), `disallowedTools`, `model`, `effort`, `maxTurns`, and `skills` (at most 3).
- Body, at most about 150 lines, in this order:
  1. Mission (2 lines)
  2. Inputs
  3. Procedure checklist
  4. Output contract
  5. Definition of done
  6. Never-do list
  7. Exits
  8. 1–2 canonical examples
- **No** identity, memory or communication-style sections.

**Engine contract `roles/<role>.contract.yaml`:**
- input artifact IDs;
- a JSON output schema: a verdict enum plus `findings[{fingerprint, severity, evidence, req_ids}]`;
- exits: `done | spec_conflict | blocked(question) | unknown`;
- machine-checked success criteria;
- the named reviewer;
- a budget;
- a locked core and an editable section.

**Prompts name port (artifact) types only.** They never name other roles or file paths; the graph configuration does the wiring.

**Context budgets [heuristic]:**

| Role type | Budget |
|---|---|
| Authors | 30–60k |
| Engineer task pack | ≤20k |
| Review lenses | ≤15k |
| Every return | ≤1.5k tokens |

### Tier 1: core pipeline
The full tables are in the catalogue §7 and in this report's source.
- **Lead** (the main session)
- **Repo Cartographer** (existing repos only)
- **Research Analyst** (scaled to the task)
- **BA** (Opus)
- **Architect** (Opus)
- **Security** (design mode and verify mode)
- **Designer** (only when there is UI)
- **Planner** (PM and Lead Engineer merged)
- **Engineer** (single writer, with skill packs)
- **QA** (author mode: writes tagged acceptance tests without seeing the diff; judge mode)
- **Spec-Verifier** (one call per acceptance criterion; sees only the criterion and the evidence)
- **Visual QA** (only on UI changes; 2-of-3 vote)
- **Lookback** (offline)

**Model tiers:**
- Haiku: gatekeeping and scoring.
- Sonnet: reviewing and implementing.
- Opus: the few high-leverage authoring steps (BA, Architect, deep security on risk hits).
- **Don't put QA test *authoring* on Haiku.**

### Tier 2: conditional specialists
Each is a **generic read-only Reviewer agent plus a lens skill**, triggered by the engine's Risk Router after the deterministic checks.

| Specialist | Trigger |
|---|---|
| DB / migration | migrations, schema changes, bulk deletes |
| Identity & auth | auth, sessions, RBAC, SSO |
| Payments | payments, billing, webhooks |
| Privacy | PII, tracking, third-party data flows |
| Secrets response | a scanner finds a secret |
| Infra / IaC / CI (DevOps/SRE) | Terraform, K8s, Docker, CI files |
| Public API contract | OpenAPI/gRPC/GraphQL or public route changes |
| Accessibility | UI tasks |
| i18n / content | user-facing strings, locales |
| Performance | the spec sets a performance budget |
| LLM feature | LLM calls, prompts, vector search |
| Mobile | iOS/Android/RN/Flutter (a **skill pack for the Engineer**, plus a simulator gate) |
| Docs / tech writer | public API, CLI or README changes |
| Supply chain | a new dependency |
| Compliance mapper | the spec declares SOC2/HIPAA/PCI |

By default a specialist is a rule addendum injected into an existing context, costing no extra invocation. It becomes a separate node only when a risk rule fires.

### Tier 3: on-demand advisors (through the Lead)
- Solution Architect / Estimator (uses the engine's history of cost per requirement)
- Client-liaison writer (client exports; impact of change requests against the signed spec)
- UX Researcher
- Incident Responder / Debugger
- Legacy explainer
- ML/Data advisor

### Engine "roles" (code, no AI)
- Scheduler / delivery manager
- Context Packer
- Risk Router
- Gate Runner
- Traceability Builder
- Triage, dedup and progress detection
- Escalation Manager
- **Release Manager** (an AI on Haiku only polishes the release notes)
- Cost Accountant
- Prompt Registry and audit trail

### Pairs where a role must never review its own output
- BA → Spec-Verifier
- Engineer → QA and all reviewers
- Designer → Visual QA
- Architect → architecture review
- Planner → coverage check
- QA → test adequacy (checked by mutation testing)
- Lookback → its graders

## 6. Workflow as data, plus a live node graph

How other tools represent workflows:
- **AgentsRoom [U]:** a React Flow canvas with role nodes (including read-only roles), conditional edges, join gates, Await (human) nodes, and a max-cycles guard.
- **ChatDev 2.0:** YAML with agent, python, human, subgraph and loop_counter nodes, plus map/tree fan-out.
- **MS Agent Framework:** declarative YAML (If, Foreach, Goto, BreakLoop, Question).
- **LangGraph:** StateGraph, `Send`, `Command`, `recursion_limit`, `interrupt`.
- **n8n:** If/Switch, Merge, Loop, Wait, and send-and-wait approval.
- **Flowise:** Loop with a max count; a human-input node.
- **Dify:** Loop with max count and an exit condition.

**Node types we need:**
- `role`
- `gate` (deterministic)
- `human_approval`
- `router`
- `fan_out` / `join`, with a join policy: all-pass, any-fail-closes, or quorum
- `loop_guard`: `max_rounds`, a no-progress check, and `on_exhaust` → park
- `park`, scoped to one task, with a resume edge
- `subflow` / `map(tasks)`, honoring `after`
- typed end states: `built`, `done`, `blocked`, `non_converged`

**Edge types:** sequence, conditional, back-edge (must pass through a `loop_guard`), escalate/resume.

**The engine validates every flow:**
- unguarded cycles are rejected;
- a reviewer's role must differ from the author's role;
- every role node has an output schema;
- removing a human gate or the Security gate requires an override recorded in the audit trail.

**Live view:** each node shows its state, loop edges show their round counter, and tokens are shown per node. Clicking a node shows its artifact and evidence.

# VTC: Virtual Tech Company. System design spec

- **Status:** Draft for review
- **Date:** 2026-10-12
- **Working name:** VTC. The product name is still to be chosen, and it must not contain "Claude Code" or "Codex".
- **Type:** System-level spec. It covers architecture, contracts between parts, and a roadmap. Each sub-project in §19 gets its own detailed spec → plan → build cycle.
- **Research base:** see `docs/research/`:
  - landscape
  - round2 deep dives
  - agency-agents role catalogue
  - role benchmark
  - architecture practice
  - token economy
  - multi-host (Codex + Claude)

---

## 1. Purpose

VTC turns an idea or a change request into reviewed, tested, merged code. It works like a small, disciplined tech company made of AI roles. Each role has one job, a precise contract, and its own checks.

- **Who uses it:** software teams and agencies.
  - Day to day, **engineers** drive it from Claude Code or Codex.
  - Other people (PMs, leads, clients) read its outputs and watch the flow in a read-only dashboard.
- **Kinds of work:** new projects started from an idea, and new features or changes on existing repos.
- **What comes out:**
  - an approved spec and an approved architecture/design;
  - verified code merged to the configured level (§6.7);
  - an evidence bundle per task;
  - prompt scorecards that improve over time.

### 1.1 Success criteria
1. An approved spec and architecture become merged, verified code. **No human touches it between the two gates and the merge, except for escalations.**
2. **Every loop terminates,** either by passing or by parking with evidence. No silent passes and no infinite loops.
3. **Every AI call can be traced** to a role, a host/model and a prompt version.
4. **Token use per task stays within budget** (§11). After calibration, the median task costs well under BMAD's reported median of about 6.6M tokens per story.
5. **Escaped defects and auto-merge reverts are tracked.** Lookback can show quality per token for each prompt version.

### 1.2 Non-goals for v1
- Hosted or cloud service; multi-tenant SaaS.
- Our own AI chat UI; a visual flow *editor*.
- Running in Claude Code web or cloud sessions, or WSL.
- Native mobile and canvas/WebGL visual QA.
- Driving Figma or Penpot as the source of truth. They are optional mirrors only.
- Model providers other than Anthropic (via Claude Code) and OpenAI (via Codex).

---

## 2. Constraints and decisions so far

| # | Decision | Why |
|---|---|---|
| D1 | Runs fully locally on the developer's machine. No server. Teams share through git. | User requirement |
| D2 | Runs on the user's **own subscription**, Claude or ChatGPT, through the user's own **unmodified** Claude Code or Codex. VTC never handles credentials. | User requirement; Anthropic and OpenAI terms (round2 §1, multi-host §1) |
| D3 | Packaged as **host plugins plus a host-agnostic local engine** (an MCP server) | The safest packaging under both vendors' terms |
| D4 | Humans approve exactly two gates: **G1 spec** and **G2 architecture + design**. Everything else is autonomous. | User requirement |
| D5 | Risky items **park only their own task** (and its dependents); everything else keeps running. Escalations come through the Lead chat. | User requirement |
| D6 | Fix loops are capped at **3–5 rounds per task, set by risk**, then go to a human | User requirement |
| D7 | The flow **composes itself per task** (the engine picks the agents). The UI is a **read-only n8n-style live graph**. | User requirement |
| D8 | v1 dashboard ships in our source and runs locally; run state is **git-tracked files** | User requirement |
| D9 | Auto-merge **Level 2 by default** (local merge, push, PR); **Level 3 opt-in** (PR auto-merges into main after green CI) | User requirement |
| D10 | Either host per user; **cross-family review is opt-in** for high-risk tasks | User requirement |
| D11 | **Deterministic first.** If code can decide it, code decides it. The token budget is a hard constraint. | User requirement; token-economy research |
| D12 | The Architect **researches before proposing**; per-project and per-task depth | User requirement; architecture research |
| D13 | **All TypeScript** (pnpm + turbo monorepo), **shipped as a single-file binary** `vtc` (Bun `--compile`) from v1 | User decision 2026-10-13 |
| D14 | Flow Studio reuses the **Deep Sea theme, ui kit and React Flow canvas from `bs-job-agents/apps/web`** | User requirement |
| D15 | The dashboard shows **5-hour and weekly usage for each host**. The engine **auto-continues after a reset.** | User requirement |
| D16 | Designer output must be **distinct per project, even on the same topic.** The direction is chosen by a code-seeded roll plus a novelty check plus human selection. | User requirement; impeccable research |

---

## 3. Design principles

1. **The engine decides; agents act.** Flow, caps, counters, budgets and state transitions live in engine code. They never live in prompts.
2. **Documents with IDs are the interface between roles.** IDs flow from REQ-n through AD-n and T-n to tests. Prompts name *artifact types*, never other roles or file paths.
3. **Tools decide pass/fail.** AI judges only what tools can't, and every AI verdict must cite evidence the engine can check.
4. **Separation of author and judge.**
   - Verifiers start with a fresh context, are read-only, and see different inputs from the author.
   - A role never reviews its own output (§5.5).
   - Only one agent writes to a worktree at a time.
5. **Park the task, not the company.**
6. **Contracts, not personas.** Role files have no identity, emoji or "vibe" sections (role benchmark §4).
7. **Everything is traced and versioned,** including prompts, graders and gate configs.
8. **Enforcement lives where it holds on every host:** the engine and the OS sandbox. Host hooks are an extra layer of defence only.

---

## 4. System architecture

```
┌──────────────────────────── Developer machine ─────────────────────────────┐
│ Host: Claude Code (CLI / VS Code / Desktop local)  OR  Codex (CLI / IDE / app)│
│  └─ LEAD = the main chat session ◄── engineer: ideas, approvals, answers    │
│        │ MCP tools                       ▲ role results                     │
│        ▼                                 │                                  │
│  ENGINE (local MCP server, TypeScript, deterministic)                       │
│   flow composer · scheduler · loop controller · budget controller           │
│   gate runner (sandboxed) · write-scope checker · schema validator          │
│   risk router · triage/progress · escalation manager · merge queue          │
│   research fetchers + cache · trace recorder · scorecards · release         │
│        │ dispatch(role, task, pack)          │ writes                       │
│        ▼                                     ▼                              │
│  ROLE AGENTS (compiled per host;     .vtc/ (git-tracked = source of truth)  │
│  fresh context, scoped tools,        .vtc/state/ (gitignored: SQLite index, │
│  model/effort per role)                transcripts, blobs)                  │
│                                      ~/.vtc/ (outside repos: hidden tests,  │
│                                        research cache, per-client data)     │
│                                              │ reads (+ live events)        │
│  FLOW STUDIO (read-only local web dashboard, `vtc dashboard`) ◄─────────────┘
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.1 Components

| Component | Responsibility | Depends on |
|---|---|---|
| **Engine core** | Owns all project and run state, plus deterministic decisions: composing the flow, scheduling, caps, budgets, gates, triage, escalation, merging, tracing. Exposes MCP tools. Has no knowledge of hosts. | SQLite, git, the gate tools |
| **Host adapter** (Claude Code; Codex) | `install`, `spawn_role` (in-session subagent or headless CLI), `parse_events` (normalised to `done / limit / auth / error`), `resume`, `sandbox_profile` | Engine interface; the host CLI |
| **Role compiler** | Turns neutral role sources (YAML + Markdown) into host formats: Claude agent `.md` files; Codex agent TOML plus SKILL.md | Role sources |
| **Host plugins** | Role agents, skills, commands (`/vtc …`), hooks (an extra layer of defence), MCP registration of the engine | Role compiler |
| **Flow Studio** | Read-only dashboard: live graph, drill-down into artifacts and evidence, design review, scorecards | `.vtc/` files plus the engine's event stream |
| **CLI `vtc`** | `init`, `calibrate`, `dashboard`, `pause`/`resume`, `status`, `doctor` | Engine |

### 4.2 Lead event loop
1. The Lead calls `engine.next()`. The engine returns actions, for example "spawn QA-author on T-7 with pack P", "ask human", or "nothing; waiting".
2. The Lead runs those actions. Roles run as background subagents where the host supports it; otherwise they run headless.
3. Each result goes back through `engine.submit(result)`. The engine:
   - validates the result against its schema;
   - checks that its claims match reality (files exist, commits exist, citations resolve);
   - runs the write-scope check;
   - updates state;
   - returns the next actions.
4. **The engine rejects results that are out of order or invalid.** Because the Lead only dispatches what the engine tells it to, the flow can't drift.

### 4.3 Files

| Location | Contents | Shared |
|---|---|---|
| `.vtc/project.yaml` | Track defaults, merge level, caps, budgets, risk rules, allowlists, host preferences | git |
| `.vtc/gates.yml` | Calibrated gate commands and the baseline reference | git |
| `.vtc/defaults.toml` | The team's approved stack, cloud, and banned technologies (for the Architect) | git |
| `.vtc/research/` | Cited research notes plus `facts.jsonl` | git |
| `.vtc/spec/` | The spec, with REQ-n requirements; frozen after G1 | git |
| `.vtc/architecture/` | The architecture spine (AD-n), candidates, C4 diagrams, design notes per task | git |
| `.vtc/design/` | `flows.mmd`, `screens.yaml`, `tokens.json`, `DESIGN.md`, `prototype/`, `components/`, `reviews/` | git |
| `.vtc/tasks/T-n.md` | Plan files with intent contracts (§6.3) | git |
| `.vtc/evidence/T-n/` | Gate reports (JUnit, SARIF), findings, traceability, verdicts | git |
| `.vtc/runs/<run>/events.jsonl` | Append-only event log, committed at milestones | git |
| `.vtc/lookback/` | Scorecards per machine, `pins.yaml`, the changelog | git |
| `.vtc/state/` | SQLite index, full transcripts, blobs | gitignored |
| `~/.vtc/` | Hidden acceptance tests, the research cache, the pinned scanner store | local only |

### 4.4 Product source layout, formats, build and distribution
```
vtc/                         pnpm + turbo monorepo, TypeScript everywhere
├─ packages/shared/          Zod schemas = JSON Schemas (task, finding, escalation, event, role result)
├─ packages/engine/          deterministic core + MCP server (stdio) + HTTP/SSE for the dashboard
├─ packages/adapters/        claude-code/, codex/   (spawn, parse_events, resume, sandbox, usage)
├─ packages/compiler/        roles/ + skills/ → dist/claude-plugin, dist/codex-plugin
├─ packages/cli/             `vtc` entry: init, calibrate, dashboard, pause/resume, install, doctor, engine
├─ apps/dashboard/           Flow Studio (Next.js 16 static export, React 19, Tailwind v4, Radix, React Flow)
├─ roles/<role>/             role.yaml (contract) + prompt.md (locked core + editable section)
├─ skills/                   SKILL.md packs shared by both hosts (architect refs, lenses, designer, mobile…)
├─ gates/                    gate definitions, scanner pins (version + SHA-256), MIT rulesets
└─ dist/                     GENERATED plugins and binaries (never hand-edited)
```

**Formats:**

| Format | Used for |
|---|---|
| TypeScript | Everything deterministic |
| YAML / JSON validated by schemas | Contracts, config and every AI output |
| Markdown | Prompts, skills and human-facing documents |
| HTML / CSS | Prototypes |
| DTCG JSON | Design tokens |

**Build and distribution: a single file.**
- `bun build --compile` produces **one executable `vtc`** containing:
  - the runtime;
  - the engine and CLI;
  - the dashboard's static assets;
  - the compiled plugin templates.
- **Targets:** darwin-arm64/x64, linux-x64/arm64, windows-x64.
- **Runtime choices that keep the binary self-contained:**
  - The engine runs on the Bun runtime.
  - SQLite through `bun:sqlite`, with no native addon.
  - tree-sitter through WASM.
  - The dashboard is a **static export**: no Next server; the engine serves the files plus an SSE stream.
- **Downloaded on demand by `vtc doctor`, into `~/.vtc/`, pinned by checksum:**
  - Playwright's Chromium;
  - the scanner binaries (Opengrep, Gitleaks, osv-scanner…).
- **Release channels:** GitHub Releases, a Homebrew tap, and a `curl | sh` installer. Each release carries checksums and signatures.
- **macOS builds are code-signed and notarized.**
- **Optional:** an npm wrapper package for teams that prefer npm.

**Getting it running:**
1. Install `vtc`.
2. Claude Code: `/plugin marketplace add <org>/vtc` then `/plugin install vtc`. The plugin's MCP entry runs `vtc engine --mcp`.
3. Codex: add the same marketplace, then `vtc install codex`, which also writes `.codex/agents/*.toml`.
4. In a repo: `vtc init && vtc calibrate`, then `/vtc start "…"` in either host, then `vtc dashboard`.
5. During VTC's own development, test with `claude --plugin-dir ./dist/claude-plugin`.

---

## 5. Roles

### 5.1 Role definition template
Each role has one neutral source: `roles/<role>/role.yaml` plus `prompt.md`. The prompt is split into a **locked core** and an **editable section**.

**Prompt body:** about 150 lines at most:
- a 2-line mission;
- inputs (by artifact type);
- a procedure checklist;
- the output contract;
- definition of done;
- a never-do list;
- exits;
- 1–2 canonical examples.

**Contract** (`role.yaml`):
- input artifact types;
- a JSON output schema (verdict enum plus `findings[]`);
- exits: `done | spec_conflict | blocked(question) | unknown`;
- success criteria checked by machine;
- the named reviewer;
- a model tier and effort level for each host;
- a tool profile;
- a context budget;
- a return cap of about 1.5k tokens or less.

Role sources are forked from the files listed in the role catalogue §7 and rewritten to this template. The MIT notice from agency-agents is kept. Unsafe content listed in catalogue §5 is removed.

### 5.2 Core roles (Tier 1)

| Role | Runs when | Output | Model tier* | Tools |
|---|---|---|---|---|
| **Lead** | Always: this is the main session | Intents for the engine; batched escalations with evidence and options | The user's session | Engine MCP, Read |
| **Repo Cartographer** | Existing repos | As-is map: modules, conventions, an inferred architecture spine, extracted design tokens | Mid | Read-only + engine repo-map tools |
| **Research Analyst** | New project or large feature (scaled to the task) | Research brief; every claim has a citation that resolves | Mid | Read-only + engine research fetchers |
| **BA** | Always | Spec: REQ-n in EARS form, Given/When/Then acceptance criteria, non-functional requirements, assumptions, out-of-scope. **Gate G1.** | Top | Write `.vtc/spec/` only |
| **Architect** | Always (depth S/M/L, §8) | Spine (AD-n: Binds/Prevents/Rule/Check), candidates, scorecard, C4 diagrams. **Gate G2.** | Top | Write `.vtc/architecture/` only + engine fact lookups |
| **Security** | Design mode and verify mode | Design mode: threat model + SEC-n requirements. Verify mode: fingerprinted findings with CWE and a cited location. | Mid (top on a risk hit) | Read-only + SARIF |
| **Designer** | When there is UI | Flows, `screens.yaml`, prototype, DTCG tokens, component specs. **Gate G2.** | Mid | Write `.vtc/design/` only |
| **Planner** (PM + Lead Engineer) | Always | `tasks`: `covers[]`, `after[]`, `files_scope[]`, **one `discipline` per task** (cross-discipline features are split, joined by interface contracts, §5.2a), stack packs, risk tags, architecture triage, size | Mid | Read |
| **Engineer** | Per task. **The only role that writes code.** | Diff + exit `built / spec_conflict / blocked` | Mid + skill packs | Read/Edit/Bash, sandboxed |
| **QA** | Per task, in two modes. **Author mode** runs *before* the Engineer and writes acceptance tests tagged with REQ IDs. **Judge mode** runs after and checks test adequacy. | Tests, findings | Mid (**never the bottom tier when authoring**) | Author: write to acceptance-test paths only. Judge: read-only. |
| **Spec-Verifier** | Per task, one call per acceptance criterion | PASS/FAIL/UNKNOWN plus cited evidence | Low/Mid | Read-only |
| **Visual QA** | UI tasks | Verdicts on criteria V1–V8 on top of the deterministic visual checks; 2-of-3 vote | Mid | Read-only |
| **Lookback** | Offline or on demand | At most 3 changes to editable sections, plus replay results | Mid/Top, budget-capped | Read traces; write only `prompts/*/editable.md` proposals |

\*Model tier (Top/Mid/Low) maps per host, set in `role.yaml`. For example, on Claude: Opus / Sonnet / Haiku.

### 5.2a Engineer family: specialist profiles (v1)
"Engineer" in §5.2 is a **family**. Every member shares the Engineer contract:
- a single writer per task;
- a worktree;
- protected tests;
- 3–5 round caps;
- a budget.

What changes per specialist is its **profile prompt** (about 1–2k tokens), **stack packs**, **tools**, **specialist gates**, and a **paired reviewer lens**.

**How tasks get a specialist:**
- The Planner gives each task exactly **one `discipline`**.
- **A feature that spans disciplines is split into one task per discipline,** joined by an **interface contract**: OpenAPI/GraphQL/proto for APIs, an event schema for messages, a data contract for pipelines.
- The provider task publishes the contract first. Consumer tasks build against it (`after: [provider]`).
- **Contract tests in the gates** check both sides.

| Specialist | Focus | Extra gates | Paired reviewer lens | Fork sources (rewritten to §5.1) |
|---|---|---|---|---|
| **Frontend Engineer** | Components, state, routing, forms, a11y, Core Web Vitals, design-system compliance | Playwright, axe, bundle size (size-limit), Lighthouse CI, token lint | Frontend lens + Visual QA | agency-agents `engineering-frontend-developer` (CWV/WCAG rules only); Designer rules; the rest new |
| **Backend / API Engineer** | API design, validation, authn/z flows, transactions, idempotency, concurrency, observability, expand/contract migrations | Contract tests, integration tests, migration lint | Backend lens + DB lens | `engineering-backend-architect`, `engineering-api-platform-engineer`, DBRE rules |
| **Mobile Engineer** (iOS/Android/RN/Flutter) | Lifecycle, offline/sync, permissions, push, on-device performance, store policies | Simulator/emulator build, Maestro/Detox, store-policy checks | Mobile lens | `engineering-mobile-app-builder` (rewrite), `engineering-mobile-release-engineer` |
| **Data / Database Engineer** | Schema, queries and indexes, ETL/pipelines, data contracts, backfills (row-reconciliation invariant) | Migration dry-run, query-plan checks, dbt/data tests | DB lens | `engineering-data-engineer`, `engineering-database-reliability-engineer`, data-remediation invariants |
| **DevOps / Platform Engineer** | CI/CD, IaC, containers, deploy and rollback, SLOs and burn-rate alerts | `terraform plan`, Checkov, actionlint, hadolint (user-installed) | Infra/SRE lens | `engineering-devops-automator` (rewrite; **remove auto-deploy to prod**), `engineering-sre` |
| **AI / LLM Engineer** | Prompts, RAG, embeddings, agents, eval sets, guardrails, cost and latency | A golden-set eval suite, cost/latency budgets | LLM-feature lens | `engineering-multi-agent-systems-architect`, `engineering-rag-pipeline-engineer`, `engineering-prompt-engineer` |

**Domain packs** load only when the Repo Cartographer or the spec detects the domain:
- Desktop (Electron/Tauri)
- Embedded/IoT
- CMS (WordPress/Drupal)
- Web3/Solidity
- Search relevance
- Realtime/collaboration
- Video
- Game development
- CLI/dev-tooling
- WebAssembly
- WeChat Mini Program
- US public sector (USWDS/508)

The catalogue §3 lists sources for each pack.

**Stack packs** are skills selected from the repo's detected stack, **at most about 3 per task**. For example:
- web: React/Next, Vue/Nuxt, Angular, Svelte;
- backend: Node/Nest, Django/FastAPI, Go, Spring, Laravel, .NET, Rails;
- mobile: SwiftUI, Compose;
- data: Postgres, MySQL, MongoDB;
- infra: Terraform, Kubernetes, AWS/GCP/Azure.

Each pack covers conventions, pitfalls, test commands, and version-pinned API notes that the engine fetches from official docs (§8.2), never from model memory.

**Cost and scoring:**
- A task carries one specialist profile plus its packs, which adds about 2–5k tokens of context.
- The expected saving is fewer fix rounds.
- Lookback scores each **specialist × stack pack × host** combination separately (§13).

### 5.3 Conditional specialists (Tier 2)
Each specialist is a **lens skill**: a checklist plus a schema.
- **By default** it is injected into an existing reviewer's context, at no extra cost.
- **It becomes its own read-only reviewer node** only when a risk rule fires.
- **Deterministic checks always run first.**

| Specialist | Trigger |
|---|---|
| DB / migration | Migrations, schema changes, bulk deletes |
| Identity & auth | Auth, sessions, RBAC, SSO |
| Payments | Payments, billing, webhooks |
| Privacy | PII, tracking, third-party data flows |
| Secret-leak response | A scanner finds a secret |
| Infra / CI (DevOps/SRE) | IaC, Docker, k8s, CI files |
| Public API contract | OpenAPI/gRPC/GraphQL or public routes |
| Accessibility | UI tasks |
| i18n / content | User-facing strings, locales |
| Performance | The spec sets a performance budget |
| LLM features | LLM calls, prompts, vector search |
| Supply chain | A new dependency |
| Docs | Public API, CLI or README changes |
| Compliance mapper | The spec declares SOC2/HIPAA/PCI |
| Mobile review lens | Mobile repos or tasks (pairs with the Mobile Engineer specialist, §5.2a) |

### 5.4 Advisors (Tier 3, called through the Lead)
- Estimator / Solution Architect (uses the cost history)
- Client-liaison writer (exports; change-request impact)
- UX Researcher
- Incident debugger
- Legacy explainer
- ML/Data advisor

### 5.5 Pairs that may never self-review
The engine enforces each pair at dispatch time. In each row, the second role checks the first role's output:

| Author | Checked by |
|---|---|
| BA | Spec-Verifier |
| Engineer | QA and all reviewers |
| Designer | Visual QA |
| Architect | Architecture review |
| Planner | The engine's coverage check |
| QA test adequacy | Mutation testing |
| Lookback | Its graders |

### 5.6 Engine-implemented "roles" (code, no AI)
- Scheduler / delivery manager
- Context Packer
- Risk Router
- Gate Runner
- Write-scope checker
- Traceability builder
- Triage and progress detection
- Escalation Manager
- Merge queue
- Release Manager (AI on the low tier only polishes the release notes)
- Cost tracker
- Prompt registry and audit trail
- Research fetchers

---

## 6. Flow and state machine

### 6.1 Backbone (fixed)
```
INTAKE → DISCOVER → SPECIFY → ✋G1 → DESIGN → ✋G2 → PLAN → BUILD ∥ INTEGRATE → FINAL REVIEW → RELEASE → RETRO
```
- **INTAKE:** the Lead classifies the request (track, existing repo or new project, UI, risk hints).
- **DISCOVER:**
  - Repo Cartographer, for existing repos;
  - Research Analyst, for a new idea or a large feature.
- **SPECIFY:** the BA writes the spec.
  - QA does a testability pass.
  - Security in design mode adds SEC-n requirements.
- **DESIGN:**
  - Architect (§8), Security threat model, and Designer (if there is UI) run in parallel.
  - The engine checks every REQ is mapped to a component, and to a screen if it has UI.
- **PLAN:** the Planner produces tasks. The engine checks that:
  - every REQ is covered;
  - the task DAG has no cycles;
  - tasks that run in parallel have disjoint file scopes;
  - each task is within the size cap;
  - each task has an architecture triage (fits / extends / changes).
- **BUILD:** per-task pipelines (§6.3).
- **INTEGRATE:** the merge queue merges each `built` task into the feature's integration branch while other tasks are still building (§6.6–6.7).
- **FINAL REVIEW:** once every task of the feature is merged, a whole-feature review runs on the integrated branch (§6.7a).
- **RELEASE:** evidence bundle, version and changelog, then the PR is marked ready or auto-merged by level (§6.7).
- **RETRO:** a run summary and Lookback data.

### 6.2 Tracks (chosen at intake; the human can override)

| Track | Discover | Gates | Architect depth |
|---|---|---|---|
| Quick fix | None | **G1+G2 combined on one screen** | S |
| Feature | Light research | G1, G2 | S/M |
| New project | Full research | G1, G2 | M/L |

**Freezing and change requests:**
- An approved artifact is frozen by its content hash.
- Any later change is a **change request (CR)**. The human approves only the change itself, and the CR is logged in the audit trail.
- A wording-only clarification from the BA is allowed without a CR. It is logged and shown in the run summary.

### 6.3 Per-task pipeline
1. **Pack.** The Context Packer builds the task pack:
   - the intent contract;
   - the REQs/ACs the task covers;
   - the relevant ADs;
   - the repo-map slice;
   - DESIGN.md and the component manifest, if the task touches UI;
   - the gate commands.
2. **QA author mode.** QA writes acceptance tests tagged with REQ IDs.
   - The engine checks that they **fail on the base commit**.
   - QA also writes a hidden split of tests, stored in `~/.vtc/`.
   - **Scenario card** (from QCFactory). Kept **lean** (about 15 lines) and written **only for end-to-end/acceptance scenarios**, not for unit tests. Each such scenario has a `SCENARIO.md` containing:
     - the user story;
     - setup;
     - a "proves" table;
     - an explicit **"does NOT cover"** list.
   - **Every assertion is tagged with its source**, as one of:
     - `spec:<REQ/AC id> "quote"`;
     - `observed`, meaning baseline behaviour with no spec backing.
     
     Failures on `observed` assertions route as *possible spec gaps*, not as Engineer bugs.
   - **Questions about the spec** go into the **escalation queue as `spec_question` items**, never inline. This is the same queue as §6.5, not a separate file. Each question offers 2–3 options, and the Lead batches them to the human.
3. **Engineer.** The Engineer works in the task's worktree, in a sandbox with protected paths.
   - **Exits:**
     - `built`;
     - `spec_conflict` (goes to the BA);
     - `blocked(question)` (parks the task);
     - `out_of_scope_fault`: the failure is caused outside this task's `files_scope`. The Engineer must cite `file:line` evidence.
       - **Guards (engine):**
         - the cited location must be outside `files_scope`;
         - the failure must **reproduce on the base plus contracts without this task's diff**;
         - at most one claim per round.
       - **If the guards pass:** the round ends early, does **not** count as stuck, and the engine routes the fault to the owning task or opens an integration-fix task.
       - **If they fail:** the claim is rejected, the round continues, and Lookback records the claim as misuse against the Engineer.
4. **Write-scope check (engine).** The engine compares the diff against `files_scope` and checksums the protected files.
   - Any violation counts as a test-integrity hit.
5. **Gate Runner.** Runs gates L0–L5 (§7.2) on a clean verification checkout, using affected-only tests.
   - **If a gate fails:** the task goes straight back to the Engineer with the evidence. No reviewer tokens are spent.
6. **Risk Router.** Attaches specialists to the task. A risk rule (§7.6) may park the task here.
7. **Reviewers.** These run in parallel, each with a fresh context and different inputs:
   - QA judge;
   - Security verify;
   - Spec-Verifier (one call per AC);
   - Visual QA (UI tasks only);
   - any triggered specialists;
   - optionally a cross-family reviewer (§12.4).
   
   **Reviewers are skipped on trivial diffs, and their depth scales with risk.**
8. **Triage (engine).**
   - **Classify failures first** (from QCFactory):
     - **Deterministic rules decide first:** infrastructure or timeout signatures, and "passed on the same commit earlier" (flaky). A flaky result gets one re-run; flakiness that repeats is recorded against the baseline.
     - **A low-tier judge handles only the ambiguous cases.** Its rule is "unsure means product". An `environment` verdict must cite `file:line` or a log line.
     - **Environment failures go to the gate-infra path (§6.8),** never to the Engineer.
   - **Dedupe and validate:**
     - deduplicate findings by fingerprint;
     - discard any finding whose cited evidence does not exist;
     - ignore the reviewer's own severity: the engine normalises severity itself.
   - **Route each finding:**
     - `patch`: a bug or security issue. Goes to the Engineer: same worktree, resumed session.
     - `spec_gap`: goes to the BA. A wording fix is logged; a change in meaning becomes a CR and goes to a human.
     - `design_gap`: goes to the Designer.
     - `bad_test`: goes to QA.
     - `risky`: parks the task.
     - `defer`: goes to `deferred[]`.
9. **Loop controller.** Increments the round. The cap is low = 3, medium = 4, high = 5.
   - **Stuck** means any of:
     - the same fingerprint survives 2 rounds;
     - a resolved finding reappears;
     - the Engineer submits an identical diff;
     - weighted severity does not drop.
   - **Stuck or cap reached:** the task parks.
   - **After 2 failed rounds:** the Engineer escalates one model tier, in a fresh session.
10. **All clear.** The task becomes `built` and enters the merge queue.

**Plan file** (`.vtc/tasks/T-n.md`):
- **Frontmatter state:** `status, round, cap, risk, covers, after, files_scope, baseline_revision, budget, spent, deferred[]`.
- **An immutable `<intent-contract>` block:** the intent, Always/Never boundaries, and an I/O and edge-case matrix.
- **Append-only change log and triage log.**

### 6.4 Task states
Main path:
```
draft → ready → tests_authored → building → verifying ⇄ fixing(n/cap) → built → queued → merged → done
```
Side states:
- `parked(reason)`
- `waiting_dependency`
- `interrupted` (a usage limit was hit)
- `non_converged`
- `dropped`

**`done` depends on the project's merge level, and workers can never set it:**

| Level | `done` means |
|---|---|
| 1 | Merged into the local integration branch |
| 2 | Also pushed and included in the open PR |
| 3 | Merged into main |

At Levels 1–2, a human merging the PR into main closes the feature, not the task.

### 6.5 Parking and escalation
- **A parked task blocks only its transitive dependents.** The scheduler keeps running everything else.
- **An escalation item contains:**
  - the task;
  - a reason category (risk rule / cap / stuck / spec conflict / budget / CR / gate infrastructure);
  - evidence links;
  - one question;
  - 2–4 options, with one recommended;
  - which tasks are blocked.
- **The Lead batches escalations** at natural points instead of interrupting per item.
- **When the human answers:**
  - the engine records the answer, including "which role should have caught this?";
  - the task resumes from its checkpoint (same worktree and session, plus the answer as new input).
- **Typical answers:**
  - accept with a waiver (it expires);
  - give a hint;
  - re-plan;
  - raise the budget (2× maximum);
  - drop the task.

### 6.6 Parallelism
- **Each task gets its own worktree and branch** (`vtc/T-n`).
- **Concurrency defaults to 2** and can be configured. The real limit is the subscription's usage window.
- **The engine refuses to run two tasks with overlapping `files_scope` at the same time.**
- **A task's reviewers count toward the concurrency limit.**
- **Interface contracts unblock work early.** A consumer task (e.g. Frontend or Mobile) depends on the provider's *contract*, not on its finished code. It can start as soon as the provider task has published and frozen the contract (OpenAPI, event schema or data contract). Until then it builds against contract-generated mocks.
- **Contract changes go back through the provider task.** If the provider must change a published contract, every consumer task gets a rebase round. A breaking change also needs a CR.

### 6.7 Merge queue and auto-merge levels
The merge queue processes one task at a time:
1. Rebase onto the integration branch.
2. Run the **full** gates on the combined code.
3. Merge.

A conflict or failure sends the task back to the Engineer as a rebase round. It counts toward the cap.

| Level | What merges automatically | Default |
|---|---|---|
| 1. Local | Verified tasks into the local integration branch | |
| 2. Remote branch | Level 1, plus push the integration branch and keep a **draft** PR updated. The PR is marked **ready for review** only after Final Review (§6.7a) passes, with the evidence bundle in its description. | **Default** |
| 3. Full auto | Level 2, then the PR auto-merges into main via the host's auto-merge, after Final Review passes and remote CI is green | Opt-in per project |

**Safe-to-auto-merge checklist (Level 3).** All of these must hold:
1. **Final Review (§6.7a) passed** on the integrated branch, and all gates are green on the combined code.
2. Every reviewer passed with cited evidence, and there are zero open findings at or above the configured severity (default: medium).
3. Requirement coverage is complete.
4. The test-integrity check is clean.
5. **No risk rule fired.**
6. There are no waivers and no parked dependencies.
7. **Remote CI is green.**

**Guardrails:**
- Never push directly to main.
- Use the user's existing git/`gh` auth.
- `vtc pause` acts as a kill switch.
- Downgrade one level automatically on a revert or a post-merge CI failure. This also records an escaped defect for Lookback.

### 6.7a Final Review (whole feature, integrated branch)
**When:** all tasks of the feature (or release batch) are merged into the integration branch.

**Why:** per-task checks can't see problems that only appear when the pieces run together. Examples: a new endpoint plus new UI that together expose data; migrations from two tasks that run in the wrong order; a shared component changed by one task and broken for another.

**Steps, deterministic first:**
1. **Full gates.** The *full* test suite (not affected-only), every scanner, architecture fitness checks (L6), and performance budgets, all on the integrated code.
2. **Full acceptance run.** Every REQ's acceptance tests plus all hidden tests, end-to-end across disciplines: frontend + backend + mobile against the real integrated services.
3. **Spec-Verifier across the whole spec.** Every REQ is covered by at least one passing test. Scope creep is flagged. Deferred items are listed.
4. **Security on the combined diff** (base…integration). Looks for cross-task data flows, authorization gaps between layers, and secrets or configuration across services.
5. **Visual QA on full user journeys.** Every screen and state of the feature together, design drift, and accessibility across flows.
6. **Architecture conformance.** The as-built system compared with the approved spine: no unapproved services, datastores, dependencies or boundary crossings.
7. **Release readiness:**
   - migration order and reversibility;
   - configuration and environment changes;
   - rollback notes;
   - docs updated;
   - changelog;
   - the feature flag plan, if any.

**Routing findings:**
- The engine's triage (§6.3 step 8) attributes each finding to the task and discipline that introduced it. A file blame and fingerprint match against the task diffs come first; the reviewer's citation is the fallback.
- **That task reopens** with a fix round: same specialist, its preserved worktree, rebased.
- A finding no single task owns becomes a new **integration-fix task**, assigned to the discipline that owns the affected files.
- Fixes go back through the merge queue, and Final Review **re-runs only the steps affected by the fix**, plus the full gates.

**Caps:**
- Final Review has its own cap of **3 rounds**, with stuck detection.
- If the cap is hit, a **risky** finding appears, or the review is stuck, the **feature parks** and the Lead asks the human.
- Unrelated features keep running.

**Cost:**
- Steps 1, 2, 6 and most of 7 cost no tokens.
- The AI reviewers (3, 4, 5) run **once per feature** on diffs and evidence, not on whole files.
- Final Review has its own budget line: by default 15% of the feature's total budget.

**Feature states:**
`building → integrating → final_review ⇄ fixing(n/3) → ready_to_ship → shipped`. Side state: `parked(reason)`.

**Output:**
- the **feature evidence bundle**: a REQ → test → result matrix across all tasks, findings, rounds, tokens per task and per discipline, and the Final Review verdict;
- written to `.vtc/evidence/<feature>/` and placed in the PR description.

### 6.8 Resilience and usage limits
- **Every state change is an event.** Events go to `.vtc/runs/<run>/events.jsonl`, are committed at milestones, and SQLite indexes them.
- **On SessionStart:** the engine rebuilds state from the event log, and the Lead offers "Resume run?".
- **When a usage limit is hit:**
  - the step is marked `interrupted`;
  - its inputs and worktree are kept, so the step can be re-run safely;
  - the engine re-dispatches it after the reset;
  - meanwhile, the main interactive session waits on its own.
- **Gate infrastructure failure never passes silently.** It parks the task with the reason `gate_infra`.

### 6.9 Usage readout and auto-resume
Research: `2026-10-13-usage-limits-auto-resume.md`.

**Reading usage.** Only sanctioned sources are used; VTC never reads credentials and never calls undocumented endpoints.
- **Claude Code:**
  - The plugin installs a **statusline tee shim**. It wraps the user's existing statusline command rather than replacing it, and forwards `rate_limits.five_hour` / `seven_day` (used %, `resets_at`) to the engine's localhost endpoint.
  - For runs the engine starts itself, it also reads SDK `rate_limit_event` and `api_retry` events.
- **Codex:**
  - The engine runs `codex app-server` as a managed child process and calls `account/rateLimits/read`.
  - It subscribes to `account/rateLimits/updated` for changes.
  - Windows are labelled from `windowDurationMins`.
- **Missing data:** shown as **unknown**, never as 0%.
- **Per-model limits** (e.g. the Claude Opus vs Sonnet weekly limit) are shown only as "limit reached, resets X", taken from rejection events.

**Auto-resume.** The engine owns it on both hosts:
1. **Detect** a limit hit:
   - Claude: `rate_limit_event` with status `rejected`, `api_retry` with `rate_limit`, or a non-zero `-p` exit.
   - Codex: `UsageLimitExceeded`.
2. **Persist** the reset time, the session ID and the pending steps.
3. **Mark the affected steps `interrupted`.**
4. **Schedule** a timer that survives restarts (on macOS, a launchd agent installed by `vtc install`). It fires at the reset time plus 1–2 minutes of jitter.
5. **Re-read usage.** If the host is still limited, back off and re-park, up to a cap.
6. **Otherwise re-dispatch:**
   - Claude: `claude -p --resume <id> … --permission-prompts none` with an explicit tool allowlist.
   - Codex: `codex exec resume <id> …`.

The Lead chat session doesn't need to be alive; only the engine does. If the user is chatting in an interactive Claude session, Claude Code's own auto-continue handles that session.

**Scheduling around limits:** before starting a new task, the scheduler checks the remaining quota.
- **Below a reserve** (default 10% of the 5-hour window): it starts only steps that are already in flight.
- **Lookback** never starts when less than 30% of the weekly window remains.

---

## 7. Verification gates

### 7.1 Calibration
`vtc calibrate` detects the toolchain. It checks these sources in order:
1. `.vtc/gates.yml`
2. AGENTS.md / CLAUDE.md, treated as hints
3. Task runners
4. CI steps
5. devcontainer
6. Lockfiles

It then runs everything twice on the base commit and records flaky tests. The human confirms once, and the result is frozen as the **baseline**. **Only new problems block.**

### 7.2 Deterministic layers
All of these run in the engine, outside the agent. Every scanner is pinned by version and SHA-256 and never auto-updated.

| Layer | Checks | Blocks on |
|---|---|---|
| L0 | Build, typecheck | Any failure |
| L1 | Lint on changed files, **using the base commit's config** | New violations |
| L2 | Tests, parsed from JUnit/JSON reports (affected-only per round; full in the merge queue) | Failures; the set of executed tests shrinks; more skipped tests |
| L3 | Diff coverage (diff-cover); mutation testing on the diff (v1.1) | Below threshold |
| L4 | Opengrep (MIT rulesets) + Bandit/gosec; Gitleaks/Betterleaks; `osv-scanner --offline`; license allowlist; Checkov (only when IaC changes) | New high/critical findings; any secret; vulnerable or disallowed dependencies |
| L5 | Test integrity + write-scope check | Protected tests or configs edited or deleted; new skip/only/xfail; new suppressions; snapshot rewrites; out-of-scope writes |
| L6 | Architecture fitness: the `Check:` of each AD, compiled to tools (§8.5) | A blocking rule is broken |

**Sandbox, in two phases:**
1. Install: network access to package registries only.
2. Test/scan: **no network**.

**Before evidence is written,** scanner and log output is passed through a **secret-redaction filter**, because `.vtc/evidence/` is committed to git. The filter covers:
- secret-scanner matches;
- known token formats;
- `.env` values.

The raw output stays only in gitignored `.vtc/state/`.

**Which tests run per round (from QCFactory):** affected-only selection uses three inputs:
- the file → test map;
- the REQ tags;
- the changed contracts.

The rule is **"if unsure, run it."** The full suite always runs in the merge queue and in Final Review.

**Licensing:**
- No CodeQL engine.
- No bundled Semgrep-maintained rules.
- GPL/AGPL tools only as separate programs the user installs.

### 7.3 Anti-gaming
- **QA-owned tests are protected three ways:**
  - host deny rules;
  - the OS sandbox, where the host supports per-path write-deny;
  - **the engine's write-scope checksum check, which applies on every host.**
- **Hidden acceptance tests** are stored in `~/.vtc/`, outside the repo. They are copied in only at gate time.
- **QA's tests must fail on the base commit** before the Engineer starts.
- **Monotonic metrics** may not get worse: executed test IDs, assertions per test, coverage, mutation score.
- **An honest exit for the Engineer:** `spec_conflict`.

### 7.4 AI reviewers
- **Different inputs per reviewer, and evidence is required.** The engine rejects any verdict whose citations don't resolve.
- **The Spec-Verifier sees only one AC plus the evidence.**
- **Traceability is built by code,** from REQ tags in JUnit output, per-test coverage contexts, and the diff.
  - A REQ with no passing test is a gap.
  - A changed file that no REQ covers is a scope-creep flag.

### 7.5 Visual QA (UI tasks only)
Checks run in this order:
1. Token lint.
2. A Playwright render matrix: route × state × {390, 768, 1440} × theme.
3. axe, WCAG 2.2 AA.
4. Computed styles compared with the tokens.
5. A per-region pixelmatch-v8 diff against the approved prototype, rendered in the same run.
6. An AI vision judge on V1–V8, with a 2-of-3 vote. It never measures pixels.
   - Each verdict names its **question type**: structure/content, state, layout, or brand/design-system.
   - **"Unreached is not clean"** (from QCFactory): a route, state or screen that could not be rendered or reached is reported as `unchecked` and blocks the pass. It is never reported as passing.
   - **Rendering is replayable:** the approved prototype and design references are re-rendered only when their source hash changes, and the renders are cached and keyed by that hash.

**Routing:**
- Implementation deviation goes to the Engineer.
- Ambiguity goes to the Designer.
- An accepted deviation updates the design baseline.

### 7.6 Risk rules (park the task, and block Level-3 auto-merge)
1. Any committed secret. This escalates immediately, with no loop.
2. Changes to auth, RBAC, crypto or payments, or to configured `risk_rules` globs.
3. DB migrations, especially destructive ones; bulk-delete paths.
4. A new dependency that is any of:
   - not on the allowlist;
   - copyleft or of unknown license;
   - shipping install scripts;
   - very new or low in downloads.
5. Edits to CI/CD, IaC, Docker, git hooks, `.claude/`, `.codex/`, `.vtc/`, lint or test config.
6. A breaking public API change.
7. A diff over about 800 lines or about 30 files.
8. A repeated test-integrity violation.
9. A high/critical finding still open after 1 round.
10. Stuck, or the round cap reached.
11. A spec conflict the BA can't resolve; any change request.
12. Gate infrastructure failure; sandbox denials.
13. Budget exhausted.

---

## 8. Architect method

### 8.1 Knowledge
One `architect` skill, made up of:
- **A core file** of about 2k tokens.
- **About 10 reference checklists** of 1–3k tokens each, loaded on demand:
  - quality-attribute catalogue
  - Well-Architected pillars
  - patterns index
  - 12-factor
  - C4/arc42 skeleton
  - ADR template
  - DDD strategic design
  - security NFRs (ASVS)
  - SLOs
  - fitness functions

**`defaults.toml`** holds each team's approved stack, cloud and banned technologies.

**Bundling follows each source's license** (architecture research §1):
- bundled with attribution: C4, Azure Architecture Center, Google Well-Architected, 12-factor, MADR, system-design-primer;
- paraphrased and linked: AWS Well-Architected, microservices.io, Thoughtworks Radar, the SRE book, ISO 25010.

### 8.2 Research step (engine fetchers, no facts from model memory)
The engine looks up:
- endoflife.date: support windows;
- deps.dev: versions, licenses, Scorecard;
- OSV: CVEs;
- the registry and GitHub: that a package exists and is maintained;
- official docs at the pinned version;
- official pricing APIs.

Every fact becomes a row in `facts.jsonl`, with its source and retrieval date. Versions are pinned. **Any `UNVERIFIED` claim blocks G2 unless a human waives it.**

### 8.3 Decision process
1. Turn the NFRs into quality-attribute scenarios. The 3–7 with the highest importance × difficulty drive the decision.
2. Treat constraints as hard filters.
3. Build candidates:
   - **A: a boring baseline.** Modular monolith, one relational DB, the house stack.
   - **B:** the smallest change that serves the top driver better.
   - **C:** only if a driver demands it.
4. Weighted scorecard columns: the driving qualities, team skills, 12-month cost, ops burden, reversibility, and new technologies introduced (innovation tokens, default budget 0–1). Every score cites a scenario.
5. Run a robustness check: moving any weight by ±1 must not flip the decision; close calls are flagged.

**Depth is set by the engine from the spec's attributes:**

| Depth | When | Output |
|---|---|---|
| S | ≤5 decisions | Decisions only |
| M | Default | 2 candidates + scorecard |
| L | PII, payments, regulated data, ≥99.9% availability, >2 integrations, multiple teams, or >100k LOC | 3 candidates + ATAM-lite + threat model + cost model |

### 8.4 Existing repos and per-task notes
- **Existing repos:**
  - The engine recovers the as-is architecture from manifests, infra files, import graphs and ADRs.
  - The Architect writes an inferred spine. A human confirms it once.
  - Existing violations become the baseline.
  - **Changes are incremental steps that can each ship on their own.** A rewrite is proposed only if the human asks.
- **Per-task triage (by the engine, from the diff plan):**

  | Triage | When | Architect work |
  |---|---|---|
  | **fits** | No new service, datastore, integration or trust boundary | **0 Architect tokens** |
  | **extends** | Adds within the spine | A one-page design note |
  | **changes** | A new service, datastore or integration; a cross-cutting concern; a performance target; a breaking interface; a new trust boundary; an irreversible migration | **ADR**, plus a CR if G2 was already approved |

### 8.5 Enforcement
Every AD carries Binds / Prevents / Rule / **Check**. The engine compiles each Check into a tool config, for example:
- dependency-cruiser
- eslint-plugin-boundaries
- import-linter
- ArchUnit
- Deptrac
- go-arch-lint
- Spectral
- oasdiff
- k6
- Lighthouse CI
- conftest

Each Check runs in gate L6, as blocking or warn. Waivers are human-only and expire.

### 8.6 What G2 shows (one screen)
- The recommendation.
- The C4 L2 diagram.
- The driving scenarios.
- The scorecard, with any robustness flag.
- The innovation tokens used.
- Research red flags.
- The new ADs, each with its Check.
- The cost estimate.
- The assumptions.
- The Designer's flows and prototype, if there is UI.

---

## 9. Designer method
**Source-of-truth artifacts, all code-native and diffable:**
- Mermaid flow and state diagrams.
- `screens.yaml`: each screen's route, required states (empty, loading, error, success, permission) and the REQs it covers.
- An HTML + Tailwind v4 prototype with every state reachable via `?state=`. A grayscale theme gives wireframes; the real theme gives hi-fi.
- DTCG `tokens.json`. Style Dictionary generates `@theme` and DESIGN.md from it.
- Component specs in YAML, plus Storybook stories for each state.

**Rules:**
- **Anthropic frontend-design rules:** a two-pass token plan, and five named "AI-default" looks to avoid.
- **Design Contract** for each key screen, adapted from agency-agents' finish-gate reviewer.

**Existing repos:** extract tokens from code and from the running app (dembrandt), and capture baseline screenshots.

**Consistency:**
- the Engineer may use only components from the registry;
- token lint rules (better-tailwindcss, stylelint strict-value);
- DESIGN.md and the component manifest go into every UI task pack.

**Figma:** an optional mirror via `generate_figma_design`.

### 9.1 Distinct directions per project (D16)
Research: `2026-10-13-impeccable-style.md`. Language models collapse toward the same few answers ("Artificial Hivemind", NeurIPS 2025), so **variation must come from code, and the choice from a human.**

**Fork from impeccable** (Apache-2.0). Keep LICENSE and NOTICE, mark every file we modify, and don't use the "Impeccable" brand. The parts we fork:
- the detector rules (about 59 anti-pattern rules);
- the craft floor;
- "new-work" steps 1–5;
- the per-screen **Direction contract** (THESIS, OWN-WORLD, STORY, FIRST VIEWPORT, FORM, FINISH) and screen modes (Persuade/Operate/Read/Experience);
- the critique heuristics;
- the typeset, colorize and layout playbooks;
- the font blocklist.

**Rewritten locally:** the direction roll. **No network calls and no telemetry.**

**Designer flow:**
1. **Name the rut.** State the category default and its predictable opposite. List 7 candidate visual worlds drawn from the audience's culture. Use verbalized sampling to drop the most probable ones.
2. **Constraints lottery.** A local RNG, seeded by project and run, deals:
   - a colour strategy (Restrained / Committed / Full / Drenched, in OKLCH);
   - a type pairing from a curated pool;
   - density and grid;
   - radius and elevation;
   - motion style;
   - one signature interaction.
3. **Build 2–3 directions** as first-viewport prototypes.
4. **Novelty check (engine).**
   - Render each direction's first viewport.
   - Embed the screenshot (DreamSim/DINOv2, or UIClip) and the token vector.
   - Compare against the **design library** of past projects in `~/.vtc/design-library`, kept per client.
   - Reject anything too similar.
5. **Choose at G2.** The human picks one of the 2–3 directions. Re-roll and a "category standard" exit are also offered.
6. **Record the choice.** The chosen direction enters the library, so later projects steer away from it.

**Visual QA (§7.5) gains two checks:**
- the forked detector runs in the deterministic lint layer;
- a "design specificity" criterion is added to the vision judge.

**Routing:** slop findings hold the Designer step; quality and design-system findings go to the Engineer.

---

## 10. Research Analyst
**Deterministic fetchers in the engine**, using pinned dependencies and keys the user supplies:
- web page → markdown, via a keyed reader or local Crawl4AI;
- search (Exa/Tavily or host web search);
- GitHub via `gh`;
- RSS;
- YouTube transcripts via yt-dlp;
- package metadata (§8.2).

**Code-mode tool:** the analyst writes small sandboxed scripts that call these fetchers and return digests.

**Research cache:** results are cached in `~/.vtc/research-cache`, keyed by URL or package@version plus date, and shared across projects. When a project belongs to a client, the cache is per client.

**Safety:** fetched content is untrusted data. The analyst has no write or shell tools outside the sandbox.

**Not embedded:** agent-reach and any cookie- or login-based scraping. These raise terms-of-service and credential risks (landscape §1.4).

---

## 11. Token economy
**Policy:** deterministic first (D11). The adopted techniques are in token-economy research §top-15. In summary:
- gates before reviewers;
- coarse engine tools and code mode;
- task packs plus a repo map;
- filtering tool output to failures only;
- clearing old tool output;
- a fixed model per role;
- affected-only tests;
- the research cache;
- cache discipline (long-lived sessions, no model or tool switching mid-session);
- skipping review on trivial diffs;
- no-progress detection;
- low effort first, then retrying failures at higher effort;
- returns capped at ≤1.5k tokens;
- reviewers run without CLAUDE.md;
- Lookback promoting scripts that recur across 3 or more tasks into engine tools.

**Budget controller:**
- **Unit:** list-price-equivalent USD, computed from the four token types, because plan meters are opaque.
- **Initial task budgets:** S $1.50, M $5, L $15. Recalibrate after 20 tasks of each size.
- **Shares within a task:** Engineer ≤45%, all reviewers ≤25%.
- **At 70% of budget:** reviewers drop one tier.
- **At 100%:** finish the current turn, then park the task with evidence.
- **No automatic raises.** A human can raise the budget to at most 2×.
- **Concurrency:** 1–3. Pause on rate-limit events.
- **Lookback:** about 12% of weekly usage, run off-peak.

**Measurement:**
- Cost and the token types (input, output, cache read, cache write) are captured from each agent's **final stream event**, then cross-checked against the event log.
- An **estimated share of the weekly quota** is computed per run.
- **A model missing from the price table is an error,** never silently priced at $0. The run summary flags it until the price table is updated.
- Quality per token is a first-class scorecard metric.

---

## 12. Multi-host (Claude Code or Codex)

### 12.1 Adapters
Both adapters implement the same interface (§4.1).

| Capability | Claude Code adapter | Codex adapter |
|---|---|---|
| Role agents | Plugin agents (`.md`) | Agent TOML written by the installer, plus SKILL.md |
| Per-role read-only | OS sandbox + engine check (plugin agents ignore their own `permissionMode`) | `sandbox_mode` per agent (spike: confirm inherit/override behaviour) |
| Hooks | Plugin hooks, used as an extra defence layer | Plugin hooks, which the user must trust; used as an extra defence layer only |
| Per-path write-deny | `sandbox.filesystem.denyWrite` | **None.** Engine write-scope check only. |
| Headless | `claude -p --json-schema --resume` | `codex exec --output-schema --json` + `exec resume` |
| Limit signal | `api_retry` / rate-limit events; interactive sessions wait automatically | `turn.failed` with text; parse the reset time |
| Turn/budget caps | `--max-turns`, `--max-budget-usd` + engine | **Engine only** |

### 12.2 Enforcement placement
These are always enforced by the engine, on both hosts:
- write scope;
- caps;
- budgets;
- gate order;
- schema validation;
- limit parking.

### 12.3 Prompts per host
- Roles compile from one source.
- `role.yaml` may carry small per-host overrides.
- **Lookback scores and promotes prompts per host.**

### 12.4 Cross-family review (opt-in)
On high-risk tasks, if the user has both subscriptions, the other family runs as a read-only reviewer:
- `codex exec --sandbox read-only --output-schema`, or
- `claude -p` with read-only tools.

It is capped at 1–2 rounds and costs both quotas.

### 12.5 Compliance rules
- Never read, copy or store `~/.claude` credentials, the keychain, or `~/.codex/auth.json`.
- Sign-in happens only through each host's own flow.
- The vendors' binaries are never modified.
- Branding: "works with Claude Code / Codex" in plain text only.
- Before distributing **headless** spawning commercially, get written confirmation from Anthropic and review OpenAI's terms. **Plugin-only mode needs neither.**

---

## 13. Lookback
- **Data:**
  - Every role run is logged with: role, host/model, prompt content SHA, verdict, findings, rounds, tokens, and the `pipeline_config_hash`.
  - Scorecards per machine are committed to `.vtc/lookback/scorecards/<role>/<host>/<sha8>/`.
- **Prompt versioning:**
  - The locked core is human-only. A change there is a MAJOR version.
  - The editable section is changed by Lookback proposals. A change there is a MINOR version.
  - Each version gets a CHANGELOG entry: hypothesis, trace IDs, diff, evaluation.
- **Attribution:**
  - **A deterministic routing tree** comes first:
    - missing REQ → BA;
    - REQ with no test → QA;
    - test fails → Engineer;
    - test passes but behaviour is wrong → QA primary, Engineer secondary.
  - Credit is weighted toward the first failure upstream.
  - An AI tiebreaker is used only when the tree is inconclusive.
  - **Human labels at escalation** are the gold standard.
- **Metrics:**
  - role-specific outcome metrics plus quality per token (round2 §5);
  - Engineer metrics are broken down by **discipline × stack pack × host**, so weak combinations get targeted improvements.
- **Improvement loop (v1):**
  1. Take 5–10 attributed failures from the training split, plus human edit diffs.
  2. Propose at most 3 small changes to the editable section.
  3. Run a paired held-out replay: k=2–3 trials, an A/A noise floor, and a sign test.
  4. A human approves in the Lead chat.
  5. Canary on one project (`pins.yaml`).
  6. Roll back automatically if escalations or cap hits rise 2× or more, a human flags a regression, or tokens rise more than 20%.
- **v2:** GEPA-style optimisation on cheap read-only roles, subject to the compliance rules for headless runs.
- **Protection:**
  - Graders, rubrics, hidden tests and metric code live in a protected directory that Lookback cannot write to.
  - Every score stores the `grader_bundle_sha`.
  - The judge model is fixed.
- **Tool promotion:** scripts that recur across 3 or more tasks are proposed as tested engine tools.
- **Run retro** (from QCFactory; built in sub-project 7). The retro has two layers:
  - a **deterministic data layer**: KPIs, plus a **snapshot of the config and feature flags** in force, so the retro never misreads a switched-off feature as a bug;
  - a short write-up with proposals, each carrying a baseline and target KPI.
  
  Every retro **reviews whether the previous retro's proposals actually moved their KPIs.**

---

## 14. Agency layer (v1)
- Change requests against the signed spec and architecture, with an audit trail.
- An **evidence bundle** per task and per PR: REQ → test → result, findings, rounds, tokens.
- Cost per feature and per client.
- Per-client isolation: project folders, research cache, allowlists and memory. Context never crosses clients.
- Advisors: client-liaison exports (spec/architecture as client-friendly documents) and an estimator built on cost history.

---

## 15. Security of VTC itself
- **Credentials:** none handled (§12.5). Git and `gh` use the user's existing auth.
- **Untrusted content:**
  - Research output, web pages and repo text are data.
  - Research roles have no write or shell tools outside the sandbox.
  - The engine validates every write against scope.
- **Supply chain:**
  - Scanners and dependencies are pinned by SHA-256, with signatures verified where possible.
  - No auto-updates.
  - Vulnerability databases update on an explicit schedule.
- **No `--dangerously-skip-permissions` or `bypassPermissions`.** Use explicit allow rules plus the sandbox.
- **Kill switch:** `vtc pause`. Every merge is revertable, and auto-merge has the downgrade rule (§6.7).
- **Local endpoints:** the engine's HTTP/SSE server, the dashboard and the statusline receiver must:
  - **bind to 127.0.0.1 only**;
  - require a **per-install token**;
  - check the **Host and Origin** headers, to block DNS rebinding and other websites.
  
  No config change can trigger command execution without passing through the gate allowlist.
- **Hardened agent launcher** (from QCFactory):
  - a timeout on every headless role run, with forced kill on expiry;
  - one transcript per run;
  - no orphaned processes.
- **Incident reports:** every run that doesn't finish cleanly (crash, kill, limit, infrastructure failure) leaves a marker. On the next start, the engine turns the marker into a readable incident report in the run summary and on the dashboard.
- **No agent merges its own work.** Merges happen only through the engine's merge queue.

---

## 16. Key data contracts (summary; full JSON Schemas live in the sub-project specs)
- **Task:**
  - `id, title, covers[REQ], after[T], files_scope[glob], risk(low|med|high), cap, size(S|M|L), arch_triage(fits|extends|changes)`
  - `discipline(frontend|backend|mobile|data|devops|ai_llm|<domain-pack>), stack_packs[], provides_contract?, consumes_contracts[]`
  - `budget_usd, spent_usd, status, round, worktree, branch, session_ref{host,id}, deferred[]`
- **Finding:**
  - `fingerprint, source(tool|role), rule_id, category, severity(normalised), confidence, location{path,symbol}`
  - `evidence{type,ref}, req_ids[], route(patch|spec_gap|design_gap|bad_test|risky|defer), round_first_seen, status`
- **Escalation:**
  - `id, task, reason, question, options[{id,label,effect}], recommended, evidence[], blocks[T]`
  - `answer{option,text,who_should_have_caught(role)}, answered_at`
- **Event:** `ts, run, task?, type, actor(engine|role|human), data, prompt_sha?, host?, model?, tokens{in,out,cache_r,cache_w}`
- **Role result:** `role, task, exit, verdict, findings[], artifacts[], claims[{type,ref}], summary(≤1.5k tokens)`
- **Workflow node** (for Flow Studio and the flow composer):
  - `kind(role|gate|human|router|fan_out|join|loop_guard|park|subflow)`, `ports_in/out(artifact types)`, `reason_added`
  - The engine rejects any back-edge that doesn't pass through a `loop_guard`.

---

## 17. Flow Studio (read-only dashboard)
- **Three zoom levels:**
  1. project phases;
  2. the task DAG;
  3. one task's pipeline, with its loop.
- **Node display:**
  - state (waiting, running, passed, looping n/cap, parked with its reason, done);
  - tokens used;
  - **why the node was added** (the router rule).
- **Drill-down:** inputs and outputs, verdict, findings, gate reports, diff, prompt version, timeline.
- **Design review:** the prototype iframe with viewport, state and theme switchers. Click-to-pin comments are saved to `.vtc/design/reviews/`. Approval still happens in the Lead chat.
- **Data sources:**
  - **live:** the engine's event stream, when the engine is running on that machine;
  - **otherwise:** the committed `.vtc/` snapshot. Teammates can open it from their own clone.
- **Tech:**
  - Next.js 16 **static export**, React 19, Tailwind v4, Radix, lucide, React Flow (`@xyflow/react` 12), with ELK/dagre layout.
  - The `vtc` binary serves it, with live updates over SSE.
  - A desktop wrapper is a later option.
- **Theme (D14):** reuse `bs-job-agents/apps/web`:
  - the **Deep Sea tokens** from `app/globals.css`: light by default, `data-theme="dark"`, with the `@theme inline` bridge, gradient-brand/glow utilities, the focus ring and reduced-motion rules;
  - fonts Be Vietnam Pro and Space Grotesk;
  - the `components/ui` kit;
  - the flow canvas from `components/flows` (FlowCanvas, StepNode, StepDrawer, Edges, plus the running ring/dash animation and status minimap). Node states are extended to cover VTC's states.
  
  Copy these in v1. A shared theme/UI package between the two apps is a later option.
- **Usage panel (D15):** one card per host (Claude, Codex). Each window shows:
  - used % and remaining %;
  - the local reset time;
  - when the data was last updated;
  - "unknown" when data is missing.
  
  The card also shows per-model "limit reached" rows when they are reported, the number of tasks `interrupted` by limits, and a countdown to auto-resume.

---

## 18. Testing VTC
- **Engine:**
  - unit tests for every state transition, cap, budget rule, router rule, triage route and parser (JUnit, SARIF, stream events for both hosts);
  - property tests for the scheduler and DAG invariants;
  - golden tests for event replay.
- **Adapters:** contract tests against recorded host event streams, including limit hits and auth errors.
- **Roles:**
  - eval suites per role and per host on a fixed reference-task set, in the `plugin eval` format where possible;
  - pass^k reporting.
- **End-to-end:** 5 reference projects (two greenfield, three brownfield in TS, Python and Go), run on both hosts.
- **Step 0:**
  - a feasibility spike (§19);
  - token calibration on about 5 reference tasks before budgets are frozen.

---

## 19. Roadmap: sub-projects
Each sub-project below gets its own spec → plan → implementation.

| # | Sub-project | Delivers | Depends on |
|---|---|---|---|
| **0** | **Feasibility spike** (throwaway) | Verifies on real accounts: plugin hooks and per-role limits; the sandbox write-deny; headless `claude -p` and `codex exec` events, including limit hits; Codex agent spawning and sandbox inheritance; prompt-cache behaviour in worktrees; token calibration on 5 tasks; **single-binary feasibility**: Bun `--compile` with `bun:sqlite`, an MCP stdio server, the embedded Next static export, on-demand Playwright/scanner downloads, and macOS signing/notarization; **usage readout**: the statusline tee shim and the `codex app-server` rate-limit calls; `--resume` working after a long gap | — |
| 1 | **Engine core + build loop** | State/events, scheduler, per-task pipeline, loop controller, triage, escalation, budget controller, merge queue (Levels 1–2), MCP tools | 0 |
| 2 | **Gate Runner + calibration** | Toolchain detection, baseline, L0–L5, write-scope check, hidden tests, pinned scanner store | 1 |
| 3 | **Role library + compiler + host adapters** | Neutral role sources (forked and rewritten), compiler, Claude Code plugin, Codex plugin/agents | 1 |
| 4 | **Front half: idea → G1 → G2** | Lead intake, Cartographer, Research fetchers and cache, BA, Architect method (§8 incl. L6 fitness), Security design mode, change requests | 1–3 |
| 5 | **Designer + Visual QA** | Design artifacts, prototype, tokens, Visual QA stack | 2–4 |
| 6 | **Flow Studio** | Read-only dashboard | 1 (events) |
| 7 | **Lookback + evals** | Scorecards, attribution, replay harness, promotion | 1–3 |
| 8 | **Agency layer + Level 3 auto-merge + cross-family review** | CRs/exports, cost per client, safe auto-merge, cross-review | 1–7 |
| 9 | **Watch mode** (post-merge regression, QCFactory-style, opt-in per project) | Scheduled or on-merge re-runs of the accumulated acceptance suite plus scanners on `main` (diff runs, with periodic full runs). Reuses failure classification and fingerprint dedup. New failures become fix tasks or GitHub issues, which auto-close when the check passes again. **Each one is fed to Lookback as an escaped defect, attributed to a role.** Separate small budget; never runs when the usage window is low. | 2, 5, 7 |

**Recommended first build after the spike: #1, then #2 and #3 together.** That sequence produces the headline loop (Engineer ↔ QA, Security and Spec-Verifier) early.

---

## 20. Open questions and risks
1. **Laya / Jev typed-decision models** (`2026-10-13-laya-vs-jev.md`):
   - **Not in v1.**
   - **Jev** is rejected. It is cloud-only and needs its own API key, which conflicts with D1 and D2.
   - **Laya** (local, Apache-2.0) is a **v2 option**: an opt-in advisory classifier for intake, risk hints, escalation category and Lookback attribution. It is enabled only after it is fine-tuned on VTC's labelled history and matches host-LLM accuracy for fewer tokens. It may add caution but can never relax a risk rule.
2. **Vendor terms:** written confirmation is needed before distributing headless spawning (Anthropic). OpenAI's terms quotes came from a mirror and must be re-checked on openai.com. Both vendors changed policy several times in 2026.
3. **Subscription meters are opaque.** We don't know how cached tokens count against plan limits, and there is no structured readout of remaining usage. Budgets are therefore list-price equivalents.
4. **Codex gaps:**
   - hooks are not real enforcement;
   - no per-path write-deny;
   - spawning is explicit-only;
   - no background agents or worktrees in the CLI.
   
   The engine compensates, but performance on Codex may be lower.
5. **The cold prompt cache per worktree** may raise the cost per task. Measure it in the spike.
6. **Platform absorption:** Claude Code, Kiro and Cursor are adding similar features. Our differentiation is gated contracts, verified evidence, per-role prompt scoring, and the agency layer.
7. **Immature dependencies:** DESIGN.md (alpha), Style Dictionary DTCG 2025.10 support, Storybook MCP (preview).
8. **Small-sample statistics in Lookback.** Promotion relies on human review plus canaries, not on statistical significance alone.

---

## 21. References
- `docs/research/2026-10-12-ai-software-company-landscape.md`: requested sources (agency-agents, loope, babber, agent-reach); frameworks; patterns; failure modes.
- `docs/research/2026-10-12-round2-deep-dives.md`: Claude policy and runtime, BMAD, gates, design, Lookback, competitors.
- `docs/research/2026-10-12-agency-agents-role-catalog.md`: 141 scored role files; the fork list.
- `docs/research/2026-10-12-role-benchmark.md`: real-world roles; AI catalogues; role-design evidence.
- `docs/research/2026-10-12-architecture-practice.md`: Architect knowledge, process, research, enforcement.
- `docs/research/2026-10-12-token-economy.md`: the token playbook and budget policy.
- `docs/research/2026-10-12-multi-host-codex-claude.md`: Codex policy and capabilities; adapter design.
- `docs/research/2026-10-13-laya-vs-jev.md`: typed-decision models; v2 option.
- `docs/research/2026-10-13-impeccable-style.md`: making designs distinct; what to fork; the novelty check.
- `docs/research/2026-10-13-usage-limits-auto-resume.md`: usage readout per host; auto-resume.
- `docs/research/2026-10-13-qcfactory-review.md`: Gradion's QCFactory QA factory. The user approved reusing its code. It is plain JavaScript, so we port it to TypeScript. **Never copy its Gradion-internal data:** `log.json`, scan results, specs, transcripts.
- Theme source: `/Users/bason/Documents/bason-labs/bs-job-agents/apps/web` (`app/globals.css`, `components/ui`, `components/flows`).

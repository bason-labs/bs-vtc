# VTC architecture spine (VTC's own code)

- **Status:** Phase 1 foundation, fix round 2. Frozen for the parallel build of sub-projects
  **1, 2, 3 and 6** (spec §19: 2 and 3 build on 1, 6 needs only 1's events; this spine freezes the
  contracts between them so all four can start together). Sub-projects 4, 5 and 7–9 follow §19's
  order and extend these contracts through the change process (§6 below).
- **Deviation from §19, pending confirmation:** §19 puts sub-project 0 (the feasibility spike)
  before everything and recommends building only after it. This spine starts 1, 2, 3 and 6 in
  parallel with the spike instead (§5 reading 8). Every contract that rests on host behaviour the
  spike verifies is listed in §7 **Provisional contracts** with the spike check that unfreezes it.
- **Date:** 2026-10-13
- **Source of truth:** `docs/superpowers/specs/2026-10-12-vtc-system-design.md` (the spec). Section
  numbers (§n) below refer to it. Where this document and the spec disagree, the spec wins, and
  this document gets fixed. Where the spec is silent or ambiguous, §5 records the reading used.
- **Scope:** the architecture of **VTC's own code**. It does not describe the spine that VTC's
  Architect role writes for a _target_ project (spec §8), although it uses the same format.
- **Format:** C4 L1/L2, then decisions `AD-n`, each with **Binds / Prevents / Rule / Check**
  (spec §8.5). Every Check is automated: a dependency-cruiser rule, a lint rule, or a test.

Run every Check locally with:

```sh
pnpm install && pnpm verify   # typecheck, lint, deps:check, test, format:check, then build
```

---

## 1. C4 Level 1: system context

```mermaid
flowchart LR
  eng([Engineer]) -- "ideas, G1/G2 approvals, escalation answers" --> host
  obs([PM / lead / client]) -- "reads (browser)" --> vtc
  subgraph machine [Developer machine]
    host["Host: Claude Code or Codex<br/>(the Lead = main chat session)"]
    vtc["VTC<br/>single binary `vtc`"]
    repo[("Target repo<br/>.vtc/ (git) + .vtc/state/ (gitignored)")]
    home[("~/.vtc/<br/>hidden tests, research cache, token,<br/>pinned scanners, engine discovery")]
  end
  host -- "MCP (stdio)" --> vtc
  vtc -- "spawn role (subagent instruction or headless CLI)" --> host
  vtc -- "read/write" --> repo
  vtc -- "read/write" --> home
  vtc -- "git / gh with the user's own auth" --> gh[(GitHub)]
  vtc -- "research fetchers (pinned)" --> web[(Registries, docs,<br/>endoflife, OSV, deps.dev)]
  vtc -- "doctor: download pinned by SHA-256" --> dl[(Playwright Chromium,<br/>scanner binaries)]
```

VTC never handles credentials (D2, §12.5). The model providers are reached only through the
user's own, unmodified host CLI.

## 2. C4 Level 2: containers

```mermaid
flowchart TB
  subgraph bin ["vtc binary (Bun --compile; Node 22 in dev/tests)"]
    cli["packages/cli<br/>composition root: commands, wiring,<br/>stdio MCP bridge, statusline shim,<br/>storage driver, adapters, assets, timer"]
    engine["packages/engine (one daemon per repo, AD-12)<br/>daemon · core · gates · git · http · mcp · storage"]
    adapters["packages/adapters<br/>claude-code/ · codex/<br/>(HostAdapter implementations)"]
    compiler["packages/compiler<br/>roles/ + skills/ → host plugins"]
    shared["packages/shared<br/>frozen contracts: Zod + JSON Schema,<br/>interfaces, pure helpers"]
    dash["apps/dashboard (static export)<br/>Flow Studio, served by the engine"]
  end
  plugins[["dist/claude-plugin · dist/codex-plugin<br/>(generated, never hand-edited)"]]
  lead["Lead (host chat)"] -- "MCP stdio: vtc engine --mcp --host <host>" --> cli
  cli -- "MCP over the local socket (AD-12, AD-19)" --> engine
  browser["Browser"] -- "HTTP/SSE + session token (AD-5)" --> engine
  browser -. "iframe sandbox=allow-scripts" .-> proto["prototype server<br/>(own 127.0.0.1 port)"]
  browser -. loads .-> dash
  shim["vtc statusline-tee<br/>(wraps the user's statusline)"] -- "POST ingest + token" --> engine
  cli --> engine & adapters & compiler & shared
  engine --> shared
  adapters --> shared
  compiler --> shared
  dash -. "types only" .-> shared
  psrc[["plugins/ (hand-written sources, AD-16)"]] --> compiler
  compiler --> plugins
  engine -- "events.jsonl (source of truth, single writer)" --> files[(".vtc/ in target repo")]
  engine -- "Storage interface (AD-2)" --> sqlite[(".vtc/state/index.sqlite<br/>node:sqlite | bun:sqlite")]
```

| Container                     | Responsibility (§4.1)                                                                                                                                                                               | May depend on                                   |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `packages/shared`             | Contracts (§16), interfaces, pure helpers. Runtime-agnostic, browser-safe.                                                                                                                          | Nothing internal; `zod`, `@noble/hashes`        |
| `packages/engine`             | Modules (AD-13): `daemon` (composition, AD-19), `core` (state, events, scheduler, loops, budgets, triage, escalation, merge queue, tracing), `gates` (Gate Runner), `git`, `http`, `mcp`, `storage` | `shared` only                                   |
| `packages/adapters`           | `claude-code/`, `codex/`: install, spawn, parse events, resume, sandbox, usage                                                                                                                      | `shared` only                                   |
| `packages/compiler`           | Neutral role/skill sources → Claude agent `.md`, Codex TOML + SKILL.md                                                                                                                              | `shared` only                                   |
| `packages/cli`                | `vtc` commands (§4.1, §4.4); wires everything (AD-1 rule 4)                                                                                                                                         | `shared`, `engine`, `adapters`, `compiler`      |
| `apps/dashboard`              | Read-only Flow Studio (§17) plus design-review pins                                                                                                                                                 | `shared` (contracts only); engine over HTTP/SSE |
| `tooling/arch-tests`          | Proves every architecture Check fires (planted violations)                                                                                                                                          | dev tooling only                                |
| `fixtures/golden-run`         | Recorded run + expected API responses (AD-5, AD-7)                                                                                                                                                  | data only                                       |
| `roles/`, `skills/`, `gates/` | Sources and pins, no code                                                                                                                                                                           | n/a                                             |
| `plugins/`                    | Hand-written host plugin sources: Lead skill, `/vtc` commands, hooks, MCP entry (AD-16)                                                                                                             | n/a                                             |

---

## 3. Decisions

### AD-1 Package boundaries and dependency direction

- **Binds:** every file under `packages/` and `apps/`.
- **Prevents:** the engine growing host-specific code (by import, or by starting a host CLI
  itself); adapters reaching into engine state; the dashboard bypassing the localhost security
  checks by importing engine code; cycles between packages; deep imports that freeze another
  package's internals; imports of another package's build output that slip past every rule.
- **Rule:**
  1. `shared` imports no other VTC package or app.
  2. `adapters` and `compiler` import `shared` only. `adapters/claude-code` and `adapters/codex`
     never import each other.
  3. `engine` imports `shared` only. It sees hosts through the `HostAdapter` **interface** in
     `shared`; the cli injects the concrete adapters.
  4. `cli` is the composition root. Nothing imports `cli`.
  5. `apps/dashboard` may import `shared` contracts and nothing else from `packages/`. It talks to
     the engine only over HTTP/SSE (AD-5).
  6. Packages never import from `apps/`.
  7. Imports into another package, from `packages/` or `apps/`, go through its entry
     (`src/index.ts`), never deep paths.
  8. No dependency cycles. Every npm import is declared in the importing package's `package.json`.
  9. dependency-cruiser resolves `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.json` and the
     dashboard's `@/` alias (`apps/dashboard/src/*`), so the Next.js app is checked from its first
     commit without weakening any rule.
  10. Nothing imports build output (`dist/`, `out/`, `.next/`) of any package or app. Build output
      is cruised as an import target (never excluded, which would hide such imports from every
      rule) and never followed.
  11. The engine never starts a host process itself: every `claude`/`codex` run goes through a
      `HostAdapter`. Engine code refers to hosts only through variables, never a host literal.
- **Check:** `pnpm deps:check` (`.dependency-cruiser.cjs`), rules
  `AD1-shared-has-no-internal-deps`, `AD1-adapters-depend-only-on-shared`,
  `AD1-adapter-families-are-isolated`, `AD1-engine-uses-adapter-interfaces-only`,
  `AD1-compiler-depends-only-on-shared`, `AD1-nothing-imports-the-cli`,
  `AD1-dashboard-talks-to-engine-over-http-only`, `AD1-no-package-imports-apps`,
  `AD1-no-imports-of-build-output`, `AD1-no-deep-imports-across-packages`, `no-circular`,
  `no-undeclared-deps`, `not-to-unresolvable`. Blocking. `tooling/arch-tests` plants one violation
  per rule (including `.tsx` files, an `apps/` deep import and an import of a planted
  `engine/dist/index.js`) and fails if any rule stops firing or if a rule exists without a planted
  violation. Rule 11: ESLint `ENGINE_RESTRICTED_SYNTAX` on `packages/engine/src` (a literal naming
  a host binary), proven by `eslint-rules.test.ts`.

### AD-2 Runtime, storage and asset abstraction

- **Binds:** `packages/shared`, `packages/engine/src/storage/`, the cli's driver and asset wiring.
- **Prevents:** a dev/test dependency on Bun (not installed in phase 1); a native SQLite addon
  that breaks the single-file binary (§4.4); `shared` code that cannot run in the browser; code
  that runs on Node but not inside the Bun binary.
- **Rule:**
  1. Development and tests run on **Node ≥ 22.13** (`.nvmrc` = 22). The shipped binary runs on
     **Bun** (`bun build --compile`). Nothing in phase 1 requires Bun.
  2. The engine uses SQLite only through the `Storage` interface in `@vtc/shared`: synchronous,
     positional `?` parameters, rows as plain objects, non-re-entrant synchronous transactions,
     "no row" = `undefined` (the Bun driver maps Bun's `null`). It is the common subset of
     `node:sqlite` and `bun:sqlite`.
  3. `node:sqlite` is imported only by `engine/src/storage/node-sqlite.ts`; `bun:*` only by
     `engine/src/storage/bun-sqlite.ts`. The Bun driver typechecks under Node through a minimal
     ambient declaration (`bun-sqlite-module.d.ts`, referenced by path). Drivers are loaded
     **lazily** by the engine entry only (`loadNodeSqliteStorage()`, `loadBunSqliteStorage()`); the
     cli picks one with `loadStorage()` (`"Bun" in globalThis`). A runtime never evaluates the
     other runtime's driver.
  4. The SQLite index (`.vtc/state/index.sqlite`) is a **cache** rebuildable from the event log
     (AD-7). Losing it loses nothing.
  5. `packages/shared` uses no Node or Bun built-ins **or globals** (`Buffer`, `process`,
     `__dirname`, `setImmediate`…); hashing uses `@noble/hashes`.
  6. Engine, cli, adapters and compiler import only Node built-ins Bun also implements
     (`RUNTIME_SAFE_BUILTINS` in `.dependency-cruiser.cjs`: fs, path, os, child_process, http, net,
     crypto, url, events, stream, readline, timers, util, zlib, assert, buffer, process,
     string_decoder). Anything else goes behind an interface like `Storage`.
  7. Embedded files (the dashboard's static export, the compiled plugin templates) reach packages
     only through the `AssetBundle` interface (`@vtc/shared`), which the cli builds: from disk in
     development, from Bun-embedded files in the binary. Packages never import `apps/` or `dist/`.
  8. Production npm dependencies are pure JS or WASM: no native addon (`binding.gyp`, `*.node`),
     no install script. `pnpm-workspace.yaml` sets `onlyBuiltDependencies: []`, so no dependency
     script ever runs.
- **Check:** dependency-cruiser `AD2-shared-is-runtime-agnostic`, `AD2-runtime-builtins-allowlist`,
  `AD2-node-sqlite-only-in-its-driver`, `AD2-bun-builtins-only-in-bun-driver`,
  `AD2-storage-drivers-loaded-by-the-entry-only`; ESLint `no-restricted-globals` /
  `no-restricted-properties` on `packages/shared/src` (proven by `tooling/arch-tests`); the
  storage contract suite `packages/engine/test/storage-contract.ts` (`runStorageContract`), which
  **every driver must pass unchanged** (node:sqlite now; bun:sqlite in the binary's own test job,
  sub-project 0); `cli.test.ts` asserts Node selects `node:sqlite`. Rule 8:
  `tooling/arch-tests/test/supply-chain.test.ts` walks every workspace package's production
  dependency closure and fails on a native file or an install script.

### AD-3 Frozen contracts live in `@vtc/shared`

- **Binds:** every data shape that crosses a package, process, file or host boundary. The full list
  is `CONTRACT_SCHEMAS` (`json-schema.ts`): Run, Task, TaskDraft, PlanFileFrontmatter, Feature,
  Finding, FindingDraft, Question, Escalation, Event, EventPayloads, RoleResult, RoleContract,
  AssertionProvenance, TaskPack, TraceabilityReport, EvidenceBundle, ProjectConfig, GatesConfig,
  ScannerPins, GateRunRequest, GateResult, GateReport, WriteScopeReport, UsageSnapshot,
  UsageReport, StatuslineIngest, WorkflowNode/Edge/Graph, HostOutcome, SubagentInstruction,
  EngineDiscovery, every MCP tool input and output (AD-4) and every HTTP request and response
  (AD-5). Interfaces: `HostAdapter`, `Storage`, `GateRunner`, `AssetBundle`,
  `AutoResumeScheduler`, and the composition seam (`EngineDeps`, `RunDaemon`, `ServeSnapshot`,
  `CreateGateRunner`, `EngineClient`; AD-19).
- **Prevents:** parallel teams drifting apart; hand-written JSON Schemas diverging from runtime
  validation; AI output accepted without validation (§3 principle 3).
- **Rule:**
  1. **Zod is the single source.** TypeScript types are `z.infer`; JSON Schemas (draft 2020-12)
     come from `jsonSchemas()` / `jsonSchemaFor(name)`. Never hand-write either.
  2. Contracts are **strict objects** (`additionalProperties: false`): unknown keys are errors.
     Persisted and wire data use **snake_case**; TypeScript APIs (interfaces, functions) use
     camelCase. Example: spec `spawn_role` = `HostAdapter.spawnRole`.
  3. Cross-field rules use `superRefine`. JSON Schema cannot express them, so after a host returns
     structured output the engine **always re-validates with Zod** (`fromStructuredOutput`).
  4. `CONTRACTS_VERSION` is semver. Adding an optional field or an enum value that consumers may
     ignore is MINOR. Anything else is MAJOR and needs an architecture review and every consumer
     updated in the same change. Every version's schema hash is appended to
     `packages/shared/schemas/contracts-ledger.json` by hand: a schema change without a new
     version entry fails the test even after `vitest -u`. (2.0.0 = fix round 1, 3.0.0 = fix
     round 2; nothing consumed the earlier versions.)
  5. Open vocabularies stay open on purpose: event `type` (pattern `<entity>.<verb>`; the core
     set has typed payloads, AD-7), role ids, artifact types, stack packs. Consumers ignore unknown
     values.
  6. Pure helpers that define shared semantics live here too: `fingerprintFinding`,
     `normalizeSeverity`, `weightedSeverity`, `openHighRuleFires`, `routeForFinding`,
     `riskRuleForPark`, `checkResultAgainstContract`, `planDispatch`, `redactSecrets` /
     `redactJson` / `dotenvValues`, `estimateTokens` (summary cap 1,500 tokens = 6,000 chars),
     `findUnguardedCycle`, `remainingPct`, `windowKindFromMinutes`, `usageFromStatuslineIngest`,
     `gateReportVerdict`, `gateExpectationMet`, `escalationFromQuestion`, `resolveRoleMode`,
     `agentNameFor`, `splitRolePrompt`, `renderTaskPack`, `formatReqTag` / `parseReqTags`,
     `formatProvenance` / `parseProvenance`, `sseEventId` / `parseSseEventId`, `engineRepoKey`,
     `engineSocketFile`, `isServableArtifactPath`, `engineMcpServer`, `findForbiddenHostArgs`,
     `findForbiddenInText`, `capForRisk` (caps come only from `project.yaml`).
  7. Spine extensions to §16 are named here: the finding route `out_of_scope` (an Engineer
     `out_of_scope_fault` whose guards passed, §6.3 step 3); `RequirementRef` (`REQ-3.AC-2`)
     in `Finding.req_ids`; the Visual QA verdict `unchecked` (§7.5); `FindingDraft.kind` (the
     routing signal, AD-8 rule 6); `RoleResult.verdicts` (one verdict per subject with evidence,
     replacing §16's scalar `verdict`, AD-8 rule 2); `Task.risk_tags`; the `subject` of a
     dispatch (the AC of a Spec-Verifier call).
  8. Hosts receive the **structured-output** form, `jsonSchemaFor(name, { target:
"structured-output" })`: object root (a root union is merged into one object with a
     discriminator enum), every property required with optional ones nullable, no `default`.
     Sub-project 0 verifies it against `claude -p --json-schema` and `codex exec --output-schema`
     (provisional, §7).
  9. **One evidence vocabulary.** Findings, claims, verdicts, questions and escalations all cite
     `Evidence` (`EvidenceTypeSchema`, whose doc comment defines each `ref` format and when it
     resolves). There is no second claim vocabulary.
- **Check:** `packages/shared/test/*.test.ts` (valid and invalid examples for every schema and
  helper, including an invalid payload for every core event type and every HTTP response
  contract); the JSON Schema **file snapshot** `packages/shared/schemas/contracts.json` and the
  **version ledger** `contracts-ledger.json` (`json-schema.test.ts`): a contract change fails until
  the snapshot is updated **and** a new `CONTRACTS_VERSION` with the new schema hash is appended
  (versions strictly increasing, one hash each); `json-schema.test.ts` also asserts the
  structured-output shape and that structured-output contracts have no nullable field (so `null`
  always means "absent").

### AD-4 Engine MCP tool surface

- **Binds:** `packages/engine/src/mcp`, the stdio bridge, host plugins (`/vtc …` commands), the
  Lead prompt.
- **Prevents:** the flow drifting because the Lead improvises (§4.2); agents setting state the
  engine owns (`done`, caps, budgets); teams negotiating tool output shapes.
- **Rule:** the Lead reaches the engine through `vtc engine --mcp --host <host>`
  (`engineMcpServer(host)`), a **stdio** MCP server registered by each host plugin (AD-16) that
  bridges to the repo's engine daemon (AD-12) and tags its session with the host it runs in, so
  the engine knows which adapter and model map apply. The cli control commands are MCP clients of
  the same daemon socket (AD-19). The official MCP TypeScript SDK, pinned. Lead-facing tools
  (frozen in `ENGINE_MCP_TOOLS`, each with an `input` and `output` contract):

  | Tool             | Purpose                                                                         | Input → output                               |
  | ---------------- | ------------------------------------------------------------------------------- | -------------------------------------------- |
  | `start`          | Start a run with the Lead's INTAKE classification (track, repo, UI, risk hints) | `StartInput` → `StartResult`                 |
  | `next`           | Next actions: `spawn_role`, `ask_human`, `approve_gate`, `wait`, `done`         | `RunScopedInput` → `NextResult`              |
  | `submit`         | A role result, or why the run did not finish (`limit`/`auth`/`error`)           | `SubmitInput` → `SubmitResult`               |
  | `status`         | Run summary: phase, tasks by state, parked items, budget, usage                 | `RunScopedInput` → `StatusResult`            |
  | `escalations`    | Open escalations (batched) with evidence and options                            | `RunScopedInput` → `EscalationList`          |
  | `answer`         | Record the human's answer (incl. `who_should_have_caught`) and resume           | `AnswerInput` → `NextResult`                 |
  | `approve`        | G1 / G2 decision; freezes each shown artifact at its own hash                   | `ApproveInput` → `NextResult`                |
  | `change_request` | Open a CR against a frozen spec, architecture or design (becomes an escalation) | `ChangeRequestInput` → `ChangeRequestResult` |
  | `pause`          | Kill switch: stop dispatching and merging                                       | `RunScopedInput` → `RunControlResult`        |
  | `resume`         | Resume a paused/interrupted run, rebuilding state from the event log            | `RunScopedInput` → `RunControlResult`        |
  1. The Lead dispatches **only** actions returned by `next`. `submit` must echo the `action_id`;
     unknown, stale, duplicate or out-of-order results are rejected with a `RejectReason`
     (§4.2 step 4).
  2. Tool results are compact (§11: coarse tools, ≤ 1.5k-token returns).
  3. Role-facing tools (repo map, research fetchers, fact lookups) are added by the sub-projects
     that own them (3, 4) as a MINOR contract change.
  4. **Dispatch:** `spawn_role` is always a subagent spawn the Lead performs with the action's
     `agent`, `prompt`, `background`, optional `resume` session and optional `subject` (the one
     AC a Spec-Verifier call judges). Headless runs are **launched by the engine** through
     `HostAdapter.spawnRole`, are never Lead actions, show as `wait` to the Lead, and happen only
     where `planDispatch` allows them (AD-17: never in the default plugin-only mode).
  5. A subagent that hit a limit, lost auth or crashed is reported with `submit` `kind: failure`
     and the normalised outcome, so limit parking (§6.9) and spend capture (§11) cover subagent
     runs too. Successful runs report `usage` (model, tokens, cost) alongside the result.

- **Check:** `engine-api.test.ts` in shared: tool names unique and include the §4.2 loop; every
  tool names existing input and output contracts; valid and invalid cases for every input and
  output. Sub-project 1 adds a tool-level contract test per tool (valid input accepted, invalid
  input rejected with a schema error, out-of-order `submit` rejected).

### AD-5 Engine HTTP/SSE API (localhost hardening)

- **Binds:** `packages/engine/src/http`, `apps/dashboard`, `vtc statusline-tee`.
- **Prevents:** other websites or DNS-rebinding pages reading run data or injecting data (§15);
  other servers on 127.0.0.1 (including target dev, prototype and Storybook servers VTC itself
  starts) receiving a credential, because cookies are not port-isolated (RFC 6265 §8.5); the
  install token ending up in a URL or browser history; agent-written HTML running on the API's
  origin; the dashboard becoming a control surface (it is read-only, D7); the dashboard team
  inventing response shapes.
- **Rule:**
  1. Bind **127.0.0.1 only**. Built on `node:http` (implemented by both Node and Bun); no web
     framework.
  2. **Tokens, never cookies.** A per-install token (256 random bits, `~/.vtc/token`, mode 0600,
     never in a repo, a discovery file or a URL) authenticates the cli and the statusline shim.
     Browsers get a **session token** instead: `vtc dashboard` mints a single-use nonce
     (`POST /api/session/nonce` with the install token, or `RunningSnapshot.mintNonce()`; valid
     60 s) and opens `http://127.0.0.1:<port>/#nonce=<nonce>` (a fragment, never sent to a
     server); the page exchanges it (`POST /api/session`) for a random session token that is
     never the install token, expires after `ENGINE_SESSION.sessionTtlMs` (12 h) and dies with the
     daemon. The page keeps it in memory or `sessionStorage` (origin-scoped, so other ports
     cannot read it) and sends `Authorization: Bearer <session>`, including for SSE, which it reads
     with `fetch` streaming. Each route's `auth` says which credential it takes (`token`,
     `install`, `nonce`). The static dashboard files hold no run data and need no token.
  3. **Host** must be `127.0.0.1:<port>` or `localhost:<port>`; **Origin**, when present, must equal
     the server's own origin. Otherwise `403`. No CORS headers are ever sent.
  4. Routes are frozen in `ENGINE_HTTP`, each with its response contract (errors use `HttpError`):

     | Route                                   | Auth    | Response                |
     | --------------------------------------- | ------- | ----------------------- |
     | `GET /api/health`                       | token   | `HealthResult`          |
     | `GET /api/status`                       | token   | `StatusResult`          |
     | `GET /api/runs`                         | token   | `RunList`               |
     | `GET /api/runs/:run/events?after&limit` | token   | `EventPage`             |
     | `GET /api/runs/:run/tasks`              | token   | `TaskList`              |
     | `GET /api/runs/:run/tasks/:task`        | token   | `TaskDetail`            |
     | `GET /api/runs/:run/tasks/:task/diff`   | token   | `TaskDiff`              |
     | `GET /api/runs/:run/features`           | token   | `FeatureList`           |
     | `GET /api/runs/:run/artifacts?path`     | token   | `ArtifactContent`       |
     | `GET /api/runs/:run/graph?scope&task`   | token   | `WorkflowGraph`         |
     | `GET /api/runs/:run/escalations`        | token   | `EscalationList`        |
     | `GET /api/usage`                        | token   | `UsageReport`           |
     | `GET /api/stream` (SSE over fetch)      | token   | `Event` messages        |
     | `POST /api/session/nonce`               | install | `SessionNonceResult`    |
     | `POST /api/session`                     | nonce   | `SessionExchangeResult` |
     | `POST /api/ingest/claude-statusline`    | install | `IngestResult`          |
     | `POST /api/design/reviews`              | token   | `DesignReviewResult`    |

     plus the static dashboard at `/`, served from the injected `AssetBundle` (AD-2 rule 7).

  5. Exactly **two data writes**, both size-limited (`maxBodyBytes`) and validated (`request`
     contract), and neither can execute anything: the statusline ingest (`StatuslineIngest`,
     usage data only) and design-review pins (`DesignReviewCommentInput`, spec §17), which the
     engine appends to `.vtc/design/reviews/<screen>.jsonl` and nowhere else. Approval still
     happens in the Lead chat. The two session routes write nothing to disk.
  6. SSE: each message is one `Event` (AD-7) as JSON; `id: <run>:<seq>` (`sseEventId`);
     reconnects resume from `Last-Event-ID` (`parseSseEventId`).
  7. **Snapshot mode.** When no engine runs for the repo, `vtc dashboard` serves the **same
     routes** read-only from the committed `.vtc/` snapshot, built by the engine's own replay code
     (`HealthResult.mode = "snapshot"`). It takes no lock, writes no event, publishes no discovery
     file, and answers the statusline ingest with `snapshot_mode` (design pins still append).
  8. **Dashboard development.** The dashboard team builds against `fixtures/golden-run/` (recorded
     `events.jsonl` + the expected response of every read route, all three graph zoom levels, an
     artifact and a diff). Against a live engine, `next dev` uses a dev-only proxy for `/api/*`
     that injects the token, sets `Host` and drops `Origin`, so the browser sees one origin and
     the engine's checks stay unchanged.
  9. **Prototype origin.** Design review shows `.vtc/design/prototype/` (agent-written HTML/JS)
     from a **separate listener** on its own 127.0.0.1 port (`HealthResult.prototype_url`,
     `EngineDiscovery.prototype_port`). It serves only that directory, exposes no API, needs no
     token (the files are git-tracked, no run data), checks Host, and sends `PROTOTYPE_CSP`
     (`sandbox allow-scripts`, `connect-src 'none'`, `frame-ancestors http://127.0.0.1:*`) on
     every response. The dashboard embeds it only in `<iframe sandbox="allow-scripts">`, never
     with `allow-same-origin`.
  10. **Artifacts.** `GET /api/runs/:run/artifacts?path=` serves git-tracked run artifacts under
      `.vtc/` only, never `.vtc/state/` (`isServableArtifactPath`, plus a symlink-resolved real
      path check), always as JSON (`ArtifactContent`, `X-Content-Type-Options: nosniff`, binary as
      base64, at most `ARTIFACT_MAX_BYTES`), so nothing is ever rendered on the API origin.
- **Check:** `engine-api.test.ts` (loopback bind host; every route under `/api/`; exactly two
  writes, both with a request contract and a body limit; every route names an existing response
  contract; design-review results confined to `.vtc/design/reviews/`); `golden-run.test.ts`
  (every snapshot validates as its route's response and agrees with the log); `engine-api.test.ts`
  also asserts no route mentions a cookie, the per-route `auth`, the session TTLs, the artifact
  path rule and the prototype CSP. Sub-project 1 adds HTTP tests that must pass before the server
  ships: the listening address is `127.0.0.1`; requests with a missing/wrong token, a foreign
  `Host`, or a foreign `Origin` get `403`; responses carry no `Access-Control-Allow-*` headers and
  no `Set-Cookie`; a `Cookie` header never authenticates; the install token is refused on the
  `nonce` route and a session token on `install` routes; a nonce works once and not after 60 s; a
  session token expires and dies with the daemon; oversized bodies get `413`; a design-review write
  with a path-escaping screen id is rejected; the artifacts route refuses `.vtc/state/`, `..`, `.`
  segments and a symlink pointing outside `.vtc/`; every prototype response carries
  `PROTOTYPE_CSP` and the prototype port serves no `/api/` route; snapshot mode refuses the
  ingest.

### AD-6 Host adapter interface

- **Binds:** `packages/adapters/*`, the engine's dispatcher, the cli's adapter wiring.
- **Prevents:** host differences leaking into engine logic; enforcement that only works on one
  host (§3 principle 8, §12.2); orphaned host processes (§15).
- **Rule:** both adapters implement `HostAdapter` (`@vtc/shared`), mapping spec §4.1 names:

  | Spec              | TypeScript                              | Notes                                                                                                         |
  | ----------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
  | `install`         | `install(InstallRequest)`               | Plugin/agents/MCP registration; Codex also writes `.codex/agents/*.toml`; Claude wires `vtc statusline-tee`   |
  | `spawn_role`      | `spawnRole(SpawnRoleRequest)`           | `SubagentInstruction` for the Lead, or an engine-launched `HeadlessRun` with a hard timeout and kill (§15)    |
  | (argv)            | `headlessCommand(request, session?)`    | **Pure.** The exact `HostCommand` a headless run or resume executes; `HeadlessRun.command` records it         |
  | `parse_events`    | `parseEvents(lines)`                    | **Pure.** Normalises any stream to `HostOutcome`: `done \| limit \| auth \| error` (with partial spend)       |
  | `resume`          | `resume(SessionRef, SpawnRoleRequest)`  | Same session + worktree, new input (§6.5, §6.9)                                                               |
  | `sandbox_profile` | `sandboxProfile(SandboxProfileRequest)` | **Pure.** Host settings + what the host itself enforces                                                       |
  | `read_usage`      | `readUsage?()`, `watchUsage?(cb)`       | Optional: hosts with an adapter-owned source (Codex `codex app-server`). Unknown stays `null`, never 0 (§6.9) |
  | (lifecycle)       | `dispose()`                             | Stops every child process and subscription the adapter owns. The cli calls it on shutdown.                    |
  1. `capabilities` declares what the host enforces and supports (§12.1), including `subagents`
     (the Lead can dispatch role subagents) and `headless`. Write scope, caps, budgets, gate
     order, schema validation and limit parking are **always** enforced by the engine, whatever
     the host claims (§12.2). `parseEvents` also returns the stream's latest SDK usage
     (`ParsedStream.usage`, `source: "sdk_event"`) and retry notice, so the host-agnostic engine
     never parses host events itself.
  2. Model ids come from the engine (role tier/effort + project overrides): `SpawnRoleRequest.model`
     is a `ResolvedModel` with a concrete `model` id. Adapters do not pick models.
  3. Adapters never read credentials and never pass permission-bypass flags (AD-9).
  4. **Usage ownership.** The engine owns the usage store (`UsageReport`). Claude usage arrives
     as a push: `vtc statusline-tee` turns the statusline JSON into a `StatuslineIngest` body with
     the adapter's pure `statuslineIngestFromClaude` and POSTs it; the engine stores
     `usageFromStatuslineIngest(body)` and merges SDK events from runs it launched. Codex usage
     comes from the adapter's managed `codex app-server` child (`watchUsage`, stopped by
     `dispose`). The auto-resume timer is the `AutoResumeScheduler` interface: the engine decides
     when; the cli implements it (launchd on macOS, installed by `vtc install`).
  5. `install` writes user-scope files only under `InstallRequest.home` (injected, so tests use a
     temp directory) and project files under `projectRoot`. It places or registers what the
     compiler emitted (AD-16) and authors no plugin content.

- **Check:** dependency-cruiser AD-1 rules (engine cannot import adapters);
  `packages/adapters/test/adapters.test.ts` (capabilities for every host, Codex gaps recorded,
  the recorded Claude statusline payload in `test/fixtures/claude-code/statusline.json`, the
  bypass detector). The reusable safety contract `test/host-adapter-contract.ts`
  (`runHostAdapterSafetyContract`: for every tool profile, `sandboxProfile()` arguments and
  settings, the fresh and resumed `headlessCommand` argv and env, and every file `install` writes
  into a temp home and project contain no AD-9 marker) is a per-host todo until sub-project 3
  implements those methods, then it must run for both hosts. Sub-project 3 also adds **contract tests
  against recorded host streams** in `packages/adapters/test/fixtures/<host>/*.jsonl`, including
  limit hits and auth errors (§18), validated with `HostOutcomeSchema`.

### AD-7 Event log and file layout

- **Binds:** everything that reads or writes `.vtc/`; replay; the dashboard's snapshot mode.
- **Prevents:** state that only lives in memory or SQLite; teammates unable to see a run from
  their clone (D8); silent corruption after a crash; a second source of truth.
- **Rule:**
  1. Every state change is an `Event` appended to `.vtc/runs/<run>/events.jsonl`: one JSON object
     per line, `v` (schema version, now 1), per-run `seq` starting at 1 and strictly increasing,
     `ts`, `run`, `type`, `actor`, `data`, plus optional `task`, `feature`, `role`, `prompt_sha`,
     `host`, `model`, `tokens`, `cost_usd` (`null` = unpriced model, an error, never $0).
  2. Only the engine writes the log, through one append path (`openEventLog(...).append`, which
     requires the engine lock, AD-12). The log is append-only and is committed at milestones (§6.8).
  3. Every core event type has a **typed payload** (`EVENT_PAYLOAD_SCHEMAS`, exported as
     `EventPayloads`): `EventSchema` rejects a core event whose `data` or required envelope field
     is wrong (`EVENT_ENVELOPE_REQUIREMENTS`). Unknown types stay free-form. Read payloads with
     `isEventOfType` + `readEventData`.
  4. Replay uses `parseEventLog`: invalid lines and a torn final line are **reported**, never
     thrown, and become an incident report (§15). The writer fences off a torn tail with a newline
     and continues the `seq`.
  5. On start the engine rebuilds state from the log; SQLite is only an index (AD-2).
  6. File layout is §4.3: `.vtc/project.yaml`, `gates.yml`, `defaults.toml`, `research/`, `spec/`,
     `architecture/`, `design/` (incl. `reviews/`), `tasks/T-n.md`, `evidence/T-n/` and
     `evidence/<feature>/`, `runs/<run>/events.jsonl`, `lookback/` are git-tracked. `.vtc/state/`
     (SQLite index, engine lock, worktrees, packs, transcripts, blobs, raw unredacted output) is
     gitignored. `~/.vtc/` holds hidden tests, the research cache (per client), the token, pinned
     scanners and engine discovery files.
  7. Roles write only inside their declared scope (`RoleContract.tools.write_paths`, per mode, or
     the task's `files_scope`); the engine verifies every write (§6.3 step 4, AD-13).
  8. **Plan-file frontmatter is a projection.** `.vtc/tasks/T-n.md` frontmatter
     (`PlanFileFrontmatter`) is written by the engine from the event log and **never read back as
     input**; an edit to it changes nothing and is overwritten. The `<intent-contract>` block is
     written once at PLAN from the Planner's `TaskDraft.intent` and is immutable.
  9. Run ids are path-safe (`RunIdSchema`); every path in a contract is repo-relative with no
     `..` (`RelPathSchema`), including `Task.worktree`; git ids are full SHAs.
  10. **Replay derives every engine-owned field from a core event** (the projection rules are the
      doc comment of `EVENT_PAYLOAD_SCHEMAS`): worktree, branch and baseline from
      `task.workspace_assigned`; `Task.session_ref` from `task.session_updated` (never from
      `role.submitted`, which traces one run); a contract freeze from `contract.frozen`; the PR
      from `feature.pr_updated`; the effective merge level from `run.merge_level_changed`; CRs
      from `change_request.opened`/`decided`; wording-only spec edits from `spec.clarified`.
  11. **Every AI call is traceable** (§1.1 #3, §13): `role.dispatched` and `role.submitted` must
      carry `prompt_sha`, `host` and `model`; `role.submitted` also carries `tokens` and
      `cost_usd`, which may be `null` (unknown or unpriced, flagged in the run summary) but never
      absent.
  12. **Redaction before the log** (AD-18): `openEventLog(...).append` passes `data` through
      `redactJson` with the repo's known secret values before validating and writing.
- **Check:** `event.test.ts` and `event-payloads.test.ts` (schema, a valid example and an invalid
  payload of every core type, envelope and trace rules, line round-trip, invalid and torn lines,
  unsafe run ids); `engine/test/instance.test.ts` (single writer, `seq` continuity across
  restarts, torn tail, planted token formats and a `.env` value redacted on disk);
  `golden-run.test.ts` (task workspace, session, risk tags, features and role runs follow their
  events); `.gitignore` contains `.vtc/state/`. Sub-project 1 adds **golden replay
  tests** (§18): `fixtures/golden-run/events.jsonl` replays to exactly the `api/*.json` snapshots,
  and a replay with tampered plan-file frontmatter produces the same state.

### AD-8 The engine decides; agents act

- **Binds:** `packages/engine`, role prompts, host plugins and hooks.
- **Prevents:** flow, caps, counters, budgets or state transitions living in prompts (§3
  principle 1); a worker setting `done` (§6.4); an agent merging its own work (§15).
- **Rule:**
  1. Every state transition (§6.4, §6.7a), cap (§6.3 step 9), budget rule (§11), router rule
     (§5.3, §7.6) and triage route (§6.3 step 8) is engine code with a unit test.
  2. Deterministic first (D11): if code can decide it, code decides it. **Every AI verdict cites
     evidence**: `RoleResult.verdicts` holds one `{subject, verdict, question_type?, evidence[≥1]}`
     per subject (the Spec-Verifier's AC, a Visual QA criterion `V1`–`V8` with its question type,
     a task or feature). The engine rejects a result whose evidence does not resolve
     (`claim_check`); an unresolved finding's evidence → finding `discarded`. A Visual QA call
     judges all criteria it covers; the engine runs three calls and votes 2-of-3 per criterion.
  3. Host hooks are an extra layer of defence only, never the enforcement point.
  4. Merges happen only through the engine's merge queue.
  5. Planners submit `TaskDraft`s: engine-owned task fields (status, cap, budget, round, spend,
     worktree, branch, session) are rejected at the schema; the engine derives them. The cap comes
     from `project.yaml` (`capForRisk(risk, config.caps)`), the only source of the numbers.
  6. **Triage routing** is `routeForFinding`: a secret → `risky`; test adequacy → `bad_test`;
     `info` severity → `defer`; tool findings → `patch`; role findings by their `kind`
     (implementation deviation → `patch`, design ambiguity → `design_gap`, an observed-assertion
     mismatch or spec ambiguity → `spec_gap`, test defect → `bad_test`).
  7. **Severity and rule 9.** Only security-class categories (secret, security, supply chain,
     test integrity) normalise to `high` or above; correctness is `medium`. So §7.6 rule 9
     (`openHighRuleFires`: a high/critical finding still open after one fix round) parks on
     security-class problems, and ordinary bugs run the 3–5 round loop (D6).
  8. **One encoding per risk rule.** Reason `risk_rule` names only rules 1–9; rules 10–13 use
     their own reason (`cap`/`stuck`, `spec_conflict`/`change_request`, `gate_infra`, `budget`).
     `riskRuleForPark` maps any park back to its rule (the Level-3 "no risk rule fired" check).
  9. **Result conformance.** Before accepting a schema-valid result the engine runs
     `checkResultAgainstContract` against the role's effective contract and the dispatched action
     (role, task, feature, subject, mode, declared exits, verdicts and output artifact types; only
     a role declaring the `tasks` artifact may send task drafts), rejecting with the returned
     `RejectReason`.
  10. `non_converged` is reserved and never set in v1 (§5 reading 9).
- **Check:** engine unit tests per transition/cap/budget/route (sub-project 1); property tests
  for scheduler and DAG invariants; `WorkflowGraphSchema` rejects any back-edge without a
  `loop_guard` (`usage-workflow.test.ts`); `RoleContractSchema` rejects a role reviewing itself
  and `code_sandboxed` outside the Engineer family, also inside modes (`role.test.ts`);
  `TaskDraftSchema` rejects every engine-owned field (`task.test.ts`); `role.test.ts` (verdicts
  need evidence, Visual QA question types, one verdict per subject, every conformance rejection);
  `policy.test.ts` (every route, a correctness finding surviving to the cap without tripping rule
  9, rule 9 after one round, the risk-rule mapping covering every reason and rule).

### AD-9 No credentials, no permission bypass

- **Binds:** all source under `packages/` and `apps/`; role, skill and plugin sources (`roles/`,
  `skills/`, `plugins/`); everything the compiler emits (agent frontmatter such as
  `permissionMode`, Codex agent TOML such as `sandbox_mode`, hooks, settings); every file
  `install` writes; every headless argv and env.
- **Prevents:** violating vendor terms or user trust (§12.5, §15).
- **Rule:** never read, copy or store host credentials (`~/.claude/.credentials.json`, the
  `Claude Code-credentials` keychain item, `~/.codex/auth.json`); never use
  `--dangerously-skip-permissions`, `bypassPermissions`,
  `--dangerously-bypass-approvals-and-sandbox`, `--yolo` or `danger-full-access`; never name the
  credential variables `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN` or `OPENAI_API_KEY`. Use
  explicit allow rules plus the sandbox. Git and `gh` use the user's existing auth. The markers
  live in one list, `AD9_FORBIDDEN_MARKERS` (`@vtc/shared`), mirrored by `AD9_MARKERS` in
  `eslint.config.js`. Prompts and skills do not name a marker even as a prohibition ("never use
  …"); they phrase it generically.
- **Check:** ESLint `no-restricted-syntax` fails on any string or template literal containing a
  marker (case-insensitive) in non-test source; only `shared/src/helpers/compliance.ts`, which
  defines the list, is exempt. `tooling/arch-tests` plants each form (incl. path-joined credential
  files and the keychain call) and asserts the two lists are equal. A literal split across a
  concatenation is out of a lint rule's reach; the runtime checks cover it: the adapter safety
  contract runs `findForbiddenHostArgs` on every `headlessCommand` argv and env and
  `findForbiddenInText` on every installed file (AD-6); `compiler.test.ts` proves
  `checkPluginFiles` (the compile step's gate on every emitted file) catches planted markers;
  `tooling/arch-tests/test/supply-chain.test.ts` scans every file under `roles/`, `skills/` and
  `plugins/`.

### AD-10 Toolchain, build and merge gate

- **Binds:** repo root config and every package.
- **Prevents:** tests or typecheck depending on a prior build; unpinned dependencies; config drift
  between packages; a red branch merged because nobody ran the Checks.
- **Rule:**
  1. pnpm workspaces (`packages/*`, `apps/*`, `tooling/*`) + turbo (`build`, `typecheck`, `lint`,
     `test`). Dependencies are pinned to exact versions. TypeScript 6.0 (the newest line
     typescript-eslint supports), strict, ESM, `NodeNext`, `exactOptionalPropertyTypes`,
     `noUncheckedIndexedAccess`.
  2. Each package exports `{"@vtc/source": src/index.ts, types: dist/index.d.ts, default:
dist/index.js}`. Typecheck (`customConditions`), tests (Vitest aliases) and
     dependency-cruiser resolve workspace packages **to source**; `tsc -p tsconfig.build.json`
     emits `dist/` in dependency order (`^build`).
  3. ESLint flat config with `typescript-eslint` `strictTypeChecked`; Prettier for formatting.
  4. The single-file binary is built later with `bun build --compile` (sub-project 0 spike, then
     1); the engine serves the dashboard's static export from the cli-provided `AssetBundle`.
  5. `turbo.json` sets `agentGuidance: false`, so turbo does not write an `AGENTS.md` into the
     repo.
  6. **Merge gate.** `pnpm verify` (= `pnpm check && pnpm build`) must be green before any branch
     merges into an integration branch or `main`. The orchestrator runs it as a required merge
     step for every team branch; locally, `pnpm hooks:install` enables `.githooks/pre-push`,
     which runs it on every push. A CI workflow runs it once the repo has a remote. Each team
     branch also passes `pnpm verify:scope <team> --base <integration-branch>` (AD-15).
- **Check:** `pnpm check` = `typecheck` + `lint` + `deps:check` + `test` + `format:check`, all
  blocking; `pnpm build` must succeed; `pnpm verify` runs both.

### AD-11 Testing strategy (§18)

- **Binds:** all packages.
- **Prevents:** untested state logic; tests coupled to build output; test code shipped in the
  binary.
- **Rule:**
  1. Vitest everywhere; tests live in `<pkg>/test/**/*.test.ts` and resolve workspace packages to
     source (`vitest.shared.ts`). Unit tests have no network.
  2. **Engine:** a unit test for every state transition, cap, budget rule, router rule, triage
     route and parser (JUnit, SARIF, stream events for both hosts); property tests for the
     scheduler and DAG invariants; golden tests for event replay (`fixtures/golden-run`).
  3. **Adapters:** contract tests against recorded host event streams, including limit hits and
     auth errors; the safety contract (AD-6).
  4. **Storage drivers:** the shared storage contract suite (AD-2).
  5. **Contracts:** valid and invalid examples for every schema; the JSON Schema snapshot (AD-3).
  6. **Architecture Checks:** `tooling/arch-tests` proves each dependency rule and lint rule fires.
  7. **Roles:** eval suites per role and per host on a fixed reference-task set, pass^k reporting
     (sub-project 7).
  8. **End-to-end:** 5 reference projects (two greenfield; three brownfield in TS, Python, Go) on
     both hosts.
  9. Production code (packages and apps) never imports test code or devDependencies.
- **Check:** `pnpm test`; dependency-cruiser `AD11-no-test-code-in-production`,
  `AD11-no-dev-deps-in-production`.

### AD-12 Engine instance model and discovery

- **Binds:** `packages/engine/src/core` (lock, log writer, discovery), `packages/cli` (`vtc engine`,
  `vtc dashboard`, `vtc statusline-tee`, the timer), host plugins' MCP registration.
- **Prevents:** two engines appending to one `events.jsonl` (breaking AD-7's single writer and
  strictly increasing `seq`); clients unable to find the engine's port; auto-resume dying with the
  Lead session (§6.9: "only the engine" must be alive).
- **Rule:**
  1. **One engine daemon per repo.** It holds the exclusive lock `.vtc/state/engine.lock`
     (`acquireEngineLock`; exclusive create; a lock whose holder pid is dead is taken over once and
     recorded as an `incident.recorded` `stale_lock`). Only the lock holder can open or append to a
     run's log.
  2. **Discovery:** the daemon writes `~/.vtc/engines/<repo-key>.json` (`EngineDiscovery`: pid,
     HTTP port, local MCP socket, repo root, versions; mode 0600, atomic write; no token) and
     removes it on a clean exit. `repo-key` = `engineRepoKey(absolute repo root)`.
  3. **`vtc engine --mcp`** (what host plugins run) is a stdio MCP bridge. It reads the discovery
     file; if no live daemon answers, it starts `vtc engine --daemon` detached and waits for the
     file; then it relays MCP to the daemon's local socket: `~/.vtc/run/<repo-key>.sock`
     (`engineSocketFile`; directory 0700, socket 0600) or the per-user pipe
     `\\.\pipe\vtc-<repo-key>` on Windows. Not `.vtc/state/`: a Unix socket path must fit
     `sun_path` (104 bytes on macOS, 108 on Linux) and repos can be arbitrarily deep; the daemon
     refuses to start when the path exceeds `UNIX_SOCKET_MAX_BYTES` (100). Any number of host
     sessions share one daemon. A second `vtc engine --daemon` for the same repo fails on the lock
     and exits.
  4. **Lifetime:** the daemon is not a child of any host session. It stays up while a run has
     work, a bridge is connected or an auto-resume is scheduled, and exits after
     `ENGINE_INSTANCE.idleExitMs` (30 min) otherwise. The auto-resume timer starts
     `vtc engine --daemon --wake` at the reset time (§6.9 step 4).
  5. The HTTP API (AD-5) is served by the daemon on `127.0.0.1:<port>`; the MCP socket is never
     exposed over HTTP, so a browser cannot reach a mutating tool. The cli control commands
     (`vtc pause`, `resume`, `status`) are MCP clients of the socket (`EngineClient`, AD-19).
- **Check:** `engine/test/instance.test.ts` (a second instance cannot take the lock or append; a
  writer that lost its lock stops appending; stale-lock takeover is reported; `seq` continues
  after a restart; the discovery file's path, contents and mode); `engine-instance.test.ts` in
  shared (repo key, discovery schema has no token, the socket path stays 25 bytes under the VTC
  home at any repo depth). Sub-project 1 adds a two-process test of the bridge sharing one
  daemon.

### AD-13 Engine modules and the Gate Runner seam

- **Binds:** `packages/engine/src/{daemon,core,gates,git,http,mcp,storage}`, `GateRunner` in
  `@vtc/shared`.
- **Prevents:** the engine-core and gate-runner teams editing the same files and state; untyped
  gate output; split ownership of the write-scope check and of git code.
- **Rule:**
  1. `core/` (engine-core team, sub-project 1) owns state, events, scheduling, loops, budgets,
     triage, escalation, merge queue and tracing. It calls the Gate Runner only through the
     `GateRunner` interface (`run`, `checkWriteScope`), injected at wiring time, and never imports
     `gates/`.
  2. `gates/` (gate-runner team, sub-project 2) implements `GateRunner`: calibration, baseline,
     layers L0–L5, hidden tests, the pinned scanner store, and the **L5 write-scope and
     test-integrity check**. It returns `GateReport` / `WriteScopeReport`, classifies every
     failure (`FailureClass`), and never imports `core/`, `http/` or `mcp/`.
  3. Write-scope ownership: the gate-runner team **implements** the check; engine core
     **invokes** it on every `submit` (§4.2 step 3, §6.3 step 4) and the Gate Runner runs it again
     as layer L5 (§19 sub-project 2). One implementation, two call sites.
  4. `git/` (engine-core team) owns worktrees, branches, clean verification checkouts, diffs and
     merges. It is a leaf: it imports no other engine module. `gates/` uses it through its index.
  5. `http/` and `mcp/` are transports: they call `core/` through its index; `core/`, `gates/` and
     `git/` never import them.
  6. Engine modules import each other only through the other module's `index.ts`; only the engine
     entry loads storage drivers (AD-2). The `gate.result` event carries one `GateReport`.
  7. `daemon/` (engine-core team) composes core, git, http and mcp into `runDaemon` and
     `serveSnapshot` (AD-19). It gets the Gate Runner through `EngineDeps`, never by importing
     `gates/`, and no module imports `daemon/`; the engine entry re-exports it.
  8. **Gate guards and hidden tests.** Two core guards need real test runs, so they go through
     `GateRunner.run` too: `base_fail_check` (QA's new tests, named in `tests`, must fail on the
     base commit; `expect: "fail"`) and `fault_repro` (an `out_of_scope_fault` must reproduce on
     base plus contracts without the task's diff). `gateExpectationMet` reads the report. Hidden
     acceptance tests (`HIDDEN_TESTS`): QA author mode writes artifact type
     `hidden_acceptance_test` to `.vtc/state/hidden-staging/<task>/`; the engine moves them to
     `~/.vtc/hidden/<repo-key>/<task>/`; the Gate Runner copies them in only for a run with
     `include_hidden` and never writes them to evidence.
- **Check:** dependency-cruiser `AD13-engine-modules-use-each-others-entry`,
  `AD13-core-uses-the-gate-runner-interface`, `AD13-gates-never-import-engine-core`,
  `AD13-git-imports-no-engine-module`, `AD13-core-does-not-import-transports`,
  `AD19-only-the-engine-entry-imports-the-daemon`, `AD2-storage-drivers-loaded-by-the-entry-only`
  (each proven by `tooling/arch-tests`, including a planted `daemon/` import of `gates/`);
  `gate-result.test.ts` (results, the deterministic `gateReportVerdict`, requests, write-scope
  reports); `policy.test.ts` (guard requests and `gateExpectationMet`).

### AD-14 Role sources, compiled agents and prompts

- **Binds:** `roles/`, `packages/compiler`, the engine's dispatcher, Lookback.
- **Prevents:** the compiler and the engine naming agents differently; Lookback and the compiler
  disagreeing on what is editable; mode-specific tools that cannot be compiled or enforced.
- **Rule:**
  1. One agent per role, or per **mode** when the role declares `modes` (QA `author`/`judge`,
     Security `design`/`verify`). Name: `agentNameFor(role, mode?)` = `vtc-<role>[-<mode>]`
     (hyphens only), the same base name on both hosts. A host that namespaces plugin agents adds
     its namespace inside its adapter.
  2. A mode overrides the base contract field by field (`inputs`, `output`, `exits`, `tools`,
     `models`); `resolveRoleMode` gives the effective contract. A role with modes must be
     dispatched, and must submit results, with a declared mode (`RejectReason`
     `undeclared_mode`).
  3. `roles/<role>/prompt.md` starts with `<!-- vtc:locked -->` (the locked core, human-only,
     MAJOR) and has exactly one `<!-- vtc:editable -->` line, after which the editable section
     runs to the end of the file (MINOR). `splitRolePrompt` enforces it; the compiler rejects
     anything else.
  4. Lookback never writes `roles/`. Its proposals go to
     `.vtc/lookback/proposals/<role>/editable.md` (spec §5.2's `prompts/*/editable.md`, read
     relative to `.vtc/lookback/`); a human-approved proposal replaces the editable section of
     `roles/<role>/prompt.md`.
  5. **Task packs.** A role's input is one pack per dispatch, `.vtc/state/packs/<action_id>.md`
     (`TaskPack`, rendered by `renderTaskPack`). Prompts are written against its fixed headings
     (`TASK_PACK_SECTIONS`) and name inputs by artifact type (`PACK_INPUT_TYPES` and the role's
     declared inputs), never by path.
  6. Role contracts declare what a role may return: exits, verdict values (`output.verdicts`;
     declaring any means a `done` result carries at least one) and output artifact types (the
     Planner declares `tasks`). The Spec-Verifier is dispatched once per AC with that AC as the
     `subject`; Visual QA declares the criteria it judges.
- **Check:** `traceability.test.ts` in shared (`agentNameFor`, `splitRolePrompt` incl. malformed
  prompts); `role.test.ts` (modes, `resolveRoleMode`, `checkResultAgainstContract`);
  `pack-evidence.test.ts` (`TaskPack`, every section rendered in order); `golden-run.test.ts` (the
  recorded dispatch's pack validates at its path); `compiler.test.ts` (`checkRolePrompt` rejects
  a prompt without markers, `compiledAgentNames` per mode).

### AD-15 Teams, ownership and integration

- **Binds:** every path in the repo; the six build teams; the orchestrator.
- **Prevents:** guaranteed merge conflicts on shared files; two teams changing one contract in
  different ways; an unowned path; a team branch quietly editing another team's files; two
  teams' export names colliding in a shared entry file.
- **Rule:** each team owns the globs in **`tooling/ownership.json`** (the machine-readable source
  of this table) and changes nothing else; changes elsewhere go to the owner as a proposal.

  | Team (sub-project)               | Scope (spec §19)                                                                                                      | Owns (summary of `tooling/ownership.json`)                                                                                                                        |
  | -------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | Engine core (1)                  | State/events, scheduler, pipeline, loops, triage, escalation, budgets, merge queue L1–2, daemon, MCP + HTTP           | `packages/engine/**` except the entry, package and config files and `gates/`; `fixtures/golden-run/**` (the dashboard team reviews changes)                       |
  | Gate runner (2)                  | Calibration, baseline, L0–L5, write-scope check, hidden tests, scanner store, traceability, redaction rules           | `packages/engine/src/gates/**`, `packages/engine/test/gates/**`, `gates/**`, `packages/cli/src/commands/calibrate.ts`, `packages/shared/src/helpers/redaction.ts` |
  | Roles + compiler (3)             | Neutral role sources, plugin sources, compiler, Claude/Codex plugin output                                            | `roles/**`, `skills/**`, `plugins/**`, `packages/compiler/**`                                                                                                     |
  | Adapters + usage (3)             | `HostAdapter` for both hosts, stream parsers, sandbox profiles, usage sources (statusline parser, `codex app-server`) | `packages/adapters/**`                                                                                                                                            |
  | Dashboard (6)                    | Flow Studio                                                                                                           | `apps/dashboard/**`                                                                                                                                               |
  | Cli + binary (0 binary parts, 1) | `vtc` commands and wiring, stdio bridge, statusline shim, timer, assets, Bun build and storage wiring                 | `packages/cli/**` except `commands/calibrate.ts`; the Bun build config (sub-project 0/1)                                                                          |
  1. **Integrator.** One integrator (the architect role of the orchestration) owns
     `packages/shared/**` (incl. `CONTRACTS_VERSION`, `schemas/contracts.json` and the ledger;
     except `helpers/redaction.ts`), `docs/**`, `tooling/**`, the root config files
     (`.dependency-cruiser.cjs`, `eslint.config.js`, `tsconfig*.json`, `turbo.json`, `vitest*.ts`,
     `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.gitignore`, `.githooks/**`…) and
     the files two teams share inside the engine package: `packages/engine/src/index.ts`,
     `packages/engine/package.json`, `packages/engine/tsconfig*.json` and
     `packages/engine/vitest.config.ts`. Teams send contract changes as a proposal (the diff plus
     the reason); the integrator merges them through the change process (§6), one contract change
     at a time.
  2. **Dependencies and lockfile.** A team adds npm dependencies only in a `package.json` it owns
     (adapters, compiler, cli, dashboard). The engine package is shared by two teams, so
     engine-core and gate-runner send dependency additions to the integrator, who adds them to
     `packages/engine/package.json`. The integrator regenerates `pnpm-lock.yaml` on the
     integration branch. A team branch never resolves a lockfile conflict by hand.
  3. **Shared entry files are pre-split.** `packages/engine/src/index.ts` re-exports each module
     under its own namespace (`core`, `gates`, `git`, `http`, `mcp`) plus the explicit daemon entry
     points, so two teams' export names can never collide (no TS2308 at integration), and
     `packages/cli/src/commands/index.ts` has one import line per command file. Teams add code in
     their own files. Adding a new command file adds one line, owned by the cli+binary team.
  4. Ordering follows §19 for merging: engine core lands first on the integration branch;
     gate-runner, roles/compiler and adapters rebase on it; the dashboard builds against
     `fixtures/golden-run` and the frozen contracts from day one. (The parallel start before the
     spike is §5 reading 8.)

- **Check:** `tooling/arch-tests/test/ownership.test.ts`: every file in the repo (tracked or new)
  matches exactly one team in `tooling/ownership.json`, and the known shared files map to their
  owners. `pnpm verify:scope <team> --base <integration-branch>` fails when a branch changes a
  file its team does not own; the orchestrator runs it on every team branch next to the merge
  gate (AD-10 rule 6). The AD-1/AD-13/AD-19 dependency rules keep each team's code behind its
  entry; `engine.test.ts` asserts the namespaced entry.

### AD-16 Host plugin sources and distribution

- **Binds:** `plugins/`, `packages/compiler`, `HostAdapter.install`, the release pipeline
  (sub-project 0/1), spec §4.1 "Host plugins" and §4.4 "Getting it running".
- **Prevents:** the roles+compiler and adapters teams both authoring plugin content; a plugin
  whose MCP entry drifts from the engine bridge; the marketplace install path failing because
  `dist/` is not in git.
- **Rule:**
  1. Hand-written plugin sources live in `plugins/common/` (the Lead skill, i.e. the Lead's
     instructions, and the `/vtc …` command sources), `plugins/claude-code/` (plugin manifest,
     hooks, `.mcp.json`) and `plugins/codex/` (plugin manifest, hooks), owned by the roles+compiler
     team.
  2. The compiler merges them with the compiled roles and skills into `dist/claude-plugin` and
     `dist/codex-plugin` and into the binary's `AssetBundle` (`plugin:claude-code`,
     `plugin:codex`), and fails on any AD-9 marker in an emitted file (`checkPluginFiles`).
  3. Every plugin registers the engine as `engineMcpServer(host)` = `vtc engine --mcp --host
<host>`. The Codex installer writes the same entry.
  4. `HostAdapter.install` only places or registers what the compiler emitted (plus the Codex
     agent TOML the compiler produced, and the statusline shim wiring); it authors nothing.
  5. **Marketplace.** The release job publishes the generated plugins (never hand-edited) with
     the marketplace manifest to a release branch of the product repo, so
     `/plugin marketplace add <org>/vtc` resolves without committing `dist/` to the main branch.
     The exact source form is provisional (§7) until sub-project 0 tries it on a real account.
- **Check:** `compiler.test.ts` (the hand-written `.mcp.json` equals `engineMcpServer`;
  `checkPluginFiles` reports planted markers with file and line);
  `tooling/arch-tests/test/supply-chain.test.ts` (no AD-9 marker under `roles/`, `skills/`,
  `plugins/`). Sub-project 3 adds a compile test that the emitted plugin contains the MCP entry and
  exactly one agent per `compiledAgentNames`, with `checkPluginFiles` clean.

### AD-17 Dispatch mode: plugin-only by default

- **Binds:** `ProjectConfig.hosts.dispatch`, the engine's scheduler and auto-resume, the adapters'
  `spawnRole`, cross-family review.
- **Prevents:** shipping headless spawning before the vendor confirmation §12.5 requires; the
  engine and adapters each guessing what happens without headless runs.
- **Rule:**
  1. `hosts.dispatch` is `plugin_only` (default) or `headless_allowed`. `planDispatch(purpose,
mode, capabilities)` is the only decision: in `plugin_only` the engine never starts a
     `HeadlessRun`.
  2. Plugin-only behaviour: roles run as Lead-dispatched subagents (foreground on Codex);
     auto-resume after a limit becomes `lead_redispatch`: the step stays `interrupted`, `next`
     returns `wait` until the reset, then a `spawn_role` that resumes the same session (Claude
     Code's own auto-continue keeps an interactive session alive); cross-family review is
     unavailable and skipped.
  3. `headless_allowed` (a user opt-in now; the default may change once confirmation exists)
     adds engine-launched runs for auto-resume, cross-family review and hosts without subagents.
- **Check:** `config.test.ts` (default `plugin_only`); `policy.test.ts` (`planDispatch` never
  returns `headless` in plugin-only mode, for every purpose and capability). Sub-project 1 adds an
  engine unit test that no `HeadlessRun` is started when the mode is `plugin_only`.

### AD-18 Evidence, traceability and redaction

- **Binds:** every writer of git-tracked `.vtc/` content (event log, evidence, reports, plan
  files, evidence bundles); `packages/shared/src/helpers/redaction.ts`; the Gate Runner's
  traceability builder; Final Review and release.
- **Prevents:** secrets committed to git through evidence or the event log (§7.2); two teams each
  building, or each assuming the other built, the redaction filter; the Gate Runner, Final Review
  and the dashboard each inventing the evidence shapes.
- **Rule:**
  1. One pure filter, `redactSecrets(text, knownValues)` / `redactJson` (known token formats,
     private keys, bearer tokens, URL credentials, and known values such as `.env` values from
     `dotenvValues`), owned by the gate-runner team (`tooling/ownership.json`). Every writer of
     git-tracked `.vtc/` content calls it; raw output stays only in `.vtc/state/`.
  2. The event log's append path redacts `data` (AD-7 rule 12).
  3. Traceability is built by code (§7.4) as a `TraceabilityReport` (rows of REQ/AC → tests with
     status, hidden flag and provenance; gaps; scope-creep files) at
     `.vtc/evidence/<T-n|F-n>/traceability.json`, by the Gate Runner.
  4. The evidence bundle (§6.7a, §14) is an `EvidenceBundle` (task or feature) at
     `evidenceBundlePath(id)`, written by engine core and placed in the PR description;
     `TaskDetail.evidence_bundle` points at it and the dashboard reads it through the artifacts
     route.
- **Check:** `policy.test.ts` (each planted token format, URL credentials, private key, `.env`
  values, and hashes left alone); `engine/test/instance.test.ts` (a planted token and a `.env`
  value never reach the log file); `pack-evidence.test.ts` (report and bundle contracts). The
  gate-runner and engine-core teams add a writer test per evidence writer.

### AD-19 Engine composition seam

- **Binds:** `@vtc/shared` `interfaces/engine.ts` and `interfaces/gate-runner.ts`,
  `packages/engine/src/daemon/`, `packages/engine/src/gates/index.ts` (`createGateRunner`),
  `packages/cli` (`wiring.ts`, `commands/*`).
- **Prevents:** three teams (cli, engine core, gate runner) each inventing how the daemon is
  built, how commands run, and how `vtc pause/resume/status` reach the daemon.
- **Rule:**
  1. The engine-core team implements `runDaemon(deps: EngineDeps, options)` and
     `serveSnapshot(deps)` in `daemon/`; the gate-runner team implements
     `createGateRunner(deps)` in `gates/`. Types are frozen in `@vtc/shared` (`RunDaemon`,
     `ServeSnapshot`, `CreateGateRunner`, `EngineDeps`, `SnapshotDeps`, `RunningDaemon`).
  2. The cli builds `EngineDeps` (`composeEngineDeps`: storage driver for the runtime, Gate
     Runner, adapters, asset bundle, timer, versions) and is the only caller.
  3. Commands are `CommandSpec { name, summary, run(args, ctx): Promise<number> }`; `main` is
     async. `CommandContext` carries io, cwd, the VTC home and a lazy `engine()` client.
  4. **Transport.** `vtc pause`, `resume` and `status` are MCP clients of the daemon's local socket
     (`EngineClient`, typed per tool from `ENGINE_MCP_TOOLS`), the same transport as the stdio
     bridge. The HTTP API stays read-only.
  5. `vtc engine` is one cli command (cli+binary team): `--daemon` calls `runDaemon` (the daemon
     logic lives in the engine package, engine-core team), `--mcp --host <host>` runs the bridge.
- **Check:** `cli.test.ts` (type-level: `composeEngineDeps` returns exactly what `runDaemon`
  takes; `ctx.engine()` resolves to `EngineClient` with per-tool types; the client is opened
  lazily, once); `engine.test.ts` (the engine's exports have exactly the frozen types);
  dependency-cruiser `AD19-only-the-engine-entry-imports-the-daemon` and the extended
  `AD13-core-uses-the-gate-runner-interface`.

---

## 4. Explicitly out of scope for v1

From the spec (§1.2, §20) and applied to VTC's own code. Any of these needs a change request.

- A hosted or cloud service, multi-tenant SaaS, a VTC-run server, a LAN view of the dashboard.
- Our own AI chat UI; a visual flow **editor** (the dashboard is read-only apart from
  design-review pins, AD-5 rule 5).
- Running in Claude Code web/cloud sessions, or under WSL.
- Native mobile and canvas/WebGL visual QA.
- Figma or Penpot as the source of truth (optional mirror only).
- Model providers other than Anthropic via Claude Code and OpenAI via Codex; VTC calling model
  APIs directly or handling API keys.
- Laya / Jev typed-decision models (Laya is a v2 option, §20.1).
- GEPA-style prompt optimisation (v2); mutation testing (v1.1).
- A shared theme/UI package between Flow Studio and `bs-job-agents` (copy in v1); a desktop
  wrapper for the dashboard.
- A web framework or ORM in the engine (`node:http` and the `Storage` interface are enough);
  any database other than embedded SQLite.
- Auto-updating scanners or dependencies.
- Bundling CodeQL, Semgrep-maintained rules, or GPL/AGPL tools.

## 5. Spec readings recorded here

Points where the spec is silent or ambiguous, and the reading this spine uses. Each needs human
confirmation before it is written back into the spec.

1. **Write-scope check ownership** (§4.2 step 3 vs §19 sub-project 2): one implementation in
   the Gate Runner, invoked by engine core on submit and by the Gate Runner as L5 (AD-13 rule 3).
2. **Lookback's editable-section proposals** (§5.2 `prompts/*/editable.md` vs §5.1/§4.4
   `roles/<role>/prompt.md`): proposals in `.vtc/lookback/proposals/<role>/editable.md`, applied
   to the editable section of `roles/<role>/prompt.md` after approval (AD-14 rule 4).
3. **Engine lifetime** (§4.4 "the plugin's MCP entry runs `vtc engine --mcp`" and §6.9 "only the
   engine" must be alive): a per-repo daemon plus a stdio bridge (AD-12).
4. **Headless dispatch** (§4.2 step 2 "otherwise they run headless"): headless runs are always
   engine-launched; the Lead sees `wait` (AD-4 rule 4), consistent with §6.9 and §12.4.
5. **Scanner pins** (§4.3 `gates.yml` vs §4.4 `gates/` + pinned store): product data in
   `gates/scanners.json` with per-platform checksums; `.vtc/gates.yml` holds only the project's
   calibrated gates and baseline.
6. **The statusline shim** (§6.9 "the plugin installs a statusline tee shim"): the shim is
   `vtc statusline-tee`; the Claude adapter's `install` wires it into the user's statusline.
7. **The `out_of_scope` finding route** (§16 lists six routes): a seventh route for guarded
   `out_of_scope_fault` exits (AD-3 rule 7).
8. **Parallel start before the spike** (§19: sub-project 1 depends on 0; "recommended first build
   after the spike"): sub-projects 1, 2, 3 and 6 start in parallel with sub-project 0. The
   contracts that depend on host behaviour are provisional (§7) until their spike check passes;
   the human runs the account-dependent spike items in parallel.
9. **`non_converged`** (§6.4 lists it without saying when it applies): reserved, never set in v1.
   Stuck and cap park the task (`parked`, reason `cap`/`stuck`), as §6.3 step 9 says.
10. **Rule 9 versus the round cap** (§7.6 rule 9 "a high/critical finding still open after 1
    round" and D6's 3–5 rounds): only security-class categories normalise to `high`; a
    correctness finding is `medium`, so ordinary bugs use the fix loop and rule 9 parks on
    security problems (AD-8 rule 7).
11. **When triage routes `defer`** (§6.3 step 8 lists the route without a trigger): findings that
    normalise to `info`. Routing otherwise follows the reviewer's `kind` (AD-8 rule 6).
12. **Plugin-only by default** (§12.5): `hosts.dispatch` defaults to `plugin_only`, with the
    behaviour in AD-17, until the vendor confirmation exists.
13. **Verdict shape** (§16 lists a scalar `verdict`): `RoleResult.verdicts` is a list, one per
    subject, each with evidence, because the Spec-Verifier judges one AC per call and Visual QA
    judges V1–V8 per call (AD-8 rule 2).

## 6. Change process for this spine

- Changing an AD, adding one, or changing a frozen contract (AD-3) needs an architecture review
  before merge, by the integrator (AD-15). The Check of each AD must stay automated and blocking.
- Boundary changes update `.dependency-cruiser.cjs` in the same change, with the rule name
  prefixed by the AD it enforces, and add a planted violation to `tooling/arch-tests`.

## 7. Provisional contracts (unfrozen by the spike)

These contracts rest on host behaviour that sub-project 0 verifies on real Claude and ChatGPT
accounts. Teams build against them as written; if a spike check fails, the integrator changes the
contract through §6 and every consumer updates in the same change.

| Contract                                                                                                          | Spike check that unfreezes it                                                                                             | Needs a human account |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| Structured-output form (`jsonSchemaFor(..., { target: "structured-output" })`, AD-3 rule 8)                       | `claude -p --json-schema` and `codex exec --output-schema` accept it and return a `RoleResult` that re-validates          | yes                   |
| `HostOutcome` limit/auth signals, `ParsedStream.usage` / `retry` (AD-6)                                           | recorded `claude -p` and `codex exec` streams with a real limit hit, an auth error and SDK `rate_limit_event`/`api_retry` | yes                   |
| `StatuslineIngest` field names (`rate_limits.five_hour` / `seven_day`, `used_percentage`, `resets_at`)            | the statusline payload of a signed-in Claude Code session                                                                 | yes                   |
| Codex `UsageWindow` labels from `windowDurationMins` (`codex app-server` `account/rateLimits/read`)               | a real `account/rateLimits/read` and `updated` notification                                                               | yes                   |
| `HostCapabilities` of both hosts, incl. Codex `sandbox_mode` inheritance for spawned agents (§12.1)               | Codex agent spawning with per-agent `sandbox_mode`; Claude plugin agents and `sandbox.filesystem.denyWrite`               | yes                   |
| `resume` after a long gap (`SessionRef`, AD-6)                                                                    | `--resume` / `exec resume` work after hours                                                                               | yes                   |
| Marketplace publishing (AD-16 rule 5)                                                                             | `/plugin marketplace add` from a release branch installs the generated plugin                                             | yes                   |
| `Storage` contract on `bun:sqlite`, the `AssetBundle` from Bun-embedded files, the MCP stdio bridge (AD-2, AD-12) | the storage contract suite passes under `bun build --compile`; the binary serves the static export and MCP over stdio     | no                    |

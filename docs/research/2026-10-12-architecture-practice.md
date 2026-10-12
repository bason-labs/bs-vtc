# Architect role: research-backed architecture practice (2026-10-12)

**Scope.** How the Architect agent should research best practice and propose an architecture: once per project, and again for each task that has architectural impact. This builds on the round-2 BMAD "spine" (AD-n decisions, each with **Binds / Prevents / Rule**) in `2026-10-12-round2-deep-dives.md` §2 and on the Architect row in `2026-10-12-role-benchmark.md`.

**Legend.** **[V]** means I fetched the source today. **[U]** means it is unverified: taken from search snippets, third-party pages, or my prior knowledge. None of the licence notes are legal advice.

---

## 1. Knowledge sources and how to package them

**Principle.** Do not paste frameworks into context. Ship one `architect` skill made of:
- a short `SKILL.md` that is always loaded (about 2k tokens: the method, gates, and an index);
- about 10 reference files of 1–3k tokens each, loaded on demand. Typical use is 3 or fewer per run.

Each reference file should be a **distilled checklist written in our own words**. Each item carries a stable ID and a link to the source, so the agent can fetch the full page live only when it needs to. Ideas and checklists can be paraphrased freely. Verbatim excerpts are bundled only where the licence allows it.

| Source | Use in the skill | Licence / can we bundle excerpts? |
|---|---|---|
| AWS Well-Architected (6 pillars, revision of 2024-11-06) | Merge into `pillars-checklist.md` | No licence grant found on the docs; treat as all-rights-reserved. **Paraphrase and link only** [V page, U licence]. (WA *Labs* docs are CC BY-SA 4.0 [U].) |
| Azure WAF (5 pillars) + Azure Architecture Center cloud design patterns | `pillars-checklist.md`; `patterns-index.md` | architecture-center repo: **CC BY 4.0 for docs, MIT for code**. Bundling with attribution is OK [V]. WAF repo is assumed to be the same [U]. |
| Google Cloud Well-Architected (6 pillars + AI/ML and FS perspectives) | `pillars-checklist.md` | **CC BY 4.0**, code under Apache-2.0 [V]. |
| ISO/IEC 25010:2023 (9 characteristics, now including Safety; Usability renamed Interaction capability; Portability renamed Flexibility, with Scalability under it) | `qa-catalog.md`: characteristic names plus our own one-line definitions | Paywalled ISO text. **Names and paraphrase only** [U, from [arc42 quality](https://quality.arc42.org/articles/iso-25010-update-2023)]. |
| 12-factor | `factors.md` | [heroku/12factor](https://github.com/heroku/12factor) is **MIT**, so it can be bundled [V]. "15-factor" comes from Hoffman's *Beyond the Twelve-Factor App* (O'Reilly); paraphrase the 3 extra factors (API-first, telemetry, auth) only [U]. |
| C4 model | `c4-arc42-skeleton.md` (levels 1–2 plus deployment) | [c4model.com](https://c4model.com/) is **CC BY 4.0** [V]. |
| arc42 | Same file: section skeleton only | **CC BY-SA 4.0**. It can be bundled with attribution, but **adaptations must stay CC BY-SA**, so keep it in a separate file with a notice. Content users write into the template is not affected ([arc42.org/license](https://arc42.org/license/)) [V]. |
| ADR (Nygard) / MADR 4.0.0 | `adr-template.md` | MADR is **MIT OR CC0-1.0**, the freest option, so bundle it ([adr.github.io/madr](https://adr.github.io/madr/)) [V]. |
| Thoughtworks Technology Radar (latest is Vol. 34, April 2026) | A *signal* in the research step ("Hold" ring = red flag). Never bundled. | No reuse terms stated, so **link only** ([thoughtworks.com/radar](https://www.thoughtworks.com/radar)) [V]. |
| System-design references | `patterns-index.md` covers caching, sharding, queues, consistency, and so on | [system-design-primer](https://github.com/donnemartin/system-design-primer) is **CC BY 4.0**, so it can be bundled [V]. *DDIA* (O'Reilly) and ByteByteGo are copyrighted: **concepts only** [U]. |
| microservices.io patterns | Pattern names and links in `patterns-index.md` | "© Chris Richardson, All rights reserved", so **link and paraphrase only** [V via search]. |
| DDD strategic design / Event Storming | `ddd-strategic.md`: bounded contexts, context-map relationships, a light Bounded Context Canvas | ddd-crew canvases: licence unverified [U]. Concepts are free; paraphrase. |
| OWASP ASVS 5.0 (about 350 requirements in 17 chapters [U]) and threat modelling (STRIDE, the Threat Modeling Manifesto) | `security-nfr.md`: map NFRs to ASVS chapter/requirement IDs. Fetch the official ASVS CSV/JSON at runtime instead of bundling it. | ASVS is **CC BY-SA 4.0** ([repo README](https://raw.githubusercontent.com/OWASP/ASVS/master/README.md)) [V]. ID references are fine; bundled excerpts must keep CC BY-SA. |
| SRE / SLO practice | `slo.md`: SLI menu, SLO/error-budget template | Google SRE book is **CC BY-NC-ND 4.0** ([sre.google](https://sre.google/sre-book/table-of-contents/)) [V]. NC + ND means **no bundled excerpts or adaptations in a commercial product**. Write our own text and link out. |
| Evolutionary architecture / fitness functions (Ford, Parsons, Kua; Thoughtworks) | `fitness-functions.md`: a rule-type → tool cookbook (§6) | Book is copyrighted; concepts only [U]. |
| "Boring technology" (McKinley) and MonolithFirst (Fowler) | `defaults.md`: house default stacks per archetype plus the "innovation token" budget | Link only; the defaults are our own content ([mcfunley.com](https://mcfunley.com/choose-boring-technology)) [V]. |

**Packaging rules:**
- **CC BY / MIT / CC0:** bundle excerpts with an attribution header.
- **CC BY-SA:** keep in separate files under the same licence (a `THIRD_PARTY/` folder with notices). Never merge these into proprietary prompt files.
- **All-rights-reserved or NC-ND:** our own paraphrase plus a URL.
- `defaults.md` is the one file teams and agencies should customise. Its layered TOML holds their approved stack, cloud, and banned technologies, and it is the strongest defence against "trendy stack" drift.

## 2. Process: lightweight but rigorous

1. **Quality-attribute scenarios (QAS) from NFRs.** Convert each BA NFR-n into the 6-part SEI form: *source, stimulus, artifact, environment, response, response measure*. Example: "1k concurrent users at peak (env) submit orders (stimulus) → p95 < 300 ms, 0 lost orders." An NFR with no measure is sent back to the BA as `[ASSUMPTION]` and is not invented.
2. **Utility tree.** Tag each scenario with importance (H/M/L) and difficulty (H/M/L). The **(H,H) scenarios are the architecture drivers**; cap them at 3–7. Add the **constraints**: cloud, language, budget, compliance, deadline, team skills (from `defaults.md` and the brief). Constraints are pass/fail filters, not weights.
3. **Candidates.** Always produce:
   - **A, the boring baseline:** a modular monolith, one relational DB, the house stack.
   - **B:** the smallest change to A that better serves the top driver.
   - **C:** only if a driver plausibly demands it (for example, independent scaling or regulatory isolation).

   Microservices must justify themselves against MonolithFirst ([Fowler](https://martinfowler.com/bliki/MonolithFirst.html)) [U]. Each candidate is a C4 level-1/2 sketch with its tech pins and a list of the **innovation tokens** it spends (budget: 0–1 per project by default).
4. **ATAM-lite.** For each driver scenario × candidate, record:
   - sensitivity points (which decision drives the response);
   - trade-off points (one decision affecting two quality attributes);
   - risks and non-risks.
5. **Weighted matrix.**
   - Weights come from the utility tree: H = 3, M = 2, L = 1.
   - Criteria are the driver QAs plus **team-skill fit, 12-month cost (with sourced pricing), ops burden, reversibility, and tokens spent**.
   - Scores run 1–5, and every cell carries a one-line justification tied to a scenario.
   - Run a **robustness check**: does the winner change if any single weight moves ±1? If yes, flag the decision as "close" for the human.
6. **Depth tiers, set by the engine from deterministic signals:**

| Tier | Trigger (any) | Output |
|---|---|---|
| S | Prototype or internal tool, no PII or money, 1 team | ≤5 ADs; candidate A plus a "why not B" paragraph; no matrix |
| M | Default | 2 candidates, matrix, top-3 QAS, STRIDE-lite on data flows |
| L | PII/payments/regulated, >2 external integrations, availability SLO ≥ 99.9%, multi-team, or brownfield >100k LOC | 3 candidates, full utility tree, ATAM-lite, threat model, cost model, optional spike |

## 3. Research step: live facts, not recall

The evidence (§7) shows that LLMs reach for popular libraries, hallucinate packages, and use deprecated APIs. Every version, licence, and CVE claim must therefore come from a **deterministic engine lookup**, not from the model. These are cheap scripts, not LLM tokens.

| Fact | Source | Notes |
|---|---|---|
| Runtime/framework support window | [endoflife.date API v1](https://endoflife.date/api/v1/products/nodejs) | Fields: `isLts, eolFrom, isMaintained, latest` [V] |
| Latest version, SPDX licence, advisories, OpenSSF Scorecard, deps | [deps.dev API v3](https://docs.deps.dev/api/v3/) | npm, PyPI, Maven, Go, Cargo, NuGet, RubyGems. Caching allowed; deps.dev-generated data is CC BY 4.0 [V] |
| Vulnerabilities for the exact pinned version | [OSV `/v1/querybatch`](https://google.github.io/osv.dev/api/) | "No limits on the API" [V] |
| Existence and maintenance | Registry lookup plus GitHub (archived flag, last release, commit cadence, open-issue trend) | Blocks slopsquatting |
| API usage at the pinned version | Official docs, or Context7 (`resolve-library-id` → docs query; version-specific IDs; ~3 calls per question) | [U, third-party descriptions] |
| Cloud pricing | Official pricing pages and price APIs (for example the Azure Retail Prices API, AWS Price List) | [U] |
| Trend / "Hold" signal | Tech Radar, project status pages | Advisory only |

**Rules:**
- Every tech decision gets a `facts.jsonl` row: `{claim, value, source_url, retrieved_at, tool}`.
- **No version without a row.** Pins are exact, with a lockfile in the plan.
- Anything unsourced is tagged `UNVERIFIED`, and **the gate blocks on it** unless a human waives it.
- Benchmarks must cite the methodology. Vendor benchmarks are marked as such.
- The model writes prose. The engine supplies numbers.

## 4. Brownfield: discover and respect the existing architecture

1. **Recovery, done deterministically by the engine:**
   - Manifest and lockfile scan gives the stack and versions.
   - Infra scan (compose, Terraform, k8s, CI) gives the containers and deployment.
   - Import graph (dependency-cruiser / madge, grimp/import-linter, `go list -deps`, jdeps) gives modules, cycles, and layering.
   - Collect existing ADRs (`docs/adr`, `doc/architecture/decisions`), CODEOWNERS, and existing lint rules.
2. **As-is spine.** The LLM summarises these artefacts into C4 level 1–2 (Structurizr DSL or Mermaid) and **inferred** AD-n entries with `status: inferred`, for example "AD-3 inferred: all DB access via `repo/` layer (0 violations in graph)". A human confirms or edits these once. Existing violations become a **baseline**: they are frozen, not failed.
3. **Evolution, not rewrite.** Changes are expressed as strangler-fig steps ([Fowler](https://martinfowler.com/bliki/StranglerFigApplication.html)) [U]. Each step is independently shippable, puts a seam or façade in front, and has a rollback. "Rewrite" is a forbidden candidate unless the human asks for it.
4. **Fit / extend / change triage for each task.** The engine flags task intents that:
   - add a dependency outside the pinned stack;
   - add a container, datastore, queue, or external host;
   - cross a boundary rule;
   - change a public contract (OpenAPI/proto diff);
   - carry an NFR keyword (latency, scale, residency, auth).

   No flags means the task **fits** the spine and skips the Architect. Otherwise the Architect classifies it as **extend** (a new AD consistent with the spine) or **change** (supersedes an AD and needs a human gate).

## 5. Per-task architecture

**A task needs a design note when it has any of:** a new service or container; a new datastore or schema ownership change; a new external integration or vendor; a cross-cutting concern (authn/z, tenancy, caching, observability, i18n); an explicit perf, scale, or availability target; a breaking or public interface change; a new trust boundary or data class (PII, payments); an irreversible migration.

A note becomes a **full ADR** when it supersedes or adds an AD, spends an innovation token, or is hard to reverse.

**Design note format (≤1 page, MADR-derived):**
```
# DN-<task-id>: <title>   status: proposed | accepted
Spine refs: AD-2, AD-5 (binds) · Requirements: FR-12, NFR-3
Context & driver scenario: <QAS, one line with measure>
Options: (1) fit within spine … (2) … — 1 line pros/cons each
Decision: … · Why not the others: …
New/changed rules → fitness checks: <rule> → <tool/check id>
Facts: <facts.jsonl ids> · Risks / rollback: …
```

## 6. Enforcement: turn each AD into a gate

Each AD gains a **`Check:`** block next to Binds / Prevents / Rule. Its `Prevents` clause is written so that a tool can falsify it.

| Rule type | Tool |
|---|---|
| Layering / forbidden imports / cycles (JS/TS) | dependency-cruiser; eslint-plugin-boundaries; Nx `enforce-module-boundaries` (tags) |
| Python | import-linter (`layers`, `forbidden`, `independence`; actively released, 2.12 in 2026-06 [U]); Tach (module boundaries and interfaces [U]) |
| JVM / .NET / Kotlin / PHP | ArchUnit; ArchUnitNET / NetArchTest; Konsist; Deptrac [U] |
| Go | go-arch-lint (YAML component rules [U]) |
| API style and compatibility | Spectral rulesets (naming, versioning, error format); oasdiff/buf breaking-change checks |
| Dependency policy | Allowlist from the pinned stack; OSV scan; SPDX licence allowlist |
| Performance budgets | k6 `thresholds` (p95, error rate); Lighthouse CI / size-limit bundle budgets |
| Infra / config | conftest/OPA, Checkov (for example "no public buckets", region residency) |
| Not machine-checkable | `Check: review` sends it to the verifier. LLM screening works for **code-inferable** decisions but is weak for deployment and organisational ones ([arXiv 2602.07609](https://arxiv.org/abs/2602.07609)) [V] |

The engine compiles the `Check:` blocks into tool configs and runs them in the Engineer ↔ verifier loop. Each check has a severity: `blocking` or `warn`. Waivers are human-only and expire, mirroring BMAD's TEA WAIVED rule.

## 7. Evidence: LLMs doing architecture (2024–2026)

- **Good at generating options and rationale; weaker than humans at deciding.** GPT-4 zero-shot ADR decisions were relevant but below human quality ([ICSA'24, 2403.01709](https://arxiv.org/abs/2403.01709)) [V]. Multi-agent prompting gave the best recall (71.5%) for design rationale, but 1.6–3.2% of arguments were misleading ([2504.20781](https://arxiv.org/abs/2504.20781v1)) [U, numbers from snippet]. An IEEE Software 2026 study found architects distrust LLM suggestions because of **missing context and inconsistency**; LLMs are best as option generators and sounding boards ([Drexel record](https://researchdiscovery.drexel.edu/esploro/outputs/journalArticle/LLMs-as-Assistants-in-Software-Architecture/991022164542204721)) [U]. LLM-assisted ADD satisfied the drivers but needed humans on the "most critical and nuanced" decisions (TSE 2026, "Better Together") [U].
- **Context engineering beats model size.** Using 3–5 prior ADRs as context gave the best quality/efficiency trade-off. Retrieval helped only for cross-cutting decisions (750 repos; [2604.03826](https://arxiv.org/abs/2604.03826)) [V]. This argues for feeding the spine plus the last few ADs on each task.
- **ATAM support works.** An LLM produced better risk, sensitivity, and trade-off analysis than students and cut effort ([2506.00150](https://arxiv.org/abs/2506.00150v1), [2603.28914](https://arxiv.org/abs/2603.28914)) [U].
- **Popularity and provider bias.** LLMs overuse popular libraries (up to 45–48% of cases) and default to Python (58% even for high-performance setups; Rust never chosen) ([2503.17181](https://arxiv.org/abs/2503.17181)) [U]. Seven LLMs systematically preferred Google/AWS services and sometimes rewrote code to use them unasked ([2501.07849](https://arxiv.org/abs/2501.07849v3)) [V]. This is the mechanism behind "trendy stack" and "ignored constraint" failures.
- **Stale and fabricated dependencies.** Deprecated-API usage is common; API-replacement and retrieval fixes help (ICSE'25, [2406.09834](https://arxiv.org/abs/2406.09834v3)) [U]. Package hallucination averaged 5.2% for commercial models and 21.7% for open models, and 43% of hallucinations repeat across runs ([2406.10279](https://arxiv.org/abs/2406.10279)) [U].
- **Practitioner-reported limits:** lengthy outputs, incorrect code, and dependence on project context ([2605.01392](https://arxiv.org/abs/2605.01392)) [V]. The SLR (18 papers) notes conformance checking and cloud-native design are understudied ([2505.16697](https://arxiv.org/abs/2505.16697)) [V].
- **No direct study found** on LLMs over-choosing microservices [U]. Treat it as a plausible risk, not a measured one.

**Mitigations designed into the product:**
- Constraints and `defaults.md` are injected first, with a mandatory boring baseline candidate.
- Innovation-token budget.
- Engine-sourced facts.
- Matrix cells must cite scenarios.
- The spine plus the last 3–5 ADs are passed as context.
- An independent reviewer lens checks the proposal against constraints only.
- The human makes the final call at the gate.

## 8. Recommended Architect workflow

| # | Step (actor) | Inputs | Outputs / artefacts |
|---|---|---|---|
| 0 | Tier + recon (engine) | Approved spec, repo | `tier`, `repo_map`, as-is graph, existing ADRs, `facts.jsonl` seeds |
| 1 | As-is spine (Architect, brownfield only) | Recon | `spine.md` with `inferred` ADs, C4 L1–2, violation baseline |
| 2 | Drivers (Architect) | NFRs, constraints, `defaults.md` | QAS list + utility tree; questions back to BA |
| 3 | Candidates (Architect, with Security and Designer in parallel) | Drivers, `patterns-index`, `pillars-checklist` | 1–3 candidate sketches with token spend |
| 4 | Research (engine runs lookups; Architect reads results) | Candidate pins | `facts.jsonl`, red flags (EOL, CVE, licence, archived, Radar Hold) |
| 5 | ATAM-lite + matrix (Architect) | 2–4 | `candidates.md` |
| 6 | Constraint audit (fresh-context reviewer, Sonnet) | `candidates.md`, constraints only | Pass/fail findings |
| 7 | **Human architecture gate** | — | Approve / choose other / edit |
| 8 | Compile (engine) | Accepted spine | Tool configs, CI gate, `fitness-report.json` baseline |
| 9 | Per task (engine triage → Architect only if flagged) | Task + spine + last 3–5 ADs | `fits` / DN-n / ADR (+ gate if it is a "change") |

**Spine template (`spine.md`):**
```
Archetype: modular monolith · Tier: M · Innovation tokens: 1/1 (AD-6)
Stack pins: node 24.x LTS [F12] · postgres 17 [F14] · … (all with fact ids)
Drivers: QAS-1 (perf, H/H) · QAS-2 (availability, H/M) …
AD-1 Modules by bounded context (orders, billing, catalog)
  Binds: FR-1..9 · QAS-3 | Prevents: cross-module DB table access
  Rule: modules talk via public index.ts only
  Check: dependency-cruiser no-cross-module-internal · blocking
  Status: accepted | Supersedes: — | Revisit if: >3 teams
Capability → component map · C4 L1/L2 (Mermaid) · Deferred decisions
```

**Candidate comparison (`candidates.md`):** drivers and constraints table → per-candidate sketch (C4 L2, pins, tokens spent, est. monthly cost with fact ids) → ATAM-lite table (scenario × candidate: response, sensitivity, trade-off, risk) → weighted matrix (criterion, weight, A/B/C scores with one-line reasons, totals) → robustness note ("winner stable under ±1 weight changes", or "close: depends on QAS-2 weight") → recommendation + "why not the others" + what would change the decision.

**Fitness output (`fitness-report.json` + summary):**
```
{"run":"…","checks":[{"id":"AD-1/no-cross-module","tool":"dependency-cruiser",
 "status":"fail","new_violations":2,"baseline":5,"files":["src/billing/…"],
 "severity":"blocking"},{"id":"QAS-1/p95","tool":"k6","status":"pass",
 "value":"212ms","budget":"300ms"}],"waivers":[…]}
```

**What the human sees at the gate (one screen):**
- Recommended candidate, with a C4 L2 diagram.
- The 3–7 drivers and how each is met.
- Matrix totals plus the robustness flag.
- Innovation tokens spent.
- Red flags from research.
- New or changed ADs, with Prevents and Check.
- Estimated cost and ops burden.
- Open assumptions.
- Actions: approve / pick B / edit AD / waive flag (with expiry).

**Reused per task:**
- `spine.md`, the last 3–5 ADs, `facts.jsonl` (refreshed when older than N days or on a version bump), the compiled checks, and the violation baseline.
- The Architect only re-runs steps 2–7, scaled down, when engine triage flags "extend/change".
- "Fits" tasks cost **zero Architect tokens**.

---
### Sources (fetched today unless marked [U] above)
AWS WAF https://docs.aws.amazon.com/wellarchitected/latest/framework/welcome.html · Azure WAF https://learn.microsoft.com/en-us/azure/well-architected/ · Azure AC licence https://github.com/MicrosoftDocs/architecture-center · GCP WAF https://docs.cloud.google.com/architecture/framework · C4 https://c4model.com/ · arc42 https://arc42.org/license/ · MADR https://adr.github.io/madr/ · 12factor https://github.com/heroku/12factor · system-design-primer https://github.com/donnemartin/system-design-primer · ASVS https://github.com/OWASP/ASVS · SRE book https://sre.google/sre-book/table-of-contents/ · Radar https://www.thoughtworks.com/radar · microservices.io https://microservices.io/about · McKinley https://mcfunley.com/choose-boring-technology · endoflife.date https://endoflife.date/api/v1/products/nodejs · deps.dev https://docs.deps.dev/api/v3/ · OSV https://google.github.io/osv.dev/api/ · import-linter https://import-linter.readthedocs.io/en/stable/release_notes/ · papers as linked in §7.

# Impeccable (impeccable.style) for the VTC Designer role

Date: 2026-10-13. Read-only research. Builds on round-2 deep dives §4.

## 1. What it is

- **Maker:** Paul Bakaus. The repo is `github.com/pbakaus/impeccable`, with about 80.4k stars and 4.8k forks. He made roughly 1,800 of the commits; the next human contributor made about 216.
- **License:** Apache-2.0 for the whole repo. `NOTICE.md` adds one MIT-derived part: `ios.md` and `android.md` come from ehmo's platform-design-skills.
- **Activity:** very active. Skill v4.5.2, CLI v4.5.2 and engine v0.1.14 were all released 2026-10-09. The last push was 2026-10-12, a "Telemetry v2" PR.
- **What ships:** "1 skill, 24 commands, live browser iteration, and 59 deterministic detector rules."
  - The skill is driven by `/impeccable <command>`. It has about 45 reference playbooks under `skill/reference/`.
  - Four subagents: asset-producer, documenter, finish-reviewer and manual-edit-applier.
  - A Rust engine binary that covers the detector, concept-seed, comp-spec, font-match and a decision page.
  - Also: a design hook that runs after UI edits, a Chrome extension, a VS Code extension and a CLI.
- **Install:**
  - Claude Code: `/plugin marketplace add pbakaus/impeccable`.
  - Codex: the Plugins tab, or `npx impeccable install --providers=codex`. Codex needs `/hooks` approval.
  - Vendoring: a git submodule plus `npx impeccable link`.
  - Then run `/impeccable init`, which writes PRODUCT.md, and `/impeccable hooks on`.
  - The skill has `<claude>` and `<codex>` blocks for model-specific tells.
- **README lineage:** "Anthropic's frontend-design … was the first widely-used design skill for Claude. Impeccable started from there."

## 2. Method

**Context files.**
- PRODUCT.md holds durable product truth.
- DESIGN.md follows Google's design.md spec: YAML token frontmatter plus eight canonical sections.
- `.impeccable/design.json` is a sidecar for ramps, shadows, motion and component snippets.
- Each surface brief carries a six-block **Direction contract**: THESIS, OWN-WORLD, STORY, FIRST VIEWPORT, FORM (with a seed reference) and FINISH.

**Modes.** Each surface gets one of four modes: Persuade, Operate, Read or Experience. The mode is chosen per surface, not per product. It sets how much expression is allowed.

**Commands.**

| Group | Commands |
|---|---|
| Build | `shape`, `init`, `document`, `extract` |
| Evaluate | `critique` (Nielsen 10 heuristics scored /40, a "Design Specificity Verdict", five personas, P0–P3), `audit` (a11y, performance, theming, responsive, implementation integrity) |
| Refine | `polish`, `bolder`, `quieter`, `distill`, `harden`, `onboard` |
| Enhance | `typeset`, `colorize`, `layout`, `animate`, `delight`, `overdrive` |
| Fix | `clarify`, `adapt`, `optimize` |
| Iterate | `live`, `generate` |

**How it creates distinct work.** `new-work.md` runs these steps:
1. Name the product's mechanism and the audience's scene. Write down the category's default page and its "predictable opposite", and treat both as "the rut".
2. List seven concrete visual systems from the audience's culture, spanning at least three "material families". On Operate surfaces, never take them from the tools the audience uses.
3. Run `impeccable concept-seed`: "the roll is what keeps every run from converging on the category default". The dice assign the direction and deal up to three catalog "challengers".
4. Judge each challenger on two axes, audience identification and product clarity. Each gets a verdict: wins, competitive or declined. A declined challenger still "donates" one discipline to the chosen direction.
5. The user picks on a decision page. It has re-roll in three registers (plain, safer, bolder), one "IMPECCABLE'S PICK" card and a quiet **standing exit**: the category standard, done straight.

**Guidance and bans.**
- **Colour:** choose a strategy before choosing colours: Restrained, Committed (30–60%), Full palette or Drenched. Use OKLCH. "Dark or light is never a default"; derive it from a one-sentence physical scene.
- **Type:** there is a reflex-font blocklist: Fraunces, Playfair, Space Grotesk, IBM Plex, DM Sans, Inter-as-display and others. Pick faces "like objects from the subject's world".
- **Layout:** state a "spatial thesis" before editing.
- **Craft floor:** body text 65–75ch, display type no larger than 6rem, contrast at least 4.5:1, and themed browser surfaces (selection, caret, scrollbars, focus).
- **Absolute bans:** eyebrow or kicker labels, gradient text, side-stripe borders and nested cards.

**Detector.** It has 59 rules: about 30 "slop" rules and about 29 "quality" rules. Examples:
- slop: `overused-font`, `ai-color-palette`, `cream-palette`, `icon-tile-stack`, `italic-serif-display`, `kicker-above-heading`, `dark-glow`, `em-dash-overuse`, `marketing-buzzword`;
- quality: `gray-on-color`, `line-length`, `text-overflow`, `content-hidden-at-rest`;
- **DESIGN.md drift:** `design-system-font`, `-color`, `-radius`, `-font-size`.

It runs with no LLM.

## 3. Fit with our stack

**Overlap.** Both skills share the calibration list of saturated AI looks: cream plus serif plus terracotta, near-black plus neon, broadsheet hairlines, and flat ink with hard shadows. Both put the brief first, use one orchestrated motion moment, and set a quality floor.

**What Impeccable adds:**
- a lint we can run (frontend-design is prose only);
- **enforced** variation through seeded rolls, where frontend-design only asks for self-review;
- per-surface modes;
- critique scoring;
- the Direction contract;
- design-system drift rules;
- a finish reviewer with a fresh context;
- bounded QA ("two rounds is the ceiling").

**Conflicts:**
1. **Who owns DESIGN.md.** Impeccable writes DESIGN.md in Google's design.md format, from the built page, at the end. Our pipeline generates it from DTCG `tokens.json` through Style Dictionary. One of the two must own it.
2. **Workflow ownership.** Impeccable runs its own pipeline: comp gates, a decision server and a reviewer subagent. That overlaps our Designer, our Visual QA and our human gate viewer.
3. **Network and telemetry.** `concept-seed` calls `impeccable.style/api/roll`. The world catalog is hosted, and only test fixtures are in the repo. It sends choice pings unless `IMPECCABLE_NO_TELEMETRY=1` is set, and the opt-out "do[es] not disable requests for catalog options". Offline, it falls back to a "degraded", text-only roll unless `IMPECCABLE_CATALOG_DIR` points at a local catalog. That is a problem for a local-first product.
4. **Reach.** Comp-led builds need image generation, for example with `OPENAI_API_KEY`. Operate and Read surfaces are always code-led, which is most VTC apps.

## 4. Mechanism: "same topic, different UI"

The core idea, which Impeccable shows works: **move the randomness out of the model and into code, then let a human choose.** Research shows LLMs collapse to a few modes, both within one model and across models (Artificial Hivemind, NeurIPS 2025). Asking a model to "be distinct" does not escape that.

**Proposed VTC flow:**
1. **Direction brief (Designer, before tokens).**
   - Write the rut: the category default and its opposite.
   - List seven grounded worlds across at least three material families.
   - Use Verbalized Sampling: have the model state probabilities and drop the most probable candidates. This gives 1.6–2.1x more diversity.
2. **Constraints lottery.** A seeded RNG, keyed to the project ID and stored in the contract, deals:
   - a colour strategy;
   - a type pairing from a curated pool that excludes the blocklist;
   - a density and grid model;
   - a radius and elevation language;
   - a motion grammar;
   - one signature interaction.
3. **Novelty scoring against a project library.**
   - Render each candidate's first viewport. A grayscale wireframe pass is enough.
   - Embed it with DreamSim or DINOv2 for perception, or UIClip for UI-specific quality and relevance.
   - Also embed the token vector: palette in OKLCH, type, radius and spacing.
   - Reject a candidate when its nearest neighbour in the library of past projects is within a threshold.
   - Report library diversity with the Vendi Score.
   - Use Screen2Vec if structural similarity matters too.
4. **Human gate.** Show 2–3 directions of equal visual weight in our gate viewer, plus the standing "category standard" exit and a re-roll with safer or bolder steering. Record the choice in the library so later projects avoid it.

## 5. Recommendation

- **Bundle a fork, not the plugin.** Apache-2.0 allows redistribution and modification. We must keep LICENSE and NOTICE.md (including the MIT credit for ehmo), mark changed files, and not use the "Impeccable" name as our brand.
  - **Vendor:** the detector rules, `craft-floor`, `new-work` steps 1–5, the Direction contract, the `critique` heuristics, and the typeset, colorize and layout playbooks.
  - **Rewrite:** concept-seed as a local, seeded roll over our own catalog, with no API and no telemetry. Pin and audit the engine binary if we ship it.
- **Designer:**
  - Run `shape` and new-work during the UX-flow step.
  - Run our concept-seed equivalent and the lottery before the two-pass token plan. Keep frontend-design as the base prompt.
  - Write the Direction contract into the Design Contract.
  - Run `polish` once before handoff.
  - DTCG remains the source of truth, and DESIGN.md stays generated from it. Disable Impeccable's documenter.
- **Visual QA:**
  - In the deterministic lint layer, run `impeccable detect --json` on the prototype and then on the implementation. Slop rules HOLD the Designer step; quality and design-system rules route to the Engineer.
  - Point the `design-system-*` rules at the generated DESIGN.md.
  - In the V1–V8 vision judge, add a "Design Specificity" criterion that asks whether this could be any app in the category.
  - Add a novelty check: report nearest-neighbour similarity against the project library.
  - Never let the vision model measure colours or spacing.

## Sources

- [impeccable.style](https://impeccable.style/), [GitHub: pbakaus/impeccable](https://github.com/pbakaus/impeccable), and these files in it: `skill/SKILL.src.md`, `skill/reference/new-work.md`, `craft-floor.md`, `critique.md`, `document.md`, `crates/live/assets/antipatterns.json`, `crates/context/src/concept_seed.rs`, `telemetry.rs`, `NOTICE.md`
- [Privacy policy](https://impeccable.style/privacy)
- [Anthropic frontend-design skill](https://github.com/anthropics/skills/tree/main/skills/frontend-design)
- [Artificial Hivemind, arXiv 2510.22954](https://arxiv.org/abs/2510.22954)
- [Verbalized Sampling, arXiv 2510.01171](https://arxiv.org/abs/2510.01171)
- [UIClip, UIST 2024](https://arxiv.org/abs/2404.12500v1)
- [DreamSim, NeurIPS 2023](https://arxiv.org/abs/2306.09344v3)
- [Vendi Score](https://arxiv.org/pdf/2210.02410)
- [Screen2Vec, CHI 2021](https://arxiv.org/abs/2101.11103)

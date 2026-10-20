# Plan 1: VTC's own faults from the owner's runs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the VTC-side faults that turned into questions for the owner in the bs-kara and
bs-job-agents runs, so a real run gets from the request to the design review without the owner
being asked about VTC's own machinery.

**Architecture:** Small, test-first fixes in the engine (`packages/engine/src/core`), one per fault,
each pinned by a test that uses the exact text from the logged runs. One additive contract change
(`role.rejected` gets an optional `session_ref`, contracts 5.15.0). No behaviour change for the
owner's flow beyond fewer rejections and fewer escalations. Ask-once, plain language, auto-merge and
several runs per project are Plans 2 to 5.

**Tech Stack:** TypeScript (Node 22.14+), pnpm 10 workspace, vitest 5, zod.

**Spec:** `docs/superpowers/specs/2026-10-20-ask-once-then-automate-design.md`, §2a (fault table
rows 1 to 10). Plan 1 implements §2a only.

## Global Constraints

- The engine decides; agents act (spine AD-8). No role gains write or network access it doesn't
  have today (design §2a, faults 5 and 6).
- Contract changes are additive only: `CONTRACTS_VERSION` 5.14.0 → **5.15.0** (spine AD-3).
- Every behaviour change gets a spine reading: readings **272** onward in
  `docs/architecture/vtc-spine.md` §5, in the format of readings 269 to 271.
- Test data is synthetic. Copy the *shape* of the logged text, but never the owner's project
  content (the style of `quick-fix-design.test.ts`).
- Commit messages are plain, with no Claude co-author or "Generated with" lines (owner's rule).
- Branch: `build/ask-once-then-automate`. `pnpm verify` must pass at the end.

## Status of the fault table on 2026-10-20

| # | Fault | Plan 1 task |
|---|-------|-------------|
| 1 | Security design pack has an empty write scope | Task 1 (fix already in working tree) |
| 2 | `null` fields in a Lead-submitted result rejected | Task 1 (fix already in working tree) |
| 3 | Role citing its own pack fails `claim_check` | Fixed in v0.2.4 (reading 270) for absolute and checkout-relative paths. Task 3 adds the `../../packs/a-n.md` form |
| 4 | Quick-fix DESIGN packs had no spec | Fixed in v0.2.4 (reading 269). Task 6 pins it |
| 5 | `design-craft` unavailable to headless Codex roles | Task 4 |
| 6 | Headless Codex BA "can't read files" | Task 6 pins it (the current compiled prompt allows read-only shell, and headless runs don't turn the shell off) |
| 7 | Format slips rejected over and over, each retry a fresh, full-price run | Task 5 (retries resume the rejected session) |
| 8 | `spec_ref` forms `spec.md#REQ-23`, `spec.md:39`, `spec.md` don't resolve | Task 3 |
| 9 | Planner "covers unknown REQ-4" although the spec has it | Task 2 (the spec parser misses `**REQ-4** (revised r2) …`) |
| 10 | `task T-14 does not match the dispatched undefined` | Task 6 pins it (the dispatch now says `task null … never take one from the repository`) |

## Review Focus

- **A spec with REQ ids only in AC lines** (`- REQ-7.AC-1: …`, with no REQ heading or line): the REQ
  must still count as defined. Pinned in Task 2.
- **A `spec_ref` naming an id the spec really lacks** (`spec.md#REQ-99`) must still fail. Leniency
  covers the form, not the id. Pinned in Task 3.
- **A `../` ref that escapes to some other file** (`../../../etc/passwd`, `../../packs/../x.md`)
  must not resolve. Only the role's own pack basename does. Pinned in Task 3.
- **A rejected run whose host gave no session** (plugin subagent with no id, or a crash before
  `thread.started`) must fall back to a fresh dispatch, never resume `undefined`. Pinned in Task 5.
- **The Engineer and QA author** have their changes discarded on rejection (`submit.ts`). Their
  resumed retry must still carry the "redo them within scope" note. Pinned in Task 5.

---

### Task 1: Land the in-progress fixes for faults 1 and 2

**Files:**
- Modify (already changed in the working tree): `packages/engine/src/core/dispatch.ts:964-968`,
  `packages/engine/src/mcp/server.ts:19-23,161-172`, `packages/shared/src/json-schema.ts:445`
- Test (already changed): `packages/engine/test/core/pack-inputs.test.ts`,
  `packages/engine/test/mcp/mcp.test.ts`
- Modify: `docs/architecture/vtc-spine.md` (reading 272)

**Interfaces:**
- Produces: `stripNulls(value: unknown): unknown`, exported from `@vtc/shared`
  (`json-schema.ts`). `null` members are dropped deeply.

- [ ] **Step 1: Review the diff against the fault.** Run `git diff -- packages/` and check two
  things. First, the security pack's write scope now comes from `effectiveContract(k, step)` (the
  mode's `write_paths`). Second, `submit` strips `null` from `args.result` only.
- [ ] **Step 2: Show the tests fail without the fix.** Run `git stash push packages/engine/src packages/shared/src`,
  then `pnpm --filter @vtc/engine exec vitest run test/core/pack-inputs.test.ts test/mcp/mcp.test.ts`.
  Expected: FAIL on `## Write scope\n\n- .vtc/architecture/threat-model/**` and on
  `received null`. Then run `git stash pop`.
- [ ] **Step 3: Run the tests with the fix.** Same command. Expected: 26 passed.
- [ ] **Step 4: Add reading 272** to spine §5: "**A mode's write scope and a null field** (§6.3
  step 1, AD-4)". It says the pack's write scope is the dispatched mode's (`effectiveContract`), and
  that `null` in a submitted `RoleResult` means absent, as for headless structured output.
- [ ] **Step 5: Commit.**

```bash
git add packages/engine/src/core/dispatch.ts packages/engine/src/mcp/server.ts packages/shared/src/json-schema.ts packages/engine/test/core/pack-inputs.test.ts packages/engine/test/mcp/mcp.test.ts docs/architecture/vtc-spine.md
git commit -m "Security design gets its threat-model write scope; a null result field means absent"
```

### Task 2: The spec parser finds every requirement (fault 9)

**Files:**
- Modify: `packages/engine/src/core/spec.ts:15-42`
- Test: `packages/engine/test/core/spec-parse.test.ts` (create)

**Interfaces:**
- Produces: `parseSpecItems(text: string): SpecItem[]` (same signature). It now also recognises:
  - a bold id followed by an annotation, then the text: `**REQ-4** (revised r2) If …` and
    `**REQ-21** (added r2) The system …`;
  - a REQ that appears only through its ACs (`REQ-7.AC-1` defines `REQ-7` when no line defines
    `REQ-7` itself). The text of such an implied REQ is its id.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";
import { parseSpecItems, specRequirementIds } from "../../src/core/spec.js";

const SPEC = [
  "**REQ-1** (revised r2) When a scan runs for a source with an API, the system shall use it.",
  "- REQ-1.AC-1: Given an API, When the scan runs, Then 0 browser calls are made.",
  "**REQ-2** The system shall record each scan.",
  "**REQ-4** (revised r2) If a source has no API, then the system shall use the browser.",
  "- REQ-4.AC-1: Given no API, When the scan runs, Then the browser is used.",
  "**REQ-21** (added r2) The system shall try access paths in a fixed order.",
  "- REQ-7.AC-1: Given X, When Y, Then Z.",
  "## REQ-30 Heading form",
].join("\n");

describe("parseSpecItems (fault 9: the owner's revised spec)", () => {
  it("finds bold ids with an annotation, plain bold ids, headings and AC-implied REQs", () => {
    expect(specRequirementIds(parseSpecItems(SPEC))).toEqual(
      ["REQ-1", "REQ-2", "REQ-4", "REQ-21", "REQ-7", "REQ-30"],
    );
  });
  it("keeps the requirement's text without the annotation", () => {
    const req4 = parseSpecItems(SPEC).find((i) => i.id === "REQ-4");
    expect(req4?.text).toBe("If a source has no API, then the system shall use the browser.");
  });
  it("does not invent ids from prose mentions", () => {
    const ids = specRequirementIds(parseSpecItems("This run only reads (REQ-1 to REQ-7, REQ-21 to REQ-25).\n**REQ-1** Read."));
    expect(ids).toEqual(["REQ-1"]);
  });
});
```

- [ ] **Step 2: Run the test to make sure it fails.**
  `pnpm --filter @vtc/engine exec vitest run test/core/spec-parse.test.ts`. Expected: FAIL. REQ-1,
  REQ-4, REQ-21 and REQ-7 are missing.
- [ ] **Step 3: Implement.** In `spec.ts`, let `ITEM` accept an optional parenthesised annotation
  after the id (`(?:\*\*)?\s*(?:\([^)]*\))?\s*[:.)-]?\s*(.+)`). Require either the bold markers or
  a separator, so a prose line starting `REQ-1 to REQ-7` doesn't match. Then, after the loop, add
  every `REQ-n`/`SEC-n` prefix of an AC id that isn't already in `items`, positioned before its
  first AC.
- [ ] **Step 4: Run the test, then the existing spec tests.** Run
  `pnpm --filter @vtc/engine exec vitest run test/core/spec-parse.test.ts test/core/policies.test.ts`.
  Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Spec parser finds annotated bold requirements and REQs named only by their ACs"`

### Task 3: Evidence forms roles naturally write (faults 3 and 8)

**Files:**
- Modify: `packages/engine/src/core/evidence.ts:42-52,98-99`
- Test: `packages/engine/test/core/evidence-forms.test.ts` (create)

**Interfaces:**
- Consumes: `EvidenceContext` (with `packRoot`, `specIds`) and `resolves(ctx, evidence)`.
- Produces: same signatures. New behaviour:
  - `spec_ref` with ref `<path>#<ID>` resolves when `<ID>` is in `specIds`. The path part is
    ignored.
  - `spec_ref` with ref `<path>:<line>` or a bare `<path>` resolves when the path is a `.vtc/spec/`
    file that exists (and, with a line, has that many lines).
  - `file` / `file_line` with a ref ending `packs/a-<n>.md` (with any `../` prefix) resolves only
    against `${packRoot}/.vtc/state/packs/a-<n>.md`. No other `..` ref resolves.

- [ ] **Step 1: Write the failing test.** Build a temporary repo with `writeFile` from
  `../helpers/repo.js`: `.vtc/spec/spec.md` with 40 lines, and `.vtc/state/packs/a-14.md` with
  40 lines. Set `ctx = { repoRoot, packRoot: repoRoot, head: null, specIds: ["REQ-23", "REQ-23.AC-1"], git: { readFileAtCommit: async () => undefined }, commitExists: async () => false }`.
  Then assert:

```ts
expect(await resolves(ctx, { type: "spec_ref", ref: ".vtc/spec/spec.md#REQ-23" })).toBe(true);
expect(await resolves(ctx, { type: "spec_ref", ref: "REQ-23" })).toBe(true);
expect(await resolves(ctx, { type: "spec_ref", ref: ".vtc/spec/spec.md:39" })).toBe(true);
expect(await resolves(ctx, { type: "spec_ref", ref: ".vtc/spec/spec.md" })).toBe(true);
expect(await resolves(ctx, { type: "spec_ref", ref: ".vtc/spec/spec.md#REQ-99" })).toBe(false);
expect(await resolves(ctx, { type: "spec_ref", ref: ".vtc/spec/spec.md:41" })).toBe(false);
expect(await resolves(ctx, { type: "file", ref: "../../packs/a-14.md" })).toBe(true);
expect(await resolves(ctx, { type: "file_line", ref: "../../packs/a-14.md:39" })).toBe(true);
expect(await resolves(ctx, { type: "file", ref: "../../packs/../x.md" })).toBe(false);
expect(await resolves(ctx, { type: "file", ref: "../../../etc/passwd" })).toBe(false);
```

- [ ] **Step 2: Run it to make sure it fails.**
  `pnpm --filter @vtc/engine exec vitest run test/core/evidence-forms.test.ts`. Expected: FAIL on
  the first `spec_ref` assertion and on the two `../../packs` assertions.
- [ ] **Step 3: Implement.** In `packText`, map a ref matching `/^(?:\.\.\/)+packs\/(a-\d+\.md)$/`
  (after stripping a `:line` suffix in the caller) to `${PACKS_DIR}$1`. In the `spec_ref` case,
  split on the first `#`. If there's an id part, check it against `specIds`. Otherwise treat the ref
  as a `file`/`file_line` under `.vtc/spec/`. When `specIds` is empty, keep today's "not checked"
  behaviour.
- [ ] **Step 4: Run the test and the quick-fix pack-citation test.** Run
  `pnpm --filter @vtc/engine exec vitest run test/core/evidence-forms.test.ts test/core/quick-fix-design.test.ts`.
  Expected: PASS.
- [ ] **Step 5: Add reading 273** ("**Evidence in the forms roles write**") and commit:
  `git commit -m "Claim check accepts spec refs by path and anchor, and a role's own pack by a relative path"`

### Task 4: Headless roles get the method skills their prompt names (fault 5)

**Files:**
- Modify: `packages/engine/src/core/plugins.ts`, adding
  `methodSkills(host: HostId, prompt: string): { name: string; files: { path: string; text: string }[] }[]`
  to `PluginCatalog`
- Modify: `packages/engine/src/core/dispatch.ts:1463-1474` (the headless dispatch prompt)
- Test: `packages/engine/test/core/headless-skills.test.ts` (create)

**Interfaces:**
- Consumes: the manifest's `skills` entries (`{ name, kind, pack, file }`), the `AssetBundle` at
  namespace `plugin:<host>`.
- Produces:
  - `PluginCatalog.methodSkills(host, prompt)`: the `kind: "skill"`, `pack: null` skills whose name
    appears in backticks in `prompt` (for example `` `design-craft` ``). Each comes with every bundle
    file under its `skills/<name>/` directory (`SKILL.md` and `references/**`).
  - For a **headless** dispatch only, the engine writes each such skill's files to
    `.vtc/state/skills/<name>/…` in the owner's checkout (the same root as packs). The dispatch
    prompt gets one line per skill: ``Skill `design-craft`: read <abs>/.vtc/state/skills/design-craft/SKILL.md and the references it names``.
    Subagent dispatches are unchanged, since the host loads plugin skills there.

- [ ] **Step 1: Write the failing test.** Use `createHarness()` with a fake asset bundle. Its
  `plugin:codex` manifest lists `design-craft` (kind `skill`, pack `null`,
  `file: skills/design-craft/SKILL.md`) and carries `skills/design-craft/SKILL.md` = `"# Design craft\n"`
  and `skills/design-craft/references/modes.md` = `"modes\n"`. Then:
  - drive a headless Codex dispatch of the Designer (follow `headless.test.ts` for the harness
    options), and assert that the spawn's prompt contains
    ``Skill `design-craft`: read ${h.repo}/.vtc/state/skills/design-craft/SKILL.md``;
  - assert that `readFileSync(join(h.repo, ".vtc/state/skills/design-craft/references/modes.md"), "utf8")` is `"modes\n"`;
  - assert that a Claude subagent dispatch of the same role has no `Skill ` line.
- [ ] **Step 2: Run it to make sure it fails.**
  `pnpm --filter @vtc/engine exec vitest run test/core/headless-skills.test.ts`. Expected: FAIL.
  `methodSkills` doesn't exist.
- [ ] **Step 3: Implement `methodSkills`** in `createPluginCatalog`. Match names with
  `` new RegExp("`" + name + "`") `` against the agent's compiled prompt text (`promptParts(agent, host)?.compiled?.headless ?? locked`).
  List the files with `assets.list("plugin:" + host)` filtered by the `skills/<name>/` prefix.
- [ ] **Step 4: Write the files and the prompt lines** in `dispatch.ts`, next to the existing
  `Use these skills:` line, only when `dispatch === "headless"`. Write the files with the same
  helper the pack uses (so `.vtc/state/` stays git-ignored).
- [ ] **Step 5: Run the test, then `test/core/headless.test.ts` and `test/core/roles.test.ts`.**
  Expected: PASS.
- [ ] **Step 6: Add reading 274** ("**A headless role reads its method skills from the checkout**")
  and commit: `git commit -m "Headless roles get the method skills their prompt names"`

### Task 5: A format rejection resumes the same session (fault 7)

**Files:**
- Modify: `packages/shared/src/event-payloads.ts:474-490`, adding
  `session_ref: SessionRefSchema.optional()` to `role.rejected` (new in 5.15.0)
- Modify: `packages/shared/src/index.ts:370` (`CONTRACTS_VERSION = "5.15.0"`)
- Modify: `packages/engine/src/core/submit.ts` (`logRejection`, ~line 378), passing the submit's
  `session_ref` when present
- Modify: `packages/engine/src/core/state.ts:507-518`, setting `run.sessionRef = data.session_ref`
  on `role.rejected`
- Modify: `packages/engine/src/core/dispatch.ts:237-258`, adding
  `rejectionResume(h, filter): SessionRef | undefined` next to `rejectionNote`, and using it
  wherever `rejectionNote` feeds a step (lines 386, 463, 525, 623, 677) as `step.resume` when no
  other resume is set
- Test: `packages/engine/test/core/rejection-resume.test.ts` (create). Also extend the contracts
  test, following `test/core/contracts-5-13.test.ts`, as `contracts-5-15.test.ts`.

**Interfaces:**
- Produces: `rejectionResume(h: RunHandle, filter: { role: string; mode?: string; task?: string; subject?: string }): SessionRef | undefined`.
  It returns the last rejected run's `sessionRef` when its rejection reason is one of
  `schema`, `claim_check`, `dispatch_mismatch`, `undeclared_output`, `undeclared_mode`,
  `undeclared_exit` or `undeclared_verdict`. Otherwise it returns `undefined`.

- [ ] **Step 1: Write the failing test.** Use `createHarness()`, start a run as
  `quick-fix-design.test.ts` does, and get the BA spawn. Submit a result with
  `session_ref: { host: "claude-code", id: "s-1" }` that cites `{ type: "spec_ref", ref: "REQ-99" }`
  on a spec defining only REQ-1 (so it's rejected `claim_check`). Assert that the next BA
  `spawn_role` has `resume` equal to `{ host: "claude-code", id: "s-1" }` and a prompt containing
  `Your previous result was rejected (claim_check)`. In a second case, the same rejection without a
  `session_ref` gives a spawn with no `resume`. In a third case, an Engineer rejection carries both
  `resume` and `redo them within scope`.
- [ ] **Step 2: Run it to make sure it fails.**
  `pnpm --filter @vtc/engine exec vitest run test/core/rejection-resume.test.ts`. Expected: FAIL.
  `resume` is undefined.
- [ ] **Step 3: Implement** the payload field, the state update, `rejectionResume`, and its use in
  the five step builders. A `resume` already set by a step (an interrupted session, a parked
  answer) wins.
- [ ] **Step 4: Run the new test, the contracts tests and the engine suite.** Run
  `pnpm --filter @vtc/engine exec vitest run test/core/rejection-resume.test.ts`, then
  `pnpm --filter @vtc/shared test`, then `pnpm --filter @vtc/engine test`. Expected: PASS.
- [ ] **Step 5: Add reading 275** ("**A format rejection is fixed in the same session**";
  contracts 5.15.0). Bump the spine's contracts line, then commit:
  `git commit -m "A rejected result is retried in the role's own session (contracts 5.15.0)"`

### Task 6: Pin the faults already fixed (4, 6, 10)

**Files:**
- Test: `packages/engine/test/core/owner-run-faults.test.ts` (create)
- Test: `packages/adapters/test/codex/command.test.ts` (extend)

**Interfaces:**
- Consumes: `resultFields(step, taskFeature, contract)` from `dispatch.ts`,
  `codexHeadlessCommand(...)` from `packages/adapters/src/codex/command.ts`, and
  `codexFeaturesFor(tools)` from `packages/compiler/src/hosts.ts`.

- [ ] **Step 1: Write the tests.**
  - Fault 10: `resultFields({ role: "ba" }, undefined, contract)` contains
    `task null` and `never take one from the repository`.
  - Fault 6: a `codexHeadlessCommand` for a `write_scoped` role (BA) has no argument equal to
    `features.shell_tool=false`. Also, the compiled BA prompt (`dist/codex-plugin/agents/vtc-ba.toml`,
    or the compiler's output in a test build) contains
    `read and search files with read-only shell commands`.
  - Fault 4: already covered by `quick-fix-design.test.ts` ("get the BA's spec in their pack"). Add
    a one-line reference comment in the new file, with no duplicate test.
- [ ] **Step 2: Run them.**
  `pnpm --filter @vtc/engine exec vitest run test/core/owner-run-faults.test.ts` and
  `pnpm --filter @vtc/adapters exec vitest run test/codex/command.test.ts`. Expected: PASS. If one
  fails, the fault is *not* fixed. Stop and fix it within this task, test first.
- [ ] **Step 3: Commit.** `git commit -m "Pin the owner-run faults fixed in v0.2.4"`

### Task 7: Changelog and full verification

**Files:**
- Modify: `CHANGELOG.md` (a new `## Unreleased` section above v0.2.5)

- [ ] **Step 1: Write the entry** in plain words, with one bullet per fixed fault group. The
  security agent can now write its threat model. Agents' answers with empty fields are no longer
  rejected. Requirements written as `**REQ-4** (revised)` are recognised. References to the spec and
  to an agent's own instructions are accepted in the forms agents write. Headless Codex agents get
  the design and research methods. A rejected answer is fixed in the same agent session instead of
  starting over, which is cheaper.
- [ ] **Step 2: Run the full gate.** `pnpm verify`. Expected: it ends without errors (typecheck,
  lint, dependency rules, tests, format, build).
- [ ] **Step 3: Commit.** `git commit -m "Changelog: fixes from the owner's runs"`

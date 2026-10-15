/**
 * Designer artifacts other packages read (§9): `screens.yaml` and the prototype's query
 * convention. The Designer role writes them, Flow Studio's design review (§17) and Visual QA's
 * render matrix (§7.5) read them, so the shape lives here (AD-3).
 */
import { z } from "zod";
import {
  EscalationIdSchema,
  GlobSchema,
  RelPathSchema,
  RequirementRefSchema,
  SlugSchema,
} from "./primitives.js";

/** Where the Designer writes the screen list (git-tracked, AD-7 rule 6). */
export const DESIGN_SCREENS_PATH = ".vtc/design/screens.yaml";

/**
 * Where the Designer writes each key screen's design contract (§9, §9.1; spine §5 reading 179):
 * one Markdown file per screen id, returned as a `screens` artifact beside the screen list, with
 * the screen's mode and one `## Direction <id>` contract per offered direction. Visual QA and the
 * Engineer read the contract of `TaskPack.design_direction`. New in 4.11.0.
 */
export const DESIGN_CONTRACTS_DIR = ".vtc/design/screens";

/** Pure: the design contract of one key screen (`DESIGN_CONTRACTS_DIR/<screen id>.md`). */
export const designContractPath = (screenId: string): string => {
  const id = SlugSchema.parse(screenId);
  return `${DESIGN_CONTRACTS_DIR}/${id}.md`;
};

/** Prototype themes: the design review's theme switcher and Visual QA's render matrix. */
export const PrototypeThemeSchema = z.enum(["light", "dark"]);
export type PrototypeTheme = z.infer<typeof PrototypeThemeSchema>;

/**
 * One screen (§9): its route in the prototype, the states it must show (empty, loading, error,
 * success, permission… as slugs) and the REQs it covers.
 */
export const DesignScreenSchema = z
  .strictObject({
    id: SlugSchema,
    /** Path inside the prototype, starting with `/`, without query or fragment. */
    route: z
      .string()
      .max(500)
      .regex(/^\/[^\s?#]*$/, "expected a path starting with / and no query or fragment"),
    states: z.array(SlugSchema).default([]),
    reqs: z.array(RequirementRefSchema).default([]),
  })
  .refine((screen) => new Set(screen.states).size === screen.states.length, {
    message: "states must be unique",
    path: ["states"],
  });
export type DesignScreen = z.infer<typeof DesignScreenSchema>;

/** `.vtc/design/screens.yaml`. Readers parse it with `parsePersisted`. */
export const DesignScreensFileSchema = z
  .strictObject({
    version: z.literal(1).default(1),
    screens: z.array(DesignScreenSchema),
  })
  .refine((file) => new Set(file.screens.map((s) => s.id)).size === file.screens.length, {
    message: "screen ids must be unique",
    path: ["screens"],
  });
export type DesignScreensFile = z.infer<typeof DesignScreensFileSchema>;
export type DesignScreensFileInput = z.input<typeof DesignScreensFileSchema>;

/**
 * The prototype URL path of one screen state (§9 "every state reachable via `?state=`"):
 * `<route>?state=<state>&theme=<light|dark>`, relative to the prototype origin
 * (`HealthResult.prototype_url`).
 */
export const prototypeStatePath = (route: string, state: string, theme: PrototypeTheme): string => {
  const path = DesignScreenSchema.shape.route.parse(route);
  const query = new URLSearchParams({
    state: SlugSchema.parse(state),
    theme: PrototypeThemeSchema.parse(theme),
  });
  return `${path}?${query.toString()}`;
};

/**
 * The DESIGN check of REQ → component → screen coverage (spec §9, §6.1 DESIGN), computed by engine
 * core before G2 from the frozen spec, the Architect's architecture artifact (its
 * requirement-to-component map, and since 5.7.0 (H-13) the REQs each AD names: a REQ an AD or a
 * component names is covered), `screens.yaml` (each screen's `reqs`) and the Designer's
 * component specs (artifact type `component_specs`, which name the screens each component is used
 * on) against the component registry. `ok` = every requirement is mapped to a component, every UI
 * requirement has a screen, every screen covers a requirement, every component the specs use is
 * registered, a UI run's `screens.yaml` is there and valid, and a new-repo UI design offers
 * {@link G2_DIRECTIONS} directions. Since 5.7.0 (H-13; spine §5 reading 237) G2 is not
 * shown until the coverage part is complete ({@link designCoverageComplete}): a failed check
 * re-dispatches the Architect and the Designer ({@link DESIGN_COVERAGE_LOOP}); before 5.7.0 a G2
 * approval was refused while `ok` was false and the human rejected G2 (reading 146). New in 4.5.0; `reqs_without_component` and `screens_problem` new in 4.8.0;
 * `directions_problem` new in 4.10.0.
 */
export const DesignCoverageReportSchema = z
  .strictObject({
    /** Requirements the Architect's requirement-to-component map does not name. New in 4.8.0. */
    reqs_without_component: z.array(RequirementRefSchema).default([]),
    reqs_without_screen: z.array(RequirementRefSchema).default([]),
    screens_without_req: z.array(SlugSchema).default([]),
    components_unregistered: z.array(SlugSchema).default([]),
    /** A UI run's `screens.yaml` is missing or invalid (then no screen list is checked). 4.8.0. */
    screens_problem: z.string().min(1).max(300).optional(),
    /**
     * A new-repo UI design (`repo: new`, `has_ui`) with fewer than `G2_DIRECTIONS.min` distinct
     * `design_direction` artifacts after the Designer's one re-dispatch: G2 shows it as a
     * blocking notice (spine §5 reading 174, D-bt). New in 4.10.0.
     */
    directions_problem: z.string().min(1).max(300).optional(),
    ok: z.boolean(),
  })
  .refine(
    (r) =>
      r.ok ===
      (r.reqs_without_component.length === 0 &&
        r.reqs_without_screen.length === 0 &&
        r.screens_without_req.length === 0 &&
        r.components_unregistered.length === 0 &&
        r.screens_problem === undefined &&
        r.directions_problem === undefined),
    {
      message: "ok is true exactly when every list is empty and screens.yaml is usable",
      path: ["ok"],
    },
  );
export type DesignCoverageReport = z.infer<typeof DesignCoverageReportSchema>;

// ------------------------------------------------ coverage loop (5.7.0)

/**
 * The G2 coverage loop (H-13; spine §5 reading 237; replaces reading 146's "reject and redo"):
 * engine core runs the DESIGN check before G2 is shown. While the coverage part fails
 * ({@link designCoverageComplete}), it re-dispatches the roles {@link designCoverageRedispatch}
 * names with the gaps ({@link DesignCoverageGaps}, `TaskPack.coverage_gaps`) and checks again, at
 * most `maxRounds` fix rounds, with the stuck detection of the other fix loops (the same gaps after
 * a round). G2 is shown only when coverage is complete; at the cap, or stuck, the run parks with a
 * DESIGN-phase escalation (reason `cap` or `stuck`) that names the uncovered REQs and offers
 * {@link DESIGN_COVERAGE_ESCALATION_OPTIONS}. No "approve anyway". New in 5.7.0.
 */
export const DESIGN_COVERAGE_LOOP = { maxRounds: 3 } as const;

/**
 * The options of the coverage loop's escalation (H-13): change the spec (the run goes back to
 * SPECIFY and G1), or tell the Architect what to do (the answer reaches the next Architect
 * dispatch as `TaskPack.answer`, and the loop runs again with a fresh round budget). New in 5.7.0.
 */
export const DESIGN_COVERAGE_ESCALATION_OPTIONS = ["change_spec", "instruct_architect"] as const;

/**
 * Pure (H-13): whether the coverage part of a DESIGN check is complete: every REQ named by an AD
 * or a component, every UI REQ on a screen, every screen covering a REQ, every component a spec
 * uses registered, and a usable `screens.yaml`. `directions_problem` is not coverage: it keeps
 * its own rule (one Designer re-dispatch, then a blocking G2 notice, reading 174). New in 5.7.0.
 */
export const designCoverageComplete = (report: DesignCoverageReport): boolean =>
  report.reqs_without_component.length === 0 &&
  report.reqs_without_screen.length === 0 &&
  report.screens_without_req.length === 0 &&
  report.components_unregistered.length === 0 &&
  report.screens_problem === undefined;

/** The design roles the coverage loop re-dispatches. New in 5.7.0. */
export const DesignCoverageRoleSchema = z.enum(["architect", "designer"]);
export type DesignCoverageRole = z.infer<typeof DesignCoverageRoleSchema>;

/**
 * Pure (H-13): who fixes a failed coverage check. A REQ no AD or component names goes to the
 * Architect; a UI REQ with no screen, a screen with no REQ, an unregistered component or an
 * unusable `screens.yaml` goes to the Designer. Architect first: the Designer works from its
 * output. New in 5.7.0.
 */
export const designCoverageRedispatch = (report: DesignCoverageReport): DesignCoverageRole[] => [
  ...(report.reqs_without_component.length > 0 ? (["architect"] as const) : []),
  ...(report.reqs_without_screen.length > 0 ||
  report.screens_without_req.length > 0 ||
  report.components_unregistered.length > 0 ||
  report.screens_problem !== undefined
    ? (["designer"] as const)
    : []),
];

/**
 * The gaps a coverage-loop re-dispatch fixes (`TaskPack.coverage_gaps`, H-13), printed as Dispatch
 * lines: the fix round and the check's lists, ids only (the REQ texts are in the pack's
 * requirements). New in 5.7.0.
 */
export const DesignCoverageGapsSchema = z.strictObject({
  round: z.int().min(1).max(DESIGN_COVERAGE_LOOP.maxRounds),
  reqs_without_component: z.array(RequirementRefSchema).default([]),
  reqs_without_screen: z.array(RequirementRefSchema).default([]),
  screens_without_req: z.array(SlugSchema).default([]),
  components_unregistered: z.array(SlugSchema).default([]),
  screens_problem: z.string().min(1).max(300).optional(),
});
export type DesignCoverageGaps = z.infer<typeof DesignCoverageGapsSchema>;

/** Pure: the gaps of a failed check for fix round `round`. New in 5.7.0. */
export const designCoverageGaps = (
  report: DesignCoverageReport,
  round: number,
): DesignCoverageGaps =>
  DesignCoverageGapsSchema.parse({
    round,
    reqs_without_component: report.reqs_without_component,
    reqs_without_screen: report.reqs_without_screen,
    screens_without_req: report.screens_without_req,
    components_unregistered: report.components_unregistered,
    ...(report.screens_problem === undefined ? {} : { screens_problem: report.screens_problem }),
  });

/**
 * Payload of `design.coverage_checked` (H-13): one DESIGN check of the coverage loop, logged by
 * engine core before G2, so Flow Studio can show the loop's status. `check` counts from 1 (the
 * first check, before any fix round); `outcome` `complete` (G2 follows), `fixing` (the roles in
 * `redispatched` run fix round `check`), or `parked` (`park_reason` `cap` or `stuck`, and the
 * escalation that names the uncovered REQs). New in 5.7.0.
 */
export const DesignCoverageCheckedSchema = z
  .strictObject({
    check: z
      .int()
      .min(1)
      .max(DESIGN_COVERAGE_LOOP.maxRounds + 1),
    max_rounds: z.int().min(1).max(10),
    report: DesignCoverageReportSchema,
    outcome: z.enum(["complete", "fixing", "parked"]),
    redispatched: z.array(DesignCoverageRoleSchema).max(2).default([]),
    park_reason: z.enum(["cap", "stuck"]).optional(),
    escalation: EscalationIdSchema.optional(),
  })
  .refine((v) => (v.outcome === "fixing") === v.redispatched.length > 0, {
    message: "a fixing check names the roles it re-dispatches, and only a fixing check does",
    path: ["redispatched"],
  })
  .refine((v) => (v.outcome === "parked") === (v.park_reason !== undefined), {
    message: "park_reason is required for, and only allowed with, a parked check",
    path: ["park_reason"],
  });
export type DesignCoverageChecked = z.infer<typeof DesignCoverageCheckedSchema>;

/**
 * How many design directions G2 offers on a new-repo UI design (§9.1 steps 3 and 5; spine §5
 * reading 174, D-bt). Fewer than `min`: the engine re-dispatches the Designer once, then G2
 * shows `DesignCoverageReport.directions_problem` and refuses an approval. More than `max` are
 * cut. New in 4.10.0.
 */
export const G2_DIRECTIONS = { min: 2, max: 3 } as const;

/**
 * One of the 2–3 design directions G2 offers (§9.1 steps 3–5): its first-viewport prototype, a
 * screenshot of it and the engine's novelty verdict. `approve_gate.directions`. New in 4.5.0.
 */
export const G2DirectionSchema = z.strictObject({
  id: SlugSchema,
  title: z.string().min(1).max(120),
  /** The Direction contract's THESIS line. */
  thesis: z.string().min(1).max(500),
  /** Under `.vtc/design/prototype/`. */
  prototype: RelPathSchema,
  first_viewport: RelPathSchema.optional(),
  novelty: z.enum(["novel", "too_similar", "unchecked"]),
});
export type G2Direction = z.infer<typeof G2DirectionSchema>;

/**
 * The two exits G2 offers beside its directions (§9.1 step 5; spine §5 reading 151), in
 * `approve_gate.design_exits`:
 * - `re_roll`: a rejection that sends only the Designer back, with a fresh constraints deal and
 *   the engine's `novelty_report` of every direction G2 showed as too similar
 *   (`ApproveInput.design_exit` with `decision: reject`);
 * - `category_standard`: an approval that takes the category's standard look instead of a
 *   direction; nothing enters the design library (`design_exit` with `decision: approve`, no
 *   `design_direction`).
 * A `too_similar` direction cannot be picked (§9.1 step 4: "reject anything too similar"). New in
 * 4.9.0.
 */
export const DesignExitSchema = z.enum(["re_roll", "category_standard"]);
export type DesignExit = z.infer<typeof DesignExitSchema>;

// ------------------------------------------------- Designer output (4.6.0)

/**
 * Where the Designer writes each G2 direction (§9.1 step 3; spine §5 reading 116): one JSON file
 * per direction, `.vtc/design/directions/<id>.json` ({@link designDirectionPath}), returned as a
 * `design_direction` artifact. Its first viewport is a prototype file under
 * `.vtc/design/prototype/` (the file's `prototype`). New in 4.6.0.
 */
export const DESIGN_DIRECTIONS_DIR = ".vtc/design/directions";

/** `.vtc/design/directions/<id>.json`. */
export const designDirectionPath = (id: string): string =>
  `${DESIGN_DIRECTIONS_DIR}/${SlugSchema.parse(id)}.json`;

/**
 * One `design_direction` file as the Designer writes it: {@link G2DirectionSchema} without
 * `novelty`. The novelty verdict is the engine's (a deterministic check, AD-24 rule 8), never the
 * Designer's: a reader parses the file with `parsePersisted`, which drops a self-declared
 * `novelty`. New in 4.6.0.
 */
export const G2DirectionDraftSchema = G2DirectionSchema.omit({ novelty: true });
export type G2DirectionDraft = z.infer<typeof G2DirectionDraftSchema>;

/**
 * Where the engine writes the novelty check's result for a direction (`NoveltyReport`,
 * `.vtc/design/novelty/<id>.json`, {@link noveltyReportPath}). Only the engine writes it; it is
 * the role input `novelty_report` on a re-roll. New in 4.6.0.
 */
export const DESIGN_NOVELTY_DIR = ".vtc/design/novelty";

/** `.vtc/design/novelty/<id>.json`. */
export const noveltyReportPath = (id: string): string =>
  `${DESIGN_NOVELTY_DIR}/${SlugSchema.parse(id)}.json`;

/**
 * Where the Designer writes component specs (artifact type `component_specs`), one YAML file per
 * component or a `components:` list. New in 4.6.0.
 */
export const COMPONENT_SPECS_DIR = ".vtc/design/components";

/**
 * The part of one component spec other packages read (§9 Consistency, §6.1 DESIGN): its registry
 * `id`, the `screens` (ids in `screens.yaml`) that use it, and the registry components it
 * composes (`uses`). The rest of a spec (props, variants, states) is the Designer's and a reader
 * drops it (`parsePersisted`). The DESIGN check requires every component a spec `uses` to be
 * registered (`DesignCoverageReport.components_unregistered`). New in 4.6.0.
 */
export const ComponentSpecSchema = z.strictObject({
  id: SlugSchema,
  screens: z.array(SlugSchema).default([]),
  uses: z.array(SlugSchema).default([]),
});
export type ComponentSpec = z.infer<typeof ComponentSpecSchema>;

// ------------------------------------------------------- flows (5.7.0)

/**
 * Where a project names its user flows (D-ct, D-ce; spine §5 reading 247(7)): `.vtc/design/flows.yaml`,
 * git-tracked, written by the Designer beside `screens.yaml` (and editable by the human). The gate
 * runner scripts one of them on both sides of an automatic UI PR so the PR's `flow_video` shows
 * the changed flow ({@link DesignFlowsFileSchema}, `BeforeAfterRequest.flow`). New in 5.7.0.
 */
export const DESIGN_FLOWS_PATH = ".vtc/design/flows.yaml";

/** Bounds of a flows file and of one scripted flow. New in 5.7.0. */
export const FLOW_LIMITS = {
  maxFlows: 50,
  maxSteps: 20,
  maxWaitMs: 5000,
  maxFixtures: 50,
  maxFixtureChars: 200,
} as const;

const FlowRouteSchema = DesignScreenSchema.shape.route;
/** A Playwright selector (CSS, `role=…`, `text=…`), one line. */
const FlowSelectorSchema = z.string().regex(/^[^\r\n]{1,300}$/, "a one-line selector");

/**
 * One scripted step: open a route of the app (`goto`), click, fill a field with a named fixture
 * of the file (never inline text), press a key, wait for a selector, or wait a bounded time. No
 * script, no URL outside the app's origin. New in 5.7.0.
 */
export const FlowStepSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("goto"), route: FlowRouteSchema }),
  z.strictObject({ action: z.literal("click"), selector: FlowSelectorSchema }),
  z.strictObject({ action: z.literal("fill"), selector: FlowSelectorSchema, fixture: SlugSchema }),
  z.strictObject({
    action: z.literal("press"),
    key: z.string().regex(/^[A-Za-z0-9+]{1,30}$/, "a key name like Enter or Control+a"),
  }),
  z.strictObject({ action: z.literal("wait_for"), selector: FlowSelectorSchema }),
  z.strictObject({ action: z.literal("wait"), ms: z.int().min(1).max(FLOW_LIMITS.maxWaitMs) }),
]);
export type FlowStep = z.infer<typeof FlowStepSchema>;

/**
 * One user flow: where it starts, the screens (`screens.yaml` ids) it passes and the source globs
 * whose change it exercises (what selects it for a PR, {@link selectDesignFlow}), and its steps.
 * New in 5.7.0.
 */
export const DesignFlowSchema = z
  .strictObject({
    id: SlugSchema,
    start: FlowRouteSchema,
    screens: z.array(SlugSchema).max(20).default([]),
    paths: z.array(GlobSchema).max(50).default([]),
    steps: z.array(FlowStepSchema).min(1).max(FLOW_LIMITS.maxSteps),
  })
  .refine((flow) => flow.screens.length > 0 || flow.paths.length > 0, {
    message: "a flow names the screens it passes or the paths it exercises",
    path: ["paths"],
  });
export type DesignFlow = z.infer<typeof DesignFlowSchema>;

/** `.vtc/design/flows.yaml`. Readers parse it with `parsePersisted`. New in 5.7.0. */
export const DesignFlowsFileSchema = z
  .strictObject({
    version: z.literal(1).default(1),
    /** Values the `fill` steps type, by name; no secret belongs here (the file is committed). */
    fixtures: z
      .record(SlugSchema, z.string().max(FLOW_LIMITS.maxFixtureChars))
      .refine((f) => Object.keys(f).length <= FLOW_LIMITS.maxFixtures, "too many fixtures")
      .default({}),
    flows: z.array(DesignFlowSchema).max(FLOW_LIMITS.maxFlows),
  })
  .superRefine((file, ctx) => {
    const ids = file.flows.map((f) => f.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: "custom", path: ["flows"], message: "flow ids must be unique" });
    }
    file.flows.forEach((flow, i) => {
      flow.steps.forEach((step, j) => {
        if (step.action === "fill" && !Object.hasOwn(file.fixtures, step.fixture)) {
          ctx.addIssue({
            code: "custom",
            path: ["flows", i, "steps", j, "fixture"],
            message: `unknown fixture ${step.fixture}`,
          });
        }
      });
    });
  });
export type DesignFlowsFile = z.infer<typeof DesignFlowsFileSchema>;
export type DesignFlowsFileInput = z.input<typeof DesignFlowsFileSchema>;

/**
 * Pure (D-ct; spine §5 reading 247(7)): the flow an automatic UI PR records, from the head's flows
 * file: the first flow, in file order, one of whose `paths` matches a changed path, else the first
 * that passes a touched screen; `undefined` when none does (the PR keeps the first-screen
 * recording, captioned as such). `match` is the caller's glob matcher (the engine's). New in 5.7.0.
 */
export const selectDesignFlow = (
  file: DesignFlowsFile,
  change: { readonly changedPaths: readonly string[]; readonly screens?: readonly string[] },
  match: (glob: string, path: string) => boolean,
): DesignFlow | undefined =>
  file.flows.find((f) => f.paths.some((g) => change.changedPaths.some((p) => match(g, p)))) ??
  file.flows.find((f) => f.screens.some((s) => (change.screens ?? []).includes(s)));

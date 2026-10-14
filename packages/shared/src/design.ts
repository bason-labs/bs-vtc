/**
 * Designer artifacts other packages read (§9): `screens.yaml` and the prototype's query
 * convention. The Designer role writes them, Flow Studio's design review (§17) and Visual QA's
 * render matrix (§7.5) read them, so the shape lives here (AD-3).
 */
import { z } from "zod";
import { RelPathSchema, RequirementRefSchema, SlugSchema } from "./primitives.js";

/** Where the Designer writes the screen list (git-tracked, AD-7 rule 6). */
export const DESIGN_SCREENS_PATH = ".vtc/design/screens.yaml";

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
 * requirement-to-component map), `screens.yaml` (each screen's `reqs`) and the Designer's
 * component specs (artifact type `component_specs`, which name the screens each component is used
 * on) against the component registry. `ok` = every requirement is mapped to a component, every UI
 * requirement has a screen, every screen covers a requirement, every component the specs use is
 * registered, and a UI run's `screens.yaml` is there and valid. A G2 approval is refused while
 * `ok` is false (spine §5 reading 146). New in 4.5.0; `reqs_without_component` and
 * `screens_problem` new in 4.8.0.
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
    ok: z.boolean(),
  })
  .refine(
    (r) =>
      r.ok ===
      (r.reqs_without_component.length === 0 &&
        r.reqs_without_screen.length === 0 &&
        r.screens_without_req.length === 0 &&
        r.components_unregistered.length === 0 &&
        r.screens_problem === undefined),
    {
      message: "ok is true exactly when every list is empty and screens.yaml is usable",
      path: ["ok"],
    },
  );
export type DesignCoverageReport = z.infer<typeof DesignCoverageReportSchema>;

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

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
 * core before G2 from the frozen spec, `screens.yaml` (each screen's `reqs`) and the Designer's
 * component specs (artifact type `component_specs`, which name the screens each component is used
 * on) against the component registry. `ok` = every UI requirement has a screen, every screen
 * covers a requirement, and every component the specs use is registered. New in 4.5.0.
 */
export const DesignCoverageReportSchema = z
  .strictObject({
    reqs_without_screen: z.array(RequirementRefSchema).default([]),
    screens_without_req: z.array(SlugSchema).default([]),
    components_unregistered: z.array(SlugSchema).default([]),
    ok: z.boolean(),
  })
  .refine(
    (r) =>
      r.ok ===
      (r.reqs_without_screen.length === 0 &&
        r.screens_without_req.length === 0 &&
        r.components_unregistered.length === 0),
    { message: "ok is true exactly when every list is empty", path: ["ok"] },
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

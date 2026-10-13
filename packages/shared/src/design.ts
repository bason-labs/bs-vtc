/**
 * Designer artifacts other packages read (§9): `screens.yaml` and the prototype's query
 * convention. The Designer role writes them, Flow Studio's design review (§17) and Visual QA's
 * render matrix (§7.5) read them, so the shape lives here (AD-3).
 */
import { z } from "zod";
import { RequirementRefSchema, SlugSchema } from "./primitives.js";

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

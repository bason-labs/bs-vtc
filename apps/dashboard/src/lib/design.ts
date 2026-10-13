import {
  DESIGN_REVIEW_MAX_BYTES,
  DesignReviewCommentInputSchema,
  DesignScreensFileSchema,
  parsePersisted,
  prototypeStatePath,
  SlugSchema,
  type DesignReviewCommentInput,
  type DesignScreen as SharedDesignScreen,
  type PrototypeTheme,
} from "@vtc/shared";
import { parse as parseYaml } from "yaml";

/**
 * Design review (spec §17): the Designer's prototype (`.vtc/design/prototype/`, served from its
 * own origin, AD-5 rule 9) with viewport, state and theme switchers, and click-to-pin comments
 * that the engine appends to `.vtc/design/reviews/<screen>.jsonl` (AD-5 rule 5). Approval still
 * happens in the Lead chat. The screen list (`DESIGN_SCREENS_PATH`) and the prototype query
 * convention come from `@vtc/shared` (`DesignScreensFileSchema`, `prototypeStatePath`).
 */

export const designReviewsPath = (screen: string): string =>
  `.vtc/design/reviews/${SlugSchema.parse(screen)}.jsonl`;

export type DesignTheme = PrototypeTheme;
export const DESIGN_THEMES: readonly DesignTheme[] = ["light", "dark"];

/** The Visual QA render widths (§7.5), with the frame height each one is shown at. */
export const VIEWPORTS = [
  { width: 390, label: "Phone", height: 844 },
  { width: 768, label: "Tablet", height: 1024 },
  { width: 1440, label: "Desktop", height: 900 },
] as const;
export type ViewportWidth = (typeof VIEWPORTS)[number]["width"];

/** A screen as the review shows it: always at least one state (`default`). */
export type DesignScreen = Readonly<
  Omit<SharedDesignScreen, "states" | "reqs"> & {
    states: readonly string[];
    reqs: readonly string[];
  }
>;

export type ScreensRead =
  | {
      readonly ok: true;
      readonly screens: DesignScreen[];
      /** Keys a newer Designer wrote that this version does not know (dropped, AD-3 rule 2). */
      readonly stripped: readonly string[];
    }
  | { readonly ok: false; readonly error: string };

/**
 * Reads `screens.yaml` against `DesignScreensFileSchema` (a reader of persisted data, so unknown
 * keys are dropped, not errors). A screen without states gets `default`. A file that breaks the
 * contract is refused as a whole, with the first problem and where it is.
 */
export const parseScreens = (text: string): ScreensRead => {
  let doc: unknown;
  try {
    doc = parseYaml(text, { maxAliasCount: 50 });
  } catch {
    return { ok: false, error: "not valid YAML" };
  }
  const parsed = parsePersisted(DesignScreensFileSchema, doc);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue === undefined || issue.path.length === 0 ? "(file)" : issue.path.join(".");
    return { ok: false, error: `${where}: ${issue?.message ?? "invalid"}` };
  }
  const screens = parsed.data.screens.map(({ id, route, states, reqs }) => ({
    id,
    route,
    states: states.length === 0 ? ["default"] : states,
    reqs,
  }));
  return { ok: true, screens, stripped: parsed.stripped };
};

const PROTOTYPE_ORIGIN = /^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/;

/**
 * The frame URL: `prototypeStatePath(route, state, theme)` on the prototype origin
 * (`HealthResult.prototype_url`). `null` when the contract refuses the route or state, or when
 * the result would not be on that loopback origin.
 */
export const prototypeFrameUrl = (
  prototypeUrl: string,
  route: string,
  state: string,
  theme: DesignTheme,
): string | null => {
  let url: URL;
  let base: URL;
  try {
    base = new URL(prototypeUrl);
    // Relative to the prototype URL, so a route like `//host/x` can never name another origin.
    url = new URL(prototypeStatePath(route, state, theme).replace(/^[/\\]+/, ""), base);
  } catch {
    return null;
  }
  if (!PROTOTYPE_ORIGIN.test(base.origin) || url.origin !== base.origin) return null;
  return url.href;
};

export interface DesignSelection {
  readonly screen: DesignScreen | null;
  readonly state: string;
  readonly viewport: ViewportWidth;
  readonly theme: DesignTheme;
}

/** What the query string asks for, with unknown values replaced by the defaults. */
export const designSelection = (
  params: URLSearchParams,
  screens: readonly DesignScreen[],
): DesignSelection => {
  const screen = screens.find((s) => s.id === params.get("screen")) ?? screens[0] ?? null;
  const asked = params.get("state");
  const state =
    screen === null
      ? "default"
      : asked !== null && screen.states.includes(asked)
        ? asked
        : (screen.states[0] ?? "default");
  const width = Number(params.get("viewport"));
  const viewport = VIEWPORTS.find((v) => v.width === width)?.width ?? 1440;
  const theme = params.get("theme") === "dark" ? "dark" : "light";
  return { screen, state, viewport, theme };
};

// ------------------------------------------------------------------- pins

export type DesignPin = DesignReviewCommentInput & {
  /** 1-based position in the file: the number shown on the pin. */
  readonly n: number;
};

/** The pins of one screen from its JSONL file; lines that break the contract are skipped. */
export const parsePins = (text: string): DesignPin[] => {
  const pins: DesignPin[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      continue;
    }
    const parsed = parsePersisted(DesignReviewCommentInputSchema, raw);
    if (parsed.success) pins.push({ ...parsed.data, n: pins.length + 1 });
  }
  return pins;
};

/** Pins made on the same state, viewport and theme: only these line up with the frame. */
export const pinsInView = (
  pins: readonly DesignPin[],
  view: Pick<DesignSelection, "state" | "viewport" | "theme">,
): DesignPin[] =>
  pins.filter(
    (p) => p.state === view.state && p.viewport === view.viewport && p.theme === view.theme,
  );

const clampPct = (value: number): number => Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;

/** A click inside the frame as percentages of its rendered box (scale-independent). */
export const pinPosition = (
  rect: { left: number; top: number; width: number; height: number },
  clientX: number,
  clientY: number,
): { x_pct: number; y_pct: number } => {
  if (rect.width <= 0 || rect.height <= 0) return { x_pct: 50, y_pct: 50 };
  return {
    x_pct: clampPct(((clientX - rect.left) / rect.width) * 100),
    y_pct: clampPct(((clientY - rect.top) / rect.height) * 100),
  };
};

export interface ReviewFields {
  readonly screen: string;
  readonly state: string;
  readonly viewport: number;
  readonly theme: DesignTheme;
  readonly x_pct: number;
  readonly y_pct: number;
  readonly comment: string;
  readonly author: string;
}

export type ReviewInputResult =
  | { readonly ok: true; readonly input: DesignReviewCommentInput }
  | { readonly ok: false; readonly error: string };

/** Validates a draft pin against `DesignReviewCommentInput` and the route's body limit. */
export const buildReviewInput = (fields: ReviewFields): ReviewInputResult => {
  const comment = fields.comment.trim();
  const author = fields.author.trim();
  if (comment === "") return { ok: false, error: "Write a comment first." };
  if (comment.length > 2000)
    return { ok: false, error: "Keep the comment under 2,000 characters." };
  const parsed = DesignReviewCommentInputSchema.safeParse({
    screen: fields.screen,
    state: fields.state,
    viewport: fields.viewport,
    theme: fields.theme,
    x_pct: fields.x_pct,
    y_pct: fields.y_pct,
    comment,
    ...(author === "" ? {} : { author }),
  });
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path.join(".") ?? "input";
    return { ok: false, error: `This pin cannot be saved: ${field} is not valid.` };
  }
  if (new TextEncoder().encode(JSON.stringify(parsed.data)).length > DESIGN_REVIEW_MAX_BYTES) {
    return { ok: false, error: "This comment is too long to send." };
  }
  return { ok: true, input: parsed.data };
};

/**
 * The render matrix (§7.5 step 2, AD-24 rule 3): screen × state × width × theme from
 * `.vtc/design/screens.yaml`, limited to the screens a `VisualRequest` names (empty = all of
 * them, Final Review step 5). Pure.
 */
import {
  DesignScreensFileSchema,
  parsePersisted,
  prototypeStatePath,
  visualRenderKey,
  type DesignScreensFile,
  type PrototypeTheme,
} from "@vtc/shared";
import { parse } from "yaml";

/** The state a screen with no listed states renders in. */
export const DEFAULT_STATE = "default";

export interface RenderJob {
  /** `<screen>:<state>:<width>:<theme>` (`visualRenderKey`). */
  readonly key: string;
  readonly screen: string;
  readonly state: string;
  readonly width: number;
  readonly theme: PrototypeTheme;
  /** `<route>?state=<state>&theme=<theme>` (`prototypeStatePath`), for app and prototype alike. */
  readonly path: string;
}

export interface RenderMatrix {
  readonly jobs: readonly RenderJob[];
  /** Requested screen ids `screens.yaml` does not have: never rendered, so never clean. */
  readonly missing: readonly string[];
}

/** Parses `screens.yaml` text; throws with the reasons when it is not a valid screen list. */
export const parseScreens = (text: string): DesignScreensFile => {
  const parsed = parsePersisted(DesignScreensFileSchema, parse(text, { uniqueKeys: true }));
  if (!parsed.success) {
    throw new Error(
      parsed.error.issues
        .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
        .join("; "),
    );
  }
  return parsed.data;
};

export const expandMatrix = (
  screens: DesignScreensFile,
  requested: readonly string[],
  settings: { readonly widths: readonly number[]; readonly themes: readonly PrototypeTheme[] },
): RenderMatrix => {
  const wanted = requested.length === 0 ? null : new Set(requested);
  const known = new Set(screens.screens.map((s) => s.id));
  const jobs: RenderJob[] = [];
  for (const screen of screens.screens) {
    if (wanted !== null && !wanted.has(screen.id)) continue;
    const states = screen.states.length === 0 ? [DEFAULT_STATE] : screen.states;
    for (const state of states) {
      for (const width of settings.widths) {
        for (const theme of settings.themes) {
          jobs.push({
            key: visualRenderKey(screen.id, state, width, theme),
            screen: screen.id,
            state,
            width,
            theme,
            path: prototypeStatePath(screen.route, state, theme),
          });
        }
      }
    }
  }
  const missing = [...new Set(requested)].filter((id) => !known.has(id)).sort();
  return { jobs, missing };
};

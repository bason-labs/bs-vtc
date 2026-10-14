/**
 * The app server the visual step renders the implementation from (§7.5 step 2). Every screen
 * state renders at `<url><route>?state=<state>&theme=<theme>`, the same convention as the
 * approved prototype (`prototypeStatePath`), so the implementation and the prototype are
 * compared state by state.
 *
 * PROVISIONAL (contract proposal): `@vtc/shared` 4.5.0 has no field for it, so it is read from
 * `.vtc/gates.yml` `visual.app` in the raw YAML (`parsePersisted` strips the key from the typed
 * config). It is human-calibrated like every gate: its `command` must pass the machine's gate
 * allowlist (§15), and the `url` must be an http(s) loopback URL (the sandbox allows nothing else).
 */
import { RelPathSchema } from "@vtc/shared";
import { parse } from "yaml";
import { z } from "zod";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export const VisualAppSchema = z.strictObject({
  /** argv, without a shell; allowlisted like a gate command. */
  command: z.array(z.string().min(1)).min(1),
  /** Base URL the server answers on, e.g. `http://127.0.0.1:4173`. */
  url: z.url().refine((u) => {
    const url = new URL(u);
    return (
      (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK_HOSTS.has(url.hostname)
    );
  }, "the app server must answer on an http(s) loopback URL"),
  /** Working directory inside the checkout. */
  cwd: RelPathSchema.optional(),
  ready_timeout_s: z.int().positive().max(600).default(120),
});
export type VisualApp = z.infer<typeof VisualAppSchema>;

/**
 * `visual.app` of raw `gates.yml` text: the app, `null` when there is none, or why it is invalid
 * (a run then reports the visual step as gate infrastructure, never a silent pass).
 */
export const visualAppOf = (gatesYml: string | null): VisualApp | null | { invalid: string } => {
  if (gatesYml === null) return null;
  let raw: unknown;
  try {
    raw = parse(gatesYml, { uniqueKeys: true });
  } catch {
    return null;
  }
  const visual = (raw as { visual?: unknown } | null)?.visual;
  const app = (visual as { app?: unknown } | null | undefined)?.app;
  if (app === undefined || app === null) return null;
  const parsed = VisualAppSchema.safeParse(app);
  return parsed.success
    ? parsed.data
    : {
        invalid: parsed.error.issues
          .map((i) => `visual.app.${i.path.map(String).join(".")}: ${i.message}`)
          .join("; "),
      };
};

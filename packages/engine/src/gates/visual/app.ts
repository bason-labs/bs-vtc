/**
 * The app server the visual step renders the implementation from (§7.5 step 2): read only through
 * the typed `GatesConfig.visual.app` (`VisualApp`, contracts 4.6.0), so `gates.yml` is validated
 * once, as a whole, and an invalid `visual.app` fails the run's config like any other key. Every
 * screen state renders at `<url><route>?state=<state>&theme=<theme>`, the approved prototype's
 * convention (`prototypeStatePath`). It is human-calibrated like every gate: its `command` must
 * pass the machine's gate allowlist (§15), and the `url` is an http(s) loopback URL.
 */

/**
 * The loopback port the app server answers on: the URL's port, else the scheme's default. The
 * gate sandbox opens this port of the loopback to the visual run, and no other.
 */
export const appLoopbackPort = (url: string): number => {
  const parsed = new URL(url);
  if (parsed.port !== "") return Number(parsed.port);
  return parsed.protocol === "https:" ? 443 : 80;
};

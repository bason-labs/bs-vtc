/**
 * Client-side routing over Flow Studio's fixed pages (AD-20): ids travel in the query string
 * (`/task/?run=r1&task=T-2`), never in path segments, because a static export cannot pre-render
 * `/runs/:run`. Every exported page renders the same app, which picks the view from the path, so
 * links switch views with `history.pushState` and no page load; a hard load of any page (or the
 * engine's SPA fallback to `index.html`) lands on the same view.
 */
export type View =
  "runs" | "run" | "task" | "feature" | "escalations" | "usage" | "artifact" | "not_found";

export const VIEW_PATHS = {
  runs: "/",
  run: "/run/",
  task: "/task/",
  feature: "/feature/",
  escalations: "/escalations/",
  usage: "/usage/",
  artifact: "/artifact/",
} as const satisfies Record<Exclude<View, "not_found">, string>;

const BY_PATH = new Map<string, View>(
  Object.entries(VIEW_PATHS).map(([view, path]) => [path, view as View]),
);

export const matchView = (pathname: string): View => {
  let path = pathname.replace(/index\.html$/, "");
  if (!path.endsWith("/")) path = `${path}/`;
  return BY_PATH.get(path) ?? "not_found";
};

const withQuery = (path: string, query: Record<string, string | undefined>): string => {
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined) search.set(k, v);
  const qs = search.toString();
  return qs === "" ? path : `${path}?${qs}`;
};

export type RunZoom = "phases" | "tasks";

export const hrefs = {
  runs: (): string => VIEW_PATHS.runs,
  run: (run: string, zoom?: RunZoom, node?: string): string =>
    withQuery(VIEW_PATHS.run, { run, zoom, node }),
  task: (run: string, task: string, node?: string): string =>
    withQuery(VIEW_PATHS.task, { run, task, node }),
  feature: (run: string, feature?: string): string =>
    withQuery(VIEW_PATHS.feature, { run, feature }),
  escalations: (run: string): string => withQuery(VIEW_PATHS.escalations, { run }),
  usage: (): string => VIEW_PATHS.usage,
  artifact: (run: string, path: string): string => withQuery(VIEW_PATHS.artifact, { run, path }),
};

const listeners = new Set<() => void>();

export const subscribeLocation = (callback: () => void): (() => void) => {
  listeners.add(callback);
  if (listeners.size === 1) window.addEventListener("popstate", notify);
  return () => {
    listeners.delete(callback);
    if (listeners.size === 0) window.removeEventListener("popstate", notify);
  };
};

function notify(): void {
  for (const l of listeners) l();
}

/**
 * Switches view without a page load. `replace` swaps the current history entry. A new page
 * scrolls to the top; a query change on the same page (selecting a node) keeps the position.
 */
export const navigate = (href: string, options: { replace?: boolean } = {}): void => {
  const before = window.location.pathname;
  if (options.replace === true) window.history.replaceState(null, "", href);
  else window.history.pushState(null, "", href);
  notify();
  if (window.location.pathname !== before) window.scrollTo({ top: 0 });
};

/** `pathname + search`, the router's snapshot of the address bar. */
export const locationSnapshot = (): string =>
  `${window.location.pathname}${window.location.search}`;

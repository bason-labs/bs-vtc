"use client";

import { useSyncExternalStore } from "react";
import { locationSnapshot, matchView, subscribeLocation, type View } from "./router";

export interface Route {
  readonly view: View;
  readonly params: URLSearchParams;
  /** `pathname + search`. */
  readonly href: string;
}

const parse = (href: string): Route => {
  const url = new URL(href, "http://flow.studio");
  return { view: matchView(url.pathname), params: url.searchParams, href };
};

/**
 * The current route. `serverPath` is the page that was exported (its prerender has no query
 * string); the real address takes over right after hydration.
 */
export function useRoute(serverPath: string): Route {
  const href = useSyncExternalStore(subscribeLocation, locationSnapshot, () => serverPath);
  return parse(href);
}

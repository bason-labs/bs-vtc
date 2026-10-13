import { ENGINE_HTTP, RunIdSchema, TaskIdSchema, type EngineHttpRouteName } from "@vtc/shared";

export type RouteParams = Partial<Record<"run" | "task", string>>;
export type RouteQuery = Record<string, string | number | undefined>;

const PARAMS = { run: RunIdSchema, task: TaskIdSchema } as const;

/**
 * The URL of an engine route, from the frozen `ENGINE_HTTP` table (AD-5 rule 4): the dashboard
 * never spells a route itself. Ids are validated against their contracts, so no value can change
 * the path (`../`, `/`, `?`).
 */
export const routeUrl = (
  name: EngineHttpRouteName,
  params: RouteParams = {},
  query: RouteQuery = {},
): string => {
  const path = ENGINE_HTTP.routes[name].path.replace(/:(run|task)\b/g, (_match, key: string) => {
    const param = key as keyof typeof PARAMS;
    const value = params[param];
    if (value === undefined || !PARAMS[param].safeParse(value).success) {
      throw new TypeError(`invalid ${param} id for route ${name}`);
    }
    return encodeURIComponent(value);
  });
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const qs = search.toString();
  return qs === "" ? path : `${path}?${qs}`;
};

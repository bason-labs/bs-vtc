/** Pure helpers of the D-cl live checks (scripts/dcl-check.ts, spine §5 reading 206). */

/**
 * The adapter's argv with its one `web_search="<from>"` override set to `to`: how the Codex check
 * runs a mode the adapter never emits. Throws unless the override is there exactly once, and
 * refuses `live`, which no check ever asks for (D-cf).
 */
export const swapWebSearch = (args: readonly string[], from: string, to: string): string[] => {
  if (to === "live") throw new Error("the D-cl check never runs live web search (D-cf)");
  const current = `web_search="${from}"`;
  const at = args.flatMap((arg, i) => (arg === current ? [i] : []));
  if (at.length !== 1) {
    throw new Error(`expected exactly one ${current} override, found ${String(at.length)}`);
  }
  return args.map((arg) => (arg === current ? `web_search="${to}"` : arg));
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const parse = (line: string): unknown => {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
};

export interface CodexWebSearchSummary {
  /** Every item type the stream carried, with its count. */
  readonly itemTypes: Readonly<Record<string, number>>;
  /** The completed web-search items, as the stream printed them. */
  readonly webSearchItems: readonly unknown[];
  /** Web-search actions other than a search (an opened page, a find in a page). */
  readonly pageActions: readonly unknown[];
}

/**
 * What a `codex exec --json` stream shows about web search: the item types, every completed item
 * whose type names web search, and any action on such an item that is not a plain search (an
 * opened page is what `cached` must never show).
 */
export const summarizeCodexWebSearch = (lines: readonly string[]): CodexWebSearchSummary => {
  const itemTypes: Record<string, number> = {};
  const webSearchItems: unknown[] = [];
  const pageActions: unknown[] = [];
  for (const line of lines) {
    const event = parse(line);
    if (!isObject(event) || event.type !== "item.completed" || !isObject(event.item)) continue;
    const type = typeof event.item.type === "string" ? event.item.type : "<none>";
    itemTypes[type] = (itemTypes[type] ?? 0) + 1;
    if (!/web_?search/iu.test(type)) continue;
    webSearchItems.push(event.item);
    const action = event.item.action;
    if (isObject(action) && action.type !== undefined && action.type !== "search") {
      pageActions.push(action);
    }
  }
  return { itemTypes, webSearchItems, pageActions };
};

/** The debug-log lines a plugin load proof reads: every line that names a plugin. */
export const pluginDebugLines = (log: string): string[] =>
  log.split("\n").filter((line) => /plugin/iu.test(line));

/** The `init` record's plugin and agent fields of a Claude stream (null when there is none). */
export const armInitFields = (
  lines: readonly string[],
): { plugins: unknown; agents: unknown } | null => {
  for (const line of lines) {
    const event = parse(line);
    if (isObject(event) && event.type === "system" && event.subtype === "init") {
      return { plugins: event.plugins ?? null, agents: event.agents ?? null };
    }
  }
  return null;
};

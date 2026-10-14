/**
 * robots.txt (RFC 9309), which the `web` fetcher honours (AD-22 rule 1). Pure.
 *
 * - The group for VTC's product token wins; otherwise the `*` group; several groups for the same
 *   token are merged (§2.2.1).
 * - The most specific (longest) matching rule decides; on a tie `allow` wins (§2.2.2).
 * - `*` matches any run of characters and a trailing `$` anchors the end (§2.2.3).
 * - `/robots.txt` itself is always allowed (§2.2.2).
 *
 * The file is untrusted, so matching never compiles a rule into a RegExp: {@link robotsPatternMatches}
 * is a greedy wildcard matcher (as in the RFC's reference parsers), linear in the path for each
 * pattern segment. Rules are capped per file and in length (§2.5 lets a crawler bound the parse).
 */

/** Rules read from one robots.txt; later ones are ignored. */
export const ROBOTS_MAX_RULES = 2000;
/** Longest rule pattern kept; a longer one is ignored. */
export const ROBOTS_MAX_PATTERN = 1024;

interface Rule {
  readonly allow: boolean;
  readonly pattern: string;
}

interface Group {
  readonly agents: string[];
  readonly rules: Rule[];
}

const parseGroups = (text: string): Group[] => {
  const groups: Group[] = [];
  let current: Group | undefined;
  let lastWasAgent = false;
  let rules = 0;
  for (const rawLine of text.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === "user-agent") {
      if (current === undefined || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    if ((key === "allow" || key === "disallow") && current !== undefined) {
      lastWasAgent = false;
      // An empty `disallow` allows everything: it is no rule at all.
      if (value !== "" && value.length <= ROBOTS_MAX_PATTERN && rules < ROBOTS_MAX_RULES) {
        current.rules.push({ allow: key === "allow", pattern: value });
        rules += 1;
      }
      continue;
    }
    // Other records (sitemap, crawl-delay) neither start nor end a group.
  }
  return groups;
};

/**
 * Whether a robots.txt pattern matches the path (§2.2.3): `*` matches any run of characters, a
 * trailing `$` anchors the end, and otherwise the pattern matches a prefix. Greedy and
 * backtracking-free: the first segment must be a prefix, each middle segment takes its leftmost
 * occurrence after the previous one (leftmost is always safe for `*`), and an anchored last
 * segment must end the path.
 */
export const robotsPatternMatches = (pattern: string, path: string): boolean => {
  const anchored = pattern.endsWith("$");
  const segments = (anchored ? pattern.slice(0, -1) : pattern).split("*");
  const head = segments[0] ?? "";
  if (!path.startsWith(head)) return false;
  if (segments.length === 1) return !anchored || path.length === head.length;
  let at = head.length;
  const last = segments.length - 1;
  for (let i = 1; i < last; i += 1) {
    const segment = segments[i] ?? "";
    if (segment === "") continue;
    const found = path.indexOf(segment, at);
    if (found === -1) return false;
    at = found + segment.length;
  }
  const tail = segments[last] ?? "";
  if (!anchored) return tail === "" || path.indexOf(tail, at) !== -1;
  return path.length - tail.length >= at && path.endsWith(tail);
};

/** Whether `productToken` may fetch `pathAndQuery` (e.g. `/docs/a?x=1`) under `robotsText`. */
export const robotsAllows = (
  robotsText: string,
  productToken: string,
  pathAndQuery: string,
): boolean => {
  if (pathAndQuery === "/robots.txt") return true;
  const groups = parseGroups(robotsText);
  const token = productToken.toLowerCase();
  const own = groups.filter((g) => g.agents.includes(token));
  const chosen = own.length > 0 ? own : groups.filter((g) => g.agents.includes("*"));
  let best: Rule | undefined;
  for (const rule of chosen.flatMap((g) => g.rules)) {
    if (!robotsPatternMatches(rule.pattern, pathAndQuery)) continue;
    if (
      best === undefined ||
      rule.pattern.length > best.pattern.length ||
      (rule.pattern.length === best.pattern.length && rule.allow && !best.allow)
    ) {
      best = rule;
    }
  }
  return best === undefined || best.allow;
};

/** The product token VTC's user agent `vtc-research/1` presents to robots.txt. */
export const robotsProductToken = (userAgent: string): string =>
  userAgent.split("/")[0] ?? userAgent;

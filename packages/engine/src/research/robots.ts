/**
 * robots.txt (RFC 9309), which the `web` fetcher honours (AD-22 rule 1). Pure.
 *
 * - The group for VTC's product token wins; otherwise the `*` group; several groups for the same
 *   token are merged (§2.2.1).
 * - The most specific (longest) matching rule decides; on a tie `allow` wins (§2.2.2).
 * - `*` matches any run of characters and a trailing `$` anchors the end (§2.2.3).
 * - `/robots.txt` itself is always allowed (§2.2.2).
 */

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
      if (value !== "") current.rules.push({ allow: key === "allow", pattern: value });
      continue;
    }
    // Other records (sitemap, crawl-delay) neither start nor end a group.
  }
  return groups;
};

const escapeRegExp = (text: string): string => text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");

const matches = (pattern: string, path: string): boolean => {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const source = body.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`).test(path);
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
    if (!matches(rule.pattern, pathAndQuery)) continue;
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

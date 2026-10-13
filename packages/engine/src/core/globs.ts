/**
 * Repo-relative POSIX globs (`files_scope`, risk-rule paths, acceptance globs). Supports `**`
 * (any number of segments), `*` (within a segment), `?` and `{a,b}`. Pure.
 */

const escape = (c: string): string => c.replace(/[.+^${}()|[\]\\]/g, "\\$&");

const cache = new Map<string, RegExp>();

/** The regular expression of a glob (anchored). */
export const globToRegExp = (glob: string): RegExp => {
  const hit = cache.get(glob);
  if (hit !== undefined) return hit;
  let out = "";
  let i = 0;
  let inBraces = false;
  while (i < glob.length) {
    const c = glob.charAt(i);
    if (c === "*") {
      if (glob.charAt(i + 1) === "*") {
        const atSegmentStart = i === 0 || glob.charAt(i - 1) === "/";
        const atSegmentEnd = i + 2 === glob.length || glob.charAt(i + 2) === "/";
        if (atSegmentStart && atSegmentEnd) {
          if (glob.charAt(i + 2) === "/") {
            out += "(?:[^/]*/)*";
            i += 3;
          } else {
            out += ".*";
            i += 2;
          }
          continue;
        }
        out += "[^/]*";
        i += 2;
        continue;
      }
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "{") {
      inBraces = true;
      out += "(?:";
    } else if (c === "}" && inBraces) {
      inBraces = false;
      out += ")";
    } else if (c === "," && inBraces) {
      out += "|";
    } else {
      out += escape(c);
    }
    i += 1;
  }
  const re = new RegExp(`^${out}$`);
  cache.set(glob, re);
  return re;
};

export const globMatch = (glob: string, path: string): boolean => globToRegExp(glob).test(path);

export const matchesAny = (globs: readonly string[], path: string): boolean =>
  globs.some((g) => globMatch(g, path));

/** The literal leading segments of a glob, before the first segment with a wildcard. */
const staticPrefix = (glob: string): string[] => {
  const segments = glob.split("/");
  const out: string[] = [];
  for (const segment of segments) {
    if (/[*?{}[\]]/.test(segment)) break;
    out.push(segment);
  }
  return out;
};

const hasWildcard = (glob: string): boolean => /[*?{}[\]]/.test(glob);

/**
 * Conservative overlap test for two globs (§6.6: the engine refuses to run two tasks with
 * overlapping `files_scope` at the same time). True when some path could match both: two literal
 * paths are equal, a literal path matches the other glob, or one glob's literal prefix contains
 * the other's. It may report an overlap that no real file has; it never misses one.
 */
export const globsOverlap = (a: string, b: string): boolean => {
  if (!hasWildcard(a) && !hasWildcard(b)) return a === b;
  if (!hasWildcard(a)) return globMatch(b, a);
  if (!hasWildcard(b)) return globMatch(a, b);
  const pa = staticPrefix(a);
  const pb = staticPrefix(b);
  const n = Math.min(pa.length, pb.length);
  for (let i = 0; i < n; i += 1) if (pa[i] !== pb[i]) return false;
  return true;
};

export const scopesOverlap = (a: readonly string[], b: readonly string[]): boolean =>
  a.some((x) => b.some((y) => globsOverlap(x, y)));

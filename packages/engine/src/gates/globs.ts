/**
 * Repo-relative POSIX globs (`files_scope`, protected configs, `when_changed`). Same semantics as
 * engine core's matcher (`**`, `*`, `?`, `{a,b}`), kept here because `gates/` never imports
 * `core/` (AD-13 rule 2). Pure.
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

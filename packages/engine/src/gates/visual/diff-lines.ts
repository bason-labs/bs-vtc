/**
 * Added lines of a unified diff with their line numbers in the new file, so token lint
 * (§7.5 step 1) reports only what the diff added (§7.1: only new problems block) and points at
 * the line. Pure.
 */

export interface AddedLine {
  readonly line: number;
  readonly text: string;
}

const unquote = (target: string): string => {
  if (!(target.startsWith('"') && target.endsWith('"'))) return target;
  try {
    return JSON.parse(target) as string;
  } catch {
    return target.slice(1, -1);
  }
};

/** Added lines by path (`git diff` output, any context size). Deleted files have none. */
export const addedLinesWithNumbers = (diff: string): Map<string, AddedLine[]> => {
  const out = new Map<string, AddedLine[]>();
  let current: AddedLine[] | null = null;
  let next = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const target = unquote(raw.slice(4).trim());
      if (target === "/dev/null") current = null;
      else {
        const path = target.replace(/^b\//, "");
        current = out.get(path) ?? [];
        out.set(path, current);
      }
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("diff --git ")) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk?.[1] !== undefined) {
      next = Number(hunk[1]);
      continue;
    }
    if (current === null || next === 0) continue;
    if (raw.startsWith("+")) {
      current.push({ line: next, text: raw.slice(1) });
      next += 1;
    } else if (raw.startsWith(" ")) next += 1;
    // "-" lines and "\ No newline at end of file" do not advance the new file.
  }
  return out;
};

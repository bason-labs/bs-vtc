/**
 * The Architect's machine-checkable AD Checks (§8.5; spine §5 reading 126): the format the
 * Architect writes and the Gate Runner compiles into layer L6. The approved spine
 * (`.vtc/architecture/spine.md`, {@link ARCHITECTURE_SPINE_PATH}) carries, under an `AD-n`
 * heading, one fenced block per Check whose info string is {@link AD_CHECK_FENCE}:
 *
 * ```vtc-check
 * kind: import-boundary        # or forbidden-dependency, forbidden-pattern
 * mode: blocking               # or warn (non-blocking, §8.5)
 * from: ["src/ui/**"]          # files whose imports are checked
 * forbid: ["src/db/**"]        # files they may not import
 * forbid_packages: ["pg"]      # packages they may not import
 * ```
 *
 * The block body is YAML parsed into {@link AdCheckSpecSchema}. Checks written in prose (`Check:
 * review`, a named external tool) are not compiled: external tools run as calibrated L6 gates.
 * New in 4.6.0 (the Gate Runner's provisional format, frozen).
 */
import { z } from "zod";

/** Where the Architect writes the spine (artifact type `architecture`). */
export const ARCHITECTURE_SPINE_PATH = ".vtc/architecture/spine.md";

/** The info string of a machine-checkable Check's fenced block. */
export const AD_CHECK_FENCE = "vtc-check";

const Globs = z.array(z.string().min(1).max(300)).max(50);
const Mode = z.enum(["blocking", "warn"]).default("blocking");

/** Most unbounded quantifiers (`*`, `+`, `{n,}`) a `forbidden-pattern` may have. */
export const MAX_UNBOUNDED_QUANTIFIERS = 2;

/**
 * Why a `forbidden-pattern` is refused, or `null`. It runs in the engine process with no way to
 * interrupt a match, so only patterns whose matching time stays polynomial and small on a capped
 * line are accepted: valid, no backreference, no repeated group that itself repeats or holds an
 * alternation (`(a+)+`, `(a|ab)*`: exponential backtracking), at most
 * {@link MAX_UNBOUNDED_QUANTIFIERS} unbounded quantifiers.
 */
export const patternProblem = (pattern: string): string | null => {
  try {
    new RegExp(pattern);
  } catch {
    return "not a valid regular expression";
  }
  if (/\\[1-9]|\\k</.test(pattern)) return "a backreference is not allowed in a forbidden-pattern";
  /** Per open group: whether it holds a repeating quantifier or an alternation. */
  const frames: { repeats: boolean; alternates: boolean }[] = [
    { repeats: false, alternates: false },
  ];
  /** The atom a following quantifier applies to: a closed group's facts, or a plain atom. */
  let last: { repeats: boolean; alternates: boolean } | null = null;
  let unbounded = 0;
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    const top = frames[frames.length - 1] ?? { repeats: false, alternates: false };
    if (c === "\\") {
      i += 1;
      last = { repeats: false, alternates: false };
      continue;
    }
    if (c === "[") {
      for (i += 1; i < pattern.length && pattern[i] !== "]"; i += 1)
        if (pattern[i] === "\\") i += 1;
      last = { repeats: false, alternates: false };
      continue;
    }
    if (c === "(") {
      frames.push({ repeats: false, alternates: false });
      last = null;
      continue;
    }
    if (c === ")") {
      const closed = frames.pop() ?? { repeats: false, alternates: false };
      const parent = frames[frames.length - 1];
      if (parent !== undefined) {
        parent.repeats ||= closed.repeats;
        parent.alternates ||= closed.alternates;
      }
      last = closed;
      continue;
    }
    if (c === "|") {
      top.alternates = true;
      last = null;
      continue;
    }
    let max: number | null = null;
    if (c === "*" || c === "+") max = Infinity;
    else if (c === "?") max = 1;
    else if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
      if (m !== null) {
        max = m[2] === undefined ? Number(m[1]) : m[3] === "" ? Infinity : Number(m[3]);
        i += m[0].length - 1;
      }
    }
    if (max === null) {
      last = { repeats: false, alternates: false };
      continue;
    }
    if (pattern[i + 1] === "?") i += 1; // lazy: the same backtracking
    if (max > 1) {
      if (last !== null && (last.repeats || last.alternates)) {
        return "a repeated group may not repeat inside or hold an alternation (catastrophic backtracking); rewrite the pattern";
      }
      top.repeats = true;
    }
    if (max === Infinity) unbounded += 1;
    last = { repeats: false, alternates: false };
  }
  return unbounded > MAX_UNBOUNDED_QUANTIFIERS
    ? `at most ${String(MAX_UNBOUNDED_QUANTIFIERS)} unbounded quantifiers (*, +, {n,}) in a forbidden-pattern`
    : null;
};

export const AdCheckSpecSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("import-boundary"),
    mode: Mode,
    /** Files whose imports are checked. */
    from: Globs.min(1),
    /** Files (repo-relative globs) those files may not import. */
    forbid: Globs.default([]),
    /** Packages (bare specifiers, `a` or `a/sub`) those files may not import. */
    forbid_packages: z.array(z.string().min(1).max(200)).max(50).default([]),
    /** Files exempt from the check. */
    except: Globs.default([]),
    message: z.string().min(1).max(500).optional(),
  }),
  z.strictObject({
    kind: z.literal("forbidden-dependency"),
    mode: Mode,
    /** Packages no manifest may add (package.json, requirements*.txt, pyproject.toml, go.mod). */
    packages: z.array(z.string().min(1).max(200)).min(1).max(100),
    message: z.string().min(1).max(500).optional(),
  }),
  z.strictObject({
    kind: z.literal("forbidden-pattern"),
    mode: Mode,
    /** Files the pattern may not appear in. */
    paths: Globs.min(1),
    /** A JavaScript regular expression, matched per line (see {@link patternProblem}). */
    pattern: z
      .string()
      .min(1)
      .max(500)
      .superRefine((p, ctx) => {
        const problem = patternProblem(p);
        if (problem !== null) ctx.addIssue({ code: "custom", message: problem });
      }),
    except: Globs.default([]),
    message: z.string().min(1).max(500).optional(),
  }),
]);
export type AdCheckSpec = z.infer<typeof AdCheckSpecSchema>;

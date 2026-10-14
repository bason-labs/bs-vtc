/**
 * The Architect's AD Checks as the Gate Runner compiles them into layer L6 (§8.5: "the engine
 * compiles each Check into a tool config … each Check runs in gate L6, as blocking or warn").
 *
 * The approved spine (`.vtc/architecture/spine.md`, read at the run's base commit so a diff
 * cannot change what verifies it) carries, under an `AD-n` heading, one fenced block per
 * machine-checkable Check:
 *
 * ```vtc-check
 * kind: import-boundary        # or forbidden-dependency, forbidden-pattern
 * mode: blocking               # or warn (non-blocking, §8.5)
 * from: ["src/ui/**"]          # files whose imports are checked
 * forbid: ["src/db/**"]        # files they may not import
 * forbid_packages: ["pg"]      # packages they may not import
 * ```
 *
 * PROVISIONAL (contract proposal): the block format is VTC's own until it is frozen in
 * `@vtc/shared` and taught to the Architect; Checks written in prose (`Check: review`, a named
 * external tool) are not compiled here: external tools run as calibrated L6 gates.
 */
import { parse } from "yaml";
import { z } from "zod";

/** Where the Architect writes the spine (artifact type `architecture`). */
export const ARCHITECTURE_SPINE_PATH = ".vtc/architecture/spine.md";

const Globs = z.array(z.string().min(1).max(300)).max(50);
const Mode = z.enum(["blocking", "warn"]).default("blocking");

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
    /** A JavaScript regular expression, matched per line. */
    pattern: z
      .string()
      .min(1)
      .max(500)
      .refine((p) => {
        try {
          new RegExp(p);
          return true;
        } catch {
          return false;
        }
      }, "not a valid regular expression"),
    except: Globs.default([]),
    message: z.string().min(1).max(500).optional(),
  }),
]);
export type AdCheckSpec = z.infer<typeof AdCheckSpecSchema>;

export interface AdCheck {
  /** `AD-3`. */
  readonly ad: string;
  /** Gate id: `vtc-ad-3`, or `vtc-ad-3-2` for the AD's second block. */
  readonly id: string;
  /** The AD heading's title, e.g. `Search module owns its tables`. */
  readonly title: string;
  readonly spec: AdCheckSpec;
  /** 1-based line of the block's opening fence in the spine. */
  readonly line: number;
}

export interface InvalidAdCheck {
  readonly ad: string;
  readonly id: string;
  readonly line: number;
  readonly problem: string;
}

const HEADING = /^#{1,6}\s+(?:\*\*)?(AD-([1-9]\d*))\b[\s:.\-–—]*(.*?)(?:\*\*)?\s*$/;
const BOLD_AD = /^\*\*(AD-([1-9]\d*))\b[\s:.\-–—]*(.*?)\*\*/;

/** Every `vtc-check` block of a spine, by the AD it sits under. */
export const parseAdChecks = (
  markdown: string,
): { readonly checks: AdCheck[]; readonly invalid: InvalidAdCheck[] } => {
  const lines = markdown.split("\n");
  const checks: AdCheck[] = [];
  const invalid: InvalidAdCheck[] = [];
  const perAd = new Map<string, number>();
  let ad: { id: string; n: string; title: string } | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const heading = HEADING.exec(line) ?? BOLD_AD.exec(line.trim());
    if (heading?.[1] !== undefined && heading[2] !== undefined) {
      ad = { id: heading[1], n: heading[2], title: (heading[3] ?? "").trim() };
      continue;
    }
    if (/^#{1,6}\s/.test(line)) {
      ad = null;
      continue;
    }
    const anyFence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (anyFence?.[1] !== undefined && anyFence[2]?.trim() !== "vtc-check") {
      // Another fenced block (code, a diagram): its `#` lines are not headings.
      const marker = anyFence[1];
      let j = i + 1;
      while (j < lines.length && !(lines[j] ?? "").trim().startsWith(marker)) j += 1;
      i = j;
      continue;
    }
    const fence = /^(\s*)(`{3,}|~{3,})\s*vtc-check\s*$/.exec(line);
    if (fence?.[2] === undefined) continue;
    const close = fence[2];
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && (lines[j] ?? "").trim() !== close) {
      body.push(lines[j] ?? "");
      j += 1;
    }
    const start = i + 1;
    i = j;
    const owner = ad;
    if (owner === null) {
      invalid.push({
        ad: "AD-?",
        id: `vtc-ad-line-${String(start)}`,
        line: start,
        problem: "a vtc-check block outside any AD-n section",
      });
      continue;
    }
    const n = (perAd.get(owner.id) ?? 0) + 1;
    perAd.set(owner.id, n);
    const id = n === 1 ? `vtc-ad-${owner.n}` : `vtc-ad-${owner.n}-${String(n)}`;
    let raw: unknown;
    try {
      raw = parse(body.join("\n"), { uniqueKeys: true });
    } catch (error) {
      invalid.push({
        ad: owner.id,
        id,
        line: start,
        problem: `not YAML: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    const parsed = AdCheckSpecSchema.safeParse(raw);
    if (!parsed.success) {
      invalid.push({
        ad: owner.id,
        id,
        line: start,
        problem: parsed.error.issues
          .map((issue) => `${issue.path.map(String).join(".") || "(block)"}: ${issue.message}`)
          .join("; "),
      });
      continue;
    }
    checks.push({ ad: owner.id, id, title: owner.title, spec: parsed.data, line: start });
  }
  return { checks, invalid };
};

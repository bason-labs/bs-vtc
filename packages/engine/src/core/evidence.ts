/**
 * Claim checks (§4.2 step 3, principle 3, AD-8 rule 2): every piece of evidence a role cites must
 * resolve before the engine accepts the result (verdicts, claims) or keeps a finding (findings
 * whose evidence does not resolve are discarded, §6.3 step 8). The `ref` formats are the ones of
 * `EvidenceTypeSchema`.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Evidence, GitOps } from "@vtc/shared";

export interface EvidenceContext {
  readonly repoRoot: string;
  readonly git: Pick<GitOps, "readFileAtCommit">;
  /** The commit the result refers to (a task's head); `null` = the repo's working tree. */
  readonly head: string | null;
  /** REQ/AC ids of the frozen spec; empty = not known yet (spec refs are then not checked). */
  readonly specIds: readonly string[];
  readonly commitExists: (sha: string) => Promise<boolean>;
  /**
   * The user's checkout, where the engine writes task packs (reading 270). A role reads its pack
   * there by the absolute path its dispatch names, outside its own worktree, and cites it; such a
   * citation resolves against the pack itself, whichever root the rest of the check uses.
   */
  readonly packRoot?: string;
}

/** Where task packs live (`dispatch-guard.ts`), relative to the user's checkout. */
const PACKS_DIR = ".vtc/state/packs/";

const FULL_SHA = /^([a-f0-9]{40}|[a-f0-9]{64})$/;

const splitLine = (ref: string): { path: string; line: number; end: number } | null => {
  const match = /^(.+):(\d+)(?:-(\d+))?$/.exec(ref);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  const line = Number(match[2]);
  const end = match[3] === undefined ? line : Number(match[3]);
  return line >= 1 && end >= line ? { path: match[1], line, end } : null;
};

const safe = (path: string): boolean =>
  path !== "" && !path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..");

/** `../../packs/a-14.md`: a role's own pack as seen from its worktree (reading 274). */
const RELATIVE_PACK = /^(?:\.\.\/)+packs\/(a-\d+\.md)$/;

/**
 * A pack the role cites, by its absolute or checkout-relative path (reading 270), or by the
 * relative path from its worktree to the pack (reading 274, the only `..` form that resolves).
 */
const packText = (ctx: EvidenceContext, path: string): string | undefined => {
  if (ctx.packRoot === undefined) return undefined;
  const root = `${ctx.packRoot}/`;
  const relative = RELATIVE_PACK.exec(path)?.[1];
  const rel =
    relative !== undefined
      ? `${PACKS_DIR}${relative}`
      : path.startsWith(root)
        ? path.slice(root.length)
        : path;
  if (!rel.startsWith(PACKS_DIR) || !safe(rel)) return undefined;
  const abs = join(ctx.packRoot, rel);
  return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
};

const fileText = async (ctx: EvidenceContext, path: string): Promise<string | undefined> => {
  const pack = packText(ctx, path);
  if (pack !== undefined) return pack;
  if (!safe(path)) return undefined;
  if (ctx.head !== null && !path.startsWith(".vtc/")) {
    const bytes = await ctx.git.readFileAtCommit(ctx.head, path);
    return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
  }
  const abs = join(ctx.repoRoot, path);
  return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
};

const lineCount = (text: string): number => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

/**
 * A spec ref in the forms roles write (reading 274): an id, `<path>#<id>` (the path is ignored),
 * or a `.vtc/spec/` file, bare or with `:<line>`.
 */
const specRefResolves = async (ctx: EvidenceContext, ref: string): Promise<boolean> => {
  if (ctx.specIds.length === 0) return true;
  if (ctx.specIds.includes(ref)) return true;
  const hash = ref.indexOf("#");
  if (hash >= 0) return ctx.specIds.includes(ref.slice(hash + 1));
  const at = splitLine(ref);
  const path = at?.path ?? ref;
  if (!path.startsWith(".vtc/spec/") || !safe(path)) return false;
  const text = await fileText(ctx, path);
  return text !== undefined && (at === null || lineCount(text) >= at.end);
};

/** True when one piece of evidence resolves. */
export const resolves = async (ctx: EvidenceContext, evidence: Evidence): Promise<boolean> => {
  switch (evidence.type) {
    case "file":
      return (await fileText(ctx, evidence.ref)) !== undefined;
    case "file_line":
    case "log_line": {
      const at = splitLine(evidence.ref);
      if (at === null) return false;
      if (evidence.type === "log_line" && !at.path.startsWith(".vtc/")) return false;
      const text = await fileText(ctx, at.path);
      return text !== undefined && lineCount(text) >= at.end;
    }
    case "junit":
    case "sarif":
    case "command_output":
    case "screenshot": {
      const path = evidence.ref.split("#")[0] ?? "";
      return path.startsWith(".vtc/") && safe(path) && existsSync(join(ctx.repoRoot, path));
    }
    case "commit":
      return FULL_SHA.test(evidence.ref) && ctx.commitExists(evidence.ref);
    case "diff": {
      const parts = evidence.ref.split("..");
      const [base, head] = parts;
      if (parts.length !== 2 || base === undefined || head === undefined) return false;
      if (!FULL_SHA.test(base) || !FULL_SHA.test(head)) return false;
      return (await ctx.commitExists(base)) && ctx.commitExists(head);
    }
    case "spec_ref":
      return specRefResolves(ctx, evidence.ref);
    case "fact": {
      const facts = join(ctx.repoRoot, ".vtc/research/facts.jsonl");
      if (!existsSync(facts)) return false;
      return readFileSync(facts, "utf8")
        .split("\n")
        .some((line) => {
          try {
            return (JSON.parse(line) as { id?: unknown }).id === evidence.ref;
          } catch {
            return false;
          }
        });
    }
    case "test":
      // Resolved against the latest JUnit report by the Gate Runner's traceability; accept the id.
      return evidence.ref.trim() !== "";
    case "url":
      return evidence.ref.startsWith("https://");
  }
};

/** The evidence that does not resolve, as `type ref` strings (empty = all resolve). */
export const unresolved = async (
  ctx: EvidenceContext,
  evidence: readonly Evidence[],
): Promise<string[]> => {
  const out: string[] = [];
  for (const e of evidence) if (!(await resolves(ctx, e))) out.push(`${e.type} ${e.ref}`);
  return out;
};

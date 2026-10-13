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
}

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

const fileText = async (ctx: EvidenceContext, path: string): Promise<string | undefined> => {
  if (!safe(path)) return undefined;
  if (ctx.head !== null && !path.startsWith(".vtc/")) {
    const bytes = await ctx.git.readFileAtCommit(ctx.head, path);
    return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
  }
  const abs = join(ctx.repoRoot, path);
  return existsSync(abs) ? readFileSync(abs, "utf8") : undefined;
};

const lineCount = (text: string): number => text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

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
      return ctx.specIds.length === 0 || ctx.specIds.includes(evidence.ref);
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

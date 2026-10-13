/**
 * The L5 write-scope and test-integrity check (§6.3 step 4, §7.2 L5, §7.3; AD-13 rule 3). One
 * implementation with two call sites: engine core runs it on every `submit`, the Gate Runner runs
 * it again as layer L5. It works on commits only (`base..head` through `GitOps`), never on a
 * worktree's uncommitted state, so it sees exactly what the gates verify.
 */
import { createHash } from "node:crypto";
import type {
  GitOps,
  WriteScopeCheckRequest,
  WriteScopeReport,
  WriteScopeViolationKind,
} from "@vtc/shared";
import { matchesAny } from "./globs.js";

/** Test-skip markers on added lines: JS/TS runners, pytest/unittest, Go, JUnit, Rust (§7.2 L5). */
export const SKIP_PATTERNS: readonly RegExp[] = [
  /\b(?:it|test|describe|suite|context|specify|bench)\.(?:skip|only|todo|fixme|skipIf|runIf)\b/,
  /(?<![\w.])(?:xit|xdescribe|xtest|xspecify|fit|fdescribe)\s*\(/,
  /@pytest\.mark\.(?:skip|skipif|xfail)\b/,
  /\bpytest\.(?:skip|xfail|importorskip)\s*\(/,
  /@unittest\.(?:skip|skipIf|skipUnless|expectedFailure)\b/,
  /\bself\.skipTest\s*\(/,
  /\bt\.Skip(?:f|Now)?\s*\(/,
  /@(?:Disabled|Ignore)\b/,
  /#\[ignore\]/,
];

/** Suppression markers on added lines: linters, type checkers, scanners, coverage (§7.2 L5). */
export const SUPPRESSION_PATTERNS: readonly RegExp[] = [
  /eslint-disable/,
  /@ts-(?:ignore|expect-error|nocheck)\b/,
  /biome-ignore/,
  /deno-lint-ignore/,
  /#\s*noqa\b/,
  /#\s*type:\s*ignore\b/,
  /#\s*pylint:\s*disable/,
  /#\s*pyright:\s*ignore/,
  /\/\/\s*nolint\b/,
  /\bNOLINT/,
  /#\s*nosec\b/,
  /\bnosemgrep\b/,
  /\bnoopengrep\b/,
  /gitleaks:allow/,
  /checkov:skip/,
  /(?:istanbul|c8|v8)\s+ignore/,
  /pragma:\s*no\s*cover/,
  /@SuppressWarnings\b/,
  /#!?\[allow\(/,
  /rubocop:disable/,
  /\bnoinspection\b/,
];

/** Existing snapshot files: modifying or deleting one is a rewrite (§7.2 L5). */
export const SNAPSHOT_GLOBS: readonly string[] = [
  "**/__snapshots__/**",
  "**/__image_snapshots__/**",
  "**/*.snap",
  "**/*.ambr",
  "**/*.golden",
  "**/*.approved.*",
];

/** Files whose added lines are prose, where a marker is a mention, not a suppression. */
const PROSE = /\.(?:md|mdx|markdown|txt|rst|adoc)$/i;

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Added lines per file of a unified diff (`+++ b/<path>` headers; `/dev/null` = deleted). */
export const addedLinesByFile = (diff: string): Map<string, string[]> => {
  const out = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      let target = line.slice(4).trim();
      if (target.startsWith('"') && target.endsWith('"')) {
        try {
          target = JSON.parse(target) as string;
        } catch {
          target = target.slice(1, -1);
        }
      }
      current = target === "/dev/null" ? null : target.replace(/^b\//, "");
      if (current !== null && !out.has(current)) out.set(current, []);
      continue;
    }
    if (line.startsWith("diff --git ")) {
      current = null;
      continue;
    }
    if (current !== null && line.startsWith("+")) out.get(current)?.push(line.slice(1));
  }
  return out;
};

/** The markers found in a diff's added lines, as `[kind, path]` pairs. */
export const scanAddedLines = (diff: string): [WriteScopeViolationKind, string][] => {
  const hits: [WriteScopeViolationKind, string][] = [];
  for (const [path, lines] of addedLinesByFile(diff)) {
    if (PROSE.test(path)) continue;
    if (lines.some((l) => SKIP_PATTERNS.some((p) => p.test(l)))) hits.push(["new_skip", path]);
    if (lines.some((l) => SUPPRESSION_PATTERNS.some((p) => p.test(l)))) {
      hits.push(["new_suppression", path]);
    }
  }
  return hits;
};

type ScopeGit = Pick<GitOps, "changedFiles" | "diff" | "readFileAtCommit">;

/** Runs the check. Violations are unique and sorted by path, then kind. */
export const checkWriteScope = async (
  git: ScopeGit,
  request: WriteScopeCheckRequest,
): Promise<WriteScopeReport> => {
  const found = new Map<string, { kind: WriteScopeViolationKind; path: string }>();
  const add = (kind: WriteScopeViolationKind, path: string): void => {
    found.set(`${path}\u0000${kind}`, { kind, path });
  };
  const protectedPaths = new Set(request.protected.map((p) => p.path));

  for (const entry of request.protected) {
    const bytes = await git.readFileAtCommit(request.head, entry.path);
    if (bytes === undefined) add("protected_deleted", entry.path);
    else if (sha256(bytes) !== entry.sha256) add("protected_modified", entry.path);
  }

  const changed = await git.changedFiles(request.base, request.head);
  for (const file of changed) {
    const touched = file.oldPath === undefined ? [file.path] : [file.path, file.oldPath];
    for (const path of touched) {
      if (protectedPaths.has(path)) continue;
      if (!matchesAny(request.filesScope, path)) add("out_of_scope_write", path);
    }
    if (file.status !== "added") {
      const before = file.oldPath ?? file.path;
      if (matchesAny(SNAPSHOT_GLOBS, before)) add("snapshot_rewrite", before);
    }
  }

  if (changed.length > 0) {
    for (const [kind, path] of scanAddedLines(await git.diff(request.base, request.head))) {
      add(kind, path);
    }
  }

  const violations = [...found.values()].sort((a, b) =>
    a.path === b.path ? (a.kind < b.kind ? -1 : 1) : a.path < b.path ? -1 : 1,
  );
  return { ok: violations.length === 0, violations };
};

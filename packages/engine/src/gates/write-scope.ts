/**
 * The L5 write-scope and test-integrity check (§6.3 step 4, §7.2 L5, §7.3; AD-13 rule 3). One
 * implementation with two call sites: engine core runs it on every `submit`, the Gate Runner runs
 * it again as layer L5. It works on commits only (`base..head` through `GitOps`), never on a
 * worktree's uncommitted state, so it sees exactly what the gates verify.
 */
import { createHash } from "node:crypto";
import type {
  GitChangedFile,
  GitOps,
  WriteScopeCheckRequest,
  WriteScopeReport,
  WriteScopeViolationKind,
} from "@vtc/shared";
import { matchesAny, matchesAnyCaseless } from "./globs.js";
import { guardedSections, isMixedConfig } from "./mixed-configs.js";
import {
  DEFAULT_PROTECTED_GLOBS,
  isGateCommandFile,
  SCANNER_CONFIG_GLOBS,
} from "./protected-globs.js";

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

const decode = (bytes: Uint8Array | undefined): string | undefined =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);

/**
 * Whether a diff changed the tool sections of a `pyproject.toml` or `package.json` at `path` (one
 * side of `file`): the base side is the path before a rename, the head side the path after it.
 */
const toolSectionsChanged = async (
  git: ScopeGit,
  request: WriteScopeCheckRequest,
  file: GitChangedFile,
  path: string,
): Promise<boolean> => {
  const isOld = file.oldPath === path;
  const base = file.status === "added" || (file.oldPath !== undefined && !isOld) ? undefined : path;
  const head = file.status === "deleted" || isOld ? undefined : path;
  const before = base === undefined ? undefined : await git.readFileAtCommit(request.base, base);
  const after = head === undefined ? undefined : await git.readFileAtCommit(request.head, head);
  return guardedSections(path, decode(before)) !== guardedSections(path, decode(after));
};

/**
 * Runs the check. Violations are unique and sorted by path, then kind.
 *
 * Besides the checksummed `request.protected` files, every changed file that matches
 * `protectedGlobs` (lint, test and scanner configuration; default {@link DEFAULT_PROTECTED_GLOBS},
 * the runner adds the project's `tests.protected_configs`) is a violation, added files included:
 * a new nested `vitest.config.ts` or `.gitleaksignore` can weaken the gates as much as an edit.
 * A changed scanner config is a `new_suppression`. A `pyproject.toml` or `package.json` is a
 * violation only when its tool sections changed (`mixed-configs.ts`). All of these match in any
 * letter case, because tools find their configs by the canonical name and a case-insensitive file
 * system finds `Vitest.config.ts` under `vitest.config.ts`. A task-runner file (Makefile,
 * justfile, `*.mk`, Taskfile, noxfile.py) or package-manager config (`.npmrc`, `.yarnrc.yml`,
 * `bunfig.toml`, …), in any letter case, is always guarded, like package.json `scripts`, whatever
 * `protectedGlobs` holds (D-y); so are the settings of `pnpm-workspace.yaml`. The only exception is a file
 * the task's `files_scope` names exactly (no wildcard), which is how a plan allows a config change.
 */
export const checkWriteScope = async (
  git: ScopeGit,
  request: WriteScopeCheckRequest,
  protectedGlobs: readonly string[] = DEFAULT_PROTECTED_GLOBS,
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
      if (request.filesScope.includes(path)) continue;
      if (!matchesAnyCaseless(protectedGlobs, path) && !isGateCommandFile(path)) {
        if (isMixedConfig(path) && (await toolSectionsChanged(git, request, file, path))) {
          add(file.status === "deleted" ? "protected_deleted" : "protected_modified", path);
        }
        continue;
      }
      const gone = file.status === "deleted" || file.oldPath === path;
      add(
        gone
          ? "protected_deleted"
          : matchesAnyCaseless(SCANNER_CONFIG_GLOBS, path)
            ? "new_suppression"
            : "protected_modified",
        path,
      );
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

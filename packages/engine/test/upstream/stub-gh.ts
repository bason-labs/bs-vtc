/**
 * A stub `gh` binary for the upstream tests (D-cc): it records every argv (with its cwd, whether
 * `GH_PROMPT_DISABLED` was set and the `--body-file` contents) and answers from canned rules. The
 * real `gh` is never run.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "../helpers/repo.js";

export interface GhRule {
  /** Matches when argv starts with these elements. */
  readonly match: readonly string[];
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
  /** Used at most this many times, then the next matching rule applies. */
  readonly times?: number;
}

export interface GhCall {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly promptDisabled: boolean;
  readonly body?: string;
  readonly attached?: readonly string[];
}

export interface StubGh {
  readonly command: string;
  calls(): GhCall[];
  setRules(rules: readonly GhRule[]): void;
}

const SCRIPT = (dir: string): string => `#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const dir = ${JSON.stringify(dir)};
const args = process.argv.slice(2);
const call = { args, cwd: process.cwd(), promptDisabled: process.env.GH_PROMPT_DISABLED === "1" };
const bf = args.indexOf("--body-file");
if (bf >= 0) call.body = fs.readFileSync(path.join(process.cwd(), args[bf + 1]), "utf8");
const attached = [];
args.forEach((a, i) => {
  if (a === "--attach" && fs.existsSync(path.join(process.cwd(), args[i + 1]))) attached.push(args[i + 1]);
});
if (attached.length > 0) call.attached = attached;
fs.appendFileSync(path.join(dir, "calls.jsonl"), JSON.stringify(call) + "\\n");
const rules = JSON.parse(fs.readFileSync(path.join(dir, "rules.json"), "utf8"));
const usedFile = path.join(dir, "used.json");
const used = fs.existsSync(usedFile) ? JSON.parse(fs.readFileSync(usedFile, "utf8")) : {};
let chosen = null;
rules.forEach((rule, index) => {
  if (chosen !== null) return;
  if (!rule.match.every((m, i) => args[i] === m)) return;
  if (rule.times !== undefined && (used[index] || 0) >= rule.times) return;
  used[index] = (used[index] || 0) + 1;
  chosen = rule;
});
fs.writeFileSync(usedFile, JSON.stringify(used));
chosen = chosen || {};
process.stdout.write(chosen.stdout || "");
process.stderr.write(chosen.stderr || "");
process.exitCode = chosen.code || 0;
`;

export const stubGh = (rules: readonly GhRule[] = []): StubGh => {
  const dir = tempDir("vtc-stub-gh-");
  const command = join(dir, "gh");
  writeFileSync(command, SCRIPT(dir));
  chmodSync(command, 0o755);
  const setRules = (next: readonly GhRule[]): void => {
    writeFileSync(join(dir, "rules.json"), JSON.stringify(next));
    writeFileSync(join(dir, "used.json"), "{}");
  };
  setRules(rules);
  return {
    command,
    setRules,
    calls: () => {
      const file = join(dir, "calls.jsonl");
      if (!existsSync(file)) return [];
      return readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as GhCall);
    },
  };
};

/** `gh issue list|view --json` shape. */
export const ghIssue = (fields: {
  number: number;
  state?: "OPEN" | "CLOSED";
  stateReason?: string;
  labels?: string[];
  body?: string;
  title?: string;
  updatedAt?: string;
  comments?: string[];
}): Record<string, unknown> => ({
  number: fields.number,
  url: `https://github.com/o/r/issues/${String(fields.number)}`,
  title: fields.title ?? "vtc(defect): x",
  state: fields.state ?? "OPEN",
  stateReason: fields.stateReason ?? "",
  labels: (fields.labels ?? ["vtc:auto"]).map((name) => ({ name })),
  body: fields.body ?? "",
  updatedAt: fields.updatedAt ?? "2026-10-01T00:00:00Z",
  comments: (fields.comments ?? []).map((body) => ({ body })),
});

/** `gh pr list|view --json` shape. */
export const ghPr = (fields: {
  number: number;
  head?: string;
  sha?: string;
  draft?: boolean;
  state?: string;
  labels?: string[];
  body?: string;
}): Record<string, unknown> => ({
  number: fields.number,
  url: `https://github.com/o/r/pull/${String(fields.number)}`,
  headRefName: fields.head ?? "vtc/auto/defect/0123abcd",
  headRefOid: fields.sha ?? "a".repeat(40),
  isDraft: fields.draft ?? true,
  state: fields.state ?? "OPEN",
  labels: (fields.labels ?? ["vtc:auto"]).map((name) => ({ name })),
  body: fields.body ?? "",
});

/**
 * Where a gate run writes (AD-18, §7.2): redacted reports, test inventories and traceability go
 * under `.vtc/evidence/<T-n|F-n>/` (git-tracked); raw output stays under `.vtc/state/gates/`
 * (gitignored). Every git-tracked write passes `redactSecrets` / `redactJson` with the repo's
 * known secret values, collected over the whole run first (secret-scanner matches and `.env`
 * values), so a secret one gate found is redacted from every other gate's evidence too.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { dotenvValues, redactJson, redactSecrets } from "@vtc/shared";
import { writeRepoFile } from "../git/index.js";
import type { JunitCase } from "./parsers/junit.js";

export const GATES_STATE_DIR = ".vtc/state/gates";
export const EVIDENCE_DIR = ".vtc/evidence";

/** `.vtc/evidence/<T-n|F-n>/traceability.json` (AD-18 rule 3). */
export const traceabilityPath = (owner: string): string =>
  `${EVIDENCE_DIR}/${owner}/traceability.json`;

export type PendingWrite =
  | { readonly rel: string; readonly redact: boolean; readonly text: string }
  /** Binary evidence (visual screenshots and diffs): written as it is, never redacted. */
  | { readonly rel: string; readonly redact: false; readonly bytes: Uint8Array }
  | {
      readonly rel: string;
      readonly redact: boolean;
      readonly json: unknown;
      /** Re-normalises the value after redaction (a test inventory is re-sorted by its new ids). */
      readonly normalize?: (redacted: unknown) => unknown;
    };

/**
 * Values to redact by value: every `.env` file at the top of the repo and of the checkout
 * (`.env`, `.env.local`, `.env.production`…), plus the given secret-scanner matches.
 */
export const knownSecretValues = (
  dirs: readonly string[],
  scannerSecrets: readonly string[],
): string[] => {
  const values = new Set(scannerSecrets.map((s) => s.trim()).filter((s) => s !== ""));
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name !== ".env" && !name.startsWith(".env.")) continue;
      try {
        for (const v of dotenvValues(readFileSync(join(dir, name), "utf8"))) values.add(v);
      } catch {
        // unreadable: nothing to add
      }
    }
  }
  return [...values];
};

/** Writes every pending file; git-tracked ones (`redact`) through the redaction filter. */
export const flushWrites = (
  repoRoot: string,
  writes: readonly PendingWrite[],
  knownValues: readonly string[],
): void => {
  for (const write of writes) {
    if ("bytes" in write) {
      writeRepoFile(repoRoot, write.rel, write.bytes);
      continue;
    }
    const json =
      "json" in write
        ? write.redact
          ? (write.normalize ?? ((v: unknown) => v))(redactJson(write.json, knownValues))
          : write.json
        : undefined;
    const body =
      "json" in write
        ? `${JSON.stringify(json, null, 2)}\n`
        : write.redact
          ? redactSecrets(write.text, knownValues)
          : write.text;
    writeRepoFile(repoRoot, write.rel, body);
  }
};

const escapeXml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // XML 1.0 forbids most control characters.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

export const HIDDEN_DETAILS_WITHHELD = "hidden acceptance test: details withheld";

/**
 * A normalised JUnit document of one L2 run for evidence. Failure details of hidden acceptance
 * tests are withheld (§7.3: hidden tests never reach evidence); every test id is the case name,
 * so `junit` evidence `report#test-id` resolves against it.
 */
export const toJunitXml = (
  gateId: string,
  cases: readonly JunitCase[],
  hidden: ReadonlySet<string>,
): string => {
  const count = (status: string): number => cases.filter((c) => c.status === status).length;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="${escapeXml(gateId)}" tests="${String(cases.length)}" failures="${String(count("fail"))}" errors="${String(count("error"))}" skipped="${String(count("skipped"))}">`,
    `  <testsuite name="${escapeXml(gateId)}" tests="${String(cases.length)}">`,
  ];
  for (const c of cases) {
    const attrs = `name="${escapeXml(c.id)}"${c.assertions === null ? "" : ` assertions="${String(c.assertions)}"`}`;
    if (c.status === "pass") {
      lines.push(`    <testcase ${attrs}/>`);
      continue;
    }
    const message = hidden.has(c.id) ? HIDDEN_DETAILS_WITHHELD : (c.message ?? "");
    const child =
      c.status === "skipped"
        ? "<skipped/>"
        : `<${c.status === "fail" ? "failure" : "error"} message="${escapeXml(message.split("\n")[0] ?? "")}">${escapeXml(message)}</${c.status === "fail" ? "failure" : "error"}>`;
    lines.push(`    <testcase ${attrs}>${child}</testcase>`);
  }
  lines.push("  </testsuite>", "</testsuites>", "");
  return lines.join("\n");
};

/** A run attempt's directory name: unique among existing attempts of the same owner. */
export const attemptId = (
  repoRoot: string,
  dirs: readonly string[],
  reason: string,
  head: string,
  now: Date,
): string => {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  const base = `${stamp}-${reason}-${head.slice(0, 12)}`;
  for (let n = 1; ; n += 1) {
    const id = n === 1 ? base : `${base}-${String(n)}`;
    if (!dirs.some((d) => existsSync(join(repoRoot, d, id)))) return id;
  }
};

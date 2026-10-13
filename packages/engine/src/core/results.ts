/**
 * Accepted role results, kept whole in gitignored `.vtc/state/results/` (raw output stays out of
 * git, AD-18 rule 1). The log records what triage needs to replay; the full result (finding
 * drafts, verdict evidence) is what triage reads when the last reviewer of a round reports, even
 * across an engine restart.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RoleResultSchema, SlugSchema, type RoleResult } from "@vtc/shared";

export const RESULTS_DIR = ".vtc/state/results";

const pathOf = (repoRoot: string, actionId: string): string =>
  join(repoRoot, RESULTS_DIR, `${SlugSchema.parse(actionId)}.json`);

export const saveResult = (repoRoot: string, actionId: string, result: RoleResult): void => {
  const path = pathOf(repoRoot, actionId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(result)}\n`, { mode: 0o600 });
};

export const loadResult = (repoRoot: string, actionId: string): RoleResult | undefined => {
  const path = pathOf(repoRoot, actionId);
  if (!existsSync(path)) return undefined;
  try {
    const parsed = RoleResultSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Accepted role results, kept whole in gitignored `.vtc/state/results/` (raw output stays out of
 * git, AD-18 rule 1). The log records what triage needs to replay; the full result (finding
 * drafts, verdict evidence) is what triage reads when the last reviewer of a round reports, even
 * across an engine restart.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RoleResultSchema, SlugSchema, type RoleResult } from "@vtc/shared";
import { writeRepoFile } from "../git/index.js";

export const RESULTS_DIR = ".vtc/state/results";

const relOf = (actionId: string): string => `${RESULTS_DIR}/${SlugSchema.parse(actionId)}.json`;
const pathOf = (repoRoot: string, actionId: string): string => join(repoRoot, relOf(actionId));

export const saveResult = (repoRoot: string, actionId: string, result: RoleResult): void => {
  writeRepoFile(repoRoot, relOf(actionId), `${JSON.stringify(result)}\n`, 0o600);
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

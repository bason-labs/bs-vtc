/**
 * `pnpm verify:scope <team> [--base <ref>]` (AD-15): fails when the current branch changes any
 * file its team does not own. The orchestrator runs it on every team branch before the merge
 * gate (AD-10 rule 6). Changes outside the team's globs go to the owner as a proposal.
 */
import { changedFiles, loadOwnership, teamOwns } from "./ownership.ts";

const args = process.argv.slice(2);
const team = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--base");
const baseAt = args.indexOf("--base");
const base = baseAt >= 0 ? args[baseAt + 1] : (process.env.VTC_BASE ?? "master");
const map = loadOwnership();

if (team === undefined || base === undefined || map.teams[team] === undefined) {
  console.error(
    `usage: pnpm verify:scope <team> [--base <ref>]; teams: ${Object.keys(map.teams).join(", ")}`,
  );
  process.exit(64);
}
const globs = map.teams[team] ?? [];
const outside = changedFiles(base).filter((path) => !teamOwns(globs, path));
if (outside.length > 0) {
  console.error(`verify:scope: ${team} changed ${String(outside.length)} file(s) it does not own:`);
  for (const path of outside) console.error(`  ${path}`);
  process.exit(1);
}
console.warn(`verify:scope: every change since ${base} is owned by ${team}.`);

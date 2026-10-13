/**
 * `vtc calibrate` (§7.1): detect the toolchain, have a human confirm every command before it runs
 * (§15, the gate allowlist), run every gate twice on the base commit, record flaky tests, and
 * freeze the result as the baseline in `.vtc/gates.yml` once the human confirms it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  gateCommandAllowed,
  GateRunRequestSchema,
  GatesConfigSchema,
  type GateReport,
  type GatesConfig,
  type GitOps,
  type TestRecord,
} from "@vtc/shared";
import { writeRepoFile } from "../../git/index.js";
import {
  addToAllowlist,
  GATES_CONFIG_PATH,
  loadGatesConfig,
  readAllowlist,
  stringifyGatesConfig,
} from "../config.js";
import { downloadOsvDatabase, osvDatabaseDir, osvDatabaseReady } from "../osv-db.js";
import { runWithConfig } from "../runner.js";
import { createScannerStore, type ScannerStore } from "../scanners.js";
import { allowlistPrefix, detectToolchain } from "./detect.js";

export interface CalibrateDeps {
  readonly repoRoot: string;
  readonly vtcHome: string;
  readonly git: GitOps;
  /** The base commit to calibrate on (the repo's `HEAD`). */
  readonly revision: string;
  readonly out: (line: string) => void;
  /**
   * Asks the human (a terminal prompt in the cli). Nothing else confirms: calibration never
   * widens the allowlist or freezes a baseline without a `true` from here.
   */
  readonly confirm: (question: string) => Promise<boolean>;
  readonly now?: () => Date;
  readonly scanners?: ScannerStore;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export type CalibrateOutcome =
  | { readonly status: "dry_run"; readonly yaml: string }
  | { readonly status: "commands_not_confirmed"; readonly pending: string[][] }
  | {
      readonly status: "frozen" | "not_frozen";
      readonly config: GatesConfig;
      readonly flaky: string[];
    };

const statuses = (repoRoot: string, report: GateReport): Map<string, TestRecord["status"]> => {
  const out = new Map<string, TestRecord["status"]>();
  for (const result of report.results) {
    if (result.tests === undefined) continue;
    try {
      const inventory = JSON.parse(
        readFileSync(join(repoRoot, result.tests.inventory), "utf8"),
      ) as { tests?: TestRecord[] };
      for (const t of inventory.tests ?? []) out.set(t.id, t.status);
    } catch {
      // no inventory: nothing to compare
    }
  }
  return out;
};

/** Tests whose outcome differs between two runs of the same commit (§7.1). */
export const flakyBetween = (
  first: ReadonlyMap<string, TestRecord["status"]>,
  second: ReadonlyMap<string, TestRecord["status"]>,
): string[] => {
  const ids = new Set([...first.keys(), ...second.keys()]);
  return [...ids].filter((id) => first.get(id) !== second.get(id)).sort();
};

export const calibrate = async (
  deps: CalibrateDeps,
  options: { readonly dryRun?: boolean } = {},
): Promise<CalibrateOutcome> => {
  const now = deps.now ?? (() => new Date());
  const scanners = deps.scanners ?? createScannerStore({ vtcHome: deps.vtcHome });
  let existing: GatesConfig | null = null;
  try {
    existing = loadGatesConfig(deps.repoRoot);
  } catch (error) {
    deps.out(
      `ignoring the unreadable .vtc/gates.yml: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const detection = detectToolchain(deps.repoRoot, { existing, scanners: scanners.names });
  for (const note of detection.notes) deps.out(`note: ${note}`);
  if (detection.gates.length === 0)
    throw new Error(
      "no gate commands detected; write .vtc/gates.yml by hand and run vtc calibrate again",
    );

  const proposed = GatesConfigSchema.parse({
    version: 1,
    baseline: {
      revision: deps.revision,
      calibrated_at: now().toISOString(),
      confirmed: false,
      flaky_tests: [],
    },
    sources: detection.sources,
    tests: detection.tests,
    gates: detection.gates,
  });
  if (options.dryRun === true) return { status: "dry_run", yaml: stringifyGatesConfig(proposed) };

  // Pinned scanners need no allowlist entry, but the human sees exactly how they will run.
  const scannerGates = proposed.gates.filter((g) => scanners.names.includes(g.command[0] ?? ""));
  if (scannerGates.length > 0) {
    deps.out(
      "Pinned scanners run as (vtc refuses unknown flags, network use and paths outside the checkout):",
    );
    for (const g of scannerGates) deps.out(`  ${g.id}: ${g.command.join(" ")}`);
  }

  // 1. Every command a human has not confirmed on this machine, before anything runs (§15).
  const allowlist = readAllowlist(deps.vtcHome, deps.repoRoot);
  const pending: string[][] = [];
  for (const gate of proposed.gates) {
    if (gateCommandAllowed(gate.command, allowlist, scanners.names)) continue;
    const prefix = allowlistPrefix(gate.command);
    if (!pending.some((p) => p.join("\u0000") === prefix.join("\u0000"))) pending.push(prefix);
  }
  if (pending.length > 0) {
    deps.out("These gate commands would run on this machine (no shell; in a clean checkout):");
    for (const p of pending) deps.out(`  ${p.join(" ")}`);
    if (!(await deps.confirm("Allow these commands for this repo on this machine?"))) {
      return { status: "commands_not_confirmed", pending };
    }
    addToAllowlist(deps.vtcHome, deps.repoRoot, pending, now());
  }

  const stamp = now()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");

  // The offline vulnerability database: downloaded only when the human says so (§7.2, §15).
  const osvGates = proposed.gates.filter((g) => g.command[0] === "osv-scanner");
  if (osvGates.length > 0 && !osvDatabaseReady(deps.vtcHome)) {
    deps.out(
      `WARNING: the osv-scanner offline vulnerability database is not in ${osvDatabaseDir(deps.vtcHome)}; without it the L4 vulnerable-dependency gate cannot run.`,
    );
    if (await deps.confirm("Download the OSV offline vulnerability database now (network)?")) {
      const checkout = await deps.git.createCleanCheckout(deps.revision);
      try {
        const done = await downloadOsvDatabase({
          vtcHome: deps.vtcHome,
          scanners,
          checkoutAbs: join(deps.repoRoot, checkout),
          logDir: join(deps.repoRoot, ".vtc/state/gates", `calibrate-${stamp}-osv-db`),
          env: deps.env ?? process.env,
          now: now(),
        });
        deps.out(done.ok ? `OSV database ${done.detail}` : `WARNING: OSV database: ${done.detail}`);
      } finally {
        await deps.git.removeCheckout(checkout);
      }
    }
  }

  // 2. Everything twice on the base commit (§7.1).
  const runOnce = async (n: number): Promise<GateReport> => {
    const checkout = await deps.git.createCleanCheckout(deps.revision);
    try {
      return await runWithConfig(
        { repoRoot: deps.repoRoot, vtcHome: deps.vtcHome, git: deps.git, now },
        { scanners, ...(deps.env === undefined ? {} : { env: deps.env }) },
        GateRunRequestSchema.parse({
          run: `calibrate-${stamp}-${String(n)}`,
          reason: "calibration",
          scope: "full",
          base: deps.revision,
          head: deps.revision,
          checkout,
        }),
        proposed,
      );
    } finally {
      await deps.git.removeCheckout(checkout);
    }
  };
  deps.out(`Running every gate twice on ${deps.revision.slice(0, 12)}…`);
  const first = await runOnce(1);
  const second = await runOnce(2);
  const flaky = flakyBetween(statuses(deps.repoRoot, first), statuses(deps.repoRoot, second));

  const broken = proposed.gates.filter((g) =>
    [first, second].every((r) => r.results.find((x) => x.gate_id === g.id)?.status === "error"),
  );
  for (const g of broken) {
    deps.out(
      `WARNING: dropped ${g.layer} gate ${g.id}: it could not run on the base commit, so its check is NOT active (see .vtc/state/gates/)`,
    );
    if (g.command[0] === "osv-scanner" && !osvDatabaseReady(deps.vtcHome)) {
      deps.out(
        "  the vulnerable-dependency check needs the OSV offline database: run vtc calibrate again and accept the download",
      );
    }
  }
  const gates = proposed.gates.filter((g) => !broken.includes(g));
  if (gates.length === 0)
    throw new Error("no gate could run on the base commit; fix the toolchain and calibrate again");

  deps.out("Baseline (only new problems will block):");
  for (const g of gates) {
    const a = first.results.find((x) => x.gate_id === g.id);
    const b = second.results.find((x) => x.gate_id === g.id);
    const existingProblems = Math.max(a?.new_violations ?? 0, b?.new_violations ?? 0);
    deps.out(
      `  ${g.layer} ${g.id}: ${a?.status ?? "?"}/${b?.status ?? "?"}, ${String(existingProblems)} existing problem(s)`,
    );
  }
  if (flaky.length > 0)
    deps.out(`Flaky tests (different results on the same commit): ${flaky.join(", ")}`);

  const confirmed = await deps.confirm("Freeze this as the baseline?");
  const config = GatesConfigSchema.parse({
    ...proposed,
    baseline: { ...proposed.baseline, confirmed, flaky_tests: flaky },
    gates,
  });
  writeRepoFile(deps.repoRoot, GATES_CONFIG_PATH, stringifyGatesConfig(config));
  deps.out(
    confirmed
      ? `Wrote ${GATES_CONFIG_PATH} (baseline confirmed). Commit it with the repo.`
      : `Wrote ${GATES_CONFIG_PATH} unconfirmed: gates will not run until vtc calibrate is confirmed.`,
  );
  return { status: confirmed ? "frozen" : "not_frozen", config, flaky };
};

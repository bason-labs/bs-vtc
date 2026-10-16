/**
 * `vtc calibrate` (§7.1): detect the toolchain, have a human confirm every command before it runs
 * (§15, the gate allowlist), run every gate twice on the base commit, record flaky tests, and
 * freeze the result as the baseline in `.vtc/gates.yml` once the human confirms it. Every command
 * (both runs and the OSV database download) runs in the gate sandbox (D-al); with none, and no
 * user-level `gates.allow_unsandboxed`, calibration refuses before it asks or runs anything.
 *
 * It also sets up the visual step's app server (`GatesConfig.visual.app`, contracts 4.6.0): the
 * one in a readable `gates.yml` is kept across re-calibration (with every other `visual`
 * setting); otherwise one is proposed from the package.json `dev`/`start`/`preview` script
 * (`detectVisualApp`), and only a human's yes puts it into `gates.yml` and its argv into the
 * allowlist, like every gate command (§15). `gates.yml` is written only through the typed config.
 *
 * Each check gate gets its tool (H-14, `GateSchema.tool`, {@link withCheckTools}): the `project`
 * tool installed in the working tree, which the Gate Runner verifies by content hash at each run.
 * The confirmed commands include the second pass of each two-pass install (`scriptsFreeInstall`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  GATE_SANDBOX,
  gateCommandAllowed,
  GateRunRequestSchema,
  GatesConfigSchema,
  VisualAppSchema,
  type GateReport,
  type GateSandbox,
  type GatesConfig,
  type GitOps,
  type TestRecord,
  type VisualApp,
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
import { detectGateSandbox, resolveGateSandbox } from "../sandbox.js";
import { createScannerStore, type ScannerStore } from "../scanners.js";
import {
  deriveProjectTool,
  lintPluginPaths,
  scriptsFreeInstall,
  toolPathsCover,
  toolPathsExist,
} from "../tool-integrity.js";
import { appLoopbackPort } from "../visual/app.js";
import { allowlistPrefix, detectToolchain, detectVisualApp, type ProposedGate } from "./detect.js";

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
  /** The gate sandbox (D-al); absent: the machine's own (`detectGateSandbox`). */
  readonly sandbox?: GateSandbox;
  /** `gates.allow_unsandboxed` from `~/.vtc/config.yaml`, read by the cli. Default false. */
  readonly allowUnsandboxed?: boolean;
  /**
   * `gates.allow_tools_hashed_after_scripts` from `~/.vtc/config.yaml` (H-14, reading 250), read
   * by the cli. Calibration runs such gates either way; without it, it warns that runs will not.
   */
  readonly allowToolsHashedAfterScripts?: boolean;
  /** Finds the machine's sandbox when `sandbox` is absent; tests pass `() => null`. */
  readonly detectSandbox?: () => GateSandbox | null;
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

/**
 * The loopback question (D-av, spine §5 reading 84): asked at the terminal confirmation, before
 * anything runs; a yes is recorded as `sandbox.verify_loopback: true` in `.vtc/gates.yml`.
 */
export const LOOPBACK_QUESTION =
  "Does the test suite need sockets to this machine's loopback (127.0.0.1, ::1)? Without it, verify-phase gates get no network at all";

/** The question that puts a proposed app server into `visual.app`. */
export const visualAppQuestion = (app: Pick<VisualApp, "command" | "url">): string =>
  `Use \`${app.command.join(" ")}\` at ${app.url} as the app server the visual step renders screens from? It runs in the gate sandbox, which then may listen on and connect to port ${String(appLoopbackPort(app.url))} of this machine's loopback (on macOS the host's own loopback: any local service already on that port is reachable too, so the visual step stops with an error while one is listening there; no other port)`;

/**
 * Each check gate's tool (H-14, spine §5 reading 238; `GateSchema.tool`): a verify-phase gate
 * whose executable is installed in the working tree (`node_modules/.bin`, a virtual environment,
 * a file of the repository) gets the `project` tool `deriveProjectTool` finds, which the Gate
 * Runner then verifies by content hash at every run; a package script's gate gets the tools its
 * commands run (`pnpm typecheck` running `tsc`). A pinned scanner always runs from the store and
 * needs none; a gate that already names its tool keeps it while that tool still covers what the
 * command runs and names something in the working tree, and gets the derived one otherwise
 * (`refreshed`, reading 249). A gate with no tool found here (a
 * script that runs nothing installed, a tool outside the repository, or one not installed in the
 * working tree) gets none, and each run derives one from its command when it can. A Node lint
 * gate's tool also gets the ESLint plugins, configs and parsers its package.json names (see
 * {@link lintPluginPaths}): ESLint loads them through its config, not as its dependencies.
 */
export const withCheckTools = (
  repoRoot: string,
  gates: readonly ProposedGate[],
  scanners: readonly string[],
): {
  readonly gates: ProposedGate[];
  readonly recorded: string[];
  readonly none: string[];
  readonly refreshed: string[];
} => {
  const recorded: string[] = [];
  const none: string[] = [];
  const refreshed: string[] = [];
  const out = gates.map((gate) => {
    if (gate.phase === "install" || gate.tool?.source === "pinned") return gate;
    if (scanners.includes(gate.command[0] ?? "")) return gate;
    const tool = deriveProjectTool(repoRoot, gate.cwd ?? "", gate.command);
    if (gate.tool !== undefined) {
      // reading 249: a recorded tool is kept while it still covers what the command runs and
      // names something in the checkout; a stale one (a pnpm store path from before a version
      // bump, say) is derived again, since the runner refuses to run a gate with it
      const recordedPaths = gate.tool.paths;
      const stale =
        tool !== null &&
        (tool.paths.some((p) => !toolPathsCover(recordedPaths, p)) ||
          !toolPathsExist(repoRoot, recordedPaths));
      if (!stale) return gate;
      refreshed.push(gate.id);
    } else if (tool === null) {
      none.push(gate.id);
      return gate;
    } else {
      recorded.push(gate.id);
    }
    const plugins =
      gate.layer === "L1" && tool.paths.some((p) => p.includes("node_modules/"))
        ? lintPluginPaths(repoRoot, gate.cwd ?? "").filter((p) => !tool.paths.includes(p))
        : [];
    return { ...gate, tool: { ...tool, paths: [...tool.paths, ...plugins].slice(0, 50) } };
  });
  return { gates: out, recorded, none, refreshed };
};

/** `config` with `visual.app` set to `app` (`null`: as it is), every other `visual` setting kept. */
const withVisualApp = (config: GatesConfig, app: VisualApp | null): GatesConfig =>
  app === null ? config : GatesConfigSchema.parse({ ...config, visual: { ...config.visual, app } });

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

  // The visual step's app server: kept when the readable gates.yml has one, else proposed.
  const kept = existing?.visual?.app;
  let app: VisualApp | null = null;
  let proposedApp: VisualApp | null = null;
  if (kept !== undefined) {
    app = kept;
    deps.out(`note: kept the visual app server of .vtc/gates.yml: ${kept.command.join(" ")}`);
  } else {
    const found = detectVisualApp(deps.repoRoot);
    for (const note of found.notes) deps.out(`note: ${note}`);
    if (found.app !== null) {
      proposedApp = VisualAppSchema.parse({ command: found.app.command, url: found.app.url });
    }
  }
  if (detection.gates.length === 0)
    throw new Error(
      "no gate commands detected; write .vtc/gates.yml by hand and run vtc calibrate again",
    );

  const tools = withCheckTools(deps.repoRoot, detection.gates, scanners.names);
  if (tools.recorded.length > 0) {
    deps.out(
      `note: recorded the check tool of ${tools.recorded.join(", ")}: each run verifies its files by content hash, and an install script that changes one fails that gate (H-14)`,
    );
  }
  if (tools.refreshed.length > 0) {
    deps.out(
      `note: replaced the stale check tool of ${tools.refreshed.join(", ")}: its recorded paths no longer covered what the command runs, or named nothing in this working tree (H-14)`,
    );
  }
  if (tools.none.length > 0) {
    deps.out(
      `note: no check tool in this working tree for ${tools.none.join(", ")} (a script that runs nothing installed, a tool outside the repository, or not installed here): each run derives one from the command when it can`,
    );
  }
  const detected = GatesConfigSchema.parse({
    version: 1,
    baseline: {
      revision: deps.revision,
      calibrated_at: now().toISOString(),
      confirmed: false,
      flaky_tests: [],
    },
    sources: detection.sources,
    tests: detection.tests,
    gates: tools.gates,
    ...(existing?.visual === undefined ? {} : { visual: existing.visual }),
  });
  if (options.dryRun === true) {
    return {
      status: "dry_run",
      yaml: stringifyGatesConfig(withVisualApp(detected, app ?? proposedApp)),
    };
  }

  // Nothing runs outside the gate sandbox unless the user opted in (D-al, spine §5 reading 69).
  let detail = "";
  const sandbox = resolveGateSandbox(
    deps,
    deps.detectSandbox ??
      (() => {
        const found = detectGateSandbox();
        detail = found.detail;
        return found.sandbox;
      }),
  );
  if (sandbox === null) {
    throw new Error(
      detail === ""
        ? `${GATE_SANDBOX.noSandboxReason}: install sandbox-exec (macOS) or bwrap (Linux), or set gates.allow_unsandboxed: true in ~/.vtc/config.yaml to run gates unconfined`
        : detail,
    );
  }
  if (sandbox.kind === "none") {
    deps.out(
      `WARNING: ${GATE_SANDBOX.noSandboxReason}: gates.allow_unsandboxed is set, so every gate command runs unconfined, with your files and network`,
    );
  }

  // Pinned scanners need no allowlist entry, but the human sees exactly how they will run.
  const scannerGates = detected.gates.filter((g) => scanners.names.includes(g.command[0] ?? ""));
  if (scannerGates.length > 0) {
    deps.out(
      "Pinned scanners run as (vtc refuses unknown flags, network use and paths outside the checkout):",
    );
    for (const g of scannerGates) deps.out(`  ${g.id}: ${g.command.join(" ")}`);
  }

  if (proposedApp !== null) {
    if (await deps.confirm(visualAppQuestion(proposedApp))) app = proposedApp;
    else {
      deps.out(
        "note: no visual app server: the visual step reports gate infrastructure (error) until visual.app is set in .vtc/gates.yml and confirmed with vtc calibrate",
      );
    }
  }

  // 1. Every command a human has not confirmed on this machine, before anything runs (§15),
  // with the second pass of each two-pass install (H-14: `pnpm rebuild --recursive --pending` after
  // `pnpm install --ignore-scripts`), which runs the scripts the install skipped.
  const allowlist = readAllowlist(deps.vtcHome, deps.repoRoot);
  const pending: string[][] = [];
  const commands = [
    ...detected.gates.flatMap((g) => {
      const build = g.phase === "install" ? scriptsFreeInstall(g.command)?.build : null;
      return build === null || build === undefined ? [g.command] : [g.command, build];
    }),
    ...(app === null ? [] : [app.command]),
  ];
  for (const command of commands) {
    if (gateCommandAllowed(command, allowlist, scanners.names)) continue;
    const prefix = allowlistPrefix(command);
    if (!pending.some((p) => p.join("\u0000") === prefix.join("\u0000"))) pending.push(prefix);
  }
  if (pending.length > 0) {
    deps.out("These gate commands would run on this machine (no shell; in a clean checkout):");
    for (const p of pending) {
      const isApp =
        app !== null && p.join("\u0000") === allowlistPrefix(app.command).join("\u0000");
      deps.out(`  ${p.join(" ")}${isApp ? "  (the visual step's app server)" : ""}`);
    }
    if (!(await deps.confirm("Allow these commands for this repo on this machine?"))) {
      return { status: "commands_not_confirmed", pending };
    }
    addToAllowlist(deps.vtcHome, deps.repoRoot, pending, now());
  }

  // The loopback (D-av): only the human's answer here turns it on; gates.yml is human-calibrated.
  const loopback =
    detected.gates.some((g) => g.phase === "verify") && (await deps.confirm(LOOPBACK_QUESTION));
  const proposed = GatesConfigSchema.parse({
    ...detected,
    ...(loopback ? { sandbox: { verify_loopback: true } } : {}),
  });

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
          sandbox,
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
        { repoRoot: deps.repoRoot, vtcHome: deps.vtcHome, git: deps.git, now, sandbox },
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
  // H-14 (reading 250): a tool hashed only after an install's scripts ran does not run in a real
  // run without the user's opt-in, though calibration measured it
  const afterScripts = proposed.gates.filter(
    (g) =>
      !broken.includes(g) &&
      first.results.find((x) => x.gate_id === g.id)?.tool?.baseline === "after_scripts",
  );
  if (afterScripts.length > 0 && deps.allowToolsHashedAfterScripts !== true) {
    const installs = proposed.gates
      .filter((g) => g.phase === "install" && scriptsFreeInstall(g.command) === null)
      .map((g) => g.id);
    deps.out(
      `WARNING: gate(s) ${afterScripts.map((g) => g.id).join(", ")}: the tool was hashed only after install gate(s) ${installs.join(", ")} ran their scripts (VTC knows no scripts-free form for them), so runs will NOT run these gates (H-14). Use an install command VTC can run scripts-free (npm ci, pnpm install, bun install, go mod download, cargo fetch), a pinned tool, or set gates.allow_tools_hashed_after_scripts: true in ~/.vtc/config.yaml`,
    );
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
  const config = withVisualApp(
    GatesConfigSchema.parse({
      ...proposed,
      baseline: { ...proposed.baseline, confirmed, flaky_tests: flaky },
      gates,
    }),
    app,
  );
  writeRepoFile(deps.repoRoot, GATES_CONFIG_PATH, stringifyGatesConfig(config));
  deps.out(
    confirmed
      ? `Wrote ${GATES_CONFIG_PATH} (baseline confirmed). Commit ${GATES_CONFIG_PATH} now: runs read it at their base commit and park until it is committed.`
      : `Wrote ${GATES_CONFIG_PATH} unconfirmed: gates will not run until vtc calibrate is confirmed.`,
  );
  return { status: confirmed ? "frozen" : "not_frozen", config, flaky };
};

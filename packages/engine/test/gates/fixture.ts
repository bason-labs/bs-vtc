/**
 * A target repo whose gates are small Node scripts, so the Gate Runner runs real processes on
 * real git checkouts without any real toolchain or scanner (no network, no downloads).
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  GateRunRequestSchema,
  type GateReport,
  type GateRunRequestInput,
  type GateSandbox,
  type GateSandboxSpec,
  type GatesConfigInput,
} from "@vtc/shared";

type Gate = GatesConfigInput["gates"][number];
import { createGitOps } from "../../src/git/index.js";
import {
  addToAllowlist,
  createGateRunnerWith,
  stringifyGatesConfig,
  type GateJailSpec,
  type GateRunnerOptions,
  type ReapedGateCommand,
  type ScannerStore,
} from "../../src/gates/index.js";
import { git, initRepo, tempDir, writeFile } from "../helpers/repo.js";

export const NODE = process.execPath;

/** Writes `junit` from every `tests/**\/*.json` case list; exits 1 when a case fails. */
const FAKE_TEST_RUNNER = `
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
const out = process.argv[2];
const cases = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith(".json")) for (const c of JSON.parse(readFileSync(p, "utf8"))) {
      if (c.flaky) {
        // Alternates between runs through a counter outside the checkout.
        let n = 0;
        try { n = Number(readFileSync(c.flaky, "utf8")); } catch {}
        writeFileSync(c.flaky, String(n + 1));
        c.status = n % 2 === 0 ? "pass" : "fail";
      }
      cases.push({ ...c, file: p });
    }
  }
};
walk("tests");
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
const body = cases.map((c) => {
  const a = c.assertions === undefined ? "" : \` assertions="\${c.assertions}"\`;
  const open = \`<testcase classname="\${esc(c.file)}" name="\${esc(c.name)}" file="\${esc(c.file)}"\${a}>\`;
  if (c.status === "fail") return \`\${open}<failure message="\${esc(c.message ?? "failed")}">\${esc(c.message ?? "")}</failure></testcase>\`;
  if (c.status === "skipped") return \`\${open}<skipped/></testcase>\`;
  return \`\${open}</testcase>\`;
});
console.log("ran", cases.length, "tests");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, \`<testsuites><testsuite name="fake">\${body.join("")}</testsuite></testsuites>\`);
process.exit(cases.some((c) => c.status === "fail") ? 1 : 0);
`;

/** Lint: every changed file containing "TODO" is a violation unless .lintrc says "off". */
const FAKE_LINT = `
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
const [out, ...files] = process.argv.slice(2);
const mode = readFileSync(".lintrc", "utf8").trim();
const results = files.map((f) => ({
  filePath: f,
  messages: mode === "off" ? [] : readFileSync(f, "utf8").split("\\n").flatMap((l, i) =>
    l.includes("TODO") ? [{ ruleId: "no-todo", severity: 2, message: "TODO left", line: i + 1 }] : []),
}));
mkdirSync(".vtc/state/gates", { recursive: true });
writeFileSync(out, JSON.stringify(results));
process.exit(results.some((r) => r.messages.length > 0) ? 1 : 0);
`;

/**
 * A fake Gitleaks: reports every line of every file that contains "SECRET=", except in files
 * that a \`.gitleaksignore\` at the top lists (like the real one, it reads that file on its own).
 */
const FAKE_LEAKS = `#!/usr/bin/env node
const { existsSync, readdirSync, readFileSync, writeFileSync, statSync, mkdirSync } = require("node:fs");
const { join, dirname } = require("node:path");
const out = process.argv[process.argv.indexOf("--report-path") + 1];
const ignored = existsSync(".gitleaksignore")
  ? readFileSync(".gitleaksignore", "utf8").split("\\n").map((l) => l.trim()).filter(Boolean)
  : [];
const found = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === ".vtc" || name === "node_modules") continue;
    const p = join(dir, name);
    if (ignored.includes(p)) continue;
    if (statSync(p).isDirectory()) { walk(p); continue; }
    readFileSync(p, "utf8").split("\\n").forEach((l, i) => {
      const m = /SECRET=(\\S+)/.exec(l);
      if (m) found.push({ Description: "generic secret", StartLine: i + 1, EndLine: i + 1, Match: m[0], Secret: m[1], File: p, RuleID: "generic-api-key" });
    });
  }
};
walk(".");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(found));
`;

/**
 * A fake osv-scanner: \`--download-offline-databases\` fills the database directory; a scan
 * writes an empty JSON report (no vulnerabilities).
 */
const FAKE_OSV = `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const args = process.argv.slice(2);
const db = process.env.OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY;
if (args.includes("--download-offline-databases")) {
  mkdirSync(join(db, "npm"), { recursive: true });
  writeFileSync(join(db, "npm", "all.zip"), "fake advisories");
}
const out = args[args.indexOf("--output") + 1];
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ results: [] }));
`;

export const TOOLS: Record<string, string> = {
  "tools/fake-test.mjs": FAKE_TEST_RUNNER,
  "tools/fake-lint.mjs": FAKE_LINT,
  "tools/install.mjs": 'console.log("installed");\n',
  "tools/sleep.mjs": "setTimeout(() => {}, 60000);\n",
  "tools/build.mjs": "process.exit(process.argv[2] === 'broken' ? 2 : 0);\n",
};

export const JUNIT = ".vtc/state/gates/junit.xml";

export const testsGate: Gate = {
  id: "tests",
  layer: "L2",
  command: [NODE, "tools/fake-test.mjs", JUNIT],
  report: { format: "junit", path: JUNIT },
};

export const installGate: Gate = {
  id: "install",
  layer: "L0",
  phase: "install",
  command: [NODE, "tools/install.mjs"],
};

export const leaksGate: Gate = {
  id: "secrets",
  layer: "L4",
  command: [
    "gitleaks",
    "dir",
    ".",
    "--report-format",
    "json",
    "--report-path",
    ".vtc/state/gates/leaks.json",
  ],
  report: { format: "json", path: ".vtc/state/gates/leaks.json" },
};

export const lintGate: Gate = {
  id: "lint",
  layer: "L1",
  command: [NODE, "tools/fake-lint.mjs", ".vtc/state/gates/lint.json", "{changed}"],
  report: { format: "json", path: ".vtc/state/gates/lint.json" },
};

export const config = (
  gates: GatesConfigInput["gates"],
  extra: Partial<GatesConfigInput> = {},
): string =>
  stringifyGatesConfig({
    version: 1,
    baseline: {
      revision: "0".repeat(40),
      calibrated_at: "2026-10-13T08:00:00.000Z",
      confirmed: true,
      flaky_tests: [],
    },
    sources: ["gates_yml"],
    tests: { acceptance_globs: ["tests/acceptance/**"], protected_configs: [".lintrc"] },
    gates,
    ...extra,
  });

export const cases = (
  list: { name: string; status?: string; assertions?: number; message?: string; flaky?: string }[],
): string => JSON.stringify(list.map((c) => ({ status: "pass", ...c })));

export const commitAll = (repo: string, message = "change"): string => {
  git(repo, "add", "--all");
  git(repo, "commit", "--quiet", "--allow-empty", "-m", message);
  return git(repo, "rev-parse", "HEAD");
};

/**
 * A fake gate sandbox: runs the argv as it is and records every spec it was asked to wrap, so
 * tests see that each command went through the sandbox and with what (D-al).
 */
export const recordingSandbox = (
  kind: GateSandbox["kind"] = "sandbox-exec",
): {
  readonly sandbox: GateSandbox;
  readonly specs: GateSandboxSpec[];
  readonly argvs: (readonly string[])[];
} => {
  const specs: GateSandboxSpec[] = [];
  const argvs: (readonly string[])[] = [];
  return {
    specs,
    argvs,
    sandbox: {
      kind,
      wrap: (argv, spec) => {
        specs.push(spec);
        argvs.push(argv);
        return {
          command: argv[0] ?? "",
          args: argv.slice(1),
          network: spec.phase === "verify" ? "none" : "full",
        };
      },
    },
  };
};

/**
 * A stand-in for the macOS in-sandbox reaper (`sandbox.ts` `REAPER_SCRIPT`) that is safe to run
 * unsandboxed: instead of `kill -KILL -1` it kills only the pid the command wrote to
 * `orphan.pid` in its working directory, then confirms with `R` on fd 3. With
 * `confirm = false` it never confirms, like a reaper the gate killed.
 */
export const fakeReaperSandbox = (confirm: boolean): GateSandbox => ({
  kind: "sandbox-exec",
  wrap: (argv, spec): ReapedGateCommand => {
    const script = `s=$1; shift
exec 4<&0 0</dev/null
set -m
{ read -r _ <&4; [ -f orphan.pid ] && kill -KILL "$(cat orphan.pid)"; ${confirm ? '[ -e "$s" ] && printf R >&3;' : ":;"} } >/dev/null 2>&1 &
set +m
exec 3>&- 4<&-
"$@"`;
    return {
      command: "/bin/sh",
      args: ["-c", script, "vtc-gate", (spec as GateJailSpec).reapSentinel ?? "", ...argv],
      network: spec.phase === "verify" ? "none" : "full",
      reaper: true,
    };
  },
});

export interface Harness {
  readonly repo: string;
  readonly home: string;
  readonly base: string;
  /** Every spec the harness's fake sandbox wrapped, in order. */
  readonly specs: readonly GateSandboxSpec[];
  /** Every argv the harness's fake sandbox wrapped, in order. */
  readonly argvs: readonly (readonly string[])[];
  readonly run: (request: Partial<GateRunRequestInput> & { head: string }) => Promise<GateReport>;
  /** Like `run`, but hands the request to the runner unparsed (a malformed caller). */
  readonly runUnparsed: (
    request: Record<string, unknown> & { head: string },
  ) => Promise<GateReport>;
}

export const osvGate: Gate = {
  id: "dependencies",
  layer: "L4",
  command: [
    "osv-scanner",
    "scan",
    "source",
    "--offline",
    "--format",
    "json",
    "--output",
    ".vtc/state/gates/osv.json",
    "-r",
    ".",
  ],
  report: { format: "json", path: ".vtc/state/gates/osv.json" },
};

/** A fake scanner store: `gitleaks` and `osv-scanner` are the fake scripts above; nothing is downloaded. */
export const fakeScanners = (home: string): ScannerStore => {
  const dir = join(home, "fake-scanners");
  mkdirSync(dir, { recursive: true });
  const fakes: Record<string, string> = {};
  for (const [name, script] of [
    ["gitleaks", FAKE_LEAKS],
    ["osv-scanner", FAKE_OSV],
  ] as const) {
    const path = join(dir, name);
    writeFileSync(path, script);
    chmodSync(path, 0o755);
    fakes[name] = path;
  }
  return {
    names: ["gitleaks", "osv-scanner", "opengrep", "checkov"],
    ensure: (name) => {
      const path = fakes[name];
      return path === undefined
        ? Promise.reject(new Error(`no fake ${name}`))
        : Promise.resolve(path);
    },
  };
};

export const harness = (
  files: Record<string, string>,
  gatesYml: string,
  options: {
    allow?: readonly (readonly string[])[];
    now?: () => Date;
    /** The scanner store (default {@link fakeScanners}). */
    scanners?: (home: string) => ScannerStore;
    /** The engine environment the runner scrubs (default `process.env`). */
    env?: Readonly<Record<string, string | undefined>>;
    /**
     * The gate sandbox (default {@link recordingSandbox}). `null`: none injected and none
     * detected, as on a machine without sandbox-exec or bwrap.
     */
    sandbox?: GateSandbox | null;
    /** `gates.allow_unsandboxed` from the user config. */
    allowUnsandboxed?: boolean;
    /** `gates.allow_tools_hashed_after_scripts` from the user config (H-14, reading 250). */
    allowToolsHashedAfterScripts?: boolean;
    /** The visual step's runner and toolchains (AD-24); tests never start a browser. */
    visual?: Pick<GateRunnerOptions, "visualRunner" | "visualToolchains" | "node">;
  } = {},
): Harness => {
  const repo = initRepo({ ...TOOLS, ".lintrc": "strict\n", ...files });
  writeFile(repo, ".vtc/gates.yml", gatesYml);
  const base = commitAll(repo, "base");
  const home = tempDir("vtc-home-");
  addToAllowlist(home, repo, options.allow ?? [[NODE]], new Date("2026-10-13T08:00:00.000Z"));
  const gitOps = createGitOps({ repoRoot: repo });
  const recording = recordingSandbox();
  const sandbox = options.sandbox === undefined ? recording.sandbox : options.sandbox;
  const runner = createGateRunnerWith(
    {
      repoRoot: repo,
      vtcHome: home,
      git: gitOps,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(sandbox === null ? {} : { sandbox }),
      ...(options.allowUnsandboxed === undefined
        ? {}
        : { allowUnsandboxed: options.allowUnsandboxed }),
      ...(options.allowToolsHashedAfterScripts === undefined
        ? {}
        : { allowToolsHashedAfterScripts: options.allowToolsHashedAfterScripts }),
    },
    {
      scanners: (options.scanners ?? fakeScanners)(home),
      env: options.env ?? process.env,
      detectSandbox: () => null,
      ...options.visual,
    },
  );
  return {
    repo,
    home,
    base,
    specs: recording.specs,
    argvs: recording.argvs,
    run: async (partial) => {
      const checkout = await gitOps.createCleanCheckout(partial.head);
      try {
        return await runner.run(
          GateRunRequestSchema.parse({
            run: "r1",
            task: "T-1",
            reason: "round",
            scope: "affected",
            base,
            checkout,
            ...partial,
          }),
        );
      } finally {
        await gitOps.removeCheckout(checkout);
      }
    },
    runUnparsed: async (partial) => {
      const checkout = await gitOps.createCleanCheckout(partial.head);
      try {
        const request = {
          ...GateRunRequestSchema.parse({
            run: "r1",
            task: "T-1",
            reason: "round",
            scope: "affected",
            base,
            checkout,
            head: partial.head,
          }),
          ...partial,
        };
        return await runner.run(request);
      } finally {
        await gitOps.removeCheckout(checkout);
      }
    },
  };
};

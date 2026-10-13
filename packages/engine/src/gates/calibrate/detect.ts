/**
 * Toolchain detection for `vtc calibrate` (§7.1). Sources, in precedence order: an existing
 * `.vtc/gates.yml`; AGENTS.md / CLAUDE.md (hints); task runners (package.json scripts, Makefile,
 * justfile); CI steps (GitHub Actions `run:` lines); the devcontainer; lockfiles. The first source
 * that names a command for a layer wins. Detection only proposes: nothing here runs a command, and
 * every proposed command must be confirmed by a human before it ever runs (§15).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  CalibrationSource,
  GateLayer,
  GatesConfig,
  GatesConfigInput,
  TestLayout,
} from "@vtc/shared";
import { parse } from "yaml";
import { globMatch } from "../globs.js";
import { DEFAULT_PROTECTED_GLOBS } from "../protected-globs.js";

/** A proposed gate (the `GateSchema` input shape). */
export type ProposedGate = GatesConfigInput["gates"][number];

export interface Detection {
  readonly gates: ProposedGate[];
  readonly sources: CalibrationSource[];
  readonly tests: TestLayout;
  /** What detection saw and skipped, for the human reading the proposal. */
  readonly notes: string[];
}

/** Raw reports go under the checkout's `.vtc/state/` (gitignored), never into evidence directly. */
export const REPORT_DIR = ".vtc/state/gates";

type Slot = "install" | "build" | "typecheck" | "lint" | "test" | "arch";

const SLOT_LAYER: Readonly<Record<Slot, GateLayer>> = {
  install: "L0",
  build: "L0",
  typecheck: "L0",
  lint: "L1",
  test: "L2",
  arch: "L6",
};

const SHELL_META = /[|&;<>`$(){}*?\\'"]/;

/** argv of a one-line command, or `null` when it needs a shell (gates run without one). */
export const splitCommand = (line: string): string[] | null => {
  const trimmed = line.trim();
  if (trimmed === "" || SHELL_META.test(trimmed)) return null;
  const argv = trimmed.split(/\s+/);
  return argv.length > 0 && argv.length <= 32 ? argv : null;
};

/** Which slot a command or script name serves, or `null`. */
export const slotOf = (text: string): Slot | null => {
  const t = text.toLowerCase();
  if (
    /\b(dev|start|serve|watch|deploy|release|publish|preview|format|fmt|prettier|clean)\b/.test(t)
  )
    return null;
  if (
    /\b(depcruise|dependency-cruiser|deps:check|arch(itecture)?(:check)?|fitness|import-linter|deptrac|go-arch-lint)\b/.test(
      t,
    )
  )
    return "arch";
  if (/\b(install|ci|sync|mod download|fetch|restore|bootstrap)\b/.test(t) && !/\btest/.test(t))
    return "install";
  if (/\b(test|tests|vitest|jest|pytest|mocha|go test|cargo test|spec)\b/.test(t)) return "test";
  if (/\b(lint|eslint|ruff|flake8|pylint|golangci-lint|clippy|biome)\b/.test(t)) return "lint";
  if (/\b(typecheck|type-check|check-types|tsc|mypy|pyright|go vet|cargo check)\b/.test(t))
    return "typecheck";
  if (/\b(build|compile|go build|cargo build)\b/.test(t)) return "build";
  return null;
};

const readText = (root: string, rel: string): string | null => {
  try {
    return readFileSync(join(root, rel), "utf8");
  } catch {
    return null;
  }
};

const readJson = (root: string, rel: string): Record<string, unknown> | null => {
  const text = readText(root, rel);
  if (text === null) return null;
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

const has = (root: string, rel: string): boolean => existsSync(join(root, rel));

// ------------------------------------------------------------------ toolchains

type NodePm = "pnpm" | "npm" | "yarn" | "bun";

const nodePm = (root: string): NodePm | null => {
  if (has(root, "pnpm-lock.yaml")) return "pnpm";
  if (has(root, "bun.lock") || has(root, "bun.lockb")) return "bun";
  if (has(root, "yarn.lock")) return "yarn";
  if (has(root, "package-lock.json")) return "npm";
  return has(root, "package.json") ? "npm" : null;
};

const NODE_INSTALL: Readonly<Record<NodePm, string[]>> = {
  pnpm: ["pnpm", "install", "--frozen-lockfile"],
  npm: ["npm", "ci"],
  yarn: ["yarn", "install", "--immutable"],
  bun: ["bun", "install", "--frozen-lockfile"],
};

const runScript = (pm: NodePm, script: string): string[] =>
  pm === "npm" ? ["npm", "run", script] : [pm, "run", script];

const execBin = (pm: NodePm, bin: string): string[] =>
  pm === "npm" ? ["npx", "--no-install", bin] : pm === "bun" ? ["bunx", bin] : [pm, "exec", bin];

type PyRunner = "uv" | "poetry" | null;

const pyRunner = (root: string): PyRunner =>
  has(root, "uv.lock") ? "uv" : has(root, "poetry.lock") ? "poetry" : null;

const pyCmd = (runner: PyRunner, argv: string[]): string[] =>
  runner === "uv"
    ? ["uv", "run", ...argv]
    : runner === "poetry"
      ? ["poetry", "run", ...argv]
      : argv;

const deps = (pkg: Record<string, unknown>): Set<string> => {
  const out = new Set<string>();
  for (const key of ["dependencies", "devDependencies"]) {
    const value = pkg[key];
    if (typeof value === "object" && value !== null)
      for (const name of Object.keys(value)) out.add(name);
  }
  return out;
};

// ---------------------------------------------------------------- the sources

interface Candidate {
  readonly slot: Slot;
  readonly gate: ProposedGate;
  readonly source: CalibrationSource;
}

const gateFor = (
  slot: Slot,
  command: string[],
  extra: Partial<ProposedGate> = {},
): ProposedGate => ({
  id: slot,
  layer: SLOT_LAYER[slot],
  command,
  ...(slot === "install" ? { phase: "install" as const, timeout_s: 1200 } : {}),
  ...extra,
});

/** Commands quoted in AGENTS.md / CLAUDE.md (inline code or code blocks), one per line. */
const hintCommands = (root: string): string[] => {
  const out: string[] = [];
  for (const file of ["AGENTS.md", "CLAUDE.md"]) {
    const text = readText(root, file);
    if (text === null) continue;
    for (const match of text.matchAll(/`([^`\n]+)`/g))
      if (match[1] !== undefined) out.push(match[1]);
    for (const block of text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
      for (const line of (block[1] ?? "").split("\n")) out.push(line.replace(/^\$\s*/, ""));
    }
  }
  return out;
};

const KNOWN_RUNNERS =
  /^(pnpm|npm|npx|yarn|bun|bunx|make|just|task|pytest|uv|poetry|ruff|mypy|go|cargo|tox|nox|gradle|\.\/gradlew|mvn)$/;

const fromCommandLines = (lines: readonly string[], source: CalibrationSource): Candidate[] => {
  const out: Candidate[] = [];
  for (const line of lines) {
    const argv = splitCommand(line);
    if (argv === null || !KNOWN_RUNNERS.test(argv[0] ?? "")) continue;
    const slot = slotOf(argv.join(" "));
    if (slot !== null) out.push({ slot, gate: gateFor(slot, argv), source });
  }
  return out;
};

const fromTaskRunners = (root: string): Candidate[] => {
  const out: Candidate[] = [];
  const pkg = readJson(root, "package.json");
  const pm = nodePm(root);
  if (pkg !== null && pm !== null) {
    const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
    for (const [name, body] of Object.entries(scripts)) {
      if (typeof body !== "string" || /^(pre|post)/.test(name)) continue;
      const slot = slotOf(name);
      if (slot !== null && slot !== "install")
        out.push({ slot, gate: gateFor(slot, runScript(pm, name)), source: "task_runner" });
    }
  }
  const make = readText(root, "Makefile");
  if (make !== null) {
    for (const match of make.matchAll(/^([A-Za-z][\w-]*):(?!=)/gm)) {
      const target = match[1] ?? "";
      const slot = slotOf(target);
      if (slot !== null)
        out.push({ slot, gate: gateFor(slot, ["make", target]), source: "task_runner" });
    }
  }
  const just = readText(root, "justfile") ?? readText(root, "Justfile");
  if (just !== null) {
    for (const match of just.matchAll(/^([A-Za-z][\w-]*)\s*:/gm)) {
      const recipe = match[1] ?? "";
      const slot = slotOf(recipe);
      if (slot !== null)
        out.push({ slot, gate: gateFor(slot, ["just", recipe]), source: "task_runner" });
    }
  }
  return out;
};

const fromCi = (root: string): Candidate[] => {
  const dir = join(root, ".github/workflows");
  if (!existsSync(dir)) return [];
  const lines: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!/\.ya?ml$/.test(name)) continue;
    let doc: unknown;
    try {
      doc = parse(readFileSync(join(dir, name), "utf8"));
    } catch {
      continue;
    }
    const jobs =
      (doc as { jobs?: Record<string, { steps?: { run?: unknown }[] }> } | null)?.jobs ?? {};
    for (const job of Object.values(jobs)) {
      for (const step of job.steps ?? []) {
        if (typeof step.run === "string") lines.push(...step.run.split("\n"));
      }
    }
  }
  return fromCommandLines(lines, "ci");
};

const fromDevcontainer = (root: string): Candidate[] => {
  const doc = readJson(root, ".devcontainer/devcontainer.json");
  if (doc === null) return [];
  const lines: string[] = [];
  for (const key of ["postCreateCommand", "updateContentCommand", "onCreateCommand"]) {
    const value = doc[key];
    if (typeof value === "string") lines.push(value);
    if (Array.isArray(value) && value.every((v) => typeof v === "string"))
      lines.push(value.join(" "));
  }
  return fromCommandLines(lines, "devcontainer");
};

const fromLockfiles = (root: string): Candidate[] => {
  const out: Candidate[] = [];
  const pm = has(root, "package.json") ? nodePm(root) : null;
  if (pm !== null)
    out.push({ slot: "install", gate: gateFor("install", NODE_INSTALL[pm]), source: "lockfile" });
  if (has(root, "uv.lock"))
    out.push({
      slot: "install",
      gate: gateFor("install", ["uv", "sync", "--frozen"]),
      source: "lockfile",
    });
  else if (has(root, "poetry.lock"))
    out.push({
      slot: "install",
      gate: gateFor("install", ["poetry", "install", "--no-interaction"]),
      source: "lockfile",
    });
  if (has(root, "go.mod")) {
    out.push({
      slot: "install",
      gate: gateFor("install", ["go", "mod", "download"]),
      source: "lockfile",
    });
    out.push({
      slot: "build",
      gate: gateFor("build", ["go", "build", "./..."]),
      source: "lockfile",
    });
    out.push({
      slot: "typecheck",
      gate: gateFor("typecheck", ["go", "vet", "./..."]),
      source: "lockfile",
    });
    out.push({ slot: "test", gate: gateFor("test", ["go", "test", "./..."]), source: "lockfile" });
  }
  if (has(root, "Cargo.lock") || has(root, "Cargo.toml")) {
    out.push({
      slot: "install",
      gate: gateFor("install", ["cargo", "fetch", "--locked"]),
      source: "lockfile",
    });
    out.push({
      slot: "build",
      gate: gateFor("build", ["cargo", "build", "--locked"]),
      source: "lockfile",
    });
    out.push({
      slot: "test",
      gate: gateFor("test", ["cargo", "test", "--locked"]),
      source: "lockfile",
    });
  }
  if (has(root, "pyproject.toml") || has(root, "requirements.txt")) {
    const runner = pyRunner(root);
    const pyproject = readText(root, "pyproject.toml") ?? "";
    if (/pytest/.test(pyproject) || has(root, "pytest.ini") || has(root, "tests")) {
      out.push({
        slot: "test",
        gate: gateFor("test", pyCmd(runner, ["pytest"])),
        source: "lockfile",
      });
    }
    if (/\bruff\b/.test(pyproject) || has(root, "ruff.toml")) {
      out.push({
        slot: "lint",
        gate: gateFor("lint", pyCmd(runner, ["ruff", "check"])),
        source: "lockfile",
      });
    }
    if (/\bmypy\b/.test(pyproject))
      out.push({
        slot: "typecheck",
        gate: gateFor("typecheck", pyCmd(runner, ["mypy", "."])),
        source: "lockfile",
      });
  }
  return out;
};

// ------------------------------------------------------- structured reports

const JUNIT = `${REPORT_DIR}/junit.xml`;

/**
 * Upgrades a detected test or lint command to one that writes a report the Gate Runner parses
 * (JUnit for tests, JSON for linters), when the tool is known.
 */
const withReport = (root: string, candidate: Candidate): ProposedGate => {
  const { slot, gate } = candidate;
  const pkg = readJson(root, "package.json");
  const pm = nodePm(root);
  const node =
    pkg === null || pm === null
      ? null
      : { pm, deps: deps(pkg), scripts: (pkg.scripts ?? {}) as Record<string, unknown> };
  const scriptBody = (): string => {
    const name = gate.command.at(-1) ?? "";
    const body = node?.scripts[name];
    return typeof body === "string" ? body : "";
  };
  const isScript = node !== null && gate.command[1] === "run";
  if (slot === "test") {
    const text = `${gate.command.join(" ")} ${isScript ? scriptBody() : ""}`;
    if (
      node !== null &&
      (/\bvitest\b/.test(text) || (isScript && node.deps.has("vitest") && !/\bjest\b/.test(text)))
    ) {
      return {
        ...gate,
        command: [
          ...execBin(node.pm, "vitest"),
          "run",
          "--reporter=default",
          "--reporter=junit",
          `--outputFile.junit=${JUNIT}`,
        ],
        report: { format: "junit", path: JUNIT },
      };
    }
    if (/\bpytest\b/.test(text)) {
      const prefix = gate.command.slice(0, gate.command.indexOf("pytest") + 1);
      return {
        ...gate,
        command: [...(prefix.length > 0 ? prefix : ["pytest"]), `--junitxml=${JUNIT}`],
        report: { format: "junit", path: JUNIT },
      };
    }
  }
  if (slot === "lint") {
    const text = `${gate.command.join(" ")} ${isScript ? scriptBody() : ""}`;
    if (node !== null && /\beslint\b/.test(text) && node.deps.has("eslint")) {
      const out = `${REPORT_DIR}/eslint.json`;
      return {
        ...gate,
        command: [...execBin(node.pm, "eslint"), ".", "--format", "json", "--output-file", out],
        report: { format: "json", path: out },
      };
    }
    if (/\bruff\b/.test(text)) {
      const out = `${REPORT_DIR}/ruff.json`;
      const prefix = gate.command.slice(0, gate.command.indexOf("ruff") + 1);
      return {
        ...gate,
        command: [
          ...(prefix.length > 0 ? prefix : ["ruff"]),
          "check",
          "--output-format",
          "json",
          "--output-file",
          out,
        ],
        report: { format: "json", path: out },
      };
    }
  }
  return gate;
};

// ------------------------------------------------------------------- scanners

const IAC_GLOBS = [
  "**/*.tf",
  "**/*.tfvars",
  "**/Dockerfile",
  "**/*.dockerfile",
  "**/docker-compose*.y*ml",
  "**/k8s/**",
  "**/helm/**",
  "**/cloudformation/**",
];

const LOCKFILES = [
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "uv.lock",
  "poetry.lock",
  "requirements.txt",
  "go.sum",
  "Cargo.lock",
  "Gemfile.lock",
  "composer.lock",
];

/** Repo files (tracked or not), bounded, skipping VCS, VTC state and dependency directories. */
export const listFiles = (root: string, limit = 20_000): string[] => {
  const out: string[] = [];
  const skip = new Set([
    ".git",
    ".vtc",
    "node_modules",
    ".venv",
    "venv",
    "dist",
    "build",
    "target",
    ".next",
    "out",
  ]);
  const walk = (rel: string): void => {
    if (out.length >= limit) return;
    let entries: string[];
    try {
      entries = readdirSync(join(root, rel));
    } catch {
      return;
    }
    for (const name of entries.sort()) {
      if (skip.has(name)) continue;
      const childRel = rel === "" ? name : `${rel}/${name}`;
      let isDir: boolean;
      try {
        isDir = statSync(join(root, childRel)).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(childRel);
      else if (out.length < limit) out.push(childRel);
    }
  };
  walk("");
  return out;
};

const scannerGates = (files: readonly string[], scanners: readonly string[]): ProposedGate[] => {
  const out: ProposedGate[] = [];
  if (scanners.includes("gitleaks")) {
    out.push({
      id: "secrets",
      layer: "L4",
      // Commits of base..head only: every secret committed in the range, nothing older (§7.6 rule 1).
      command: [
        "gitleaks",
        "git",
        ".",
        "--log-opts={base}..{head}",
        "--report-format",
        "json",
        "--report-path",
        `${REPORT_DIR}/gitleaks.json`,
        "--exit-code",
        "0",
        "--no-banner",
      ],
      report: { format: "json", path: `${REPORT_DIR}/gitleaks.json` },
    });
  }
  const code = files.some((f) => /\.(m?[jt]sx?|cjs|py|go)$/.test(f));
  if (scanners.includes("opengrep") && code) {
    out.push({
      id: "sast",
      layer: "L4",
      command: [
        "opengrep",
        "scan",
        "--config",
        "{rules}/opengrep",
        "--sarif",
        "--output",
        `${REPORT_DIR}/opengrep.sarif`,
        ".",
      ],
      report: { format: "sarif", path: `${REPORT_DIR}/opengrep.sarif` },
    });
  }
  if (scanners.includes("osv-scanner") && LOCKFILES.some((l) => files.includes(l))) {
    out.push({
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
        `${REPORT_DIR}/osv.json`,
        "-r",
        ".",
      ],
      report: { format: "json", path: `${REPORT_DIR}/osv.json` },
    });
  }
  if (
    scanners.includes("checkov") &&
    files.some((f) =>
      IAC_GLOBS.some((g) => globMatch(g, f) || globMatch(g.replace(/^\*\*\//, ""), f)),
    )
  ) {
    out.push({
      id: "iac",
      layer: "L4",
      command: [
        "checkov",
        "-d",
        ".",
        "--quiet",
        "-o",
        "sarif",
        "--output-file-path",
        `${REPORT_DIR}/checkov`,
      ],
      report: { format: "sarif", path: `${REPORT_DIR}/checkov/results_sarif.sarif` },
      when_changed: IAC_GLOBS,
    });
  }
  return out;
};

// ----------------------------------------------------------------- test layout

/**
 * The acceptance-test directory and the protected configs. Every lint, test and scanner config
 * glob is protected whether or not a matching file exists yet: a config a later diff adds must
 * be caught too (§7.3, §7.6 rule 5).
 */
export const detectTestLayout = (root: string): TestLayout => {
  const dir = ["tests", "test", "spec", "__tests__", "e2e"].find((d) => has(root, d)) ?? "tests";
  return {
    acceptance_globs: [`${dir}/acceptance/**`],
    protected_configs: [...DEFAULT_PROTECTED_GLOBS],
  };
};

// ------------------------------------------------------------------- detection

const PRECEDENCE: readonly CalibrationSource[] = [
  "gates_yml",
  "agents_md",
  "task_runner",
  "ci",
  "devcontainer",
  "lockfile",
];

export interface DetectOptions {
  /** The repo's current `gates.yml`: its gates and layout win (source 1). */
  readonly existing?: GatesConfig | null;
  /** Pinned scanner names (`gates/scanners.json`). */
  readonly scanners: readonly string[];
}

export const detectToolchain = (root: string, options: DetectOptions): Detection => {
  const notes: string[] = [];
  const files = listFiles(root);
  if (options.existing !== undefined && options.existing !== null) {
    notes.push("kept the gates of the existing .vtc/gates.yml; only the baseline is recalibrated");
    return {
      gates: options.existing.gates.map((g) => ({
        ...g,
        command: [...g.command],
        ...(g.when_changed === undefined ? {} : { when_changed: [...g.when_changed] }),
      })),
      sources: ["gates_yml"],
      tests: options.existing.tests,
      notes,
    };
  }
  const candidates: Candidate[] = [
    ...fromCommandLines(hintCommands(root), "agents_md"),
    ...fromTaskRunners(root),
    ...fromCi(root),
    ...fromDevcontainer(root),
    ...fromLockfiles(root),
  ];
  const chosen = new Map<Slot, Candidate>();
  for (const source of PRECEDENCE) {
    for (const c of candidates.filter((x) => x.source === source))
      if (!chosen.has(c.slot)) chosen.set(c.slot, c);
  }
  const order: Slot[] = ["install", "build", "typecheck", "lint", "test", "arch"];
  const gates: ProposedGate[] = [];
  for (const slot of order) {
    const c = chosen.get(slot);
    if (c === undefined) continue;
    gates.push(withReport(root, c));
  }
  if (!chosen.has("test"))
    notes.push("no test command found: L2 has no gate; add one to .vtc/gates.yml");
  if (gates.some((g) => g.layer === "L2" && g.report === undefined)) {
    notes.push(
      "the test command writes no JUnit report: L2 passes or fails on its exit code, without per-test metrics",
    );
  }
  gates.push(...scannerGates(files, options.scanners));
  const sources = PRECEDENCE.filter((s) => [...chosen.values()].some((c) => c.source === s));
  return { gates, sources, tests: detectTestLayout(root), notes };
};

/** The argv prefix a human confirms for a command: the tokens before its first placeholder. */
export const allowlistPrefix = (command: readonly string[]): string[] => {
  const cut = command.findIndex((t) => /\{(base|head|changed|rules)\}/.test(t));
  return [...(cut < 0 ? command : command.slice(0, Math.max(1, cut)))];
};

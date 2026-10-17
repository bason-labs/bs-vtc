/**
 * What a pinned scanner may be asked to do (§7.2 L4, §15). Pinned scanners pass the gate
 * allowlist by name, so their arguments come from repo content (`.vtc/gates.yml`). Only the flags
 * listed here are accepted (an allowlist, not a denylist): every path a scanner reads or writes
 * must stay inside the checkout, Opengrep rules come from local files only, Gitleaks scans a
 * commit range and nothing else, and osv-scanner runs `--offline`. Anything else is refused before
 * the scanner starts. Paths are checked lexically here; the runner refuses symlinked output paths.
 */
import { existsSync } from "node:fs";
import { relative, resolve, sep } from "node:path";

type Value =
  /** A boolean flag: no value. */
  | { readonly kind: "none" }
  /** A boolean flag that must be true: bare, or `=true`. */
  | { readonly kind: "true" }
  | { readonly kind: "int" }
  | { readonly kind: "enum"; readonly values: readonly string[] }
  /** Comma-separated names (frameworks, severities). */
  | { readonly kind: "word" }
  /** A path the scanner writes. */
  | { readonly kind: "output" }
  /** A path the scanner reads. */
  | { readonly kind: "input" }
  /** Opengrep rules: the product ruleset (`{rules}`) or a local file in the checkout. */
  | { readonly kind: "rules" }
  /** A Gitleaks `--log-opts` commit range: `{base}..{head}` or two commit ids, nothing else. */
  | { readonly kind: "range" }
  /** A path pattern (`--exclude`). */
  | { readonly kind: "pattern" };

interface ScannerSpec {
  /** Accepted leading subcommands; `[]` allows none. */
  readonly subcommands: readonly (readonly string[])[];
  readonly flags: Readonly<Record<string, Value>>;
  /** Flags that must be present (as written in `flags`, any alias). */
  readonly required?: { readonly names: readonly string[]; readonly why: string };
}

const NONE = { kind: "none" } as const;
const INT = { kind: "int" } as const;
const OUTPUT = { kind: "output" } as const;
const INPUT = { kind: "input" } as const;
const WORD = { kind: "word" } as const;
const PATTERN = { kind: "pattern" } as const;
const oneOf = (...values: string[]): Value => ({ kind: "enum", values });

const LOG_LEVELS = oneOf("trace", "debug", "info", "warn", "error", "fatal");

export const SCANNER_SPECS: Readonly<Record<string, ScannerSpec>> = {
  gitleaks: {
    subcommands: [["git"], ["dir"], ["directory"], ["detect"]],
    flags: {
      "--report-format": oneOf("json", "sarif", "csv", "junit"),
      "-f": oneOf("json", "sarif", "csv", "junit"),
      "--report-path": OUTPUT,
      "-r": OUTPUT,
      "--exit-code": INT,
      "--log-opts": { kind: "range" },
      "--no-banner": NONE,
      "--no-color": NONE,
      "--verbose": NONE,
      "-v": NONE,
      "--ignore-gitleaks-allow": NONE,
      "--max-target-megabytes": INT,
      "--max-decode-depth": INT,
      "--timeout": INT,
      "--log-level": LOG_LEVELS,
      "-l": LOG_LEVELS,
    },
  },
  "osv-scanner": {
    subcommands: [["scan", "source"], ["scan"], []],
    flags: {
      "--offline": { kind: "true" },
      "--offline-vulnerabilities": NONE,
      "--no-resolve": NONE,
      "--format": oneOf("json", "sarif", "table", "markdown", "vertical", "gh-annotations"),
      "-f": oneOf("json", "sarif", "table", "markdown", "vertical", "gh-annotations"),
      "--output": OUTPUT,
      "--output-file": OUTPUT,
      "--recursive": NONE,
      "-r": NONE,
      "--lockfile": INPUT,
      "-L": INPUT,
      "--allow-no-lockfiles": NONE,
      "--all-packages": NONE,
      "--no-ignore": NONE,
      "--verbosity": oneOf("error", "warn", "info", "verbose"),
    },
    required: {
      names: ["--offline"],
      why: "osv-scanner runs only with --offline (§7.2)",
    },
  },
  opengrep: {
    subcommands: [["scan"]],
    flags: {
      "--config": { kind: "rules" },
      "-c": { kind: "rules" },
      "-f": { kind: "rules" },
      "--sarif": NONE,
      "--json": NONE,
      "--text": NONE,
      "--junit-xml": NONE,
      "--output": OUTPUT,
      "-o": OUTPUT,
      "--sarif-output": OUTPUT,
      "--json-output": OUTPUT,
      "--text-output": OUTPUT,
      "--junit-xml-output": OUTPUT,
      "--quiet": NONE,
      "-q": NONE,
      "--verbose": NONE,
      "-v": NONE,
      "--metrics": oneOf("off"),
      "--disable-version-check": NONE,
      "--no-git-ignore": NONE,
      "--error": NONE,
      "--strict": NONE,
      "--timeout": INT,
      "--timeout-threshold": INT,
      "--jobs": INT,
      "-j": INT,
      "--max-target-bytes": INT,
      "--max-memory": INT,
      "--severity": oneOf("INFO", "WARNING", "ERROR"),
      "--exclude": PATTERN,
      "--include": PATTERN,
    },
  },
  checkov: {
    subcommands: [[]],
    flags: {
      "--directory": INPUT,
      "-d": INPUT,
      "--file": INPUT,
      "-f": INPUT,
      "--output": oneOf("cli", "json", "sarif", "junitxml", "csv", "cyclonedx", "spdx"),
      "-o": oneOf("cli", "json", "sarif", "junitxml", "csv", "cyclonedx", "spdx"),
      "--output-file-path": OUTPUT,
      "--quiet": NONE,
      "--compact": NONE,
      "--soft-fail": NONE,
      "--skip-download": NONE,
      "--no-guide": NONE,
      "--framework": WORD,
      "--skip-framework": WORD,
      "--hard-fail-on": WORD,
      "--soft-fail-on": WORD,
      "--download-external-modules": oneOf("false", "False"),
    },
  },
};

export interface ScannerArgsContext {
  /** Absolute checkout root. */
  readonly checkoutAbs: string;
  /** Absolute working directory of the gate (inside the checkout). */
  readonly cwd: string;
}

export type ScannerArgsCheck =
  | { readonly ok: false; readonly problem: string }
  | {
      readonly ok: true;
      /** Checkout-relative paths the scanner writes (refused when any parent is a symlink). */
      readonly outputs: readonly string[];
      /** Checkout-relative rule files the scanner reads (run with their base version). */
      readonly configs: readonly string[];
    };

const RANGE = /^(?:\{base\}|[0-9a-f]{7,40})\.\.(?:\{head\}|[0-9a-f]{7,40})$/;
/** Registry and remote forms Opengrep would fetch: `p/…`, `r/…`, `s/…`, `auto`, any URL scheme. */
const REMOTE_RULES = /^(?:[a-z][a-z0-9+.-]*:|[prs]\/|auto$|supply-chain$)/i;

/** A checkout-relative POSIX path for `value` resolved from `cwd`, or `null` when it leaves. */
const inside = (ctx: ScannerArgsContext, value: string): string | null => {
  if (value === "" || value.includes("\0")) return null;
  const rel = relative(ctx.checkoutAbs, resolve(ctx.cwd, value));
  if (rel.startsWith("..") || rel.startsWith(sep) || /^[A-Za-z]:/.test(rel)) return null;
  return rel.split(sep).join("/");
};

/** Checks a pinned scanner's arguments (the argv after the scanner's name, placeholders unexpanded). */
export const checkScannerArgs = (
  scanner: string,
  args: readonly string[],
  ctx: ScannerArgsContext,
): ScannerArgsCheck => {
  const spec = SCANNER_SPECS[scanner];
  if (spec === undefined) return { ok: false, problem: `${scanner} is not a known scanner` };
  const refuse = (problem: string): ScannerArgsCheck => ({ ok: false, problem });
  const sub = [...spec.subcommands]
    .sort((a, b) => b.length - a.length)
    .find((s) => s.every((token, i) => args[i] === token));
  if (sub === undefined) {
    const names = spec.subcommands.map((s) => s.join(" ")).filter((s) => s !== "");
    return refuse(`${scanner} runs only as: ${names.join(", ")}`);
  }
  const outputs: string[] = [];
  const configs: string[] = [];
  const seen = new Set<string>();
  for (let i = sub.length; i < args.length; i += 1) {
    const arg = args[i] ?? "";
    if (arg === "{changed}") continue;
    if (!arg.startsWith("-") || arg === "-") {
      // A positional argument is a path to scan.
      if (arg.includes("{") || inside(ctx, arg) === null) {
        return refuse(`${scanner} scans only paths inside the checkout, not ${arg}`);
      }
      continue;
    }
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const value = spec.flags[name];
    if (value === undefined) return refuse(`${scanner} argument ${name} is not supported by vtc`);
    seen.add(name);
    if (value.kind === "none") {
      if (eq > 0) return refuse(`${scanner} argument ${name} takes no value`);
      continue;
    }
    if (value.kind === "true") {
      if (eq > 0 && arg.slice(eq + 1) !== "true") {
        return refuse(spec.required?.why ?? `${scanner} argument ${name} must be true`);
      }
      continue;
    }
    let given: string | undefined;
    if (eq > 0) given = arg.slice(eq + 1);
    else {
      i += 1;
      given = args[i];
    }
    if (given === undefined) return refuse(`${scanner} argument ${name} needs a value`);
    switch (value.kind) {
      case "int":
        if (!/^\d{1,9}$/.test(given)) return refuse(`${scanner} ${name} takes a number`);
        break;
      case "enum":
        if (!value.values.includes(given))
          return refuse(`${scanner} ${name} takes one of ${value.values.join(", ")}`);
        break;
      case "word":
        if (!/^[A-Za-z0-9_,.-]{1,200}$/.test(given) || given.startsWith("-"))
          return refuse(`${scanner} ${name} takes a list of names`);
        break;
      case "pattern":
        if (given === "" || given.startsWith("-") || given.includes("\0"))
          return refuse(`${scanner} ${name} takes a path pattern`);
        break;
      case "range":
        if (!RANGE.test(given))
          return refuse(`${scanner} ${name} takes only a commit range such as {base}..{head}`);
        break;
      case "input":
      case "output": {
        const rel = given.includes("{") ? null : inside(ctx, given);
        if (rel === null)
          return refuse(`${scanner} ${name} must name a path inside the checkout, not ${given}`);
        if (value.kind === "output") outputs.push(rel);
        break;
      }
      case "rules": {
        if (given === "{rules}" || given.startsWith("{rules}/")) break;
        if (REMOTE_RULES.test(given) || given.includes("{")) {
          return refuse("opengrep rules must come from a local path, never the network");
        }
        const rel = inside(ctx, given);
        if (rel === null || !existsSync(resolve(ctx.cwd, given))) {
          return refuse(
            `opengrep rules must be the product ruleset or a file in the checkout, not ${given}`,
          );
        }
        configs.push(rel);
        break;
      }
    }
  }
  if (spec.required !== undefined && !spec.required.names.some((n) => seen.has(n))) {
    return refuse(spec.required.why);
  }
  return { ok: true, outputs, configs };
};

/** The problem with a pinned scanner's arguments, or `null` when they are acceptable. */
export const scannerArgsProblem = (
  scanner: string,
  args: readonly string[],
  ctx: ScannerArgsContext,
): string | null => {
  const check = checkScannerArgs(scanner, args, ctx);
  return check.ok ? null : check.problem;
};

/**
 * Arguments vtc adds to a scanner's own: Gitleaks reports secrets even on lines marked
 * `gitleaks:allow` (a new marker is also an L5 suppression).
 */
export const scannerExtraArgs = (scanner: string, args: readonly string[]): string[] =>
  scanner === "gitleaks" && !args.includes("--ignore-gitleaks-allow")
    ? ["--ignore-gitleaks-allow"]
    : [];

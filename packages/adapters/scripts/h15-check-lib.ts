/**
 * Pure helpers of the H-15 live checks (scripts/h15-check.ts, spine §5 reading 239) and of the
 * round-5 Claude arm items (the `vtc` shim the D-cl `claude-arm` check puts on `PATH`). Nothing
 * here opens a file or starts a process.
 */
import type { UsageSnapshot } from "@vtc/shared";

/** A model id no plan has: what the D-cx refusal probe asks Codex for. */
export const CODEX_REFUSAL_PROBE_MODEL = "vtc-probe-no-such-model";

/**
 * The adapter's `codex exec` argv with `--ephemeral` right after `exec`, so a probe run persists
 * no session file in the user's own `CODEX_HOME` (H-15: the real `~/.codex` is never modified).
 * Only for a fresh run (`exec resume` is never probed); throws on anything else.
 */
export const withCodexEphemeral = (args: readonly string[]): string[] => {
  if (args[0] !== "exec" || args.includes("resume")) {
    throw new Error("expected a fresh `codex exec` argv");
  }
  return args.includes("--ephemeral") ? [...args] : ["exec", "--ephemeral", ...args.slice(1)];
};

/**
 * Whether a usage reading shows a limit reached (the only time a limit text can be seen): a window
 * at 100%, or a per-model limit (listed only once it is hit).
 */
export const atLimit = (snapshot: UsageSnapshot): boolean =>
  snapshot.windows.some((w) => w.used_pct !== null && w.used_pct >= 100) ||
  snapshot.model_limits.length > 0;

/** A POSIX shell single-quoted word. */
export const shellQuote = (text: string): string => `'${text.replace(/'/gu, `'\\''`)}'`;

/** One path the session-sandbox probe tries to read or write. */
export interface SandboxProbeTarget {
  /** A short label (`[a-z0-9_-]`), the key in the results. */
  readonly name: string;
  readonly path: string;
  readonly kind: "read" | "write";
}

/** One tool the probe runs to see whether it still works in the sandbox. */
export interface SandboxProbeTool {
  readonly name: string;
  readonly argv: readonly string[];
}

const LABEL = /^[a-z0-9_-]{1,40}$/u;

/**
 * The shell script the Claude session-sandbox check has the model run with its Bash tool. It
 * never prints a file's contents: each read target is opened into `/dev/null` and reported
 * `open` or `denied`; each write target gets the word `probe` (`open` when the write worked); each
 * tool reports `ok` or `failed <status>`. Lines go to `resultsFile` as `<phase> <kind> <name>
 * <result>`, the phase being the script's first argument (default `sandboxed`).
 */
export const sandboxProbeScript = (
  targets: readonly SandboxProbeTarget[],
  tools: readonly SandboxProbeTool[],
  resultsFile: string,
): string => {
  for (const label of [...targets, ...tools].map((t) => t.name)) {
    if (!LABEL.test(label)) throw new Error(`bad probe label ${JSON.stringify(label)}`);
  }
  return [
    "#!/bin/sh",
    "# VTC H-15 session-sandbox probe: prints no file contents",
    'phase="${1:-sandboxed}"',
    `out=${shellQuote(resultsFile)}`,
    'r() { if cat "$2" >/dev/null 2>&1; then s=open; else s=denied; fi; echo "$phase read $1 $s" >> "$out"; }',
    'w() { if (printf probe > "$2") 2>/dev/null; then s=open; else s=denied; fi; echo "$phase write $1 $s" >> "$out"; }',
    't() { n="$1"; shift; "$@" >/dev/null 2>&1; c=$?; if [ "$c" = 0 ]; then s=ok; else s="failed $c"; fi; echo "$phase tool $n $s" >> "$out"; }',
    ...targets.map((t) => `${t.kind === "read" ? "r" : "w"} ${t.name} ${shellQuote(t.path)}`),
    ...tools.map((t) => `t ${t.name} ${t.argv.map(shellQuote).join(" ")}`),
    'echo "$phase done" >> "$out"',
    "",
  ].join("\n");
};

/** The probe's results file → `{ phase: { "<kind> <name>": result } }`; other lines are ignored. */
export const parseProbeResults = (text: string): Record<string, Record<string, string>> => {
  const phases: Record<string, Record<string, string>> = {};
  for (const line of text.split("\n")) {
    const match = /^([a-z]+) (read|write|tool) ([a-z0-9_-]+) (open|denied|ok|failed \d+)$/u.exec(
      line.trim(),
    );
    if (match === null) continue;
    const [, phase = "", kind = "", name = "", result = ""] = match;
    phases[phase] = { ...phases[phase], [`${kind} ${name}`]: result };
  }
  return phases;
};

/**
 * A `vtc` shim for the Claude arm check (round-5 items): for `vtc hook …` it keeps the call's
 * stdin, argv, stdout, stderr, exit status and the headless-role variable in `logDir` (one set per
 * call), then gives the real `vtc` the same stdin and passes its output and status through. Any
 * other command (the `vtc engine --mcp` bridge, which streams on stdin) goes straight to the real
 * `vtc`.
 */
export const vtcHookShim = (realVtc: readonly string[], logDir: string, roleEnv: string): string =>
  [
    "#!/bin/sh",
    `[ "$1" = hook ] || exec ${realVtc.map(shellQuote).join(" ")} "$@"`,
    `d=${shellQuote(logDir)}`,
    'n="$d/call-$$"',
    'cat > "$n.in"',
    'printf "%s\\n" "$*" > "$n.argv"',
    `printf "%s" "\${${roleEnv}-<unset>}" > "$n.role"`,
    `${realVtc.map(shellQuote).join(" ")} "$@" < "$n.in" > "$n.out" 2> "$n.err"`,
    "c=$?",
    'echo "$c" > "$n.code"',
    'cat "$n.out"',
    'cat "$n.err" >&2',
    'exit "$c"',
    "",
  ].join("\n");

/** What one recorded hook call showed, without its tool input, paths or session id. */
export interface HookCallSummary {
  readonly argv: string;
  readonly event: string | null;
  readonly inputKeys: readonly string[];
  readonly agentType: string | null;
  readonly roleEnv: string;
  readonly exitCode: number | null;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
}

/** Summarizes one shim call set (the texts of its `.argv`, `.in`, `.role`, `.code`, `.out`, `.err`). */
export const hookCallSummary = (call: {
  readonly argv: string;
  readonly input: string;
  readonly role: string;
  readonly code: string;
  readonly stdout: string;
  readonly stderr: string;
}): HookCallSummary => {
  let input: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(call.input) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      input = parsed as Record<string, unknown>;
    }
  } catch {
    // not JSON: no keys
  }
  const code = Number.parseInt(call.code.trim(), 10);
  return {
    argv: call.argv.trim(),
    event: typeof input.hook_event_name === "string" ? input.hook_event_name : null,
    inputKeys: Object.keys(input).sort(),
    agentType: typeof input.agent_type === "string" ? input.agent_type : null,
    roleEnv: call.role,
    exitCode: Number.isNaN(code) ? null : code,
    stdoutBytes: Buffer.byteLength(call.stdout),
    stderrBytes: Buffer.byteLength(call.stderr),
  };
};

const parse = (line: string): unknown => {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * What a Claude stream shows about its sign-in and settings: the `init` record's `apiKeySource`
 * (`none` = the subscription login), how many plugins, MCP servers and hooks it loaded, and the
 * `result` subtype.
 */
export const claudeStreamFacts = (
  lines: readonly string[],
): {
  readonly apiKeySource: unknown;
  readonly plugins: number | null;
  readonly mcpServers: number | null;
  readonly tools: unknown;
  readonly hooksStarted: number;
  readonly result: { readonly subtype: unknown; readonly is_error: unknown } | null;
} => {
  let init: Record<string, unknown> | null = null;
  let result: Record<string, unknown> | null = null;
  let hooksStarted = 0;
  for (const line of lines) {
    const event = parse(line);
    if (!isObject(event)) continue;
    if (event.type === "system" && event.subtype === "init") init = event;
    if (event.type === "system" && event.subtype === "hook_started") hooksStarted += 1;
    if (event.type === "result") result = event;
  }
  const size = (value: unknown): number | null => (Array.isArray(value) ? value.length : null);
  return {
    apiKeySource: init?.apiKeySource ?? null,
    plugins: size(init?.plugins),
    mcpServers: size(init?.mcp_servers),
    tools: init?.tools ?? null,
    hooksStarted,
    result: result === null ? null : { subtype: result.subtype, is_error: result.is_error },
  };
};

/**
 * The plan windows a Claude stream's last `rate_limit_event` reports in `unifiedWindows`: each
 * window's raw `utilization` and `resetsAt` (epoch seconds), as the host sent them.
 */
export const unifiedWindowReadings = (
  lines: readonly string[],
): Record<string, { readonly utilization: unknown; readonly resetsAt: unknown }> => {
  let last: Record<string, { utilization: unknown; resetsAt: unknown }> = {};
  for (const line of lines) {
    const event = parse(line);
    if (!isObject(event) || event.type !== "rate_limit_event") continue;
    const info = isObject(event.rate_limit_info) ? event.rate_limit_info : {};
    const windows = isObject(info.unifiedWindows) ? info.unifiedWindows : null;
    if (windows === null) continue;
    last = {};
    for (const [label, window] of Object.entries(windows)) {
      if (isObject(window))
        last[label] = { utilization: window.utilization, resetsAt: window.resetsAt };
    }
  }
  return last;
};

/**
 * The percentages Claude Code's own `/usage` prints ("Current session: 13% used · resets …",
 * "Current week (all models): 73% used · resets …"), or `null` for a line it did not print.
 */
export const usageCommandPercents = (
  text: string,
): { readonly session: number | null; readonly week: number | null } => {
  const pct = (pattern: RegExp): number | null => {
    const match = pattern.exec(text);
    return match?.[1] === undefined ? null : Number(match[1]);
  };
  return {
    session: pct(/Current session:\s*(\d+(?:\.\d+)?)% used/u),
    week: pct(/Current week \(all models\):\s*(\d+(?:\.\d+)?)% used/u),
  };
};

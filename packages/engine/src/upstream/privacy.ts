/**
 * Privacy of what VTC sends to its own repo (D-by; AD-27 rule 5; spine §5 readings 193 and 208).
 * An upstream report is an allowlist projection (fields are picked one by one into the strict
 * `UpstreamReportSchema`, never deleted from a richer object), then `redactJson` with the known
 * values, then a project-identifier denylist (repo name and owner, remote path, project-root
 * segments, client names, the home path). Any hit fails closed with `privacy`: nothing is redacted
 * and sent anyway, and the skip's detail never holds the matched text.
 */
import { redactJson, redactSecrets, UpstreamReportSchema, type UpstreamReport } from "@vtc/shared";
import { AutomationSkip } from "./skip.js";

/** Facts the triggers hand over for an upstream item; only the allowlisted fields are read. */
export interface UpstreamFacts {
  readonly kind: UpstreamReport["kind"];
  readonly fingerprint: string;
  readonly vtcVersion: string;
  readonly role?: string | undefined;
  readonly mode?: string | undefined;
  readonly host?: string | undefined;
  readonly model?: string | undefined;
  readonly promptSha?: string | undefined;
  readonly errorClass?: string | undefined;
  readonly frames?: readonly string[] | undefined;
  readonly metrics?: Readonly<Record<string, number>> | undefined;
  readonly occurrences: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly advisory?: { readonly id: string; readonly package: string } | undefined;
}

/**
 * Pure: the allowlist projection of `facts`. Unknown or malformed values fail the strict schema,
 * which skips with `privacy` (a value that does not look like VTC-side data is never sent).
 */
export const projectUpstreamReport = (facts: UpstreamFacts): UpstreamReport => {
  const input: Record<string, unknown> = {
    v: 1,
    kind: facts.kind,
    fingerprint: facts.fingerprint,
    vtc_version: facts.vtcVersion,
    ...(facts.role === undefined ? {} : { role: facts.role }),
    ...(facts.mode === undefined ? {} : { mode: facts.mode }),
    ...(facts.host === undefined ? {} : { host: facts.host }),
    ...(facts.model === undefined ? {} : { model: facts.model }),
    ...(facts.promptSha === undefined ? {} : { prompt_sha: facts.promptSha }),
    ...(facts.errorClass === undefined ? {} : { error_class: facts.errorClass }),
    vtc_frames: [...(facts.frames ?? [])].slice(0, 3),
    metrics: { ...(facts.metrics ?? {}) },
    occurrences: facts.occurrences,
    first_seen: facts.firstSeen,
    last_seen: facts.lastSeen,
    ...(facts.advisory === undefined
      ? {}
      : { advisory: { id: facts.advisory.id, package: facts.advisory.package } }),
  };
  const parsed = UpstreamReportSchema.safeParse(input);
  if (!parsed.success) {
    const fields = [...new Set(parsed.error.issues.map((i) => String(i.path[0] ?? "report")))];
    throw new AutomationSkip(
      "privacy",
      `the upstream report refused field(s): ${fields.join(", ")}`,
    );
  }
  return parsed.data;
};

/** What identifies the project an upstream item came from (never sent; used to refuse leaks). */
export interface ProjectIdentity {
  /** `owner/name` of the project's GitHub repo. */
  readonly repo?: string | undefined;
  /** The push remote URL. */
  readonly remoteUrl?: string | undefined;
  /** Absolute project root. */
  readonly repoRoot?: string | undefined;
  /** Client names from the project config. */
  readonly clientNames?: readonly string[] | undefined;
  /** The user's home directory. */
  readonly homeDir?: string | undefined;
}

/** Words too generic (or VTC's own vocabulary) to identify a project. */
const GENERIC = new Set([
  "users",
  "home",
  "documents",
  "desktop",
  "downloads",
  "projects",
  "project",
  "clients",
  "client",
  "sites",
  "source",
  "sources",
  "workspaces",
  "workspace",
  "repos",
  "repo",
  "code",
  "src",
  "dev",
  "work",
  "git",
  "github",
  "tmp",
  "private",
  "var",
  "opt",
  "app",
  "apps",
  "packages",
  "vtc",
  "shared",
  "engine",
  "adapters",
  "compiler",
  "cli",
  "dashboard",
  "root",
  "admin",
  "user",
]);

const MIN_TOKEN = 3;

const usefulToken = (token: string): boolean =>
  token.length >= MIN_TOKEN && !GENERIC.has(token.toLowerCase());

const pathSegments = (path: string): string[] =>
  path
    .replace(/\\/g, "/")
    .split("/")
    .filter((s) => s !== "");

const remotePath = (url: string): string | null => {
  const scp = /^[^@\s]+@[^:\s]+:(.+?)(?:\.git)?\/?$/.exec(url);
  if (scp?.[1] !== undefined) return scp[1];
  try {
    return new URL(url).pathname
      .replace(/^\/+/, "")
      .replace(/\.git$/, "")
      .replace(/\/+$/, "");
  } catch {
    return null;
  }
};

/** Pure: the project-identifier denylist (spine §5 reading 208; AD-27 rule 5). */
export const projectDenylist = (identity: ProjectIdentity): string[] => {
  const out = new Set<string>();
  const add = (value: string | undefined): void => {
    const v = value?.trim();
    if (v !== undefined && v !== "" && (v.includes("/") || usefulToken(v))) out.add(v);
  };
  if (identity.repo !== undefined) {
    add(identity.repo);
    for (const part of identity.repo.split("/")) add(part);
  }
  if (identity.remoteUrl !== undefined) {
    add(identity.remoteUrl);
    const path = remotePath(identity.remoteUrl);
    if (path !== null) {
      add(path);
      for (const part of pathSegments(path)) add(part);
    }
  }
  const home = identity.homeDir?.replace(/\/+$/, "");
  if (home !== undefined && home !== "") {
    add(home);
    add(pathSegments(home).at(-1));
  }
  if (identity.repoRoot !== undefined) {
    add(identity.repoRoot);
    const root = identity.repoRoot.replace(/\/+$/, "");
    const below =
      home !== undefined && home !== "" && root.startsWith(`${home}/`)
        ? root.slice(home.length + 1)
        : root;
    for (const part of pathSegments(below)) add(part);
  }
  for (const name of identity.clientNames ?? []) add(name);
  return [...out];
};

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

/** Pure: whether `text` contains a denylisted identifier (case-insensitive, whole token). */
export const containsDenied = (text: string, denylist: readonly string[]): boolean =>
  denylist.some((token) => {
    if (token.includes("/")) return text.toLowerCase().includes(token.toLowerCase());
    return new RegExp(`(?<![A-Za-z0-9])${escape(token)}(?![A-Za-z0-9])`, "i").test(text);
  });

export interface UpstreamPrivacyCheck {
  readonly knownValues: readonly string[];
  readonly denylist: readonly string[];
  /** The upstream repo (`owner/name`): its own name and links may appear in bodies. */
  readonly upstreamRepo: string;
}

const maskUpstream = (text: string, upstreamRepo: string): string =>
  text
    .split(`https://github.com/${upstreamRepo}/`)
    .join("https://github.com/UPSTREAM/")
    .split(upstreamRepo)
    .join("UPSTREAM");

/**
 * Throws `AutomationSkip("privacy")` unless the report and every outgoing text are unchanged by
 * the shared redaction (known values and token formats) and free of project identifiers. Fails
 * closed: a hit is never redacted-and-sent.
 */
export const assertUpstreamSafe = (
  report: UpstreamReport,
  texts: readonly string[],
  check: UpstreamPrivacyCheck,
): void => {
  const json = JSON.stringify(report);
  if (JSON.stringify(redactJson(report, check.knownValues)) !== json) {
    throw new AutomationSkip("privacy", "the upstream report matched the secret redaction");
  }
  for (const text of [json, ...texts]) {
    if (redactSecrets(text, check.knownValues) !== text) {
      throw new AutomationSkip("privacy", "an upstream text matched the secret redaction");
    }
    if (containsDenied(maskUpstream(text, check.upstreamRepo), check.denylist)) {
      throw new AutomationSkip("privacy", "an upstream text named the project");
    }
  }
};

/** Project-repo content may hold project details; it still passes the shared redaction. */
export const redactProjectText = (text: string, knownValues: readonly string[]): string =>
  redactSecrets(text, knownValues);

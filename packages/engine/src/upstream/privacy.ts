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
import { projectSubject } from "./subject.js";

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
  /**
   * A D-cd improvement's subject as the fact named it (`tool`, `capability`, `config`): projected
   * through its kind's pattern into the report's typed `subject` (`projectSubject`), never sent
   * as given; ignored for any other kind.
   */
  readonly subject?: string | undefined;
  readonly metrics?: Readonly<Record<string, number>> | undefined;
  readonly occurrences: number;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly advisory?: { readonly id: string; readonly package: string } | undefined;
}

/** What an upstream report says for a model id that is not a public one ({@link upstreamModelId}). */
export const CUSTOM_MODEL = "custom";

/** Public model ids: the hosts' aliases, Anthropic's (first-party, Bedrock, Vertex) and OpenAI's. */
const PUBLIC_MODEL_IDS: readonly RegExp[] = [
  /^(?:opus|sonnet|haiku|default|best|opusplan)$/,
  /^(?:(?:us|eu|apac|global|jp|au)\.)?(?:anthropic\.)?claude-[a-z0-9][a-z0-9.-]{0,80}(?::\d{1,3})?(?:@\d{8})?$/,
  /^(?:gpt-[a-z0-9][a-z0-9.-]{0,40}|o\d(?:-[a-z0-9]{1,20}){0,3}|codex-[a-z0-9][a-z0-9.-]{0,40})$/,
];

/**
 * Pure (D-by; D-ci): the model id an upstream report may carry. The configured id is project
 * config (`hosts.models`), and with provider billing it is often an inference-profile ARN (which
 * holds the cloud account id), a deployment path or a gateway alias named after the client: only
 * a public model id is sent as is (a host's `[1m]` context suffix dropped), anything else as
 * {@link CUSTOM_MODEL}. A run of 12 digits (an AWS account id) is never public.
 */
export const upstreamModelId = (model: string): string => {
  const id = model.trim().replace(/\[1m\]$/i, "");
  if (/\d{12}/.test(id)) return CUSTOM_MODEL;
  return PUBLIC_MODEL_IDS.some((re) => re.test(id)) ? id : CUSTOM_MODEL;
};

/**
 * Pure: the allowlist projection of `facts`. Unknown or malformed values fail the strict schema,
 * which skips with `privacy` (a value that does not look like VTC-side data is never sent).
 */
export const projectUpstreamReport = (facts: UpstreamFacts): UpstreamReport => {
  // D-cs, D-cn, reading 247(8): the typed subject, through its kind's pattern only
  const subject = projectSubject(facts.kind, facts.subject);
  const input: Record<string, unknown> = {
    v: 1,
    kind: facts.kind,
    fingerprint: facts.fingerprint,
    vtc_version: facts.vtcVersion,
    ...(facts.role === undefined ? {} : { role: facts.role }),
    ...(facts.mode === undefined ? {} : { mode: facts.mode }),
    ...(facts.host === undefined ? {} : { host: facts.host }),
    ...(facts.model === undefined ? {} : { model: upstreamModelId(facts.model) }),
    ...(facts.promptSha === undefined ? {} : { prompt_sha: facts.promptSha }),
    ...(facts.errorClass === undefined ? {} : { error_class: facts.errorClass }),
    vtc_frames: [...(facts.frames ?? [])].slice(0, 3),
    ...(subject === undefined ? {} : { subject }),
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
  // VTC's own vocabulary, which every upstream text names: a value of 4 or more characters
  // matches as a substring (reading 212(12)), so these would refuse every report
  "roles",
  "role",
  "prompt",
  "prompts",
  "lookback",
  "replay",
  "replays",
  "scorecard",
  "scorecards",
  "gates",
  "evidence",
  "upstream",
  "automation",
  "release",
  "changelog",
  "plugins",
  "skills",
  "docs",
  "tooling",
  "fixtures",
  "test",
  "tests",
  "main",
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

/**
 * Pure: the denylist of a project that is VTC's own repo ("VTC builds VTC", spine §5 reading 208
 * (1)): the upstream repo's public identifiers (its `owner/name`, each part, any remote URL of it,
 * and every token that is part of that public name) are not project secrets there, so they are
 * left out; the local paths (the home directory and the checkout path) and client names stay.
 */
export const selfDenylist = (denylist: readonly string[], upstreamRepo: string): string[] => {
  const name = upstreamRepo.toLowerCase();
  return denylist.filter((token) => {
    const t = token.toLowerCase();
    if (name.includes(t)) return false;
    return remotePath(token)?.toLowerCase() !== name;
  });
};

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");

/** Denylist values shorter than this match as a whole word only (spine §5 reading 212(12)). */
export const DENY_SUBSTRING_MIN = 4;

/**
 * Pure: whether `text` contains a denylisted identifier, case-insensitive (spine §5 reading
 * 212(12)): a value of {@link DENY_SUBSTRING_MIN} or more characters (or any path) as a substring,
 * so `InitechPortal` or `acmeApi` still names the project; a shorter one as a whole word.
 */
export const containsDenied = (text: string, denylist: readonly string[]): boolean => {
  const lower = text.toLowerCase();
  return denylist.some((token) => {
    if (token.includes("/") || token.length >= DENY_SUBSTRING_MIN)
      return lower.includes(token.toLowerCase());
    return new RegExp(`(?<![A-Za-z0-9])${escape(token)}(?![A-Za-z0-9])`, "i").test(text);
  });
};

export interface UpstreamPrivacyCheck {
  readonly knownValues: readonly string[];
  readonly denylist: readonly string[];
  /** The upstream repo (`owner/name`): its own name and links may appear in bodies. */
  readonly upstreamRepo: string;
}

/**
 * `text` with the upstream repo's own name masked, at token boundaries only: a project repo such as
 * `owner/name-client` keeps its full name, so the denylist still sees it.
 */
const maskUpstream = (text: string, upstreamRepo: string): string =>
  text.replace(
    new RegExp(`(?<![A-Za-z0-9_.-])${escape(upstreamRepo)}(?![A-Za-z0-9_.-])`, "gi"),
    "UPSTREAM",
  );

/**
 * Where a path in an upstream text may point: VTC's own tree and the generic tool folders. Any
 * other `dir/file.ext` is taken for a project path (model-written text cannot be trusted not to
 * carry one, and the denylist cannot know project-relative paths).
 */
const VTC_TREE = new Set([
  "roles",
  "packages",
  "apps",
  "skills",
  "plugins",
  "gates",
  "docs",
  "tooling",
  "fixtures",
  "packaging",
  ".vtc",
  ".github",
  ".claude",
  ".codex",
]);

/** `dir/…/file.ext` not inside a URL or a longer path (a URL's host and path are not matched). */
const PATH_SHAPE =
  /(?<![A-Za-z0-9_.~/:@-])((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]*\.[A-Za-z][A-Za-z0-9]{0,7})(?![A-Za-z0-9_/-])/g;

/** Pure: whether `text` names a file path outside VTC's own tree (spine §5 reading 208; D-by). */
export const containsProjectPath = (text: string): boolean => {
  for (const match of text.matchAll(PATH_SHAPE)) {
    const first = (match[1] ?? "").replace(/^\.\//, "").split("/")[0] ?? "";
    if (!VTC_TREE.has(first)) return true;
  }
  return false;
};

/**
 * Throws `AutomationSkip("privacy")` when a model-written upstream text (a proposal's summary,
 * hypothesis or new prompt lines, a PR's slots) names a file path outside VTC's tree.
 */
export const assertNoProjectPaths = (texts: readonly string[]): void => {
  if (texts.some(containsProjectPath)) {
    throw new AutomationSkip("privacy", "an upstream text named a file path outside VTC's tree");
  }
};

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

/**
 * Project-repo content may hold project details; it still passes the shared redaction (AD-27
 * rule 5): known values and token formats are replaced by redaction markers.
 */
export const redactProjectText = (text: string, knownValues: readonly string[]): string =>
  redactSecrets(text, knownValues);

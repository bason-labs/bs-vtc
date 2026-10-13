/**
 * Secret redaction (§7.2: before evidence is written, output passes a secret-redaction filter,
 * because `.vtc/` evidence and logs are committed to git). Pure and runtime-agnostic.
 *
 * Owner: gate-runner team (spine AD-18; `tooling/ownership.json`). Every writer of git-tracked
 * `.vtc/` content calls it: the event-log append path, evidence and report writers, plan files
 * and evidence bundles. Raw output stays only in gitignored `.vtc/state/`.
 */

/** Marker that replaces a secret: `[REDACTED:<kind>]`. */
export const redactionMarker = (kind: string): string => `[REDACTED:${kind}]`;

/**
 * Known token formats. Each pattern matches only the secret part, so surrounding text (e.g.
 * `Bearer `, a URL's scheme and host) stays readable.
 */
export const SECRET_PATTERNS: readonly { readonly kind: string; readonly pattern: RegExp }[] = [
  {
    kind: "private_key",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { kind: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "github_token", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_\w{22,255})/g },
  { kind: "gitlab_token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: "slack_token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: "anthropic_key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "openai_key", pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/g },
  { kind: "stripe_key", pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { kind: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}/g },
  {
    kind: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  { kind: "npm_token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: "pypi_token", pattern: /\bpypi-AgE[A-Za-z0-9_-]{50,}/g },
  { kind: "huggingface_token", pattern: /\bhf_[A-Za-z0-9]{34,}\b/g },
  { kind: "sendgrid_key", pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g },
  { kind: "bearer_token", pattern: /(?<=\b[Bb]earer\s+)[A-Za-z0-9._~+/-]{20,}=*/g },
  { kind: "url_credentials", pattern: /(?<=\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+(?=@)/gi },
  /**
   * A value assigned to a secret-named key (`password=…`, `api_key: "…"`, `client_secret=…`) in
   * logs and configs. Only values with both a letter and a digit, so code such as
   * `apiKey: config.apiKey` stays readable.
   */
  {
    kind: "secret_assignment",
    pattern:
      /(?<=(?<![A-Za-z0-9])(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)["']?\s*[:=]\s*["']?)(?=[^\s"'`,;(){}<>[\]]*\d)(?=[^\s"'`,;(){}<>[\]]*[A-Za-z])[^\s"'`,;(){}<>[\]]{8,}/gi,
  },
];

/** Known values shorter than this are not redacted by value (too many false positives). */
export const MIN_KNOWN_SECRET_LENGTH = 8;

/**
 * Replaces known secret values (e.g. `.env` values, scanner matches) and every known token
 * format in `text`. Known values go first, longest first, so a value that contains a token
 * format is removed whole.
 */
export const redactSecrets = (text: string, knownValues: readonly string[] = []): string => {
  let out = text;
  const known = [...new Set(knownValues)]
    .filter((v) => v.length >= MIN_KNOWN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length);
  for (const value of known) out = out.split(value).join(redactionMarker("known_value"));
  for (const { kind, pattern } of SECRET_PATTERNS)
    out = out.replace(pattern, redactionMarker(kind));
  return out;
};

/** Redacts every string inside a JSON-like value (objects, arrays); other values are copied. */
export const redactJson = <T>(value: T, knownValues: readonly string[] = []): T => {
  const visit = (node: unknown): unknown => {
    if (typeof node === "string") return redactSecrets(node, knownValues);
    if (Array.isArray(node)) return node.map(visit);
    if (typeof node === "object" && node !== null) {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, visit(v)]));
    }
    return node;
  };
  return visit(value) as T;
};

/**
 * The values of a `.env` file (`KEY=value`, optional `export`, single or double quotes, `#`
 * comments), for use as `knownValues`. Values shorter than {@link MIN_KNOWN_SECRET_LENGTH} are
 * dropped.
 */
export const dotenvValues = (text: string): string[] => {
  const values: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.]*\s*=\s*(.*)$/.exec(raw);
    if (match?.[1] === undefined) continue;
    let value = match[1].trim();
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted?.[2] !== undefined) value = quoted[2];
    else value = value.replace(/\s+#.*$/, "");
    if (value.length >= MIN_KNOWN_SECRET_LENGTH) values.push(value);
  }
  return values;
};

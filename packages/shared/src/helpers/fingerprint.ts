/**
 * Finding fingerprints (§6.3 step 8 dedupe, §6.3 step 9 stuck detection).
 * Pure and runtime-agnostic: SHA-256 via @noble/hashes, so it runs in Node, Bun and the browser.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

/** Bumped only if the canonical form changes; old fingerprints then stop matching. */
export const FINGERPRINT_VERSION = "vtc-fp-v1";

export interface FingerprintInput {
  readonly rule_id: string;
  readonly path: string;
  readonly symbol?: string | undefined;
  readonly snippet?: string | undefined;
  /** Used only when there is neither a symbol nor a snippet to anchor the finding. */
  readonly line?: number | undefined;
}

/** POSIX separators, no leading `./`, no duplicate or trailing slashes. Case is preserved. */
export const normalizeFindingPath = (path: string): string => {
  let out = path
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/");
  while (out.startsWith("./")) out = out.slice(2);
  return out.replace(/\/+$/, "");
};

/** Whitespace-insensitive: every whitespace run becomes one space; ends are trimmed. */
export const normalizeSnippet = (snippet: string): string => snippet.replace(/\s+/g, " ").trim();

export const sha256Hex = (text: string): string => bytesToHex(sha256(utf8ToBytes(text)));

/**
 * Stable fingerprint for a finding: rule + normalised path + symbol + normalised snippet.
 * Line numbers are excluded when a symbol or snippet exists, so a finding keeps its
 * fingerprint when unrelated edits shift lines. The source (tool or role) is excluded, so
 * the same issue reported by two reviewers dedupes. Returns 64 lower-case hex chars.
 */
export const fingerprintFinding = (input: FingerprintInput): string => {
  const ruleId = input.rule_id.trim();
  const path = normalizeFindingPath(input.path);
  if (ruleId === "") throw new TypeError("fingerprint requires a rule_id");
  if (path === "") throw new TypeError("fingerprint requires a path");
  const symbol = input.symbol?.trim() ?? "";
  const snippet = input.snippet === undefined ? "" : normalizeSnippet(input.snippet);
  const anchor =
    symbol === "" && snippet === "" && input.line !== undefined ? `L${input.line}` : "";
  return sha256Hex([FINGERPRINT_VERSION, ruleId, path, symbol, snippet, anchor].join("\u0000"));
};

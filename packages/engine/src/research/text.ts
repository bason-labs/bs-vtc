/**
 * Fetched text as a role receives it (AD-22 rule 5): decoded, redacted, then datamarked and
 * capped by `datamarkFetchedText`, so the role reads it as data and never as instructions.
 */
import {
  datamarkFetchedText,
  FETCHED_TEXT_MAX_CHARS,
  redactSecrets,
  type FetchResult,
} from "@vtc/shared";

/** Longest `ResearchFetchResult.text` the contract accepts. */
export const ROLE_TEXT_MAX_CHARS = FETCHED_TEXT_MAX_CHARS + 500;

const isJson = (contentType: string | null): boolean =>
  contentType !== null && /\bjson\b/i.test(contentType);

const isText = (contentType: string | null): boolean =>
  contentType === null || /^text\/|\bxml\b|\bjson\b|markdown/i.test(contentType);

/** The body as readable text: pretty JSON, plain text, or a note for binary content. */
export const bodyText = (body: Uint8Array, contentType: string | null): string => {
  if (!isText(contentType))
    return `[${contentType ?? "binary"} content, ${String(body.length)} bytes, not shown]`;
  const text = new TextDecoder().decode(body);
  if (!isJson(contentType)) return text;
  try {
    return JSON.stringify(JSON.parse(text) as unknown, null, 2);
  } catch {
    return text;
  }
};

/**
 * Datamarked, redacted text for a role. Every line gains a `│ ` prefix, so text with many short
 * lines is cut further until the whole result fits {@link ROLE_TEXT_MAX_CHARS}.
 */
export const roleFacingText = (
  result: FetchResult,
  body: Uint8Array | undefined,
  knownValues: readonly string[],
): string => {
  const raw =
    body === undefined
      ? `[no content: ${result.status}${result.detail === undefined ? "" : `, ${result.detail}`}]`
      : bodyText(body, result.content_type);
  let text = redactSecrets(raw, knownValues);
  let out = datamarkFetchedText(result.url, text);
  while (out.length > ROLE_TEXT_MAX_CHARS && text.length > 0) {
    text = text.slice(0, Math.max(0, text.length - (out.length - ROLE_TEXT_MAX_CHARS) - 16));
    out = datamarkFetchedText(result.url, `${text}\n[cut]`);
  }
  return out;
};

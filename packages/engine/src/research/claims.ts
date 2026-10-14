/**
 * Claims in research sections that G2 must list (AD-22 rule 4): every `UNVERIFIED:` tag, and every
 * version, licence, CVE or EOL claim on a line that cites no fact (`f-<16 hex>`), or cites an id
 * that is not a current row of `facts.jsonl` (a made-up citation is no citation). Headings are
 * scanned like any other line. Pure.
 *
 * A claim gets a stable fact id (`factId(text, kind, path, null)`), so the human can waive it at
 * G2 like a fact row; claims are not written to `facts.jsonl`, they are recomputed from the
 * documents each time. The patterns are deliberately conservative: a line is flagged only for a
 * CVE or GHSA id, an SPDX-like licence name or the word licence, an EOL / end-of-life / support
 * window phrase, or a `name@1.2` / `v1.2` / `1.2.3` version.
 */
import { factId, type FactId } from "@vtc/shared";

export interface ResearchDocument {
  /** Repo-relative path, shown to the human. */
  readonly path: string;
  readonly text: string;
}

export interface DocumentClaim {
  readonly id: FactId;
  readonly kind: "unverified_tag" | "uncited_claim";
  /** Cited ids that are not current facts (the line cites them, but they verify nothing). */
  readonly unknownFacts?: readonly FactId[];
  readonly path: string;
  /** 1-based. */
  readonly line: number;
  /** The claim, trimmed and capped at 300 characters. */
  readonly text: string;
}

const TAG = "UNVERIFIED:";
const CITED_FACTS = /\bf-[a-f0-9]{16}\b/g;
const CLAIM_PATTERNS: readonly RegExp[] = [
  /\bCVE-\d{4}-\d{4,}\b/i,
  /\bGHSA(?:-[23456789cfghjmpqrvwx]{4}){3}\b/i,
  /\b(?:MIT|ISC|Apache-2\.0|BSD-[23]-Clause|MPL-2\.0|[AL]?GPL-?[23](?:\.0)?(?:-only|-or-later)?|licen[cs]ed?)\b/i,
  /\b(?:EOL|end[- ]of[- ]life|end of support|supported until|LTS)\b/i,
  // One character before the `@` is enough to tell `name@1.2`; a `+` there backtracks
  // quadratically on a long run of name characters with no version after them.
  /[\w/.-]@\d+(?:\.\d+)+/,
  /\bv\d+\.\d+(?:\.\d+)?\b/,
  /\b\d+\.\d+\.\d+\b/,
];

/**
 * Lines are tested in windows of this many characters, overlapping by {@link WINDOW_OVERLAP}
 * (longer than any claim the patterns match in full), so a role-written line of any length costs
 * time linear in its length and a claim deep in a long line is still found.
 */
const WINDOW = 2_000;
const WINDOW_OVERLAP = 200;

const hasClaim = (body: string): boolean => {
  for (let start = 0; start < body.length; start += WINDOW - WINDOW_OVERLAP) {
    const window = body.slice(start, start + WINDOW);
    if (CLAIM_PATTERNS.some((pattern) => pattern.test(window))) return true;
    if (start + WINDOW >= body.length) break;
  }
  return false;
};

const clipText = (text: string): string => (text.length > 300 ? `${text.slice(0, 299)}…` : text);

/**
 * The claims G2 lists for these documents, in document and line order, without duplicates.
 * `knownFacts` are the ids of the current fact rows: a line counts as cited only when it cites at
 * least one id and every id it cites is known (an unverified known fact is listed through its row).
 */
export const scanResearchClaims = (
  documents: readonly ResearchDocument[],
  knownFacts: ReadonlySet<string>,
): DocumentClaim[] => {
  const claims: DocumentClaim[] = [];
  const seen = new Set<string>();
  const add = (claim: DocumentClaim): void => {
    if (seen.has(claim.id)) return;
    seen.add(claim.id);
    claims.push(claim);
  };
  for (const doc of documents) {
    let inFence = false;
    doc.text.split(/\r?\n/).forEach((raw, index) => {
      const line = raw.trim();
      if (line.startsWith("```") || line.startsWith("~~~")) {
        inFence = !inFence;
        return;
      }
      if (inFence || line === "") return;
      const tagAt = line.indexOf(TAG);
      if (tagAt !== -1) {
        const text = clipText(line.slice(tagAt + TAG.length).trim() || line);
        add({
          id: factId(text, "unverified_claim", doc.path, null),
          kind: "unverified_tag",
          path: doc.path,
          line: index + 1,
          text,
        });
        return;
      }
      const cited: FactId[] = [...new Set(line.match(CITED_FACTS) ?? [])];
      const unknown = cited.filter((id) => !knownFacts.has(id));
      if (cited.length > 0 && unknown.length === 0) return;
      const body = line.replace(/^#+\s*/, "");
      if (body === "" || !hasClaim(body)) return;
      const text = clipText(line);
      add({
        id: factId(text, "uncited_claim", doc.path, null),
        kind: "uncited_claim",
        ...(unknown.length === 0 ? {} : { unknownFacts: unknown }),
        path: doc.path,
        line: index + 1,
        text,
      });
    });
  }
  return claims;
};

/**
 * Claims in research sections that G2 must list (AD-22 rule 4): every `UNVERIFIED:` tag, and every
 * version, licence, CVE or EOL claim on a line that cites no fact (`f-<16 hex>`). Pure.
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
  readonly path: string;
  /** 1-based. */
  readonly line: number;
  /** The claim, trimmed and capped at 300 characters. */
  readonly text: string;
}

const TAG = "UNVERIFIED:";
const CITED_FACT = /\bf-[a-f0-9]{16}\b/;
const CLAIM_PATTERNS: readonly RegExp[] = [
  /\bCVE-\d{4}-\d{4,}\b/i,
  /\bGHSA(?:-[23456789cfghjmpqrvwx]{4}){3}\b/i,
  /\b(?:MIT|ISC|Apache-2\.0|BSD-[23]-Clause|MPL-2\.0|[AL]?GPL-?[23](?:\.0)?(?:-only|-or-later)?|licen[cs]ed?)\b/i,
  /\b(?:EOL|end[- ]of[- ]life|end of support|supported until|LTS)\b/i,
  /[\w@/.-]+@\d+(?:\.\d+)+/,
  /\bv\d+\.\d+(?:\.\d+)?\b/,
  /\b\d+\.\d+\.\d+\b/,
];

const clipText = (text: string): string => (text.length > 300 ? `${text.slice(0, 299)}…` : text);

/** The claims G2 lists for these documents, in document and line order, without duplicates. */
export const scanResearchClaims = (documents: readonly ResearchDocument[]): DocumentClaim[] => {
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
      if (line.startsWith("#") || CITED_FACT.test(line)) return;
      if (!CLAIM_PATTERNS.some((pattern) => pattern.test(line))) return;
      const text = clipText(line);
      add({
        id: factId(text, "uncited_claim", doc.path, null),
        kind: "uncited_claim",
        path: doc.path,
        line: index + 1,
        text,
      });
    });
  }
  return claims;
};

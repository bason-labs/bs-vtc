/**
 * Traceability formats shared by QA prompts, the Gate Runner's traceability builder and triage
 * (§6.3 step 2, §7.4). REQ tags in test names (and so in JUnit output) link tests to
 * requirements; every assertion names its provenance.
 */
import { z } from "zod";
import { RequirementRefSchema, type RequirementRef } from "./primitives.js";

/** Tag form in a test name: `[REQ-3]` or `[REQ-3.AC-2]`; a name may carry several. */
export const formatReqTag = (ref: RequirementRef): string => `[${RequirementRefSchema.parse(ref)}]`;

const TAG = /\[((?:REQ|SEC)-[1-9]\d*(?:\.AC-[1-9]\d*)?)\]/g;

/** Every REQ/AC tag in a test name, in order of first appearance, without duplicates. */
export const parseReqTags = (testName: string): RequirementRef[] => {
  const found: RequirementRef[] = [];
  for (const match of testName.matchAll(TAG)) {
    const ref = match[1];
    if (ref !== undefined && !found.includes(ref)) found.push(ref);
  }
  return found;
};

/**
 * Where an assertion's expectation comes from (§6.3 step 2): a quoted spec reference, or
 * `observed` baseline behaviour with no spec backing. Failures on `observed` assertions route
 * as possible spec gaps, not as Engineer bugs.
 */
export const AssertionProvenanceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("spec"),
    ref: RequirementRefSchema,
    quote: z.string().min(1).max(500),
  }),
  z.strictObject({ kind: z.literal("observed") }),
]);
export type AssertionProvenance = z.infer<typeof AssertionProvenanceSchema>;

/** Text form written next to an assertion: `spec:REQ-3.AC-2 "quote"` or `observed`. */
export const formatProvenance = (provenance: AssertionProvenance): string => {
  const valid = AssertionProvenanceSchema.parse(provenance);
  return valid.kind === "observed"
    ? "observed"
    : `spec:${valid.ref} ${JSON.stringify(valid.quote)}`;
};

/** Parses the text form; `null` when it is not a valid provenance tag. */
export const parseProvenance = (text: string): AssertionProvenance | null => {
  const trimmed = text.trim();
  if (trimmed === "observed") return { kind: "observed" };
  const match = /^spec:(\S+) ("(?:[^"\\]|\\.)*")$/.exec(trimmed);
  if (match?.[1] === undefined || match[2] === undefined) return null;
  let quote: unknown;
  try {
    quote = JSON.parse(match[2]);
  } catch {
    return null;
  }
  const parsed = AssertionProvenanceSchema.safeParse({ kind: "spec", ref: match[1], quote });
  return parsed.success ? parsed.data : null;
};

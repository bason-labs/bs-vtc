import { parsePersisted, type ArtifactContent } from "@vtc/shared";
import type { z } from "zod";

/** A file read against its contract: the value, or the first problem found. */
export type Read<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: string };

/**
 * Parses a JSON artifact (as the artifacts route returns it) against `schema`. Tolerant reader
 * (AD-3 rule 2): keys a newer MINOR engine added are dropped; anything else that breaks the
 * contract is refused with the first problem.
 */
export const readJsonArtifact = <S extends z.ZodType>(
  schema: S,
  artifact: ArtifactContent,
): Read<z.infer<S>> => {
  if (artifact.encoding !== "utf8") return { ok: false, problem: "not a text file" };
  let raw: unknown;
  try {
    raw = JSON.parse(artifact.content);
  } catch {
    return { ok: false, problem: "not JSON" };
  }
  const parsed = parsePersisted(schema, raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  const path = issue?.path.map(String).join(".") ?? "";
  return {
    ok: false,
    problem: `${path === "" ? "" : `${path}: `}${issue?.message ?? "does not match its contract"}`,
  };
};

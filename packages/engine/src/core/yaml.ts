/**
 * YAML for VTC's own files (`.vtc/project.yaml`, `.vtc/gates.yml`, plan-file frontmatter),
 * through the pinned `yaml` library (spine §5 reading 24): the whole YAML 1.2 core schema, block
 * scalars and anchors included. What stays refused, with a line number: a multi-document stream,
 * a duplicate key, an unresolved tag (no custom types are ever built), more aliases than a config
 * file needs (an alias bomb), and a `__proto__` key (it would replace an object's prototype in
 * code that copies it). JSON, a subset of YAML, reads as is.
 */
import { parseDocument, stringify, type YAMLError as LibraryError } from "yaml";

export class YamlError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`line ${String(line)}: ${message}`);
    this.name = "YamlError";
  }
}

/** Aliases one config file may expand: generous for real files, fatal for an alias bomb. */
const MAX_ALIASES = 100;

const lineOf = (error: LibraryError): number => error.linePos?.[0]?.line ?? 1;

const firstLine = (message: string): string => message.split("\n")[0]?.trim() ?? message;

/** Refuses a `__proto__` key anywhere in the parsed value. */
const refuseProto = (value: unknown, text: string): void => {
  if (Array.isArray(value)) {
    for (const item of value) refuseProto(item, text);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const key of Object.keys(value)) {
    if (key === "__proto__") {
      const at = text.split("\n").findIndex((l) => l.includes("__proto__"));
      throw new YamlError("the key __proto__ is not allowed", at < 0 ? 1 : at + 1);
    }
    refuseProto((value as Record<string, unknown>)[key], text);
  }
};

/** Parses one YAML document into plain data (see the module doc for what is refused). */
export const parseYaml = (text: string): unknown => {
  const doc = parseDocument(text, {
    uniqueKeys: true,
    merge: false,
    prettyErrors: true,
    strict: true,
    schema: "core",
  });
  const problem = doc.errors[0] ?? doc.warnings[0];
  if (problem !== undefined) throw new YamlError(firstLine(problem.message), lineOf(problem));
  let value: unknown;
  try {
    value = doc.toJS({ maxAliasCount: MAX_ALIASES });
  } catch (error) {
    throw new YamlError(error instanceof Error ? firstLine(error.message) : String(error), 1);
  }
  refuseProto(value, text);
  return value;
};

/** Serialises plain data as block YAML (no anchors; long strings never folded). */
export const toYaml = (value: unknown): string =>
  stringify(value, { lineWidth: 0, aliasDuplicateObjects: false });

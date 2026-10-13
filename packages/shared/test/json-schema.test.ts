import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONTRACT_SCHEMAS,
  CONTRACTS_VERSION,
  fromStructuredOutput,
  jsonSchemaFor,
  jsonSchemas,
  sha256Hex,
  STRUCTURED_OUTPUT_CONTRACTS,
  type ContractName,
} from "../src/index.js";
import { validRoleResult } from "./fixtures.js";

/** Visits every sub-schema of a JSON Schema document. */
const walk = (node: unknown, visit: (n: Record<string, unknown>) => void): void => {
  if (Array.isArray(node)) {
    node.forEach((n) => {
      walk(n, visit);
    });
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const record = node as Record<string, unknown>;
  visit(record);
  for (const value of Object.values(record)) walk(value, visit);
};

describe("jsonSchemas", () => {
  it("exports a JSON Schema for every contract", () => {
    const all = jsonSchemas();
    expect(Object.keys(all).sort()).toEqual(Object.keys(CONTRACT_SCHEMAS).sort());
    for (const [name, schema] of Object.entries(all)) {
      expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(schema.title).toBe(name);
      expect(() => JSON.stringify(schema)).not.toThrow();
    }
  });
  it("marks strict objects as closed and keeps enums", () => {
    const task = jsonSchemaFor("Task");
    expect(task.additionalProperties).toBe(false);
    const props = task.properties as Record<string, { enum?: string[] }>;
    expect(props.status?.enum).toContain("waiting_dependency");
    expect(props.risk?.enum).toEqual(["low", "med", "high"]);
  });
  it("input mode leaves defaulted fields optional; output mode requires them", () => {
    const input = jsonSchemaFor("ProjectConfig");
    const output = jsonSchemaFor("ProjectConfig", { io: "output" });
    expect(input.required).toEqual(["version"]);
    expect(output.required).toContain("merge_level");
  });
  it("represents the RoleResult exit union", () => {
    const schema = JSON.stringify(jsonSchemaFor("RoleResult" satisfies ContractName));
    for (const exit of ["built", "blocked", "spec_conflict", "out_of_scope_fault"]) {
      expect(schema).toContain(exit);
    }
  });
});

describe("structured-output target (hosts' --output-schema / --json-schema)", () => {
  const schema = jsonSchemaFor("RoleResult", { target: "structured-output" });
  it("has an object root with no root union", () => {
    expect(schema.type).toBe("object");
    expect(schema.oneOf).toBeUndefined();
    expect(schema.anyOf).toBeUndefined();
    expect(schema.additionalProperties).toBe(false);
    const exit = (schema.properties as Record<string, { enum?: string[] }>).exit;
    expect([...(exit?.enum ?? [])].sort()).toEqual(
      ["blocked", "built", "done", "out_of_scope_fault", "spec_conflict", "unknown"].sort(),
    );
  });
  it("requires every property of every object and carries no defaults", () => {
    walk(schema, (node) => {
      expect(node).not.toHaveProperty("default");
      if (node.type === "object" && typeof node.properties === "object" && node.properties) {
        expect([...((node.required as string[] | undefined) ?? [])].sort()).toEqual(
          Object.keys(node.properties).sort(),
        );
      }
    });
  });
  it("caps the summary as a plain maxLength", () => {
    const summary = (schema.properties as Record<string, unknown>).summary;
    expect(JSON.stringify(summary)).toContain('"maxLength":6000');
  });
  it("round-trips a result through the host form and re-validates with Zod", () => {
    const hostOutput = {
      ...validRoleResult(),
      verdicts: (validRoleResult().verdicts ?? []).map((v) => ({ ...v, question_type: null })),
      question: null,
      conflict: null,
      fault: null,
      tasks: null,
      acceptance_tests: null,
      feature: null,
    };
    const parsed = fromStructuredOutput("RoleResult", hostOutput);
    expect(parsed.success).toBe(true);
    const bad = fromStructuredOutput("RoleResult", { ...hostOutput, exit: "blocked" });
    expect(bad.success).toBe(false);
  });
  it.each(STRUCTURED_OUTPUT_CONTRACTS)(
    "%s has no nullable field, so null always means absent",
    (name) => {
      walk(jsonSchemaFor(name), (node) => {
        expect(node.type).not.toBe("null");
      });
    },
  );
});

describe("frozen contracts (AD-3)", () => {
  it("match the committed JSON Schema snapshot", async () => {
    // Any contract change shows up here. Update deliberately with `vitest -u` and bump
    // CONTRACTS_VERSION (additive = MINOR, anything else = MAJOR). See docs/architecture/vtc-spine.md AD-3.
    const document = { contracts_version: CONTRACTS_VERSION, schemas: jsonSchemas() };
    await expect(`${JSON.stringify(document, null, 2)}\n`).toMatchFileSnapshot(
      "../schemas/contracts.json",
    );
  });

  /**
   * `vitest -u` can rewrite the snapshot but not this hand-edited ledger: changing a schema
   * without adding a new CONTRACTS_VERSION entry (with the new hash) fails here.
   */
  describe("version ledger (schemas/contracts-ledger.json)", () => {
    const ledger = JSON.parse(
      readFileSync(new URL("../schemas/contracts-ledger.json", import.meta.url), "utf8"),
    ) as { versions: { version: string; schemas_sha256: string }[] };
    const semver = (v: string): number[] => v.split(".").map(Number);
    const newer = (a: string, b: string): boolean => {
      const [x, y] = [semver(a), semver(b)];
      for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return (x[i] ?? 0) > (y[i] ?? 0);
      return false;
    };
    it("records the current schemas under the current version", () => {
      const hash = sha256Hex(JSON.stringify(jsonSchemas()));
      const entry = ledger.versions.find((v) => v.version === CONTRACTS_VERSION);
      expect(entry, `add ${CONTRACTS_VERSION} to the ledger`).toBeDefined();
      expect(
        entry?.schemas_sha256,
        "schemas changed: bump CONTRACTS_VERSION and append a new ledger entry",
      ).toBe(hash);
    });
    it("is append-only: strictly increasing versions, one hash each, current version last", () => {
      const versions = ledger.versions.map((v) => v.version);
      versions.slice(1).forEach((v, i) => {
        expect(newer(v, versions[i] ?? "0.0.0"), `${v} after ${String(versions[i])}`).toBe(true);
      });
      const hashes = ledger.versions.map((v) => v.schemas_sha256);
      expect(new Set(hashes).size).toBe(hashes.length);
      expect(versions.at(-1)).toBe(CONTRACTS_VERSION);
    });
  });
});
